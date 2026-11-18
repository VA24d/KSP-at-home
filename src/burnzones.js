// Optimal burn zones drawn on the current orbit:
//   - circularize: around apoapsis (prograde raises periapsis) and periapsis
//     (retrograde lowers apoapsis), while the orbit is noticeably eccentric;
//   - TLI window: the departure point for a Hohmann transfer that meets the
//     Moon, with the time until the craft reaches it;
//   - planet window: the Earth-ejection point for a Hohmann transfer to
//     Mercury / Venus / Mars, plus the wait for the planetary alignment.
// All the geometry lives in analyze(), a pure function (no renderer needed).
import * as THREE from 'three';
import { params, bodies, sim, r, v, EARTH_MOON_R, moonAngularRate, dominantBody } from './maneuver.js';
import { orbitalElements, fmtDuration } from './orbit.js';
import { PLANETS, helioState, helioAngle, meanMotion, hohmann } from './solar.js';

const SEG = 40;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const MIN_ECC = 0.05;   // below this the orbit counts as circular: no nagging over tidal wobble

/** Half-widths of the burn zones (degrees). */
export const DIFFICULTY = {
    easy: { circ: 30, tli: 25, planet: 25 },
    real: { circ: 16, tli: 9, planet: 9 },
};

let difficulty = 'easy';
let target = 'moon';
let lastInfo = nullInfo();
let lastNext = null;

function nullInfo() {
    return { kind: null, grade: null, label: '', burn: null, timeTo: Infinity, target: null };
}

export function setDifficulty(d) { if (DIFFICULTY[d]) difficulty = d; }
export function getDifficulty() { return difficulty; }
export function setTarget(t) { if (t === 'moon' || (PLANETS[t] && t !== 'earth')) target = t; }
export function getTarget() { return target; }
/** The zone the craft is inside right now ({kind: null} when none). */
export function zoneInfo() { return lastInfo; }
/** Soonest upcoming ideal burn point for the current target: {timeTo, kind, label} or null. */
export function nextWindow() { return lastNext; }

function wrap(a) {
    a %= TAU;
    return a < 0 ? a + TAU : a;
}
function wrapPi(a) { return wrap(a + Math.PI) - Math.PI; }

/**
 * Grade a burn start by how close it is to the ideal point:
 * PERFECT inside the inner 25% of the half-width, GOOD up to 60%, OK beyond; null outside.
 */
export function gradeOf(offset, half) {
    const f = Math.abs(offset) / half;
    if (f > 1) return null;
    if (f <= 0.25) return 'PERFECT';
    if (f <= 0.6) return 'GOOD';
    return 'OK';
}

/** Asymptote true anomaly of the ejection hyperbola from a parking orbit of radius rp. */
export function asymptoteAngle(rp, vInf, mu) {
    const e = 1 + (rp * vInf * vInf) / mu;
    return Math.acos(-1 / e);
}

/**
 * Angle of the burn point (hyperbola periapsis) on the parking orbit so the
 * outgoing asymptote points along `uAngle`. cw: craft orbits clockwise.
 */
export function ejectionAngle(uAngle, rp, vInf, mu, cw = true) {
    const nu = asymptoteAngle(rp, vInf, mu);
    return wrap(cw ? uAngle + nu : uAngle - nu);
}

/**
 * Wait (time units) until Earth and `tgt` reach the Hohmann departure phase.
 * Returns { wait, prev, synodic, hoh }; prev = time since the last alignment.
 */
export function planetWait(tgt, time, G) {
    const hoh = hohmann(tgt, G);
    const rate = meanMotion(tgt, G) - meanMotion('earth', G);
    const d0 = wrap(helioAngle(tgt, time, G) - helioAngle('earth', time, G) + hoh.phase);
    const synodic = TAU / Math.abs(rate);
    let wait;
    if (rate > 0) wait = d0 < 1e-9 ? 0 : (TAU - d0) / rate;
    else wait = d0 / -rate;
    return { wait, prev: synodic - wait, synodic, hoh };
}

/**
 * Pure zone analysis. ctx = { rel:{rx,ry,vx,vy}, dom:{name,mu,radius,pos}, moon:{pos,rate,present},
 * time, G, target, difficulty }. Returns { valid, el, zones[], info, next }.
 */
