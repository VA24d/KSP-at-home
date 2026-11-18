// Space VFX layer: pooled GPU particle systems, flashes, rings and shader engine plumes.
// Everything lives in the z = 0 plane. Particles feel no gravity; they drift and slowly decelerate.
import * as THREE from 'three';

const MAX_DT = 0.1;
let QUALITY = 1;

/**
 * Scale particle emission rates globally.
 * @param {'high'|'low'} level 'low' emits 40% of the particles.
 */
export function setQuality(level) {
  QUALITY = level === 'low' ? 0.4 : 1;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = Math.random;
const rr = (a, b) => a + (b - a) * rnd();

function clampDt(dt) {
  return dt > 0 ? (dt > MAX_DT ? MAX_DT : dt) : 1 / 60;
}

// ---------------------------------------------------------------------------
// Shared glow texture (created lazily, no top-level side effects)
// ---------------------------------------------------------------------------
let glowTexture = null;
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,255,255,0.7)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.22)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.05)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

/**
 * Soft radial-gradient additive sprite for engine glow or sun glow.
 * The caller adds it to the scene and positions it.
 * @param {THREE.ColorRepresentation} color
 * @param {number} size World-unit diameter.
 * @returns {THREE.Sprite}
 */
export function makeGlow(color, size) {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: new THREE.Color(color),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(size, size, 1);
  return s;
}

// ---------------------------------------------------------------------------
// ParticleSystem: ring-buffer pool, one THREE.Points draw call
// ---------------------------------------------------------------------------
const PARTICLE_VERT = /* glsl */ `
attribute float size;
attribute float alpha;
attribute vec3 color;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float ps = size * uScale / max(-mv.z, 0.0001);
  vAlpha = alpha * clamp(ps, 0.0, 1.0);
  vColor = color;
  gl_PointSize = min(ps, 512.0);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.0, 1.0, d)) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}`;

class ParticleSystem {
  /**
   * @param {number} max Pool size.
   * @param {THREE.Blending} blending
   * @param {number} renderOrder
   */
  constructor(max, blending, renderOrder) {
    this.max = max;
    this.head = 0;
    this.alive = 0;
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max); // 0 = dead
    this.drag = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.flick = new Float32Array(max);
    this.fadeIn = new Float32Array(max);

