// Predicted coast trajectory, Ap/Pe/impact/SOI markers and map guides.
import * as THREE from 'three';
import {
    params, bodies, r, v, sim, moonState, crashState,
    EARTH_MOON_R, EARTH_CRASH_R, MOON_CRASH_R,
    moonSOI, soiRadius, dominantBody, bodyPositionsAt, accelFromPositions, BODY_NAMES,
} from './maneuver.js';
import { PLANETS } from './solar.js';
import { orbitalElements, fmtDistance, fmtDuration } from './orbit.js';

const MAX_POINTS = 6000;
const K_STEP = 0.012;
const H_MIN = 0.002;
const H_MAX = 4;
const LONG_HORIZON = 2500;              // sim time shown once the craft leaves Earth's SOI
const MAX_SOI_EVENTS = 16;
const FADE = 0.9;                       // brightness lost at the end of the horizon
const rgb = (c) => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
// Colour per dominant body, indexed like BODY_NAMES (earth, moon, sun, mercury, venus, mars).
const BODY_RGB = [
    rgb(0x39d0ff), rgb(0xffb347), rgb(0xfff0a0),
    rgb(PLANETS.mercury.color), rgb(PLANETS.venus.color), rgb(PLANETS.mars.color),
];
const BODY_LABEL = ['Earth', 'Moon', 'Sun', 'Mercury', 'Venus', 'Mars'];
const RANK = [1, 2, 0, 1, 1, 1];        // hierarchy depth, to tell SOI entry from exit
const EARTH_SOI = soiRadius('earth');

// Scratch buffers shared by predictPath and the renderer (no per-call allocation).
const _dom = new Uint8Array(MAX_POINTS);          // dominant body index of each point
const _brk = new Uint8Array(MAX_POINTS);          // 1 when the point starts a new body frame
const _frac = new Float32Array(MAX_POINTS);       // fraction of the horizon elapsed
const _soiIdx = new Int32Array(MAX_SOI_EVENTS);   // point index of each SOI change
const _P0 = new Float64Array(12);
const _P = new Float64Array(12);
const _g = { ax: 0, ay: 0 };
const sq = new Float64Array(6), crashR = new Float64Array(6);
let _horizon = params.lookahead;

function domIndex(x, y, P) {
    for (let i = 3; i < 6; i++) {
        if (Math.hypot(x - P[2 * i], y - P[2 * i + 1]) < soiRadius(BODY_NAMES[i])) return i;
    }
    if (Math.hypot(x - P[0], y - P[1]) < EARTH_SOI) {
        if (bodies.moon.m > 0 && Math.hypot(x - P[2], y - P[3]) < moonSOI()) return 1;
        return 0;
    }
    return 2;
}

/**
 * Integrate the coast path (no thrust) from the live state with the same
 * kick-drift-kick leapfrog as the simulation, using an adaptive step and the
 * time-dependent gravity of Earth, Moon, Sun and planets. Writes x,y,0 triplets
 * into `out` (length >= 3 * maxPoints) in patched-conic display coordinates:
 * each point is drawn in its dominant body's frame translated to that body's
 * CURRENT position (p - dom(t) + dom(now)). Per-point body indices, frame breaks
 * and horizon fractions are kept in module buffers used by the renderer.
 *
 * Without an explicit horizon it is params.lookahead near Earth and
 * LONG_HORIZON once the craft is outside Earth's SOI or on an escape orbit.
 *
 * @param {number} maxPoints  maximum number of points (clamped to 6000)
 * @param {Float32Array|Float64Array} out  destination positions
 * @param {number} [horizon]  sim time to cover
 * @returns {{count:number, impact:(null|{x:number,y:number,body:string,index:number}),
 *            soiChanges:number, endTime:number, horizon:number}}
 */
