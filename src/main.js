// KSP@ASTRO entry point: scene, camera, real-time simulation loop, launch and
// staging sequence, rocket visuals and HUD telemetry.
import * as THREE from 'three';
import './styles.css';
import * as M from './maneuver.js';
import * as L from './launch.js';
import * as AP from './autopilot.js';
import * as HOH from './hohmann.js';
import { CircularizationController } from './circularize.js';
import { orbitalElements, fmtDistance, fmtSpeed, fmtDuration, fmtMET } from './orbit.js';
import { earth, moon, createSolarSystem } from './planets.js';
import { createTrajectory } from './trajectory.js';
import { createBurnZones } from './burnzones.js';
import { createBurnAssist } from './burnassist.js';
import { createCoach } from './coach.js';
import { createEffects, createPlume, makeGlow, setQuality } from './effects.js';
import { buildRocket } from './rockets.js';
import { showSplash, animateLogo } from './splash.js';
import * as UI from './ui.js';
import { PLANETS, AU } from './solar.js';

const { r, v, controls, rocketParams, params, bodies, crashState, thrustState } = M;
const TAU = Math.PI * 2;
const WARPS = [0, 0.25, 1, 2, 5, 10, 50, 100, 1000, 10000];
const MAX_STEPS_PER_FRAME = 4000;
const PAD_ALT = 0.03;

// ---------------------------------------------------------------------------
// Splash / loading

const splash = showSplash();
const loading = THREE.DefaultLoadingManager;
let loadedOnce = false;
loading.onProgress = (_url, done, total) => splash.setProgress(0.15 + 0.75 * (done / Math.max(total, 1)), 'LOADING TEXTURES');
loading.onLoad = () => finishLoading();
function finishLoading() {
    if (loadedOnce) return;
    loadedOnce = true;
    splash.setProgress(1, 'SYSTEMS NOMINAL');
    splash.ready();
}
setTimeout(finishLoading, 6000);   // never strand the player behind a slow texture

// ---------------------------------------------------------------------------
// Renderer, scene, camera

const canvas = document.getElementById('scene-canvas');
canvas.style.touchAction = 'none';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 1000);

const texLoader = new THREE.TextureLoader();
texLoader.load('assets/bg.webp', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    scene.background = t;
});
for (const m of [earth, moon]) {
    if (m.material.map) m.material.map.colorSpace = THREE.SRGBColorSpace;
}
scene.add(earth, moon);

scene.add(new THREE.AmbientLight(0x8899bb, 0.35));
const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.4);
sunLight.position.set(-20, 6, 14);
scene.add(sunLight);

const atmosphere = makeGlow(0x4aa8ff, 2.75);
atmosphere.material.opacity = 0.55;
scene.add(atmosphere);
// Sun, planets, rings and distant-body markers (positions follow M's on-rails bodies).
const solar = createSolarSystem(scene, { hiQuality: UI.settings.hiQuality });
scene.add(sunLight.target);

// Twinkling star layers that follow the camera.
const starLayers = [];
for (let layer = 0; layer < 2; layer++) {
    const n = 900;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const u = Math.random() * 2 - 1, a = Math.random() * TAU, s = Math.sqrt(1 - u * u);
        pos[i * 3] = 300 * s * Math.cos(a);
        pos[i * 3 + 1] = 300 * s * Math.sin(a);
        pos[i * 3 + 2] = -Math.abs(300 * u) - 20;
        const warm = Math.random();
        col[i * 3] = 0.8 + 0.2 * warm; col[i * 3 + 1] = 0.85 + 0.1 * warm; col[i * 3 + 2] = 1 - 0.25 * warm;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        size: layer ? 2.2 : 1.4, sizeAttenuation: false, vertexColors: true,
        transparent: true, opacity: 0.8, depthWrite: false,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -10;
    scene.add(pts);
    starLayers.push(pts);
}

const effects = createEffects(scene, renderer, camera);
const trajectory = createTrajectory(scene);
const burnZones = createBurnZones(scene);
const burnAssist = createBurnAssist(scene);
const coach = createCoach();
HOH.initHohmann(scene);

function applyQuality() {
    const hi = UI.settings.hiQuality;
    setQuality(hi ? 'high' : 'low');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hi ? 2 : 1.25));
    onResize();
}
function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    viewShift = -1; viewShiftX = -1;          // force updateViewOffset to re-apply
    updateViewOffset();
}

