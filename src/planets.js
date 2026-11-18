import * as THREE from 'three';
import { bodies } from './maneuver.js'
import { PLANETS, SUN_RADIUS, helioState, planetSOI } from './solar.js';

const loader = new THREE.TextureLoader();

// Earth
const earthTexture = loader.load('assets/earth.webp');

const geometry = new THREE.SphereGeometry(1, 64, 64)

const material = new THREE.MeshPhongMaterial({
    map: earthTexture
});

const earth = new THREE.Mesh(geometry, material);
earth.position.x = bodies.earth.pos.x;
earth.position.y = bodies.earth.pos.y;

export { earth };

// moon

const moonTexture = loader.load('assets/moon.webp');

const geometry_moon = new THREE.SphereGeometry(0.4, 64, 64)

const material_moon = new THREE.MeshPhongMaterial({
    map: moonTexture
});


const moon = new THREE.Mesh(geometry_moon, material_moon);
moon.position.x = bodies.moon.pos.x;
moon.position.y = bodies.moon.pos.y;
export { moon }

// Placeholder sun kept so old imports still resolve; the real Sun comes from
// createSolarSystem().meshes.sun.
const sun = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd28a }));
sun.position.set(bodies.sun.pos.x, bodies.sun.pos.y, bodies.sun.pos.z);
export { sun };


// ---------------------------------------------------------------------------
// Solar system rendering
// ---------------------------------------------------------------------------
const hasDOM = typeof document !== 'undefined';
function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
}

// --- seamless 3D value noise sampled on the sphere --------------------------
function hash3(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
        l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
        l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
        w);
}
function fbm(x, y, z, oct = 5) {
    let a = 0.5, f = 1, sum = 0;
    for (let i = 0; i < oct; i++) { sum += a * vnoise(x * f, y * f, z * f); f *= 2.03; a *= 0.5; }
    return sum;
}
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Paint an equirectangular map; shade(nx,ny,nz,lat) -> [r,g,b] (0-255). */
function paintSphere(w, h, shade) {
    const c = makeCanvas(w, h), g = c.getContext('2d');
    const img = g.createImageData(w, h), d = img.data;
    for (let j = 0; j < h; j++) {
        const lat = (0.5 - (j + 0.5) / h) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
        for (let i = 0; i < w; i++) {
            const lon = ((i + 0.5) / w) * 2 * Math.PI;
            const rgb = shade(cl * Math.cos(lon), sl, cl * Math.sin(lon), lat);
            const k = (j * w + i) * 4;
            d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = 255;
        }
    }
    g.putImageData(img, 0, 0);
    return c;
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function mercuryCanvas(w, h) {
    const c = paintSphere(w, h, (x, y, z) => {
        const n = fbm(x * 3 + 7, y * 3, z * 3, 6);
        const v = 85 + n * 120;
        return [v, v * 0.96, v * 0.92];
    });
    const g = c.getContext('2d'), r = rng(11);
    const count = w >= 1024 ? 260 : 130;
    for (let i = 0; i < count; i++) {
        const x = r() * w, y = h * (0.08 + 0.84 * r()), rad = (2 + r() * r() * 16) * (w / 512);
        for (const dx of [0, -w, w]) {
            const gr = g.createRadialGradient(x + dx, y, rad * 0.2, x + dx, y, rad);
            gr.addColorStop(0, 'rgba(40,36,34,0.55)');
            gr.addColorStop(0.8, 'rgba(60,55,52,0.35)');
            gr.addColorStop(0.92, 'rgba(210,200,190,0.45)');
            gr.addColorStop(1, 'rgba(210,200,190,0)');
            g.fillStyle = gr;
            g.beginPath(); g.arc(x + dx, y, rad, 0, 6.2832); g.fill();
        }
    }
    return c;
}
function venusCanvas(w, h) {
    return paintSphere(w, h, (x, y, z) => {
        // stretch along latitude for banded, swirling cloud decks
        const q = fbm(x * 1.5 + 3, y * 4, z * 1.5, 4);
        const n = fbm(x * 2 + q * 2, y * 6 + q, z * 2 - q * 2, 5);
        return mix([201, 164, 96], [250, 232, 176], Math.min(1, n * 1.5));
    });
}
function marsCanvas(w, h) {
    return paintSphere(w, h, (x, y, z, lat) => {
        const n = fbm(x * 2.5 + 20, y * 2.5, z * 2.5, 6);
        const maria = fbm(x * 1.4 + 50, y * 1.4, z * 1.4, 4);
        let col = mix([176, 84, 44], [214, 128, 76], n);
        const dark = Math.max(0, Math.min(1, (0.46 - maria) * 5));
        col = mix(col, [86, 46, 36], dark * 0.75 * (Math.abs(lat) < 1.0 ? 1 : 0.3));
        const edge = 1.22 + (fbm(x * 6, y * 6, z * 6, 3) - 0.5) * 0.25;
        const cap = Math.max(0, Math.min(1, (Math.abs(lat) - edge) * 12));
        return mix(col, [244, 246, 250], cap);
    });
}

function canvasTexture(c) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
}

