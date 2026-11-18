// Predicted coast trajectory, Ap/Pe/impact/SOI markers and map guides.
import * as THREE from 'three';
import {
    params, bodies, r, v, moonState, crashState,
    EARTH_RADIUS, MOON_RADIUS, EARTH_MOON_R, EARTH_CRASH_R, MOON_CRASH_R,
    moonAngularRate, moonVelocity, moonSOI, dominantBody, gravityAt,
} from './maneuver.js';
import { orbitalElements, fmtDistance, fmtDuration } from './orbit.js';

const MAX_POINTS = 6000;
const K_STEP = 0.012;
const H_MIN = 0.002;
const H_MAX = 0.5;
const MAX_SOI_EVENTS = 16;
const FADE = 0.9;                       // brightness lost at the end of the horizon
const EARTH_RGB = [0x39 / 255, 0xd0 / 255, 0xff / 255];
const MOON_RGB = [0xff / 255, 0xb3 / 255, 0x47 / 255];

// Scratch buffers shared by predictPath and the renderer (no per-call allocation).
const _inMoon = new Uint8Array(MAX_POINTS);       // 1 when the point is inside the Moon SOI
const _frac = new Float32Array(MAX_POINTS);       // fraction of the horizon elapsed
const _soiIdx = new Int32Array(MAX_SOI_EVENTS);   // point index of each SOI change

/**
 * Integrate the coast path (no thrust) from the live state with the same
 * kick-drift-kick leapfrog and Moon motion as the simulation, using an
 * adaptive step. Writes x,y,0 triplets into `out` (length >= 3 * maxPoints).
 * Per-point SOI flags and horizon fractions are kept in module buffers used by
 * the renderer.
 *
 * @param {number} maxPoints  maximum number of points (clamped to 6000)
 * @param {Float32Array|Float64Array} out  destination positions
 * @param {number} [horizon=params.lookahead]  sim time to cover
 * @returns {{count:number, impact:(null|{x:number,y:number,body:string,index:number}),
 *            soiChanges:number, endTime:number}}
 */