// Centre the focus point in the part of the screen the HUD leaves free
// (between the top panels and the control deck on phones).
let viewShift = 0, viewShiftX = 0;
function updateViewOffset() {
    const w = window.innerWidth, h = window.innerHeight;
    let shift = 0, shiftX = 0;
    if (game.mode !== 'landing') {
        const sr = UI.getSafeViewRect?.();
        if (sr && sr.bottom - sr.top > h * 0.2 && sr.right - sr.left > w * 0.2) {
            shift = Math.round((sr.top + sr.bottom) / 2 - h / 2);
            shiftX = Math.round((sr.left + sr.right) / 2 - w / 2);
        }
    }
    if (shift === viewShift && shiftX === viewShiftX) return;
    viewShift = shift; viewShiftX = shiftX;
    if (shift || shiftX) camera.setViewOffset(w, h, -shiftX, -shift, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

// ---------------------------------------------------------------------------
// Game state

const game = {
    mode: 'landing',        // landing | launching | flight
    cfg: null,
    target: 'moon', targetChosen: false, orbited: false,
    countdown: 0,           // real seconds left before liftoff
    liftoffShown: 0,
    warp: 1,
    lastWarp: 1,
    acc: 0,                 // sim-time accumulator
    crashed: false,
    manualOn: false,
    noFuelWarned: false,
    apWasActive: false,
    apPhase: '',
    hohmann: false,
    time: 0,                // real seconds since start (animation clock)
};
const circ = new CircularizationController();
const pending = [];         // { at, tag, fn } real-time scheduled actions
function schedule(delay, fn, tag = '') { pending.push({ at: game.time + delay, fn, tag }); }
function cancelScheduled(tag) {
    for (let i = pending.length - 1; i >= 0; i--) if (!tag || pending[i].tag === tag) pending.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Rocket model, plumes and staging

const ENGINE_COLORS = {
    saturn5: { stage1: 'hot', stage2: 'hydrolox', spacecraft: 'hydrolox' },
    sls: { stage1: 'hot', stage2: 'hydrolox', spacecraft: 'hydrolox' },
    starship: { stage1: 'methalox', stage2: 'methalox', spacecraft: 'methalox' },
    custom: { stage1: 'hot', stage2: 'hydrolox', spacecraft: 'hydrolox' },
};
const craft = new THREE.Group();
craft.visible = false;
scene.add(craft);

let rocket = null;
const parts = new Map();     // name → { obj, min, max, plumes:[{anchor, plume}], nozzle, color, attached, igniteAt }
const debris = [];
const vis = {
    angle: Math.PI / 2,      // visual attitude (radians, world)
    omega: 0,
    alpha: 0,
    anchorX: -1,             // model-local x placed at the craft point
    pos: new THREE.Vector3(),
    prevPos: new THREE.Vector3(),
    vel: new THREE.Vector3(), // world units per real second
    length: 0.08,            // rendered rocket length (world units)
    throttle: 0,             // engine throttle shown this frame (0..1)
    shake: 0,                // camera-shake energy from ignition / staging (decays)
    scale: 0,                // current craft scale (0 = snap on the next frame)
};

// Engine light: glow sprites at the nozzles and a warm light that paints the
// stack (and the pad) from below while the engines burn.
const GLOW_COLORS = { hot: 0xffa24a, methalox: 0x9c8cff, hydrolox: 0x8fc8ff };
const engineLight = new THREE.PointLight(0xffa860, 0, 1, 0);
scene.add(engineLight);
const spent = [];            // detached stages already removed from the scene, freed on the next rebuild

// Sky colour while the craft is low in the atmosphere (screen-blended over the scene).
const skyTint = document.createElement('div');
skyTint.id = 'sky-tint';
Object.assign(skyTint.style, {
    position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '1',
    opacity: '0', mixBlendMode: 'screen',
});
canvas.after(skyTint);
let skyLast = -1;

function disposeObject(o) {
    o.traverse((c) => {
        c.geometry?.dispose();
        const m = c.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
    });
}

function buildCraft(id) {
    disposeCraft();
    rocket = buildRocket(id);
    craft.add(rocket.root);
    // Part extents are measured in model space: reset the craft transform first, or a
    // relaunch measures them through the last flight's position, scale and attitude
    // and every anchor (and so the ship's place on its orbit) comes out wrong.
    craft.position.set(0, 0, 0);
    craft.rotation.set(0, 0, 0);
    craft.scale.setScalar(1);
    craft.updateMatrixWorld(true);
    const colors = ENGINE_COLORS[id] || ENGINE_COLORS.custom;
    for (const name of ['stage1', 'stage2', 'spacecraft', 'escapeTower']) {
        const obj = rocket[name];
        if (!obj) continue;
        const box = new THREE.Box3().setFromObject(obj);
        const entry = {
            obj, min: box.min.x, max: box.max.x, plumes: [], attached: true, igniteAt: 0,
            nozzle: obj.userData.nozzleRadius || 0.02, color: colors[name] || 'hot',
        };
        for (const anchor of obj.userData.engines || []) {
            const plume = createPlume({ color: entry.color, radialSegments: UI.settings.hiQuality ? 20 : 12 });
            plume.object.rotation.z = Math.PI;      // flame runs along local -X (exhaust)
            anchor.add(plume.object);
            entry.plumes.push({ anchor, plume });
        }
        parts.set(name, entry);
    }
    vis.anchorX = stackExtent().min;
    vis.scale = 0;
    vis.angle = Math.PI / 2;
    vis.omega = 0;
    craft.visible = true;
}

function disposeCraft() {
    for (const d of debris) { scene.remove(d.obj); spent.push(d.obj); }
    debris.length = 0;
    for (const p of parts.values()) {
        for (const { plume } of p.plumes) plume.dispose();
        if (p.glow) { scene.remove(p.glow); p.glow.material.dispose(); }
    }
    parts.clear();
    if (rocket) {
        craft.remove(rocket.root);
        rocket.dispose();
        rocket = null;
    }
    // Separated stages left rocket.root, so rocket.dispose() never reached them.
    for (const o of spent) disposeObject(o);
    spent.length = 0;
    engineLight.intensity = 0;
    vis.shake = 0;
    craft.visible = false;
}

function stackExtent() {
    let min = Infinity, max = -Infinity;
    for (const p of parts.values()) {
        if (!p.attached) continue;
        min = Math.min(min, p.min);
        max = Math.max(max, p.max);
    }
    return { min, max };
}

const _wp = new THREE.Vector3();
const _wd = new THREE.Vector3();

/** Drop a stage: it keeps its world transform and drifts away under gravity. */
function separate(name, { push = 0.25, spin = 0.5, flash = 0.4, forward = false } = {}) {
    const p = parts.get(name);
    if (!p || !p.attached) return;
    p.attached = false;
    for (const { plume } of p.plumes) plume.set(0, 0, 0, 0);
    craft.updateMatrixWorld(true);
    scene.attach(p.obj);
    const nose = new THREE.Vector3(Math.cos(vis.angle), Math.sin(vis.angle), 0);
    const side = new THREE.Vector3(-nose.y, nose.x, 0).multiplyScalar((Math.random() - 0.5) * 0.4);
    const offV = nose.clone().multiplyScalar(forward ? push : -push).add(side).multiplyScalar(vis.length);
    debris.push({
        obj: p.obj, life: 0,
        sx: r.x, sy: r.y, vx: v.x, vy: v.y,
        off: p.obj.position.clone().sub(visualPos(r.x, r.y, new THREE.Vector3())),
        offV,
        spin: (Math.random() < 0.5 ? -1 : 1) * spin * (0.6 + Math.random() * 0.8),
        // Size and drift offset are kept relative to the camera distance, not the craft
        // scale: the craft rescales after staging and on reaching orbit, and spent
        // stages must not balloon with it.
        dist0: cam.dist,
        scale0: p.obj.scale.x / Math.max(cam.dist, 1e-6),
    });
    const box = new THREE.Box3().setFromObject(p.obj);
    box.getCenter(_wp);
    effects.sepFlash(_wp, vis.length * flash);
    // Cold-gas ullage puffs around the separation plane.
    if (UI.settings.rcsFx) {
        for (let k = 0; k < 6; k++) {
            const a = (k / 6) * TAU;
            _wd.set(Math.cos(a), Math.sin(a), 0);
            effects.emitRCS(_wp, _wd, { size: vis.length * 0.05, realDt: 0.05 });
        }
    }
    // The next stage lights after a short coast, like a real staging sequence.
    if (name !== 'escapeTower') {
        vis.shake = Math.min(1.6, vis.shake + 0.55);
        const next = name === 'stage1' && parts.get('stage2')?.attached ? parts.get('stage2') : parts.get('spacecraft');
        if (next) next.igniteAt = game.time + 0.45;
    }
}

/** Remove any launch hardware still attached (e.g. after undo into flight). */
function jettisonLaunchStages() {
    separate('stage1');
    separate('stage2');
    separate('escapeTower', { forward: true, push: 0.6 });
}

function lowestAttached() {
    for (const n of ['stage1', 'stage2', 'spacecraft']) {
        const p = parts.get(n);
        if (p && p.attached) return p;
    }
    return null;
}

function firingParts() {
    const out = [];
    const sls = game.cfg?.rocket === 'sls';
    if (game.mode === 'launching') {
        if (game.countdown > 0) {
            if (game.countdown < 0.7) {
                out.push(lowestAttached());
                if (sls && parts.get('stage2')?.attached) out.push(parts.get('stage2'));
            }
        } else if (L.ascent.phase === L.PHASE.ASCENT) {
            out.push(parts.get(L.ascent.stage) || lowestAttached());
            // SLS core stage burns alongside the boosters.
            if (sls && parts.get('stage1')?.attached && parts.get('stage2')?.attached) out.push(parts.get('stage2'));
        } else if (L.ascent.phase === L.PHASE.CIRC) {
            out.push(parts.get('spacecraft'));
        }
        return out.filter(Boolean);
    }
    if (thrustState.main > 0) out.push(parts.get('spacecraft'));
    return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Visual helpers

/** Craft render position. On the pad the rocket base sits on the surface; the
 *  offset fades out over the first part of the climb. */
function visualPos(x, y, out) {
    out.set(x, y, 0);
    if (game.mode !== 'launching') return out;
    const e = bodies.earth.pos;
    const dx = x - e.x, dy = y - e.y;
    const rm = Math.hypot(dx, dy);
    const visR = rm - PAD_ALT * padSquash(rm);
    out.set(e.x + (dx / rm) * visR, e.y + (dy / rm) * visR, 0);
    return out;
}

/** 1 on the pad, fading to 0 by 0.15 radii up: how much of PAD_ALT the visuals hide. */
function padSquash(rm) {
    return Math.min(Math.max(1 - (rm - (1 + PAD_ALT)) / 0.15, 0), 1);
}

/** Altitude above the visible ground during launch (the sim pad sits PAD_ALT up). */
function launchAltitude() {
    return Math.max(0, Math.hypot(r.x - bodies.earth.pos.x, r.y - bodies.earth.pos.y) - 1 - PAD_ALT);
}

function wrapAngle(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
}

const _fv = { x: 0, y: 0 };
function targetAttitude() {
    if (game.mode === 'launching') {
        if (game.countdown > 0) return Math.PI / 2;
        if (controls.guidance && (controls.guidance.x || controls.guidance.y)) {
            return Math.atan2(controls.guidance.y, controls.guidance.x);
        }
        if (Math.hypot(v.x, v.y) > 1e-4) return Math.atan2(v.y, v.x);
        return vis.angle;
    }
    if (thrustState.main > 0 && (thrustState.ax || thrustState.ay)) return Math.atan2(thrustState.ay, thrustState.ax);
    const fv = M.thrustFrameVelocity(_fv);
    if (Math.hypot(fv.x, fv.y) < 1e-6) return vis.angle;
    // Gentle weightless drift around prograde while coasting.
    return Math.atan2(fv.y, fv.x) + (UI.settings.reducedMotion ? 0 : 0.03 * Math.sin(game.time * 0.37));
}

function updateAttitude(dt) {
    const target = targetAttitude();
    if (UI.settings.reducedMotion) {
        vis.angle = target; vis.omega = 0; vis.alpha = 0;
        return;
    }
    const wn = game.mode === 'launching' ? 6 : 2.4;
    const err = wrapAngle(target - vis.angle);
    vis.alpha = wn * wn * err - 2 * wn * vis.omega;
    vis.omega += vis.alpha * dt;
    vis.angle = wrapAngle(vis.angle + vis.omega * dt);
}

/** How well the nose points along the thrust, 0..1 (the flame shows only when aligned). */
function thrustAlignment() {
    if (game.mode === 'launching') return 1;
    const t = targetAttitude();
    return Math.max(0, Math.cos(wrapAngle(t - vis.angle)) - 0.9) / 0.1;
}

// ---------------------------------------------------------------------------
// Camera: focus point, zoom and pan

const cam = {
    zoom: 1, zoomTarget: 1,   // user multiplier on the automatic distance
    dist: 3,
    pan: new THREE.Vector2(),
    focus: 'ship', prevFocus: 'ship', blend: 1,
    target: new THREE.Vector3(),
};
const _fp = new THREE.Vector3();

function focusPoint(name, out) {
    if (game.mode === 'landing') return out.set(bodies.earth.pos.x + 0.35, bodies.earth.pos.y + 0.55, 0);
    if (name === 'earth') return out.set(bodies.earth.pos.x, bodies.earth.pos.y, 0);
    if (name === 'moon') return out.set(bodies.moon.pos.x, bodies.moon.pos.y, 0);
    if (name === 'map') return out.set(bodies.sun.pos.x, bodies.sun.pos.y, 0);   // whole system, Sun-centred
    if (name === 'sun' || PLANETS[name]) {
        const b = bodies[name];
        if (b) return out.set(b.pos.x, b.pos.y, 0);
    }
    return out.copy(vis.pos);
}

function baseDistance() {
    if (game.mode === 'landing') return 3.4;
    if (game.mode === 'launching') {
        const alt = Math.max(0, Math.hypot(r.x - bodies.earth.pos.x, r.y - bodies.earth.pos.y) - 1);
        return Math.min(0.32 + 1.6 * alt, 5);
    }
    if (cam.focus === 'map') return mapDistance();
    if (cam.focus === 'sun') return 1500;
    if (PLANETS[cam.focus] && cam.focus !== 'earth') return Math.max(4, PLANETS[cam.focus].radius * 5);
    return cam.focus === 'earth' ? 7 : cam.focus === 'moon' ? 3.5 : 3;
}

/**
 * Camera distance that frames the whole inner solar system (out to Mars, or
 * further if the ship or the target is further out) inside the free canvas area.
 */
function mapDistance() {
    const sun = bodies.sun.pos;
    let R = PLANETS.mars.a * AU;
    const tgt = game.target && PLANETS[game.target];
    if (tgt) R = Math.max(R, tgt.a * AU);
    R = Math.max(R, Math.hypot(r.x - sun.x, r.y - sun.y)) * 1.12;
    const w = window.innerWidth, h = window.innerHeight;
    const sr = UI.getSafeViewRect?.() || { top: 0, bottom: h, left: 0, right: w };
    const fracH = Math.max(0.2, (sr.bottom - sr.top) / h);
    const fracW = Math.max(0.2, (sr.right - sr.left) / w) * camera.aspect;
    return R / (Math.tan((camera.fov * Math.PI) / 360) * Math.min(fracH, fracW));
}

let mapReturn = null;   // {focus, zoom} to restore when the map closes

function setFocus(name) {
    if (game.mode !== 'flight') return;
    if (name === 'map' && cam.focus === 'map') name = mapReturn?.focus || 'ship';   // M again: back out
    if (name === 'map') mapReturn = { focus: cam.focus, zoom: cam.zoomTarget };
    else if (cam.focus === 'map') {
        cam.zoomTarget = mapReturn && name === mapReturn.focus ? mapReturn.zoom : 1;
        mapReturn = null;
    }
    if (name === 'map') cam.zoomTarget = 1;
    if (name === cam.focus) { cam.pan.set(0, 0); return; }
    cam.prevFocus = cam.focus;
    cam.focus = name;
    cam.blend = 0;
    cam.pan.set(0, 0);
}

function updateCamera(dt) {
    cam.zoom += (cam.zoomTarget - cam.zoom) * (1 - Math.exp(-8 * dt));
    const want = baseDistance() * cam.zoom;
    cam.dist += (want - cam.dist) * (1 - Math.exp(-(game.mode === 'launching' ? 3 : 5) * dt));
    cam.blend = Math.min(1, cam.blend + dt / 0.9);
    const b = cam.blend * cam.blend * (3 - 2 * cam.blend);
    focusPoint(cam.focus, cam.target);
    if (b < 1) {
        focusPoint(cam.prevFocus, _fp);
        cam.target.lerp(_fp, 1 - b);
    }
    camera.position.set(cam.target.x + cam.pan.x, cam.target.y + cam.pan.y, cam.dist);
    // Rumble while the engines fight the thick lower air, plus kicks at liftoff and staging.
    vis.shake *= Math.exp(-2.4 * dt);
    if (!UI.settings.reducedMotion && game.mode === 'launching') {
        const alt = launchAltitude();
        const rumble = vis.throttle * Math.max(0, 1 - alt / 0.008) * 0.3;
        const amp = cam.dist * 0.005 * (vis.shake + rumble);
        if (amp > 0) {
            const t = game.time;
            camera.position.x += amp * (Math.sin(t * 37.1) + 0.6 * Math.sin(t * 61.7 + 1.3)) / 1.6;
            camera.position.y += amp * (Math.sin(t * 43.3 + 2.1) + 0.6 * Math.sin(t * 71.9 + 0.4)) / 1.6;
        }
    }
    const near = Math.max(0.0005, cam.dist * 0.005);
    const far = 700 + cam.dist * 20 + (cam.dist > 200 ? 40000 : 0);
    if (camera.near !== near || camera.far !== far) {
        camera.near = near; camera.far = far;
        camera.updateProjectionMatrix();
    }
    for (const s of starLayers) s.position.copy(camera.position);
}

/** Blue sky wash near the ground, oriented along the local vertical. */
function updateSky() {
    let o = 0;
    let deg = 0;
    if (game.mode === 'launching' && rocket) {
        const dx = r.x - bodies.earth.pos.x, dy = r.y - bodies.earth.pos.y;
        const alt = launchAltitude();
        const thin = Math.min(Math.max(1 - alt / 0.025, 0), 1);
        const close = Math.min(Math.max((1.6 - cam.dist) / 0.8, 0), 1);
        o = thin ** 1.4 * close;
        deg = Math.round(90 - (Math.atan2(dy, dx) * 180) / Math.PI);
    }
    const key = o < 0.002 ? 0 : Math.round(o * 200) / 200 + deg * 1000;
    if (key === skyLast) return;
    skyLast = key;
    skyTint.style.opacity = o < 0.002 ? '0' : o.toFixed(3);
    if (o >= 0.002) {
        skyTint.style.background = `linear-gradient(${deg}deg, rgba(150,205,255,0.8) 0%, rgba(80,145,230,0.58) 30%, `
            + 'rgba(30,75,160,0.3) 65%, rgba(0,0,0,0) 100%)';
    }
}

function worldPerPixel() {
    return (2 * cam.dist * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, window.innerHeight);
}

// Pointer input on the canvas: drag to pan, wheel / pinch to zoom, tap to focus.
const pointers = new Map();
let drag = null;
let pinch = null;
const MAX_CAM_DIST = 30000;   // far enough to frame the Sun and all planets
function clampZoom(z) {
    const base = Math.max(0.01, baseDistance());
    return Math.min(Math.max(z, 0.15), Math.max(14, MAX_CAM_DIST / base));
}
canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false };
    if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoomTarget };
        drag = null;
    }
});
canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0 && pinch.d > 0) cam.zoomTarget = clampZoom(pinch.zoom * (pinch.d / d));
        return;
    }
    if (drag && game.mode === 'flight') {
        if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.moved = true;
        if (drag.moved) {
            const k = worldPerPixel();
            cam.pan.x -= dx * k;
            cam.pan.y += dy * k;
        }
    }
});
function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pinch && pointers.size < 2) {
        pinch = null;
        // The finger left on the screen keeps panning without a re-touch.
        const rest = pointers.values().next().value;
        if (rest) drag = { x: rest.x, y: rest.y, moved: true };
    }
    if (drag && !drag.moved && e.type === 'pointerup' && game.mode === 'flight') pick(e.clientX, e.clientY);
    if (pointers.size === 0) drag = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (game.mode === 'landing') return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    cam.zoomTarget = clampZoom(cam.zoomTarget * Math.exp(dy * 0.0015));
}, { passive: false });

const raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
function pick(x, y) {
    const s = toScreen(vis.pos);
    if (s && Math.hypot(s.x - x, s.y - y) < 36) { setFocus('ship'); return; }
    _ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(_ndc, camera);
    const hit = raycaster.intersectObjects([earth, moon, ...Object.values(solar.meshes)], false)[0];
    if (hit) {
        const o = hit.object;
        const nm = o === moon ? 'moon' : o === earth ? 'earth' : Object.keys(solar.meshes).find((k) => solar.meshes[k] === o);
        if (nm) setFocus(nm);
    }
}

const _proj = new THREE.Vector3();
function toScreen(p) {
    _proj.set(p.x, p.y, p.z || 0).project(camera);
    if (_proj.z > 1) return null;
    return { x: (_proj.x + 1) * 0.5 * window.innerWidth, y: (1 - _proj.y) * 0.5 * window.innerHeight };
}

// ---------------------------------------------------------------------------
// Mission flow

function applyConfig(cfg) {
    rocketParams.Isp = cfg.Isp;
    rocketParams.thrust = cfg.thrust;
    rocketParams.dryMass = cfg.dryMass;
    rocketParams.fuelMass = cfg.fuelMass;
    M.setGravity(cfg.G);
    params.simRate = cfg.simRate;
    params.moonMass = cfg.moonMass;
    bodies.moon.m = cfg.moonMass;
    params.lookahead = cfg.lookahead;
}