export function analyze(ctx) {
    const { rel, dom, time, G } = ctx;
    const W = DIFFICULTY[ctx.difficulty || difficulty];
    const tgt = ctx.target || target;
    const el = orbitalElements(rel.rx, rel.ry, rel.vx, rel.vy, dom.mu);
    const out = { valid: false, el, zones: [], info: nullInfo(), next: null };
    if (!el.bound || !Number.isFinite(el.a) || el.rp < dom.radius) return out;
    out.valid = true;
    const here = wrap(Math.atan2(rel.ry, rel.rx));
    const cw = el.h < 0;
    const s = cw ? -1 : 1;
    const nCraft = Math.sqrt(dom.mu / (el.a * el.a * el.a));
    const zones = out.zones;

    if (el.e > MIN_ECC) {
        const half = W.circ * DEG;
        const apA = wrap(el.peAngle + Math.PI);
        const offAp = wrapPi(here - apA), offPe = wrapPi(here - el.peAngle);
        zones.push({
            kind: 'ap', id: 'burn-ap', center: apA, half, offset: offAp, inside: Math.abs(offAp) <= half,
            grade: gradeOf(offAp, half), burn: 'prograde', timeTo: el.timeToAp, target: tgt,
            text: 'AP ZONE · BURN PROGRADE TO CIRCULARIZE', markerLabel: `BURN ▲ PROGRADE · in ${fmtDuration(el.timeToAp)}`,
        });
        zones.push({
            kind: 'pe', id: 'burn-pe', center: el.peAngle, half, offset: offPe, inside: Math.abs(offPe) <= half,
            grade: gradeOf(offPe, half), burn: 'retrograde', timeTo: el.timeToPe, target: tgt,
            text: 'PE ZONE · BURN RETRO TO CIRCULARIZE', markerLabel: `BURN ▼ RETRO · in ${fmtDuration(el.timeToPe)}`,
        });
    }

    const low = dom.name === 'earth' && el.ra < EARTH_MOON_R * 0.5 && el.e < 0.2;
    if (low && tgt === 'moon' && ctx.moon && ctx.moon.present) {
        const mu = dom.mu, w = ctx.moon.rate, half = W.tli * DEG;
        const aT = (el.a + EARTH_MOON_R) / 2;
        const tT = Math.PI * Math.sqrt((aT * aT * aT) / mu);
        const thM = Math.atan2(ctx.moon.pos.y - dom.pos.y, ctx.moon.pos.x - dom.pos.x);
        // Depart half a revolution before the point where the Moon will be on arrival.
        const dep = wrap(thM + w * tT + Math.PI);
        const n = s * nCraft;
        const rate = n - w;                       // rate the craft closes on the moving window
        const gap = rate < 0 ? wrap(here - dep) : wrap(dep - here);
        const wait = Math.abs(rate) > 1e-9 ? gap / Math.abs(rate) : Infinity;
        const off = wrapPi(here - dep);
        const inside = Math.abs(off) <= half;
        zones.push({
            kind: 'tli', id: 'burn-tli', center: dep, half, offset: off, inside, grade: gradeOf(off, half),
            burn: 'prograde', timeTo: inside ? 0 : wait, target: 'moon',
            text: 'TLI WINDOW · BURN PROGRADE FOR THE MOON', markerLabel: `TLI WINDOW · in ${fmtDuration(wait)}`,
        });
    } else if (low && tgt !== 'moon' && PLANETS[tgt]) {
        const half = W.planet * DEG;
        const { wait, prev, hoh } = planetWait(tgt, time, G);
        // The alignment window spans a full craft period either side, so the craft
        // always passes the ejection point inside it (a quarter period, as before,
        // let a whole synodic window slip by when the craft was on the far side).
        const tol = el.period;
        const passAfter = (tA) => {
            // first pass over the ejection point at or after now, near alignment tA
            const ev = helioState('earth', time + Math.max(tA, 0), G);
            let uAng = Math.atan2(ev.vy, ev.vx);
            if (hoh.vInf < 0) uAng += Math.PI;      // inner planet: leave against Earth's motion
            const dep = ejectionAngle(uAng, el.a, Math.abs(hoh.vInf), dom.mu, cw);
            const gap = cw ? wrap(here - dep) : wrap(dep - here);
            let t = gap / nCraft;                    // next pass from now
            if (t < tA - tol) t += Math.ceil((tA - tol - t) / el.period) * el.period;
            return { dep, t: t <= tA + tol ? t : null };
        };
        let tA = prev < tol ? -prev : wait;         // signed time to the alignment
        let pass = passAfter(tA);
        if (pass.t === null && tA < 0) { tA = wait; pass = passAfter(tA); }   // this one is gone: next synodic
        const dep = pass.dep;
        const vInf = Math.abs(hoh.vInf);
        const off = wrapPi(here - dep);
        const aligned = Math.abs(tA) <= tol;
        const inside = aligned && Math.abs(off) <= half;
        const toPoint = pass.t ?? Math.max(tA, 0);
        const far = tA > el.period * 1.5;
        const L = PLANETS[tgt].label;
        zones.push({
            kind: 'planet', id: 'burn-planet', center: dep, half, offset: off, inside, grade: gradeOf(off, half),
            burn: 'prograde', timeTo: inside ? 0 : toPoint, target: tgt, vInf, far, alignIn: Math.max(tA, 0),
            text: `${L} WINDOW · BURN PROGRADE TO ESCAPE EARTH`,
            markerLabel: far ? `${L} ALIGNMENT · in ${fmtDuration(tA)}` : `${L} WINDOW · in ${fmtDuration(toPoint)}`,
        });
    }

    let inside = null;
    for (const z of zones) {
        if (!z.inside) continue;
        if (!inside || (inside.kind === 'ap' || inside.kind === 'pe') && z.kind !== 'ap' && z.kind !== 'pe') inside = z;
    }
    if (inside) {
        out.info = {
            kind: inside.kind, grade: inside.grade, label: `${inside.grade} · ${inside.text}`, burn: inside.burn,
            timeTo: 0, target: inside.target, vInf: inside.vInf,
        };
    }
    let best = null;
    for (const z of zones) {
        if (Number.isFinite(z.timeTo) && (!best || z.timeTo < best.timeTo)) best = z;
    }
    if (best) out.next = { timeTo: best.timeTo, kind: best.kind, label: best.text.split(' · ')[0] };
    return out;
}