export function predictPath(maxPoints, out, horizon) {
    const cap = Math.min(maxPoints | 0, MAX_POINTS);
    const G = params.G;
    const t0 = sim.time;
    if (horizon === undefined) {
        const e = bodies.earth.pos;
        const dE = Math.hypot(r.x - e.x, r.y - e.y);
        const esc = 0.5 * (v.x * v.x + v.y * v.y) - (G * bodies.earth.m) / Math.max(dE, 1e-6) > 0;
        horizon = dE > EARTH_SOI || esc ? LONG_HORIZON : params.lookahead;
    }
    _horizon = horizon;
    const hMin = Math.max(H_MIN, Math.min(horizon / cap, params.lookahead / cap));

    // Per-body step scale K·d^1.5/sqrt(mu) and crash radius.
    for (let i = 0; i < 6; i++) {
        const b = bodies[BODY_NAMES[i]];
        sq[i] = b.m > 0 ? Math.sqrt(G * b.m) : 0;
        crashR[i] = i === 0 ? EARTH_CRASH_R : i === 1 ? MOON_CRASH_R : b.radius * 1.02;
    }

    bodyPositionsAt(t0, _P0);
    let x = r.x, y = r.y, vx = v.x, vy = v.y;
    let P = _P;
    P.set(_P0);
    let g = accelFromPositions(x, y, P, _g);
    let ax = g.ax, ay = g.ay;

    let t = 0, count = 0, soiChanges = 0;
    let impact = null;
    let prev = -1;

    while (count < cap) {
        const dom = domIndex(x, y, P);
        const o = count * 3;
        // Display point: dominant-body frame at the body's current position.
        out[o] = x - P[2 * dom] + _P0[2 * dom];
        out[o + 1] = y - P[2 * dom + 1] + _P0[2 * dom + 1];
        out[o + 2] = 0;
        _dom[count] = dom;
        _frac[count] = horizon > 0 ? t / horizon : 0;
        _brk[count] = prev !== -1 && dom !== prev ? 1 : 0;
        if (_brk[count] && soiChanges < MAX_SOI_EVENTS) _soiIdx[soiChanges++] = count;
        prev = dom;
        count++;

        let h = Infinity;
        for (let i = 0; i < 6; i++) {
            const dx = x - P[2 * i], dy = y - P[2 * i + 1];
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < crashR[i]) { impact = { x: out[o], y: out[o + 1], body: BODY_NAMES[i], index: count - 1 }; break; }
            if (sq[i] > 0) {
                const hi = K_STEP * d * Math.sqrt(d) / sq[i];
                if (hi < h) h = hi;
            }
        }
        if (impact || t >= horizon) break;

        if (h < hMin) h = hMin; else if (h > H_MAX) h = H_MAX;
        if (h > horizon - t) h = horizon - t;

        // Kick, drift (bodies advance), kick.
        vx += ax * 0.5 * h; vy += ay * 0.5 * h;
        x += vx * h; y += vy * h;
        t += h;
        bodyPositionsAt(t0 + t, P);
        g = accelFromPositions(x, y, P, _g);
        ax = g.ax; ay = g.ay;
        vx += ax * 0.5 * h; vy += ay * 0.5 * h;
    }
    return { count, impact, soiChanges, endTime: t, horizon };
}

// ---------------------------------------------------------------------------
// Marker textures

function makeTexture(draw) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
    draw(g);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function chevron(up, color) {
    return makeTexture((g) => {
        g.strokeStyle = color;
        g.beginPath();
        if (up) { g.moveTo(14, 42); g.lineTo(32, 20); g.lineTo(50, 42); }
        else { g.moveTo(14, 22); g.lineTo(32, 44); g.lineTo(50, 22); }
        g.stroke();
    });
}

function crossTexture() {
    return makeTexture((g) => {
        g.strokeStyle = '#ff3b3b'; g.lineWidth = 9;
        g.beginPath();
        g.moveTo(14, 14); g.lineTo(50, 50);
        g.moveTo(50, 14); g.lineTo(14, 50);
        g.stroke();
    });
}