function resetFlightState() {
    AP.cancel();
    circ.cancel();
    L.abortAscent();
    M.stopAllControls();
    UI.releaseAll();
    cancelScheduled();
    UI.hideCrash();
    UI.setCountdown('');
    effects.clear();
    trajectory.clear();
    burnZones.clear();
    burnAssist.reset();
    coach.reset();
    if (game.hohmann) { HOH.hide(); game.hohmann = false; }
    Object.assign(game, {
        orbited: false, targetChosen: false,
        warp: 1, lastWarp: 1, acc: 0, crashed: false, manualOn: false, noFuelWarned: false,
        apWasActive: false, apPhase: '', countdown: 0, liftoffShown: 0,
    });
    controls.throttle = 1;
    UI.setThrottleUI(1);
}

function launch(cfg) {
    resetFlightState();
    game.cfg = cfg;
    applyConfig(cfg);
    M.moonState.angle = Math.PI / 3;
    M.setOnPad(PAD_ALT);
    game.mode = 'launching';
    buildCraft(cfg.rocket);
    game.countdown = UI.settings.reducedMotion ? 1 : 3.2;
    UI.setMode('launching');
    cam.focus = 'ship'; cam.prevFocus = 'ship'; cam.blend = 1;
    cam.zoom = cam.zoomTarget = 1;
    cam.pan.set(0, 0);
    visualPos(r.x, r.y, vis.pos);
    vis.prevPos.copy(vis.pos);
    cam.dist = baseDistance() * 2.2;
}

function restart() {
    resetFlightState();
    disposeCraft();
    game.mode = 'landing';
    UI.setMode('landing');
    cam.focus = 'ship'; cam.prevFocus = 'ship'; cam.blend = 1;
    cam.pan.set(0, 0);
    cam.zoom = cam.zoomTarget = 1;
}

function enterFlight() {
    game.mode = 'flight';
    UI.setMode('flight');
    UI.releaseAll();
    jettisonLaunchStages();
    M.clearHistory();
    game.acc = 0;
}

function onLaunchEvent(ev) {
    if (ev.startsWith('stage:')) {
        const name = ev.slice(6);
        separate(name, { flash: 0.45 });
        UI.toast(name === 'stage1' && game.cfg?.rocket === 'sls' ? 'BOOSTER SEPARATION' : 'STAGING', 'info');
        if (parts.get('escapeTower')?.attached) {
            schedule(1.2, () => separate('escapeTower', { forward: true, push: 0.7, flash: 0.2 }), 'tower');
        }
    } else if (ev === 'meco') {
        UI.toast('MECO · STAGE SEPARATION', 'info');
        for (const name of L.ascent.mecoDrop) separate(name, { flash: 0.5, push: 0.3 });
        if (parts.get('escapeTower')?.attached) separate('escapeTower', { forward: true, push: 0.7, flash: 0.2 });
    } else if (ev === 'circ') {
        UI.toast('CIRCULARIZATION BURN', 'info');
    } else if (ev === 'orbit') {
        UI.toast('ORBIT ACHIEVED', 'ok', 3200);
        enterFlight();
    }
}

function onCrash() {
    if (game.crashed) return;
    game.crashed = true;
    AP.cancel();
    circ.cancel();
    L.abortAscent();
    M.stopAllControls();
    UI.releaseAll();
    effects.explosion(vis.pos.clone(), Math.max(vis.length * 0.9, 0.04));
    craft.visible = false;
    const cb = String(crashState.body || 'earth');
    const body = cb.charAt(0).toUpperCase() + cb.slice(1);
    const detail = `Impact on the ${body} at ${fmtSpeed(crashState.speed)} · ${fmtMET(M.sim.time)}`;
    schedule(1.3, () => UI.showCrash(crashState.message, detail), 'crash');
}

function undo() {
    if (game.mode === 'landing') return;
    if (!M.undo()) { UI.toast('NOTHING TO UNDO', 'warn'); return; }
    cancelScheduled('crash');
    UI.hideCrash();
    AP.cancel();
    circ.cancel();
    M.stopAllControls();
    UI.releaseAll();
    game.crashed = false;
    game.acc = 0;
    craft.visible = !!rocket;
    if (game.mode === 'launching') {
        L.abortAscent();
        enterFlight();
    }
    trajectory.clear();
    UI.toast(`REWOUND TO ${fmtMET(M.sim.time)}`, 'info');
}

let warpBurn = null;   // {until: sim time} while warping to the next burn window
function setWarp(w, auto = false) {
    if (game.mode !== 'flight') return;
    if (!auto) warpBurn = null;
    game.warp = w;
    if (w > 0) game.lastWarp = w;
}
function warpStep(d) {
    const i = WARPS.indexOf(game.warp);
    setWarp(WARPS[Math.min(WARPS.length - 1, Math.max(1, (i < 0 ? 2 : i) + d))]);
}

function warpToBurn() {
    if (game.mode !== 'flight' || game.crashed) return;
    const nw = burnZones.nextWindow();
    if (!nw || !Number.isFinite(nw.timeTo) || nw.timeTo <= 0) { UI.toast('NO BURN WINDOW AHEAD', 'warn'); return; }
    warpBurn = { until: M.sim.time + nw.timeTo };
    UI.toast(`WARPING TO ${String(nw.label || 'BURN').toUpperCase()}`, 'info');
}
function updateWarpToBurn() {
    if (!warpBurn) return;
    if (game.mode !== 'flight' || game.crashed || UI.anyHeld()) { warpBurn = null; return; }
    // Fresh estimate every frame (the throttled prediction pass lags by up to
    // 0.12 s, which at 1000x is ~60 time units): it sharpens as the window nears.
    burnZones.update();
    const nw = burnZones.nextWindow();
    if (nw && Number.isFinite(nw.timeTo)) warpBurn.until = M.sim.time + nw.timeTo;
    const left = warpBurn.until - M.sim.time;
    if (left <= 0 || burnZones.zoneInfo()?.kind) { warpBurn = null; setWarp(1, true); UI.toast('BURN WINDOW', 'ok'); return; }
    let best = 1;
    for (const w of WARPS) if (w >= 1 && (w * params.simRate) / 30 <= left) best = w;
    if (best !== game.warp) { game.warp = best; game.lastWarp = best; }
}

function engageAutopilot(mode, opts) {
    if (game.mode !== 'flight' || game.crashed) return;
    if (mode === 'transfer') { UI.toast('INTERPLANETARY AUTOPILOT: COMING SOON', 'info'); return; }
    circ.cancel();
    if (AP.isActive()) AP.cancel();
    const res = AP.engage(mode, r, v, { lunarR: opts.lunarR, earthR: game.cfg?.orbitRadius ?? 2 });
    if (!res.success) { UI.toast(res.reason || 'AUTOPILOT UNAVAILABLE', 'warn'); return; }
    const label = { moon: 'LUNAR TRANSFER', earth: 'RETURN TO EARTH' }[mode] || 'CIRCULARIZE';
    UI.toast(`AUTOPILOT: ${label}`, 'ok');
}

function toggleAltHold() {
    if (game.mode !== 'flight' || game.crashed) return;
    if (AP.isHolding()) { AP.cancel(); UI.toast('ALT HOLD OFF', 'info'); return; }
    circ.cancel();
    if (AP.isActive()) AP.cancel();
    AP.engageHold();
    UI.toast('ALT HOLD ON', 'ok');
}

function toggleCircularize() {
    if (game.mode !== 'flight' || game.crashed) return;
    if (circ.active) { circ.cancel(); UI.toast('CIRCULARIZE CANCELLED', 'info'); return; }
    if (rocketParams.fuelMass <= 0) { UI.toast('NO FUEL', 'warn'); return; }
    if (AP.isActive()) AP.cancel();
    circ.start(r, v);
    UI.toast(`CIRCULARIZING · ${fmtSpeed(circ.targetDv)}`, 'ok');
}