function makeArc(color) {
    // A ribbon (triangle strip) along the orbit, so the zone reads as a band.
    const n = SEG + 1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const alpha = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        const t = i / SEG;
        const a = Math.sin(Math.PI * t) ** 0.6;        // fade at both ends
        alpha[i * 2] = a; alpha[i * 2 + 1] = a;
    }
    geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    const idx = [];
    for (let i = 0; i < SEG; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 } },
        vertexShader: `attribute float alpha; varying float vA; varying float vS;
            void main(){ vA = alpha; vS = float(gl_VertexID % 2); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uTime; varying float vA; varying float vS;
            void main(){ float edge = 1.0 - abs(vS * 2.0 - 1.0); float pulse = 0.75 + 0.25 * sin(uTime * 3.0);
              gl_FragColor = vec4(uColor, vA * (0.35 + 0.45 * edge) * pulse); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    const group = new THREE.Group();
    group.add(mesh);
    group.visible = false;
    return { group, geo, mats: [mat] };
}

/** Fill a band on the osculating ellipse (focus at cx,cy) centred on angle c. */
function fillArc(arc, cx, cy, p, e, peAngle, c, half, width) {
    const arr = arc.geo.attributes.position.array;
    for (let i = 0; i <= SEG; i++) {
        const th = c - half + (2 * half * i) / SEG;
        const rr = p / (1 + e * Math.cos(th - peAngle));
        const co = Math.cos(th), si = Math.sin(th);
        const r0 = rr - width, r1 = rr + width;
        arr[i * 6] = r0 * co; arr[i * 6 + 1] = r0 * si; arr[i * 6 + 2] = 0.002;
        arr[i * 6 + 3] = r1 * co; arr[i * 6 + 4] = r1 * si; arr[i * 6 + 5] = 0.002;
    }
    arc.geo.attributes.position.needsUpdate = true;
    arc.group.position.set(cx, cy, 0);
    arc.group.visible = true;
}

export function createBurnZones(scene) {
    const root = new THREE.Group();
    scene.add(root);
    const arcs = {
        ap: makeArc(0x4dff9a), pe: makeArc(0xffb347), tli: makeArc(0xd36bff), planet: makeArc(0xff6b6b),
    };
    const arcList = Object.values(arcs);
    for (const a of arcList) root.add(a.group);
    const markers = [];
    let visible = true;
    let zone = '';
    let width = 0.03;
    let time = 0;
    const moonPresent = () => bodies.moon.m > 0;

    function hideAll() {
        for (const a of arcList) a.group.visible = false;
        markers.length = 0;
        zone = '';
        lastInfo = nullInfo();
        lastNext = null;
    }

    function update() {
        hideAll();
        if (!visible) return;
        const dom = dominantBody(r);
        const res = analyze({
            rel: { rx: r.x - dom.pos.x, ry: r.y - dom.pos.y, vx: v.x - dom.vel.x, vy: v.y - dom.vel.y },
            dom, moon: { pos: bodies.moon.pos, rate: moonAngularRate(), present: moonPresent() },
            time: sim.time, G: params.G, target, difficulty,
        });
        if (!res.valid) return;
        const { el } = res;
        const cx = dom.pos.x, cy = dom.pos.y;
        const p = (el.h * el.h) / dom.mu;
        for (const z of res.zones) {
            const rd = p / (1 + el.e * Math.cos(z.center - el.peAngle));
            if (!z.far) fillArc(arcs[z.kind], cx, cy, p, el.e, el.peAngle, z.center, z.half, width);
            const mx = z.far ? r.x : cx + rd * Math.cos(z.center);
            const my = z.far ? r.y : cy + rd * Math.sin(z.center);
            markers.push({ id: z.id, x: mx, y: my, label: z.markerLabel, far: !!z.far, grade: z.inside ? z.grade : null });
        }
        lastInfo = res.info;
        lastNext = res.next;
        zone = res.info.kind ? res.info.label : '';
    }

    return {
        update,
        /** Band half-width in world units (scale with the camera distance). */
        setWidth(w) { width = w; },
        /** Advance the pulse animation (real seconds). */
        tick(dt) { time += dt; for (const a of arcList) a.mats[0].uniforms.uTime.value = time; },
        setVisible(b) { visible = b; if (!b) hideAll(); },
        getMarkers() { return markers; },
        /** Text when the craft is inside a zone ("GRADE · ZONE · ACTION"), else ''. */
        inZone() { return zone; },
        setDifficulty, setTarget, zoneInfo, nextWindow,
        clear: hideAll,
        dispose() {
            for (const a of arcList) { a.geo.dispose(); a.mats.forEach((m) => m.dispose()); }
            scene.remove(root);
        },
    };
}