function soiTexture(inward, color) {
    return makeTexture((g) => {
        g.strokeStyle = color; g.lineWidth = 6;
        g.beginPath(); g.arc(32, 32, 16, 0, Math.PI * 2); g.stroke();
        g.fillStyle = color;
        if (inward) { g.beginPath(); g.arc(32, 32, 6, 0, Math.PI * 2); g.fill(); }
    });
}

const CIRCLE_SEGMENTS = 160;

function fillCircle(arr, radius) {
    for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
        const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        arr[i * 3] = radius * Math.cos(a);
        arr[i * 3 + 1] = radius * Math.sin(a);
        arr[i * 3 + 2] = 0;
    }
}

/**
 * Create the predicted-path renderer and map guides; add to scene.
 * @param {THREE.Scene} scene
 * @returns {{update:function():void, setVisible:function(boolean):void,
 *   getMarkers:function():Array<{id:string,x:number,y:number,label:string}>,
 *   setScale:function(number):void, clear:function():void, dispose:function():void}}
 */
export function createTrajectory(scene) {
    const group = new THREE.Group();
    scene.add(group);

    // Predicted path line.
    const pos = new Float32Array(MAX_POINTS * 3);
    const col = new Float32Array(MAX_POINTS * 3);
    const lineGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute('position', posAttr);
    lineGeo.setAttribute('color', colAttr);
    // Dominant-body index per point: between predictions (every ~0.1 s) each point
    // is carried along with its body, so a lunar orbit stays glued to the moving
    // Moon instead of jumping to catch up at each update.
    const bodyArr = new Float32Array(MAX_POINTS);
    const bodyAttr = new THREE.BufferAttribute(bodyArr, 1).setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute('body', bodyAttr);
    const snapP = new Float64Array(12);      // body positions when the line was computed
    const nowP = new Float64Array(12);
    const offUniform = { value: Array.from({ length: 6 }, () => new THREE.Vector2()) };
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const lineIdx = new Uint16Array(MAX_POINTS * 2);
    lineGeo.setIndex(new THREE.BufferAttribute(lineIdx, 1).setUsage(THREE.DynamicDrawUsage));
    lineMat.onBeforeCompile = (sh) => {
        sh.uniforms.uBodyOff = offUniform;
        sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float body;\nuniform vec2 uBodyOff[6];')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xy += uBodyOff[int(body + 0.5)];');
    };
    const line = new THREE.LineSegments(lineGeo, lineMat);
    line.frustumCulled = false;
    line.renderOrder = 5;
    group.add(line);

    // Guides: Moon orbit (dashed) and Moon SOI (dotted).
    const orbitArr = new Float32Array((CIRCLE_SEGMENTS + 1) * 3);
    fillCircle(orbitArr, EARTH_MOON_R);
    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute('position', new THREE.BufferAttribute(orbitArr, 3));
    const orbitMat = new THREE.LineDashedMaterial({
        color: 0x8899aa, dashSize: 0.4, gapSize: 0.4, transparent: true, opacity: 0.3, depthWrite: false,
    });
    const orbitLine = new THREE.Line(orbitGeo, orbitMat);
    orbitLine.computeLineDistances();
    orbitLine.frustumCulled = false;
    group.add(orbitLine);

    const soiArr = new Float32Array((CIRCLE_SEGMENTS + 1) * 3);
    const soiGeo = new THREE.BufferGeometry();
    const soiAttr = new THREE.BufferAttribute(soiArr, 3);
    soiGeo.setAttribute('position', soiAttr);
    const soiMat = new THREE.LineDashedMaterial({
        color: 0xffb347, dashSize: 0.05, gapSize: 0.2, transparent: true, opacity: 0.35, depthWrite: false,
    });
    const soiLine = new THREE.Line(soiGeo, soiMat);
    soiLine.frustumCulled = false;
    group.add(soiLine);
    let soiDrawn = -1;

    // Marker sprites.
    const texApo = chevron(true, '#39d0ff');
    const texPeri = chevron(false, '#ffd24a');
    const texImpact = crossTexture();
    const texIn = soiTexture(true, '#ffb347');
    const texOut = soiTexture(false, '#39d0ff');
    const mkSprite = (tex) => {
        const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
        const s = new THREE.Sprite(m);
        s.visible = false;
        s.renderOrder = 10;
        group.add(s);
        return s;
    };
    const apSprite = mkSprite(texApo);
    const peSprite = mkSprite(texPeri);
    const impactSprite = mkSprite(texImpact);
    const soiSprites = [];
    for (let i = 0; i < MAX_SOI_EVENTS; i++) soiSprites.push(mkSprite(texIn));
    const soiOutMats = soiSprites.map((s) => {
        const m = s.material.clone();
        m.map = texOut;
        return m;
    });
    const soiInMats = soiSprites.map((s) => s.material);

    let visible = true;
    let scale = 1;
    let markers = [];
    let active = false;
    const spriteList = [apSprite, peSprite, impactSprite, ...soiSprites];

    function applyScale() {
        for (const s of spriteList) s.scale.set(scale, scale, 1);
    }
    applyScale();

    function hidePrediction() {
        lineGeo.setDrawRange(0, 0);
        for (const s of spriteList) s.visible = false;
        markers = [];
    }

    function updateGuides() {
        const e = bodies.earth.pos;
        orbitLine.position.set(e.x, e.y, 0);
        const mp = { x: e.x + EARTH_MOON_R * Math.cos(moonState.angle), y: e.y + EARTH_MOON_R * Math.sin(moonState.angle) };
        soiLine.position.set(mp.x, mp.y, 0);
        const rad = bodies.moon.m > 0 ? moonSOI() : 0;
        soiLine.visible = rad > 0;
        if (rad > 0 && Math.abs(rad - soiDrawn) > 1e-9) {
            soiDrawn = rad;
            fillCircle(soiArr, rad);
            soiAttr.needsUpdate = true;
            soiGeo.computeBoundingSphere();
            soiLine.computeLineDistances();
        }
        orbitLine.visible = true;
    }

    function placeSprite(sprite, id, x, y, label, body = -1) {
        sprite.position.set(x, y, 0);
        sprite.visible = true;
        markers.push({ id, x, y, label, body, x0: x, y0: y, sprite });
    }

    /** Carry the line and markers along with their bodies; call every frame. */
    function follow() {
        if (!active) return;
        bodyPositionsAt(sim.time, nowP);
        const off = offUniform.value;
        for (let i = 0; i < 6; i++) off[i].set(nowP[2 * i] - snapP[2 * i], nowP[2 * i + 1] - snapP[2 * i + 1]);
        for (const m of markers) {
            if (m.body < 0) continue;
            m.x = m.x0 + off[m.body].x; m.y = m.y0 + off[m.body].y;
            m.sprite.position.set(m.x, m.y, 0);
        }
    }

    function apsisMarkers() {
        const pt = { x: r.x, y: r.y };
        const dom = dominantBody(pt);
        const rx = r.x - dom.pos.x, ry = r.y - dom.pos.y;
        const vx = v.x - dom.vel.x, vy = v.y - dom.vel.y;
        if (!(rx * rx + ry * ry > 1e-12)) return;
        const el = orbitalElements(rx, ry, vx, vy, dom.mu);
        if (!(el.e > 0.002) || !Number.isFinite(el.rp)) return;
        const R0 = dom.radius;
        const bi = BODY_NAMES.indexOf(dom.name);
        if (el.bound || Number.isFinite(el.timeToPe)) {
            const px = dom.pos.x + el.rp * Math.cos(el.peAngle);
            const py = dom.pos.y + el.rp * Math.sin(el.peAngle);
            const alt = el.rp - R0;
            let label = alt < 0 ? 'Pe IMPACT' : 'Pe ' + fmtDistance(alt);
            if (Number.isFinite(el.timeToPe)) label += ' in ' + fmtDuration(el.timeToPe);
            placeSprite(peSprite, 'pe', px, py, label, bi);
        }
        if (el.bound && Number.isFinite(el.ra)) {
            const ax = dom.pos.x - el.ra * Math.cos(el.peAngle);
            const ay = dom.pos.y - el.ra * Math.sin(el.peAngle);
            let label = 'Ap ' + fmtDistance(el.ra - R0);
            if (Number.isFinite(el.timeToAp)) label += ' in ' + fmtDuration(el.timeToAp);
            placeSprite(apSprite, 'ap', ax, ay, label, bi);
        }
    }

    function update() {
        updateGuides();
        if (!visible || crashState.crashed) {
            if (active) { hidePrediction(); active = false; }
            return;
        }
        active = true;
        markers = [];
        for (const s of spriteList) s.visible = false;

        const res = predictPath(MAX_POINTS, pos);
        const n = res.count;
        snapP.set(_P0);
        for (const o of offUniform.value) o.set(0, 0);
        let ni = 0;
        for (let i = 0; i < n; i++) {
            bodyArr[i] = _dom[i];
            if (i > 0 && !_brk[i]) { lineIdx[ni++] = i - 1; lineIdx[ni++] = i; }
            const c = BODY_RGB[_dom[i]];
            const b = 1 - FADE * _frac[i];
            col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
        }
        posAttr.clearUpdateRanges(); colAttr.clearUpdateRanges();
        posAttr.addUpdateRange(0, n * 3); colAttr.addUpdateRange(0, n * 3);
        posAttr.needsUpdate = true; colAttr.needsUpdate = true;
        bodyAttr.clearUpdateRanges(); bodyAttr.addUpdateRange(0, n);
        bodyAttr.needsUpdate = true;
        lineGeo.index.clearUpdateRanges(); lineGeo.index.addUpdateRange(0, ni);
        lineGeo.index.needsUpdate = true;
        lineGeo.setDrawRange(0, ni);

        apsisMarkers();

        for (let k = 0; k < res.soiChanges; k++) {
            const i = _soiIdx[k];
            const from = _dom[i - 1], to = _dom[i];
            const entering = RANK[to] > RANK[from];
            const s = soiSprites[k];
            s.material = entering ? soiInMats[k] : soiOutMats[k];
            const dt = fmtDuration(_frac[i] * res.horizon);
            // Marker sits on the last point in the old body's frame (the SOI boundary).
            placeSprite(s, entering ? 'soi-in' : 'soi-out', pos[(i - 1) * 3], pos[(i - 1) * 3 + 1],
                entering ? BODY_LABEL[to] + ' SOI in ' + dt : 'Leave ' + BODY_LABEL[from] + ' SOI in ' + dt, from);
        }
        if (res.impact) {
            const im = res.impact;
            placeSprite(impactSprite, 'impact', im.x, im.y,
                'Impact in ' + fmtDuration(_frac[im.index] * res.horizon), _dom[im.index]);
        }
    }

    return {
        update,
        follow,
        /** Show/hide the prediction line and markers (guides stay). */
        setVisible(b) {
            visible = !!b;
            if (!visible) { hidePrediction(); active = false; }
        },
        /** Markers for HTML labels; empty when hidden. */
        getMarkers() { return visible && active ? markers : []; },
        /** World-space marker sprite size (pass something proportional to camera distance). */
        setScale(s) { scale = s; applyScale(); },
        /** Hide everything until the next update(). */
        clear() {
            hidePrediction();
            active = false;
            orbitLine.visible = false;
            soiLine.visible = false;
        },
        dispose() {
            scene.remove(group);
            lineGeo.dispose(); lineMat.dispose();
            orbitGeo.dispose(); orbitMat.dispose();
            soiGeo.dispose(); soiMat.dispose();
            for (const m of soiOutMats) m.dispose();
            for (const s of spriteList) s.material.dispose();
            for (const t of [texApo, texPeri, texImpact, texIn, texOut]) t.dispose();
        },
    };
}