UI.initUI({
    getMode: () => game.mode,
    launch,
    restart,
    undo,
    warp: (w) => setWarp(w),
    warpStep,
    togglePause: () => setWarp(game.warp > 0 ? 0 : game.lastWarp || 1),
    focus: (n) => { warpBurn = warpBurn && n ? warpBurn : null; setFocus(n); },
    autopilot: engageAutopilot,
    cancelAutopilot: () => {
        warpBurn = null;
        if (AP.isActive()) { AP.cancel(); UI.toast('AUTOPILOT DISENGAGED', 'info'); }
        if (circ.active) circ.cancel();
    },
    altHold: toggleAltHold,
    circularize: toggleCircularize,
    togglePredict: () => UI.setSetting('predict', !UI.settings.predict),
    toggleHohmann: () => { game.hohmann = !game.hohmann; if (game.hohmann) HOH.show(); else HOH.hide(); },
    throttle: (t) => { controls.throttle = Math.min(1, Math.max(0, t)); UI.setThrottleUI(controls.throttle); },
    throttleStep: (d) => {
        controls.throttle = Math.min(1, Math.max(0, Math.round((controls.throttle + d) * 10) / 10));
        UI.setThrottleUI(controls.throttle);
    },
    settingsChanged: () => { applyQuality(); syncSettings(); },
    setTarget: (name) => { game.target = name; game.targetChosen = true; burnZones.setTarget(name); burnAssist.reset(); },
    warpToBurn,
});
function syncSettings() {
    burnZones.setDifficulty(UI.settings.easy ? 'easy' : 'real');
    if (UI.settings.coach) coach.show?.(); else coach.hide();
    solar.setOrbitsVisible(true);
}
syncSettings();
applyQuality();
UI.setMode('landing');

splash.done.then(() => {
    const logo = document.getElementById('landing-logo');
    if (logo) animateLogo(logo);
});

// ---------------------------------------------------------------------------
// Simulation stepping

function stepLaunch(realDt) {
    if (game.countdown > 0) {
        const before = game.countdown;
        game.countdown = Math.max(0, game.countdown - realDt);
        if (game.countdown > 0) UI.setCountdown(String(Math.min(Math.ceil(game.countdown), 3)));
        if (before > 0 && game.countdown === 0) {
            UI.setCountdown('LIFTOFF', true);
            game.liftoffShown = game.time;
            vis.shake = Math.min(1.6, vis.shake + 1);
            L.startAscent(game.cfg.orbitRadius, game.cfg.rocket);
            game.acc = 0;
        }
        return;
    }
    if (game.liftoffShown && game.time - game.liftoffShown > 1.4) {
        UI.setCountdown('');
        game.liftoffShown = 0;
    }
    if (!L.isFlying()) return;
    const dt = params.dt;
    game.acc += realDt * L.timeRate();
    let n = 0;
    while (game.acc >= dt && n < MAX_STEPS_PER_FRAME) {
        const h = M.stepSize();
        const ev = L.updateAscent(h);
        if (M.step(h)) { onCrash(); return; }
        game.acc -= h;
        n++;
        if (ev) {
            onLaunchEvent(ev);
            if (ev === 'orbit') return;
            game.acc = Math.min(game.acc, dt);   // new phase, new pacing
        }
    }
    if (n >= MAX_STEPS_PER_FRAME) game.acc = 0;
}

function stepFlight(realDt) {
    if (game.crashed) return;
    const held = UI.held;
    const manual = UI.anyHeld() && game.warp > 0;   // input while paused does nothing
    if (manual) {
        if (AP.isActive()) { AP.cancel(); UI.toast('AUTOPILOT DISENGAGED', 'info'); }
        if (circ.active) circ.cancel();
        controls.automated = false;
        controls.prograding = held.prograde;
        controls.retrograding = held.retrograde;
        controls.normalPos = held.normalPos;
        controls.normalNeg = held.normalNeg;
        game.manualOn = true;
        if (rocketParams.fuelMass <= 0 && !game.noFuelWarned) { UI.toast('NO FUEL', 'danger'); game.noFuelWarned = true; }
    } else if (game.manualOn) {
        controls.prograding = controls.retrograding = controls.normalPos = controls.normalNeg = false;
        game.manualOn = false;
    }
    if (rocketParams.fuelMass > 0) game.noFuelWarned = false;

    const warp = manual ? Math.min(game.warp, 1) : game.warp;
    const dt = params.dt;
    game.acc += realDt * params.simRate * warp;
    // Warping to a burn: never step past the window, however long the frame was.
    if (warpBurn) game.acc = Math.min(game.acc, Math.max(warpBurn.until - M.sim.time, dt));
    let n = 0;
    while (game.acc >= dt && n < MAX_STEPS_PER_FRAME) {
        const h = M.stepSize();
        if (AP.isActive()) AP.update(h, r, v, bodies.moon.pos);
        if (circ.active) {
            const s = circ.update(r, v);
            if (s.completed) UI.toast('ORBIT CIRCULARIZED', 'ok');
            else if (s.fuelExhausted) UI.toast('OUT OF FUEL', 'danger');
        }
        if (M.step(h)) { onCrash(); break; }
        game.acc -= h;
        n++;
    }
    if (n >= MAX_STEPS_PER_FRAME) game.acc = 0;

    // Autopilot feedback.
    const active = AP.isActive();
    const phase = AP.getPhase();
    const announce = [AP.PHASES.TLI_BURN, AP.PHASES.CAPTURE, AP.PHASES.HOLD, AP.PHASES.ORBIT_ACHIEVED, AP.PHASES.RTE_COAST];
    if (active && phase !== game.apPhase && announce.includes(phase) && !(phase === AP.PHASES.HOLD && game.apPhase === '')) {
        UI.toast(AP.getTelemetry().phaseText.toUpperCase(), 'info');
    }
    if (game.apWasActive && !active && !game.crashed) {
        const reason = AP.getAbortReason();
        UI.toast(reason ? `AUTOPILOT ABORT: ${reason}` : 'AUTOPILOT COMPLETE', reason ? 'warn' : 'ok', 3400);
    }
    game.apWasActive = active;
    game.apPhase = active ? phase : '';
}

const _g = { ax: 0, ay: 0 };
function updateDebris(realDt, simDt) {
    for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i];
        d.life += realDt;
        // Ballistic motion in the simulation frame (coarse sub-steps are fine for a few seconds).
        let left = simDt;
        let hitEarth = false;
        while (left > 0) {
            const h = Math.min(left, 0.01);
            M.gravityAt(d.sx, d.sy, bodies.moon.pos.x, bodies.moon.pos.y, _g);
            d.vx += _g.ax * h; d.vy += _g.ay * h;
            d.sx += d.vx * h; d.sy += d.vy * h;
            left -= h;
            if (Math.hypot(d.sx - bodies.earth.pos.x, d.sy - bodies.earth.pos.y) < 1) { hitEarth = true; break; }
        }
        d.off.addScaledVector(d.offV, realDt);
        d.offV.multiplyScalar(Math.exp(-0.25 * realDt));
        visualPos(d.sx, d.sy, d.obj.position).addScaledVector(d.off, cam.dist / d.dist0);
        d.obj.rotation.z += d.spin * realDt;
        const fade = d.life < 7 ? 1 : Math.max(0, 1 - (d.life - 7) / 1.5);
        d.obj.scale.setScalar(cam.dist * d.scale0 * fade);
        if (hitEarth || fade <= 0) {
            scene.remove(d.obj);
            spent.push(d.obj);
            debris.splice(i, 1);
        }
    }
}

// ---------------------------------------------------------------------------
// Rocket rendering, plumes and particles

const _exh = new THREE.Vector3();
const _inherit = new THREE.Vector3();
const _lightPos = new THREE.Vector3();
const _vapV = new THREE.Vector3();