function radialTexture(stops) {
    const c = makeCanvas(128, 128), g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

// Fresnel rim shell (additive). Visible only near the limb.
function makeRim(radius, color, power, intensity) {
    const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(color) }, uPower: { value: power }, uI: { value: intensity } },
        vertexShader: `varying vec3 vN; varying vec3 vV;
            void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
        fragmentShader: `uniform vec3 uColor; uniform float uPower; uniform float uI; varying vec3 vN; varying vec3 vV;
            void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower); gl_FragColor = vec4(uColor, f*uI); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 24), mat);
}

let _dotTex = null;
/** Soft glowing dot sprite for distant bodies. Position it, then call updateMarker each frame. */
export function makeMarkerSprite(color) {
    if (!hasDOM) return new THREE.Sprite();
    _dotTex = _dotTex || radialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.85)'], [0.55, 'rgba(255,255,255,0.18)'], [1, 'rgba(255,255,255,0)']]);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: _dotTex, color: new THREE.Color(color), transparent: true, opacity: 0,
        depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    s.renderOrder = 5;
    s.visible = false;
    return s;
}

/**
 * Keep a marker ~sizePx wide on screen and fade it in when the body it stands
 * for (worldRadius) projects smaller than ~3 px. Call after positioning it.
 */
export function updateMarker(sprite, worldRadius, camera, sizePx = 18) {
    const H = (typeof window !== 'undefined' && window.innerHeight) || 900;
    const dist = Math.max(1e-6, camera.position.distanceTo(sprite.position));
    const wpp = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / H; // world units per pixel
    const px = worldRadius / wpp;
    const a = Math.min(1, Math.max(0, (4 - px) / 2)); // 0 at >=4px, 1 at <=2px
    sprite.visible = a > 0.01;
    sprite.material.opacity = a * 0.95;
    sprite.scale.set(wpp * sizePx, wpp * sizePx, 1);
}

function circlePoints(radius, n) {
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts[i * 3] = Math.cos(a) * radius; pts[i * 3 + 1] = Math.sin(a) * radius;
    }
    return pts;
}
function makeRing(radius, n, color, opacity) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(circlePoints(radius, n), 3));
    const m = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    m.userData.baseOpacity = opacity;
    m.frustumCulled = false;
    return m;
}

const SPIN = { mercury: 0.0004, venus: -0.0002, mars: 0.006 }; // rad per time unit