export function predictPath(maxPoints, out, horizon = params.lookahead) {
    const cap = Math.min(maxPoints | 0, MAX_POINTS);
    const ex = bodies.earth.pos.x, ey = bodies.earth.pos.y;
    const muE = params.G * bodies.earth.m;
    const muM = params.G * bodies.moon.m;
    const hasMoon = muM > 0;
    const sqE = Math.sqrt(muE);
    const sqM = hasMoon ? Math.sqrt(muM) : 1;
    const w = moonAngularRate();
    const soi = moonSOI();
    const hMin = Math.max(H_MIN, horizon / cap);

    let x = r.x, y = r.y, vx = v.x, vy = v.y;
    let ang = moonState.angle;
    let mx = ex + EARTH_MOON_R * Math.cos(ang);
    let my = ey + EARTH_MOON_R * Math.sin(ang);
    let g = gravityAt(x, y, mx, my);
    let ax = g.ax, ay = g.ay;

    let t = 0, count = 0, soiChanges = 0;
    let impact = null;
    let prevIn = -1;

    while (count < cap) {
        const dxE = x - ex, dyE = y - ey;
        const dE = Math.sqrt(dxE * dxE + dyE * dyE);
        const dxM = x - mx, dyM = y - my;
        const dM = Math.sqrt(dxM * dxM + dyM * dyM);

        // Record the current point.
        const o = count * 3;
        out[o] = x; out[o + 1] = y; out[o + 2] = 0;
        const inM = hasMoon && dM < soi ? 1 : 0;
        _inMoon[count] = inM;
        _frac[count] = horizon > 0 ? t / horizon : 0;
        if (prevIn !== -1 && inM !== prevIn && soiChanges < MAX_SOI_EVENTS) {
            _soiIdx[soiChanges++] = count;
        }
        prevIn = inM;
        count++;

        if (dE < EARTH_CRASH_R) { impact = { x, y, body: 'earth', index: count - 1 }; break; }
        if (hasMoon && dM < MOON_CRASH_R) { impact = { x, y, body: 'moon', index: count - 1 }; break; }
        if (t >= horizon) break;

        let h = K_STEP * dE * Math.sqrt(dE) / sqE;
        if (hasMoon) {
            const hm = K_STEP * dM * Math.sqrt(dM) / sqM;
            if (hm < h) h = hm;
        }
        if (h < hMin) h = hMin; else if (h > H_MAX) h = H_MAX;
        if (h > horizon - t) h = horizon - t;

        // Kick, drift (Moon advances), kick.
        vx += ax * 0.5 * h; vy += ay * 0.5 * h;
        x += vx * h; y += vy * h;
        ang += w * h;
        mx = ex + EARTH_MOON_R * Math.cos(ang);
        my = ey + EARTH_MOON_R * Math.sin(ang);
        g = gravityAt(x, y, mx, my);
        ax = g.ax; ay = g.ay;
        vx += ax * 0.5 * h; vy += ay * 0.5 * h;
        t += h;
    }
    return { count, impact, soiChanges, endTime: t };
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
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const line = new THREE.Line(lineGeo, lineMat);
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
    let soiRadius = -1;

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
        if (rad > 0 && Math.abs(rad - soiRadius) > 1e-9) {
            soiRadius = rad;
            fillCircle(soiArr, rad);
            soiAttr.needsUpdate = true;
            soiGeo.computeBoundingSphere();
            soiLine.computeLineDistances();
        }
        orbitLine.visible = true;
    }

    function placeSprite(sprite, id, x, y, label) {
        sprite.position.set(x, y, 0);
        sprite.visible = true;
        markers.push({ id, x, y, label });
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
        if (el.bound || Number.isFinite(el.timeToPe)) {
            const px = dom.pos.x + el.rp * Math.cos(el.peAngle);
            const py = dom.pos.y + el.rp * Math.sin(el.peAngle);
            const alt = el.rp - R0;
            let label = alt < 0 ? 'Pe IMPACT' : 'Pe ' + fmtDistance(alt);
            if (Number.isFinite(el.timeToPe)) label += ' in ' + fmtDuration(el.timeToPe);
            placeSprite(peSprite, 'pe', px, py, label);
        }
        if (el.bound && Number.isFinite(el.ra)) {
            const ax = dom.pos.x - el.ra * Math.cos(el.peAngle);
            const ay = dom.pos.y - el.ra * Math.sin(el.peAngle);
            let label = 'Ap ' + fmtDistance(el.ra - R0);
            if (Number.isFinite(el.timeToAp)) label += ' in ' + fmtDuration(el.timeToAp);
            placeSprite(apSprite, 'ap', ax, ay, label);
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
        for (let i = 0; i < n; i++) {
            const c = _inMoon[i] ? MOON_RGB : EARTH_RGB;
            const b = 1 - FADE * _frac[i];
            col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
        }
        posAttr.clearUpdateRanges(); colAttr.clearUpdateRanges();
        posAttr.addUpdateRange(0, n * 3); colAttr.addUpdateRange(0, n * 3);
        posAttr.needsUpdate = true; colAttr.needsUpdate = true;
        lineGeo.setDrawRange(0, n);

        apsisMarkers();

        for (let k = 0; k < res.soiChanges; k++) {
            const i = _soiIdx[k];
            const entering = _inMoon[i] === 1;
            const s = soiSprites[k];
            s.material = entering ? soiInMats[k] : soiOutMats[k];
            placeSprite(s, entering ? 'soi-in' : 'soi-out', pos[i * 3], pos[i * 3 + 1],
                entering ? 'Moon SOI in ' + fmtDuration(_frac[i] * params.lookahead)
                    : 'Leave Moon SOI in ' + fmtDuration(_frac[i] * params.lookahead));
        }
        if (res.impact) {
            const im = res.impact;
            placeSprite(impactSprite, 'impact', im.x, im.y,
                'Impact in ' + fmtDuration(_frac[im.index] * params.lookahead));
        }
    }

    return {
        update,
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