function updateCraftVisual(realDt) {
    if (!rocket) return;
    visualPos(r.x, r.y, vis.pos);
    if (realDt > 0) {
        vis.vel.subVectors(vis.pos, vis.prevPos).divideScalar(realDt);
        if (vis.vel.length() > cam.dist * 4) vis.vel.setLength(cam.dist * 4);   // warp: don't smear particles
    }
    vis.prevPos.copy(vis.pos);
    updateAttitude(realDt);

    const launching = game.mode === 'launching';
    vis.length = launching
        ? Math.min(Math.max(0.24 * cam.dist, 0.03), 0.6)
        : Math.max(
            Math.min(Math.max((camera.aspect < 1 ? 0.11 : 0.07) * cam.dist, 0.02), 0.45),   // portrait screens see less width
            18 * worldPerPixel());   // zoomed far out the 0.45 cap shrank the ship to a few pixels: keep it an icon
    // On the way up the whole stack spans vis.length; in flight whatever is left
    // (often just the upper stage) is scaled up to it, easing over a second or two.
    const ext = stackExtent();
    const span = Number.isFinite(ext.max - ext.min) ? Math.max(ext.max - ext.min, 0.2) : 2;
    const wantScale = launching ? vis.length / 2 : vis.length / span;
    vis.scale = vis.scale > 0 && Number.isFinite(vis.scale) ? vis.scale + (wantScale - vis.scale) * (1 - Math.exp(-2 * realDt)) : wantScale;
    craft.scale.setScalar(vis.scale);
    craft.position.copy(vis.pos);
    craft.rotation.set(0, 0, vis.angle);

    // Reference point: the stack base on the pad, sliding up the stack as it climbs
    // (so the flame trail gets screen room), the centre in orbit.
    const alt = launching ? launchAltitude() : Math.hypot(r.x - bodies.earth.pos.x, r.y - bodies.earth.pos.y) - 1;
    const climb = Math.min(Math.max((alt - 0.0005) / 0.01, 0), 1);
    const anchorTarget = launching
        ? ext.min + (ext.max - ext.min) * 0.3 * climb * climb * (3 - 2 * climb)
        : (ext.min + ext.max) / 2;
    // With every part dropped the extent is ±Infinity and the target NaN; a NaN
    // anchor would stick forever and move the model off to nowhere.
    if (Number.isFinite(anchorTarget)) {
        vis.anchorX = Number.isFinite(vis.anchorX) ? vis.anchorX : anchorTarget;
        vis.anchorX += (anchorTarget - vis.anchorX) * (1 - Math.exp(-(launching ? 1.5 : 4) * realDt));
    }
    rocket.root.position.x = -vis.anchorX;
    if (!craft.visible) {
        engineLight.intensity = 0; vis.throttle = 0;
        for (const p of parts.values()) if (p.glow) p.glow.visible = false;
        return;
    }

    // Engines.
    const firing = new Set(firingParts());
    _exh.set(-Math.cos(vis.angle), -Math.sin(vis.angle), 0);
    _inherit.copy(vis.vel).multiplyScalar(0.6);
    let throttle = 0;
    if (launching) {
        if (game.countdown > 0) throttle = Math.max(0, Math.min(1, (0.7 - game.countdown) / 0.7)) * 0.8;
        else if (controls.guidance) {
            const a = Math.hypot(controls.guidance.x, controls.guidance.y);
            const ref = L.ascent.phase === L.PHASE.CIRC ? L.ascent.circAccel : Math.max(1e-9, (L.ascent.accelG || 2) * params.G);
            throttle = Math.min(1, Math.max(0.25, a / ref));
        }
    } else {
        throttle = thrustState.main * thrustAlignment();
    }
    vis.throttle = throttle;
    // Ambient pressure falls off fast: plumes balloon out within ~80 km.
    const expand = launching ? Math.min(Math.max(alt / 0.012, 0), 1) : -1;
    const stage1 = parts.get('stage1');

    // Pre-ignition: water-deluge steam rolls off the pad during the last seconds of the count.
    if (launching && game.countdown > 0 && game.countdown < 2.4) {
        const a = lowestAttached()?.plumes[0]?.anchor;
        if (a) {
            a.getWorldPosition(_wp);
            const ramp = Math.min(1, (2.4 - game.countdown) / 1.2);
            for (const sgn of [-1, 1]) {
                _wd.set(-_exh.y * sgn, _exh.x * sgn, 0).addScaledVector(_exh, 0.15).normalize();
                effects.emitSmoke(_wp, _wd, { intensity: 0.28 * ramp, size: vis.length * 0.2, realDt });
            }
        }
    }

    let lightW = 0;
    _lightPos.set(0, 0, 0);
    for (const p of parts.values()) {
        const lit = firing.has(p) && game.time >= p.igniteAt;
        if (lit && !p.wasLit) p.litAt = game.time;
        p.wasLit = lit;
        // Spool up fast, tail off slower (a cut-off engine doesn't vanish in one frame).
        const want = lit ? throttle : 0;
        const cur = p.thr || 0;
        p.thr = cur + (want - cur) * (1 - Math.exp(-realDt / (want > cur ? 0.1 : 0.3)));
        if (!lit && p.thr < 0.01) p.thr = 0;
        const len = p === stage1 ? 0.65 : 0.4;
        let emitted = 0;
        let gx = 0, gy = 0, gz = 0, gn = 0;
        p.plumes.forEach(({ anchor, plume }, j) => {
            // Engines light in a quick ripple rather than all in the same frame.
            const ripple = lit ? Math.min(1, Math.max(0, (game.time - p.litAt - j * 0.045) / 0.12)) : 1;
            const inten = p.thr * ripple;
            plume.set(inten, len, p.nozzle * 0.95, game.time, p.color, expand);
            if (inten <= 0.05) return;
            anchor.getWorldPosition(_wp);
            gx += _wp.x; gy += _wp.y; gz += _wp.z; gn++;
            if (p.attached && emitted < 3) {
                effects.emitExhaust(_wp, _exh, {
                    intensity: inten, size: p.nozzle * craft.scale.x * 3 * (1 + 0.8 * Math.max(expand, 0)), realDt,
                    inheritVel: _inherit, color: p.color,
                });
                if (launching && alt < 0.03) {
                    // Pad smoke billows sideways along the ground.
                    _wd.set(-_exh.y, _exh.x, 0).multiplyScalar(emitted % 2 ? 1 : -1).addScaledVector(_exh, 0.3).normalize();
                    effects.emitSmoke(_wp, _wd, { intensity: inten * (1 - alt / 0.03), size: vis.length * 0.25, realDt });
                }
                emitted++;
            }
        });
        // Nozzle glow at the centre of the lit engines.
        if (gn > 0) {
            if (!p.glow) {
                p.glow = makeGlow(GLOW_COLORS[p.color] || GLOW_COLORS.hot, 1);
                p.glow.renderOrder = 8;
                p.glow.material.depthTest = false;
                scene.add(p.glow);
            }
            const t = game.time;
            const flick = 1 + 0.07 * Math.sin(t * 41) + 0.05 * Math.sin(t * 67 + 1.7);
            const sz = vis.length * (0.28 + 0.12 * Math.sqrt(gn)) * Math.min(1, p.thr * 1.4) * flick * (1 + 0.6 * Math.max(expand, 0));
            p.glow.position.set(gx / gn, gy / gn, gz / gn).addScaledVector(_exh, vis.length * 0.04);
            p.glow.scale.set(sz, sz, 1);
            p.glow.material.opacity = Math.min(1, p.thr) * (launching ? 0.85 : 0.6);
            p.glow.visible = true;
            if (p.attached) {
                _lightPos.addScaledVector(p.glow.position, p.thr);
                lightW += p.thr;
            }
        } else if (p.glow) {
            p.glow.visible = false;
        }
    }
    if (lightW > 0) {
        engineLight.position.copy(_lightPos.divideScalar(lightW)).addScaledVector(_exh, vis.length * 0.12);
        engineLight.position.z += vis.length * 0.15;
        engineLight.distance = vis.length * (launching ? 0.9 + 0.7 * (1 - climb) : 0.9);   // reaches the pad, not the planet below
        engineLight.intensity = (launching ? 2.6 : 1.4) * Math.min(1, lightW) * (1 + 0.08 * Math.sin(game.time * 53));
    } else {
        engineLight.intensity = 0;
    }

    // Condensation collar through the dense, transonic part of the climb (stretched
    // past the real ~10-20 km band so it reads at the compressed launch pace).
    if (launching && L.ascent.phase === L.PHASE.ASCENT && alt > 0.001 && alt < 0.008 && throttle > 0) {
        const q = Math.sin((Math.PI * (alt - 0.001)) / 0.007);
        const nx = Math.cos(vis.angle), ny = Math.sin(vis.angle);
        const at = (ext.min + (ext.max - ext.min) * 0.62 - vis.anchorX) * craft.scale.x;
        _vapV.copy(vis.vel).multiplyScalar(0.85);
        for (const sgn of [-1, 1]) {
            if (Math.random() > q) continue;
            _wp.set(vis.pos.x + nx * at - ny * sgn * vis.length * 0.035, vis.pos.y + ny * at + nx * sgn * vis.length * 0.035, vis.pos.z);
            _wd.set(-ny * sgn * 0.55 - nx * 0.85, nx * sgn * 0.55 - ny * 0.85, 0).normalize();
            effects.emitRCS(_wp, _wd, { size: vis.length * 0.05, realDt, inheritVel: _vapV });
        }
    }

    // Cold-gas RCS puffs: attitude changes and normal (sideways) burns.
    const sc = parts.get('spacecraft');
    const rcsAnchors = rocket.spacecraft.userData.rcs;
    if (UI.settings.rcsFx && sc?.attached && !launching && rcsAnchors) {
        const turning = Math.abs(vis.alpha) > 0.25;
        let gx = 0, gy = 0;    // direction the gas must leave for a normal burn
        if (thrustState.rcs > 0) {
            const fv = M.thrustFrameVelocity(_fv);
            const s = Math.hypot(fv.x, fv.y) || 1;
            const sign = controls.normalPos ? 1 : controls.normalNeg ? -1 : 0;
            gx = (fv.y / s) * sign; gy = (-fv.x / s) * sign;     // opposite to the +normal push
        }
        for (const a of rcsAnchors) {
            const dy = a.userData.dir?.y ?? 1;
            _wd.set(-Math.sin(vis.angle) * dy, Math.cos(vis.angle) * dy, 0);   // anchor gas direction in world
            let fire = turning && Math.sign(dy) === -Math.sign(vis.alpha);
            if ((gx || gy) && _wd.x * gx + _wd.y * gy > 0.5) fire = true;
            if (fire) {
                a.getWorldPosition(_wp);
                effects.emitRCS(_wp, _wd, { size: vis.length * 0.06, realDt, inheritVel: _inherit });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// HUD telemetry

let hudTimer = 0;
let viewTimer = 0;
let predTimer = 0;
let impact = null;
const labels = [];

function telemetry() {
    const dom = M.dominantBody(r);
    const rx = r.x - dom.pos.x, ry = r.y - dom.pos.y;
    const vx = v.x - dom.vel.x, vy = v.y - dom.vel.y;
    const el = orbitalElements(rx, ry, vx, vy, dom.mu);
    const rad = dom.radius;
    const fuelMax = game.cfg?.fuelMass || 1;
    const twrLocal = M.maxAcceleration() / (dom.mu / (el.r * el.r));
    const moonDist = Math.hypot(r.x - bodies.moon.pos.x, r.y - bodies.moon.pos.y) - M.MOON_RADIUS;

    let status = { text: 'NOMINAL', level: 'ok' };
    if (game.crashed) status = { text: 'SIGNAL LOST', level: 'danger' };
    else if (game.mode === 'launching') {
        const ph = game.countdown > 0 ? 'COUNTDOWN'
            : ({ ASCENT: 'ASCENT', COAST: 'COAST TO AP', CIRC: 'CIRC BURN', DONE: 'ORBIT' }[L.ascent.phase] || 'PAD');
        status = { text: ph, level: 'ok' };
    } else if (impact) status = { text: `IMPACT · ${impact.toUpperCase()}`, level: 'danger' };
    else if (rocketParams.fuelMass <= 0) status = { text: 'NO FUEL', level: 'warn' };
    else if (rocketParams.fuelMass < 0.1 * fuelMax) status = { text: 'LOW FUEL', level: 'warn' };
    else if (game.warp === 0) status = { text: 'PAUSED', level: 'warn' };
    else if (AP.isActive() || circ.active) status = { text: 'AUTOPILOT', level: 'ok' };

    let autopilot = '';
    if (AP.isActive()) {
        const t = AP.getTelemetry();
        autopilot = t.phaseText;
        if (t.remainingDv > 1e-4) autopilot += ` · ${fmtSpeed(t.remainingDv)}`;
        if (t.etaSeconds > 0) autopilot += ` · ETA ${fmtDuration(t.etaSeconds)}`;
    } else if (circ.active) {
        autopilot = `Circularizing · ${fmtSpeed(circ.remainingDv)}`;
    }

    return {
        met: fmtMET(M.sim.time),
        status,
        soi: `${dom.name.toUpperCase()} SOI`,
        alt: fmtDistance(Math.max(0, el.r - rad - (game.mode === 'launching' && dom.name === 'earth' ? PAD_ALT * padSquash(el.r) : 0))),
        vel: fmtSpeed(el.speed),
        ap: el.bound ? fmtDistance(el.ra - rad) : 'ESCAPE',
        pe: el.rp < rad ? 'SUBORBITAL' : fmtDistance(el.rp - rad),
        tap: el.bound && Number.isFinite(el.timeToAp) ? fmtDuration(el.timeToAp) : '—',
        tpe: Number.isFinite(el.timeToPe) ? fmtDuration(el.timeToPe) : '—',
        ecc: el.e.toFixed(3),
        period: el.bound ? fmtDuration(el.period) : '—',
        moonDist: fmtDistance(moonDist),
        body: dom.name.toUpperCase(),
        autopilot,
        fuelFrac: Math.min(1, Math.max(0, rocketParams.fuelMass / fuelMax)),
        fuel: `${rocketParams.fuelMass.toFixed(2)} t`,
        dv: fmtSpeed(M.deltaVRemaining()),
        twr: twrLocal.toFixed(2),
    };
}

function burnText() {
    if (game.mode !== 'flight' || game.crashed) return '';
    if (UI.anyHeld()) {
        if (rocketParams.fuelMass <= 0) return 'NO FUEL';
        const pct = Math.round(controls.throttle * 100);
        return `MANUAL BURN · ${pct}%${game.warp > 1 ? ' · WARP LIMITED 1×' : ''}`;
    }
    if (circ.active) return 'CIRCULARIZING';
    if (AP.isActive() && M.isBurning()) return `AUTOPILOT BURN · ${AP.getBurnType() || AP.getPhase()}`;
    if (!AP.isActive() && UI.settings.predict) return burnZones.inZone();
    return '';
}

const MARKER_KIND = {
    ap: 'ap', pe: 'pe', impact: 'impact', 'soi-in': 'soi', 'soi-out': 'soi',
    'burn-ap': 'burn', 'burn-pe': 'burnretro', 'burn-tli': 'tli', 'burn-planet': 'tli',
};
function updateLabels(showPred) {
    labels.length = 0;
    const W = window.innerWidth, H = window.innerHeight;
    if (showPred) {
        const zoneMarkers = game.mode === 'flight' ? burnZones.getMarkers() : [];
        for (const m of [...trajectory.getMarkers(), ...zoneMarkers]) {
            const s = toScreen({ x: m.x, y: m.y });
            if (!s || s.x < -50 || s.y < -20 || s.x > W + 50 || s.y > H + 20) continue;
            const kind = MARKER_KIND[m.id] || 'soi';
            // Burn-zone notes sit under the Ap/Pe label they share a point with.
            labels.push({ sx: s.x + 8, sy: s.y - 10 + (kind === 'burn' || kind === 'burnretro' ? 20 : 0), text: m.label, kind });
        }
    }
    if (game.mode === 'flight' && cam.dist > 5) {
        for (const [name, b, rad] of [['EARTH', bodies.earth, 1], ['MOON', bodies.moon, M.MOON_RADIUS]]) {
            const s = toScreen({ x: b.pos.x, y: b.pos.y + rad });
            if (s) labels.push({ sx: s.x - 20, sy: s.y - 22, text: name, kind: 'body' });
        }
    }
    if (game.mode === 'flight' && cam.dist > 30) {
        for (const l of solar.labels(camera)) {
            const s = toScreen({ x: l.x, y: l.y });
            if (s && s.x > -50 && s.y > -20 && s.x < W + 50 && s.y < H + 20) labels.push({ sx: s.x - 20, sy: s.y - 22, text: l.label, kind: 'body' });
        }
    }
    UI.renderMapLabels(declutter(labels));
}

// Zoomed out (map view) the Earth, Moon, Ap/Pe and burn notes all land on the
// same few pixels: keep the most useful label at each spot and drop the rest.
const LABEL_RANK = { body: 0, tli: 1, burn: 2, burnretro: 2, impact: 3, ap: 4, pe: 4, soi: 5 };
function declutter(list) {
    const order = list.map((l, i) => [l, i]).sort((a, b) => (LABEL_RANK[a[0].kind] ?? 9) - (LABEL_RANK[b[0].kind] ?? 9) || a[1] - b[1]);
    const kept = [];
    for (const [l] of order) {
        const w = Math.max(40, l.text.length * 7);
        if (kept.some((k) => k.text === l.text && Math.abs(k.sx - l.sx) < 30 && Math.abs(k.sy - l.sy) < 30)) continue;
        if (kept.some((k) => l.sx < k.sx + Math.max(40, k.text.length * 7) && k.sx < l.sx + w && Math.abs(k.sy - l.sy) < 15)) continue;
        kept.push(l);
    }
    return kept;
}

// ---------------------------------------------------------------------------
// Burn assist, coach, HUD state, ship locator

let coachTimer = 0;
const _si = new THREE.Vector3();
let lastAssist = null;

function updateAssist(showPred) {
    const flight = game.mode === 'flight' && !game.crashed;
    burnAssist.setVisible(flight && UI.settings.predict);
    let a = null;
    if (flight) {
        const held = UI.held;
        const dir = held.prograde ? 'prograde' : held.retrograde ? 'retrograde' : null;
        const burning = !!dir && game.warp > 0;
        a = burnAssist.update({ burning, dir });
        if (UI.settings.easy && burning && a?.cutoff) {
            UI.releaseAll();
            M.stopAllControls();
            UI.toast('BURN COMPLETE · ENGINES CUT', 'ok');
        }
    }
    lastAssist = a;
    UI.setBurnAssist?.(a && (a.kind || a.label) ? a : null);
    const nw = flight && showPred ? burnZones.nextWindow() : null;
    UI.setNextBurn?.(nw && Number.isFinite(nw.timeTo)
        ? { label: nw.label || 'NEXT BURN', timeText: fmtDuration(nw.timeTo), timeTo: nw.timeTo } : null);

    if (game.mode === 'launching' && L.ascent.phase !== L.PHASE.IDLE && game.countdown <= 0) {
        UI.setLaunchTelemetry?.({
            accelG: L.ascent.accelG || 0, stage: L.ascent.stage, stageFuel: L.ascent.stageFuel,
            massT: L.ascent.vehicleMassT, vehicleMassT: L.ascent.vehicleMassT, rocket: L.ascent.rocket,
        });
    } else UI.setLaunchTelemetry?.(null);

    // HUD layout state.
    let hs = 'orbit';
    const dom = M.dominantBody(r);
    if (UI.crashVisible?.() || game.crashed) hs = 'crashed';
    else if (game.mode === 'landing') hs = 'landing';
    else if (game.mode === 'launching') hs = game.countdown > 0 ? 'countdown' : 'ascent';
    else if (AP.isActive()) hs = 'autopilot';
    else if (UI.anyHeld()) hs = 'burning';
    else if (a?.kind || burnZones.zoneInfo()?.kind) hs = 'zone';
    else if (dom.name !== 'earth' && dom.name !== 'moon') hs = 'transfer';
    UI.setHudState?.(hs);

    // Ship locator.
    if (game.mode === 'landing' || game.crashed) { UI.setShipIndicator?.(null); }
    else {
        const w = window.innerWidth, h = window.innerHeight;
        _si.copy(vis.pos).project(camera);
        const front = _si.z < 1;
        let x = (_si.x + 1) * 0.5 * w, y = (1 - _si.y) * 0.5 * h;
        if (!front) { x = w - x; y = h - y; }
        const onScreen = front && x >= 0 && x <= w && y >= 0 && y <= h;
        focusPoint(cam.focus, _fp);
        const dist = Math.hypot(vis.pos.x - _fp.x, vis.pos.y - _fp.y);
        const wpp = (2 * cam.dist * Math.tan((camera.fov * Math.PI) / 360)) / h;
        UI.setShipIndicator?.({
            x, y, onScreen, angle: Math.atan2(y - h / 2, x - w / 2),
            distText: fmtDistance(dist), small: (vis.length || 0) / wpp < 24,
        });
    }

    // Coach (every 0.25 s real time).
}

function updateCoach(realDt) {
    coachTimer -= realDt;
    if (coachTimer > 0) return;
    coachTimer = 0.25;
    if (!UI.settings.coach) { coach.hide(); return; }
    const dom = M.dominantBody(r);
    const el = orbitalElements(r.x - dom.pos.x, r.y - dom.pos.y, v.x - dom.vel.x, v.y - dom.vel.y, dom.mu);
    if (game.mode === 'flight') game.orbited = true;
    coach.update({
        mode: game.mode,
        phase: game.mode === 'launching' ? (game.countdown > 0 ? 'pad' : 'ascent') : game.mode === 'flight' ? 'orbit' : '',
        dominant: dom.name,
        ecc: el.e,
        orbited: !!game.orbited,
        target: game.target || 'moon',
        targetChosen: !!game.targetChosen,
        apActive: AP.isActive(),
        inZone: !!(lastAssist?.kind || burnZones.zoneInfo()?.kind),
        burning: UI.anyHeld() || M.isBurning(),
        crashed: game.crashed,
    });
}

// ---------------------------------------------------------------------------
// Main loop

let last = performance.now();
const DAY = 86164 / M.TIME_UNIT_S;   // sidereal day in sim time units

function frame(now) {
    requestAnimationFrame(frame);
    const realDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (import.meta.env.DEV && window.__ksp?.freeze) { renderer.render(scene, camera); return; }   // dev: hold a frame for inspection
    game.time += realDt;

    for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].at <= game.time) { const p = pending.splice(i, 1)[0]; p.fn(); }
    }

    updateWarpToBurn();
    const t0 = M.sim.time;
    if (game.mode === 'launching') stepLaunch(realDt);
    else if (game.mode === 'flight') stepFlight(realDt);
    const simDt = Math.max(0, M.sim.time - t0);

    // Bodies.
    moon.position.set(bodies.moon.pos.x, bodies.moon.pos.y, 0);
    moon.rotation.y = -M.moonState.angle;
    earth.position.set(bodies.earth.pos.x, bodies.earth.pos.y, 0);
    earth.rotation.y += game.mode === 'landing' ? realDt * 0.05 : (simDt / DAY) * TAU;
    atmosphere.position.set(bodies.earth.pos.x, bodies.earth.pos.y, -0.6);
    solar.update(M.solarTime(), params.G, bodies.earth.pos, camera);
    sunLight.position.set(bodies.sun.pos.x, bodies.sun.pos.y, 0);
    sunLight.target.position.set(bodies.earth.pos.x, bodies.earth.pos.y, 0);
    sunLight.target.updateMatrixWorld();
    for (let i = 0; i < starLayers.length; i++) {
        starLayers[i].material.opacity = UI.settings.reducedMotion
            ? 0.8 : 0.62 + 0.3 * Math.sin(game.time * (1.3 + i * 0.9) + i * 2);
    }

    if (game.mode !== 'landing') {
        updateCraftVisual(realDt);
        updateDebris(realDt, simDt);
    }
    viewTimer -= realDt;
    if (viewTimer <= 0) { viewTimer = 0.25; updateViewOffset(); }
    updateCamera(realDt);
    updateSky();
    effects.update(realDt);
    burnZones.tick(UI.settings.reducedMotion ? 0 : realDt);

    // Prediction, Hohmann and labels.
    const showPred = game.mode !== 'landing' && UI.settings.predict && !game.crashed
        && !(game.mode === 'launching' && game.countdown > 0);   // nothing to predict on the pad
    trajectory.setVisible(showPred);
    if (showPred) {
        predTimer -= realDt;
        if (predTimer <= 0) {
            predTimer = M.isBurning() || controls.guidance ? 0.05 : 0.12;
            trajectory.setScale(cam.dist * 0.03);
            trajectory.update();
            burnZones.setVisible(game.mode === 'flight');
            burnZones.setWidth(cam.dist * 0.006);
            burnZones.update();
            const imp = trajectory.getMarkers().find((m) => m.id === 'impact');
            impact = imp
                ? (Math.hypot(imp.x - bodies.moon.pos.x, imp.y - bodies.moon.pos.y) < 1 ? 'moon' : 'earth')
                : null;
        }
    } else {
        impact = null;
        burnZones.setVisible(false);
    }
    updateAssist(showPred);
    updateCoach(realDt);
    if (game.hohmann && game.mode === 'flight') HOH.updateHohmann(r, bodies.earth.pos);
    updateLabels(showPred);

    // HUD.
    if (game.mode !== 'landing') {
        hudTimer -= realDt;
        if (hudTimer <= 0) {
            hudTimer = 0.1;
            UI.updateHud(telemetry());
        }
        const fv = M.thrustFrameVelocity(_fv);
        const dom = M.dominantBody(r);
        UI.drawNavball(vis.angle, Math.atan2(fv.y, fv.x), Math.atan2(r.y - dom.pos.y, r.x - dom.pos.x), Math.hypot(fv.x, fv.y) > 1e-6);
        UI.updateButtons({
            firing: {
                prograde: controls.prograding, retrograde: controls.retrograding,
                normalPos: controls.normalPos, normalNeg: controls.normalNeg,
            },
            holding: AP.isHolding(),
            circularizing: circ.active,
            predict: UI.settings.predict,
            hohmann: game.hohmann,
            autopilot: AP.isActive() && !AP.isHolding(),
            warp: game.warp,
            focus: cam.focus,
            burnText: burnText(),
        });
    }

    renderer.render(scene, camera);
}

onResize();
requestAnimationFrame(frame);
splash.setProgress(0.15, 'BUILDING SCENE');

// Debug handle for the dev server only (stripped from production builds).
if (import.meta.env.DEV) window.__ksp = { M, L, AP, game, circ, UI, camera, cam, vis, craft, solar };