export function createSolarSystem(scene, { hiQuality = false } = {}) {
    const W = hiQuality ? 1024 : 512, H = W / 2;
    const group = new THREE.Group();
    scene.add(group);
    const disposables = [];
    const track = (o) => { disposables.push(o); return o; };
    const meshes = {}, markers = {}, rings = [], sois = {}, orbitRings = {};
    const sunPos = new THREE.Vector3();
    const hs = { x: 0, y: 0, vx: 0, vy: 0 };

    // Sun
    let sunMap = null;
    if (hasDOM) { sunMap = new THREE.TextureLoader().load('assets/sun.webp'); sunMap.colorSpace = THREE.SRGBColorSpace; track(sunMap); }
    const sun = new THREE.Mesh(
        track(new THREE.SphereGeometry(SUN_RADIUS, 64, 48)),
        track(new THREE.MeshBasicMaterial({ map: sunMap, color: 0xffe6b8 })));
    group.add(sun);
    meshes.sun = sun;
    const coronaLayers = [];
    if (hasDOM) {
        const tex = track(radialTexture([[0, 'rgba(255,230,170,1)'], [0.3, 'rgba(255,190,100,0.45)'], [0.6, 'rgba(255,140,60,0.12)'], [1, 'rgba(255,120,40,0)']]));
        for (const [k, op, col] of [[2.5, 0.9, 0xffd890], [4.5, 0.45, 0xffb060], [9, 0.22, 0xff9040]]) {
            const sp = new THREE.Sprite(track(new THREE.SpriteMaterial({
                map: tex, color: col, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending })));
            sp.scale.set(SUN_RADIUS * k * 2, SUN_RADIUS * k * 2, 1);
            sp.userData = { base: op, reach: SUN_RADIUS * k };
            group.add(sp); coronaLayers.push(sp);
        }
        markers.sun = makeMarkerSprite(0xffe0a0);
        group.add(markers.sun);
    }

    // Planets
    const builders = { mercury: mercuryCanvas, venus: venusCanvas, mars: marsCanvas };
    const rimSpec = { venus: [0xfff0c0, 2.5, 0.9, 1.05], mars: [0xe0a080, 3.2, 0.5, 1.04] };
    for (const name of ['mercury', 'venus', 'mars']) {
        const p = PLANETS[name];
        let map = null;
        if (hasDOM) map = track(canvasTexture(builders[name](W, H)));
        const mesh = new THREE.Mesh(
            track(new THREE.SphereGeometry(p.radius, 40, 28)),
            track(new THREE.MeshPhongMaterial({ map, shininess: 4, specular: 0x111111 })));
        group.add(mesh);
        meshes[name] = mesh;
        if (rimSpec[name]) {
            const [c, pw, it, sc] = rimSpec[name];
            const rim = makeRim(p.radius * sc, c, pw, it);
            track(rim.geometry); track(rim.material);
            mesh.add(rim);
        }
        if (hasDOM) { markers[name] = makeMarkerSprite(p.color); group.add(markers[name]); }
    }

    // Orbit and SOI rings
    for (const name of ['mercury', 'venus', 'earth', 'mars']) {
        const p = PLANETS[name];
        const o = makeRing(p.a * 1500, 360, p.color, 0.28);
        orbitRings[name] = o; group.add(o); rings.push(o);
        const s = makeRing(planetSOI(name), 64, p.color, 0.2);
        sois[name] = s; group.add(s); rings.push(s);
    }
    for (const r of rings) { track(r.geometry); track(r.material); }

    const _p = new THREE.Vector3();
    function update(t, G, earthPos, camera) {
        helioState('earth', t, G, hs);
        sunPos.set(earthPos.x - hs.x, earthPos.y - hs.y, 0);
        sun.position.copy(sunPos);
        const dSun = camera ? camera.position.distanceTo(sunPos) : 1e9;
        for (const sp of coronaLayers) {
            sp.position.copy(sunPos);
            sp.material.opacity = sp.userData.base * Math.min(1, dSun / (sp.userData.reach * 1.2));
        }
        for (const name of ['mercury', 'venus', 'earth', 'mars']) {
            const o = orbitRings[name];
            o.position.copy(sunPos);
            if (name === 'earth') { sois.earth.position.set(earthPos.x, earthPos.y, 0); }
            else {
                helioState(name, t, G, hs);
                _p.set(sunPos.x + hs.x, sunPos.y + hs.y, 0);
                meshes[name].position.copy(_p);
                meshes[name].rotation.y = SPIN[name] * t;
                sois[name].position.copy(_p);
                if (markers[name]) markers[name].position.copy(_p);
            }
        }
        if (camera) {
            if (markers.sun) {
                markers.sun.position.copy(sunPos);
                updateMarker(markers.sun, SUN_RADIUS, camera, 30);
            }
            for (const name of ['mercury', 'venus', 'mars']) {
                if (markers[name]) updateMarker(markers[name], PLANETS[name].radius, camera, 16);
            }
            // fade rings when the camera is close to the thing they surround
            for (const name of ['mercury', 'venus', 'mars']) {
                const d = camera.position.distanceTo(meshes[name].position);
                sois[name].material.opacity = sois[name].userData.baseOpacity * Math.min(1, d / (planetSOI(name) * 1.5));
            }
            const dE = camera.position.distanceTo(_p.set(earthPos.x, earthPos.y, 0));
            sois.earth.material.opacity = sois.earth.userData.baseOpacity * Math.min(1, dE / 60);
            orbitRings.earth.material.opacity = orbitRings.earth.userData.baseOpacity * Math.min(1, dE / 200);
        }
    }

    function labels(camera) {
        const out = [{ name: 'sun', x: sunPos.x, y: sunPos.y, z: 0, label: 'SUN' }];
        for (const name of ['mercury', 'venus', 'mars']) {
            const m = meshes[name].position;
            out.push({ name, x: m.x, y: m.y, z: m.z, label: PLANETS[name].label });
        }
        return out;
    }

    return {
        meshes,
        sunPosition: sunPos,
        update,
        labels,
        /** Unit vector from `point` toward the Sun (for aiming the DirectionalLight). */
        sunDirectionFrom(point, out = new THREE.Vector3()) {
            return out.set(sunPos.x - point.x, sunPos.y - point.y, (sunPos.z || 0) - (point.z || 0)).normalize();
        },
        setOrbitsVisible(v) { for (const r of rings) r.visible = !!v; },
        dispose() {
            scene.remove(group);
            for (const d of disposables) d.dispose?.();
            for (const m of Object.values(markers)) m.material.dispose();
        },
    };
}