    this.geometry = new THREE.BufferGeometry();
    this.attrs = [
      new THREE.BufferAttribute(this.pos, 3),
      new THREE.BufferAttribute(this.size, 1),
      new THREE.BufferAttribute(this.alpha, 1),
      new THREE.BufferAttribute(this.col, 3),
    ];
    this.attrs.forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('position', this.attrs[0]);
    this.geometry.setAttribute('size', this.attrs[1]);
    this.geometry.setAttribute('alpha', this.attrs[2]);
    this.geometry.setAttribute('color', this.attrs[3]);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      // Everything flies in the z=0 plane; the planet's near bulge must not hide
      // pad smoke and flames (the camera looks straight down at the limb).
      depthTest: false,
      blending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
  }

  /** Set pixel-per-world-unit scale: pixelRatio * viewportHeight / (2 tan(fov/2)). */
  setScale(scale) {
    this.material.uniforms.uScale.value = scale;
  }

  spawn(px, py, pz, vx, vy, vz, life, s0, s1, alpha, r0, g0, b0, r1, g1, b1, drag, flick, fadeIn) {
    const i = this.head;
    this.head = i + 1 === this.max ? 0 : i + 1;
    if (this.life[i] <= 0) this.alive++;
    const i3 = i * 3;
    this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.drag[i] = drag;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.a0[i] = alpha;
    this.c0[i3] = r0; this.c0[i3 + 1] = g0; this.c0[i3 + 2] = b0;
    this.c1[i3] = r1; this.c1[i3 + 1] = g1; this.c1[i3 + 2] = b1;
    this.flick[i] = flick;
    this.fadeIn[i] = fadeIn;
    this.size[i] = s0;
    this.alpha[i] = 0;
    this.col[i3] = r0; this.col[i3 + 1] = g0; this.col[i3 + 2] = b0;
  }

  update(dt) {
    if (this.alive === 0) return;
    const { pos, vel, age, life, drag, s0, s1, a0, c0, c1, col, size, alpha, flick, fadeIn } = this;
    const n = this.max;
    for (let i = 0; i < n; i++) {
      const L = life[i];
      if (L <= 0) continue;
      const a = age[i] + dt;
      const i3 = i * 3;
      if (a >= L) {
        life[i] = 0;
        size[i] = 0;
        alpha[i] = 0;
        this.alive--;
        continue;
      }
      age[i] = a;
      const t = a / L;
      const k = Math.exp(-drag[i] * dt);
      const vx = (vel[i3] *= k), vy = (vel[i3 + 1] *= k), vz = (vel[i3 + 2] *= k);
      pos[i3] += vx * dt;
      pos[i3 + 1] += vy * dt;
      pos[i3 + 2] += vz * dt;
      size[i] = s0[i] + (s1[i] - s0[i]) * Math.sqrt(t);
      const f = 1 - t;
      const fi = fadeIn[i];
      let al = a0[i] * (t < fi ? t / fi : 1) * f * f * (3 - 2 * f);
      const fl = flick[i];
      if (fl > 0) al *= 1 - fl + fl * (0.5 + 0.5 * Math.sin(a * 70 + i * 1.7));
      alpha[i] = al;
      col[i3] = c0[i3] + (c1[i3] - c0[i3]) * t;
      col[i3 + 1] = c0[i3 + 1] + (c1[i3 + 1] - c0[i3 + 1]) * t;
      col[i3 + 2] = c0[i3 + 2] + (c1[i3 + 2] - c0[i3 + 2]) * t;
    }
    const at = this.attrs;
    at[0].needsUpdate = at[1].needsUpdate = at[2].needsUpdate = at[3].needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.size.fill(0);
    this.alpha.fill(0);
    this.alive = 0;
    this.head = 0;
    const at = this.attrs;
    at[0].needsUpdate = at[1].needsUpdate = at[2].needsUpdate = at[3].needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Exhaust profiles
// ---------------------------------------------------------------------------
const PROFILES = {
  hot: { rate: 300, a: 0.5, c0: [1.0, 0.88, 0.5], c1: [0.9, 0.22, 0.04], spread: 0.16, grow: 2.0, soot: 0.06 },
  methalox: { rate: 260, a: 0.42, c0: [0.85, 0.88, 1.0], c1: [0.4, 0.2, 0.95], spread: 0.14, grow: 2.0, soot: 0 },
  hydrolox: { rate: 220, a: 0.2, c0: [0.8, 0.92, 1.0], c1: [0.3, 0.5, 1.0], spread: 0.2, grow: 2.8, soot: 0 },
};

// ---------------------------------------------------------------------------
// Engine plume mesh
// ---------------------------------------------------------------------------
const PLUME_VERT = /* glsl */ `
uniform float uLength, uRadius, uLayerR, uLayerL, uTaper, uTime;
varying float vU;
varying vec2 vC;
varying vec3 vN;
varying vec3 vView;
void main() {
  float u = position.x;
  float prof = mix(1.0, uTaper, u) * (1.0 + 0.18 * sin(min(u * 3.0, 1.0) * 3.14159));
  float wob = 1.0 + 0.06 * sin(u * 18.0 - uTime * 25.0);
  vec3 p = vec3(u * uLength * uLayerL, position.yz * uRadius * uLayerR * prof * wob);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * vec3(0.0, position.yz));
  vView = -mv.xyz;
  vU = u;
  vC = position.yz;
  gl_Position = projectionMatrix * mv;
}`;

const PLUME_FRAG = /* glsl */ `
uniform float uTime, uIntensity, uGain, uFalloff, uEdge, uWhite, uDiamonds;
uniform vec3 uColA, uColB, uColC;
varying float vU;
varying vec2 vC;
varying vec3 vN;
varying vec3 vView;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float fres = abs(dot(normalize(vN), normalize(vView)));
  float edge = smoothstep(0.0, uEdge, fres);
  float x1 = vU * 7.0 - uTime * 16.0;
  float x2 = vU * 17.0 - uTime * 30.0;
  float n1 = 0.5 * (vnoise(vec2(x1, vC.x * 2.0)) + vnoise(vec2(x1 + 13.0, vC.y * 2.0)));
  float n2 = 0.5 * (vnoise(vec2(x2, vC.x * 4.0)) + vnoise(vec2(x2 + 7.0, vC.y * 4.0)));
  float flick = 0.7 + 0.3 * n1 + 0.15 * (n2 - 0.5);
  float fade = pow(1.0 - vU, uFalloff) * smoothstep(0.0, 0.04, vU);
  vec3 col = mix(mix(uColA, uColB, smoothstep(0.0, 0.35, vU)), uColC, smoothstep(0.3, 1.0, vU));
  col = mix(col, vec3(1.0), uWhite * (1.0 - vU));
  float dia = uDiamonds * pow(max(0.0, cos(vU * 22.0)), 10.0) * smoothstep(0.05, 0.2, vU) * (1.0 - vU);
  col += dia * vec3(0.7, 0.85, 1.0) * 1.5;
  float a = uGain * uIntensity * edge * fade * flick + dia * edge * 0.6 * uIntensity;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

const PLUME_PALETTES = {
  hot: { a: [1.0, 0.95, 0.75], b: [1.0, 0.6, 0.15], c: [0.8, 0.15, 0.03], gain: 0.9, dia: 0, taper: 0.3, falloff: 1.4 },
  methalox: { a: [0.9, 0.9, 1.0], b: [0.5, 0.4, 1.0], c: [0.2, 0.1, 0.6], gain: 0.8, dia: 0, taper: 0.35, falloff: 1.5 },
  hydrolox: { a: [0.85, 0.95, 1.0], b: [0.5, 0.7, 1.0], c: [0.2, 0.35, 0.9], gain: 0.45, dia: 1, taper: 0.7, falloff: 1.2 },
};

// layer: radius mul, length mul, gain mul, whiteness
const PLUME_LAYERS = [
  { r: 1.0, l: 1.0, g: 0.35, w: 0.0 },
  { r: 0.62, l: 0.8, g: 0.6, w: 0.25 },
  { r: 0.3, l: 0.5, g: 0.9, w: 0.7 },
];

function buildPlumeGeometry(radial, along) {
  const verts = [];
  const idx = [];
  for (let j = 0; j <= along; j++) {
    const u = j / along;
    for (let i = 0; i <= radial; i++) {
      const ang = (i / radial) * Math.PI * 2;
      verts.push(u, Math.cos(ang), Math.sin(ang));
    }
  }
  const row = radial + 1;
  for (let j = 0; j < along; j++) {
    for (let i = 0; i < radial; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

/**
 * Create an engine flame for one nozzle: three nested open cones with a shader material.
 * The flame extends along local +X from the origin; parent it to a nozzle anchor and
 * rotate so local +X points along the exhaust direction.
 * @param {{radialSegments?: number, color?: 'hot'|'methalox'|'hydrolox'}} [opts]
 * @returns {{object: THREE.Group, set: (intensity:number, length:number, radius:number, timeSec:number, color?:string)=>void, dispose: ()=>void}}
 */
export function createPlume(opts = {}) {
  const geometry = buildPlumeGeometry(opts.radialSegments || 20, 12);
  const group = new THREE.Group();
  group.visible = false;
  const layers = PLUME_LAYERS.map((L, n) => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uIntensity: { value: 0 }, uGain: { value: 1 }, uFalloff: { value: 1.4 },
        uEdge: { value: 0.55 }, uWhite: { value: L.w }, uDiamonds: { value: 0 }, uTaper: { value: 0.3 },
        uLength: { value: 1 }, uRadius: { value: 0.1 }, uLayerR: { value: L.r }, uLayerL: { value: L.l },
        uColA: { value: new THREE.Vector3() }, uColB: { value: new THREE.Vector3() }, uColC: { value: new THREE.Vector3() },
      },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,          // see the particle material: the limb must not clip the flame
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3 + n;
    group.add(mesh);
    return { mesh, material, L };
  });
  let curColor = null;
  let curPalette = PLUME_PALETTES.hot;

  function applyColor(name) {
    const p = PLUME_PALETTES[name] || PLUME_PALETTES.hot;
    curColor = name;
    curPalette = p;
    for (const { material, L } of layers) {
      const u = material.uniforms;
      u.uColA.value.set(p.a[0], p.a[1], p.a[2]);
      u.uColB.value.set(p.b[0], p.b[1], p.b[2]);
      u.uColC.value.set(p.c[0], p.c[1], p.c[2]);
      u.uGain.value = p.gain * (L.g / 0.6);
      u.uDiamonds.value = L.r < 0.5 || L.r === 1.0 ? 0 : p.dia; // diamonds in the mid layer
      if (L.r === 0.3) u.uDiamonds.value = p.dia;
      u.uTaper.value = p.taper;
      u.uFalloff.value = p.falloff;
    }
  }
  applyColor(opts.color || 'hot');

  return {
    object: group,
    /**
     * @param {number} intensity 0..1 (0 hides the plume)
     * @param {number} length World-unit length at full thrust.
     * @param {number} radius Nozzle exit radius in world units.
     * @param {number} timeSec Animation time in seconds.
     * @param {'hot'|'methalox'|'hydrolox'} [color]
     * @param {number} [expand] 0 at sea level .. 1 in vacuum: the plume balloons out as
     *   ambient pressure drops, and shock diamonds only show in thick air. Omit (or -1)
     *   for the plain look used in orbit.
     */
    set(intensity, length, radius, timeSec, color, expand = -1) {
      if (color && color !== curColor) applyColor(color);
      if (!(intensity > 0.01)) { group.visible = false; return; }
      group.visible = true;
      const x = Math.min(Math.max(expand, 0), 1);
      const p = curPalette;
      const len = length * (0.35 + 0.65 * Math.min(intensity, 1)) * (1 + 0.45 * x);
      const rad = radius * (1 + 1.5 * x);
      const taper = p.taper + (1.35 - p.taper) * x;          // bell-shaped in vacuum
      const dia = Math.max(p.dia, 0.55) * Math.max(0, 1 - x * 3);   // diamonds fade by ~1/3 expansion
      for (const { material, L } of layers) {
        const u = material.uniforms;
        u.uTime.value = timeSec;
        u.uIntensity.value = Math.min(intensity, 1) * (1 - 0.35 * x);
        u.uLength.value = len;
        u.uRadius.value = rad;
        u.uTaper.value = taper;
        if (L.r !== 1.0) u.uDiamonds.value = expand >= 0 ? dia : p.dia;
      }
    },
    dispose() {
      geometry.dispose();
      layers.forEach(({ material }) => material.dispose());
    },
  };
}

// ---------------------------------------------------------------------------
// Effects layer
// ---------------------------------------------------------------------------
const POOL_FLASH = 6;
const POOL_RING = 3;

/**
 * Create the effects layer. Call once.
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} [renderer] Optional; used to track pixel ratio and viewport height.
 * @param {THREE.PerspectiveCamera} [camera] Optional; used for fov (default 50 degrees).
 */
export function createEffects(scene, renderer, camera) {
  const smoke = new ParticleSystem(800, THREE.NormalBlending, 1);
  const exhaust = new ParticleSystem(3000, THREE.AdditiveBlending, 2);
  const rcs = new ParticleSystem(600, THREE.AdditiveBlending, 2);
  const sparks = new ParticleSystem(800, THREE.AdditiveBlending, 2);
  const systems = [smoke, exhaust, rcs, sparks];
  systems.forEach((s) => scene.add(s.points));

  // accumulators for rate-based emission
  let accExh = 0, accSmoke = 0, accRcs = 0, accSoot = 0;
  let lastDt = 1 / 60;
  const sizeVec = new THREE.Vector2();

  function updateScale() {
    if (!renderer) return;
    const pr = renderer.getPixelRatio();
    renderer.getSize(sizeVec);
    const fov = camera && camera.fov ? camera.fov : 50;
    const scale = (pr * sizeVec.y) / (2 * Math.tan((fov * Math.PI) / 360));
    for (const s of systems) s.setScale(scale);
  }
  updateScale();

  // flash sprites
  const flashes = [];
  for (let i = 0; i < POOL_FLASH; i++) {
    const sp = makeGlow(0xffffff, 1);
    sp.visible = false;
    sp.renderOrder = 6;
    scene.add(sp);
    flashes.push({ sp, age: 0, dur: 0, size: 0, on: false });
  }
  let flashHead = 0;
  function flash(pos, size, dur, color) {
    const f = flashes[flashHead];
    flashHead = (flashHead + 1) % POOL_FLASH;
    f.sp.position.copy(pos);
    f.sp.material.color.setHex(color);
    f.age = 0; f.dur = dur; f.size = size; f.on = true;
    f.sp.visible = true;
    f.sp.scale.set(size * 0.5, size * 0.5, 1);
    f.sp.material.opacity = 1;
  }

  // expansion rings (RingGeometry faces +Z, so it lies in the XY plane)
  const ringGeo = new THREE.RingGeometry(0.88, 1.0, 64);
  const rings = [];
  for (let i = 0; i < POOL_RING; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffc080, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    scene.add(mesh);
    rings.push({ mesh, age: 0, dur: 1.4, size: 1, on: false });
  }
  let ringHead = 0;

  function updateTimed(dt) {
    for (let i = 0; i < POOL_FLASH; i++) {
      const f = flashes[i];
      if (!f.on) continue;
      f.age += dt;
      const t = f.age / f.dur;
      if (t >= 1) { f.on = false; f.sp.visible = false; continue; }
      const s = f.size * (0.5 + 0.9 * Math.sqrt(t));
      f.sp.scale.set(s, s, 1);
      f.sp.material.opacity = (1 - t) * (1 - t);
    }
    for (let i = 0; i < POOL_RING; i++) {
      const r = rings[i];
      if (!r.on) continue;
      r.age += dt;
      const t = r.age / r.dur;
      if (t >= 1) { r.on = false; r.mesh.visible = false; continue; }
      const e = 1 - (1 - t) * (1 - t) * (1 - t);
      const s = r.size * (0.12 + 1.5 * e);
      r.mesh.scale.set(s, s, 1);
      r.mesh.material.opacity = 0.8 * Math.pow(1 - t, 1.5);
    }
  }

  function takeCount(acc, add) {
    const n = Math.min(acc | 0, 250);
    return n;
  }

  return {
    /**
     * Advance all particles and timed effects.
     * @param {number} realDt Real seconds since the last frame (clamped to 0.1).
     */
    update(realDt) {
      const dt = clampDt(realDt);
      updateScale();
      for (const s of systems) s.update(dt);
      updateTimed(dt);
    },

    /**
     * Continuous engine exhaust; call every frame while firing.
     * @param {THREE.Vector3} pos Nozzle exit (world).
     * @param {THREE.Vector3} dir Unit direction the exhaust travels (world).
     * @param {{intensity?:number,size?:number,realDt?:number,inheritVel?:THREE.Vector3,color?:'hot'|'methalox'|'hydrolox'}} [opts]
     */
    emitExhaust(pos, dir, opts = {}) {
      const inten = clamp(opts.intensity == null ? 1 : opts.intensity, 0, 1);
      if (inten <= 0.01) return;
      const size = opts.size || 0.05;
      const dt = clampDt(opts.realDt);
      lastDt = dt;
      const prof = PROFILES[opts.color] || PROFILES.hot;
      accExh += prof.rate * inten * QUALITY * dt;
      let n = accExh | 0;
      accExh -= n;
      if (n > 250) n = 250;
      const ih = opts.inheritVel;
      const ix = ih ? ih.x : 0, iy = ih ? ih.y : 0, iz = ih ? ih.z : 0;
      const dx = dir.x, dy = dir.y, px = -dy, py = dx;
      const c0 = prof.c0, c1 = prof.c1;
      for (let k = 0; k < n; k++) {
        const tb = rnd() * dt; // sub-frame back-fill so emission is smooth at any fps
        const core = rnd() < 0.35;
        const spd = size * (8 + 8 * inten) * rr(0.85, 1.2) * (core ? 1.15 : 1);
        const sp = (rnd() - 0.5) * 2 * prof.spread * spd;
        const vx = dx * spd + px * sp, vy = dy * spd + py * sp;
        const lat = (rnd() - 0.5) * size * 0.7;
        const x = pos.x + (vx) * tb + px * lat;
        const y = pos.y + (vy) * tb + py * lat;
        const z = pos.z + (rnd() - 0.5) * size * 0.3;
        if (core) {
          exhaust.spawn(x, y, z, vx + ix, vy + iy, iz, rr(0.15, 0.3), size * 0.55, size * 0.9,
            Math.min(1, prof.a * 1.8) * inten, 1, 0.97, 0.9, c0[0], c0[1], c0[2], 1.2, 0, 0.05);
        } else {
          exhaust.spawn(x, y, z, vx + ix, vy + iy, iz, rr(0.35, 0.7), size * 0.7, size * prof.grow * rr(0.8, 1.2),
            prof.a * inten, c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], 1.1, 0, 0.08);
          if (prof.soot > 0 && rnd() < prof.soot) {
            smoke.spawn(x, y, z, vx * 0.55 + ix, vy * 0.55 + iy, iz, rr(1.2, 2.0), size * 0.8, size * 2.6,
              0.2 * inten, 0.28, 0.24, 0.22, 0.1, 0.1, 0.1, 0.9, 0, 0.15);
          }
        }
      }
    },

    /**
     * Launch-pad billowing smoke.
     * @param {THREE.Vector3} pos Source position.
     * @param {THREE.Vector3} dir Unit direction the smoke initially travels.
     * @param {{intensity?:number,size?:number,realDt?:number}} [opts]
     */
    emitSmoke(pos, dir, opts = {}) {
      const inten = clamp(opts.intensity == null ? 1 : opts.intensity, 0, 1);
      if (inten <= 0.01) return;
      const size = opts.size || 0.1;
      const dt = clampDt(opts.realDt);
      accSmoke += 70 * inten * QUALITY * dt;
      let n = accSmoke | 0;
      accSmoke -= n;
      if (n > 100) n = 100;
      const px = -dir.y, py = dir.x;
      for (let k = 0; k < n; k++) {
        const tb = rnd() * dt;
        const spd = size * rr(1.5, 5);
        const side = (rnd() < 0.5 ? -1 : 1) * size * rr(0.5, 3.5);
        const vx = dir.x * spd + px * side, vy = dir.y * spd + py * side;
        const g = rr(0.8, 0.98);
        smoke.spawn(pos.x + vx * tb, pos.y + vy * tb, pos.z + (rnd() - 0.5) * size * 0.3, vx, vy, 0,
          rr(2, 4), size * 0.6, size * rr(3, 4.5), 0.35 * inten, g, g, g, g * 0.6, g * 0.6, g * 0.62, 0.8, 0, 0.1);
      }
    },

    /**
     * Cold-gas RCS puff; call every frame while the thruster fires.
     * @param {THREE.Vector3} pos Thruster nozzle (world).
     * @param {THREE.Vector3} dir Unit direction the gas travels.
     * @param {{size?:number,realDt?:number,inheritVel?:THREE.Vector3}} [opts]
     */
    emitRCS(pos, dir, opts = {}) {
      const size = opts.size || 0.02;
      const dt = clampDt(opts.realDt);
      accRcs += 130 * QUALITY * dt;
      let n = accRcs | 0;
      accRcs -= n;
      if (n > 60) n = 60;
      const ih = opts.inheritVel;
      const ix = ih ? ih.x : 0, iy = ih ? ih.y : 0, iz = ih ? ih.z : 0;
      for (let k = 0; k < n; k++) {
        const tb = rnd() * dt;
        const ang = (rnd() - 0.5) * 0.5;
        const c = Math.cos(ang), s = Math.sin(ang);
        const spd = size * rr(8, 14);
        const vx = (dir.x * c - dir.y * s) * spd, vy = (dir.x * s + dir.y * c) * spd;
        rcs.spawn(pos.x + vx * tb, pos.y + vy * tb, pos.z + (rnd() - 0.5) * size * 0.2,
          vx + ix, vy + iy, iz, rr(0.15, 0.35), size * 0.3, size * rr(0.9, 1.3), 0.7,
          1, 1, 1, 0.75, 0.93, 1, 3, 0.4, 0.05);
      }
    },

    /**
     * Crash explosion: flash, fireball, smoke, sparks and a ring in the XY plane (~2.5 s).
     * @param {THREE.Vector3} pos
     * @param {number} [scale] Approximate fireball radius in world units.
     */
    explosion(pos, scale = 0.1) {
      const q = QUALITY;
      flash(pos, scale * 5, 0.25, 0xffe0a0);
      const r = rings[ringHead];
      ringHead = (ringHead + 1) % POOL_RING;
      r.mesh.position.copy(pos);
      r.mesh.visible = true;
      r.on = true; r.age = 0; r.dur = 1.4; r.size = scale * 1.6;
      r.mesh.scale.set(scale * 0.2, scale * 0.2, 1);
      const nf = Math.round(70 * q);
      for (let i = 0; i < nf; i++) {
        const a = rnd() * 6.2832, v = scale * 1.5 * Math.pow(rnd(), 0.7);
        exhaust.spawn(pos.x, pos.y, pos.z, Math.cos(a) * v, Math.sin(a) * v, (rnd() - 0.5) * v * 0.2,
          rr(1.0, 2.2), scale * 0.25, scale * rr(0.5, 0.8), 0.4,
          1, 0.85, 0.45, 0.45, 0.06, 0.02, 1.5, 0, 0.03);
      }
      const ns = Math.round(30 * q);
      for (let i = 0; i < ns; i++) {
        const a = rnd() * 6.2832, v = scale * rr(0.2, 1.1);
        smoke.spawn(pos.x, pos.y, pos.z, Math.cos(a) * v, Math.sin(a) * v, 0,
          rr(1.8, 2.6), scale * 0.3, scale * rr(0.9, 1.3), 0.5,
          0.3, 0.2, 0.15, 0.1, 0.1, 0.1, 1.2, 0, 0.1);
      }
      const nd = Math.round(110 * q);
      for (let i = 0; i < nd; i++) {
        const a = rnd() * 6.2832, v = scale * (0.8 + 3 * Math.sqrt(rnd()));
        sparks.spawn(pos.x, pos.y, pos.z, Math.cos(a) * v, Math.sin(a) * v, (rnd() - 0.5) * v * 0.2,
          rr(0.8, 2.5), scale * 0.035, scale * 0.01, 1,
          1, 0.9, 0.6, 1, 0.25, 0.05, 0.5, 0.5, 0.02);
      }
    },

    /**
     * Stage separation: small flash plus a short puff of white vapour (~0.6 s).
     * @param {THREE.Vector3} pos
     * @param {number} [scale] World-unit size of the effect.
     */
    sepFlash(pos, scale = 0.05) {
      flash(pos, scale * 3, 0.18, 0xfff4e0);
      const n = Math.round(30 * QUALITY);
      for (let i = 0; i < n; i++) {
        const a = rnd() * 6.2832, v = scale * rr(0.5, 2.2);
        rcs.spawn(pos.x, pos.y, pos.z, Math.cos(a) * v, Math.sin(a) * v, (rnd() - 0.5) * v * 0.2,
          rr(0.3, 0.6), scale * 0.3, scale * rr(0.8, 1.4), 0.6,
          1, 1, 1, 0.8, 0.9, 1, 2.5, 0.2, 0.05);
      }
      const ns = Math.round(10 * QUALITY);
      for (let i = 0; i < ns; i++) {
        const a = rnd() * 6.2832, v = scale * rr(2, 5);
        sparks.spawn(pos.x, pos.y, pos.z, Math.cos(a) * v, Math.sin(a) * v, 0,
          rr(0.3, 0.6), scale * 0.08, scale * 0.02, 1, 1, 1, 0.9, 1, 0.6, 0.3, 1.5, 0.02, 0.3);
      }
    },

    makeGlow,
    createPlume,

    /** Kill all live particles and timed effects instantly. */
    clear() {
      for (const s of systems) s.clear();
      for (const f of flashes) { f.on = false; f.sp.visible = false; }
      for (const r of rings) { r.on = false; r.mesh.visible = false; }
      accExh = accSmoke = accRcs = accSoot = 0;
    },

    /** Remove everything from the scene and free GPU resources. */
    dispose() {
      for (const s of systems) { scene.remove(s.points); s.dispose(); }
      for (const f of flashes) { scene.remove(f.sp); f.sp.material.dispose(); }
      for (const r of rings) { scene.remove(r.mesh); r.mesh.material.dispose(); }
      ringGeo.dispose();
    },
  };
}
