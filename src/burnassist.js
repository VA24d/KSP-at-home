// Burn assist: for the zone the craft is in (or the burn it is flying), work out
// the burn's target, its progress 0..1 and a preview of the orbit the craft
// would reach if it finished the burn now (impulsive, along prograde/retrograde).
// The math is pure (createAssistCore, neededDv, applyBurn, conicPoints); the
// three.js part only draws the preview line.
import * as THREE from 'three';
import { params, r, v, EARTH_MOON_R, dominantBody } from './maneuver.js';
import { orbitalElements } from './orbit.js';
import { PLANETS } from './solar.js';
import { zoneInfo } from './burnzones.js';

const TAU = Math.PI * 2;
const NONE = { label: '', kind: null, progress: 0, done: false, neededDv: 0, remainingDv: 0, grade: null, cutoff: false };

const elOf = (rel, mu) => orbitalElements(rel.rx, rel.ry, rel.vx, rel.vy, mu);
const scaled = (rel, k) => ({ rx: rel.rx, ry: rel.ry, vx: rel.vx * k, vy: rel.vy * k });

/** Orbit after an impulsive burn of `dv` (signed, + prograde) along the current velocity. */
export function applyBurn(rel, mu, dv) {
    const sp = Math.hypot(rel.vx, rel.vy);
    const k = sp > 0 ? Math.max(0, (sp + dv) / sp) : 1;
    return elOf(scaled(rel, k), mu);
}

/**
 * Signed delta-v (+ prograde, - retrograde) the zone's burn needs from this state.
 * zone = { kind: 'ap'|'pe'|'tli'|'planet', vInf? }.
 */
export function neededDv(zone, rel, mu) {
    const rr = Math.hypot(rel.rx, rel.ry);
    const sp = Math.hypot(rel.vx, rel.vy);
    if (zone.kind === 'ap' || zone.kind === 'pe') return Math.sqrt(mu / rr) - sp;
    if (zone.kind === 'planet') return Math.sqrt(zone.vInf * zone.vInf + (2 * mu) / rr) - sp;
    if (zone.kind === 'tli') {
        if (elOf(rel, mu).ra >= EARTH_MOON_R) return 0;
        // ra grows monotonically with the speed scale k; bisect up to escape speed.
        let lo = 1, hi = (Math.sqrt((2 * mu) / rr) / sp) * 0.99999;
        for (let i = 0; i < 70; i++) {
            const mid = (lo + hi) / 2;
            if (elOf(scaled(rel, mid), mu).ra < EARTH_MOON_R) lo = mid; else hi = mid;
        }
        return (hi - 1) * sp;
    }
    return 0;
}

/** Points of a conic (relative to its focus), clipped to radius rmax. Returns [x0,y0,x1,y1,...]. */
export function conicPoints(el, mu, n = 160, rmax = 60) {
    const p = (el.h * el.h) / mu;
    const s = el.h < 0 ? -1 : 1;
    let nuMax = Math.PI;
    if (el.e >= 1 - 1e-9) {
        const c = (p / rmax - 1) / el.e;
        nuMax = Math.acos(Math.max(-1, Math.min(1, c))) * 0.999;
    } else if (el.e < 1e-6) {
        nuMax = Math.PI;
    }
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const nu = -nuMax + (2 * nuMax * i) / n;
        const rr = p / (1 + el.e * Math.cos(nu));
        const a = el.peAngle + s * nu;
        pts.push(rr * Math.cos(a), rr * Math.sin(a));
    }
    return pts;
}

function labelFor(zone) {
    if (zone.kind === 'tli') return 'MOON TRANSFER';
    if (zone.kind === 'planet') return `${(PLANETS[zone.target] || { label: 'PLANET' }).label} EJECTION`;
    return 'CIRCULARIZE';
}

/**
 * Stateful, renderer-free core. step({rel, mu, zone, burning}) -> result with
 * { label, kind, progress, done, neededDv, remainingDv, grade, cutoff, preview }.
 * `zone` is zoneInfo()-shaped. A burn that starts inside a zone stays "captured"
 * (even after the craft drifts out of the zone) until the pilot stops burning
 * and the zone changes.
 */
export function createAssistCore() {
    let cap = null;
    return {
        reset() { cap = null; },
        step({ rel, mu, zone, burning }) {
            const sameZone = cap && zone && zone.kind === cap.zone.kind && zone.target === cap.zone.target;
            if (cap && !burning && !sameZone) cap = null;
            if (!cap && burning && zone && zone.kind) {
                const el0 = elOf(rel, mu);
                cap = {
                    zone: { ...zone }, e0: el0.e, r0: el0.r, grade: zone.grade,
                    need0: Math.abs(neededDv(zone, rel, mu)),
                };
            }
            const z = cap ? cap.zone : zone;
            if (!z || !z.kind) return { ...NONE, preview: null };
            const el = elOf(rel, mu);
            const dv = neededDv(z, rel, mu);
            const remaining = Math.abs(dv);
            let progress = 0, done = false;
            if (z.kind === 'tli') {
                const r0 = cap ? cap.r0 : el.r;
                progress = !Number.isFinite(el.ra) || !el.bound ? 1 : (el.ra - r0) / Math.max(1e-6, EARTH_MOON_R - r0);
            } else if (z.kind === 'planet') {
                const vi2 = el.speed * el.speed - (2 * mu) / el.r;
                progress = vi2 > 0 ? Math.sqrt(vi2) / z.vInf : 0;
            } else {
                const e0 = cap ? cap.e0 : el.e;
                progress = e0 > 1e-9 ? 1 - el.e / e0 : 0;
                if (cap) {
                    const other = z.kind === 'ap' ? el.rp : el.ra;
                    if (el.e < 0.005 || (el.bound && Math.abs(other - el.r) <= 0.005 * el.r)) progress = 1;
                }
            }
            progress = Math.max(0, Math.min(1, progress));
            done = progress >= 1;
            const preview = el.bound || el.e > 1 ? applyBurn(rel, mu, dv) : null;
            return {
                label: labelFor(z), kind: z.kind, progress, done,
                neededDv: cap ? cap.need0 : remaining, remainingDv: done ? 0 : remaining,
                grade: cap ? cap.grade : z.grade, cutoff: done, preview,
            };
        },
    };
}

export function createBurnAssist(scene) {
    const N = 160;
    const core = createAssistCore();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
    const mat = new THREE.LineDashedMaterial({
        color: 0xffe14d, dashSize: 0.5, gapSize: 0.3, transparent: true, opacity: 0.9, depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 7;
    line.visible = false;
    scene.add(line);
    let visible = true;
    let last = { ...NONE, preview: null };
    let previewInfo = { valid: false, kind: null, ra: 0, rp: 0, e: 0 };

    function update(ctx = {}) {
        line.visible = false;
        previewInfo = { valid: false, kind: null, ra: 0, rp: 0, e: 0 };
        const dom = dominantBody(r);
        const rel = { rx: r.x - dom.pos.x, ry: r.y - dom.pos.y, vx: v.x - dom.vel.x, vy: v.y - dom.vel.y };
        const res = core.step({ rel, mu: dom.mu, zone: zoneInfo(), burning: !!ctx.burning });
        last = res;
        if (visible && res.preview && res.kind) {
            const pts = conicPoints(res.preview, dom.mu, N, 60);
            const arr = geo.attributes.position.array;
            const cnt = pts.length / 2;
            for (let i = 0; i < cnt; i++) {
                arr[i * 3] = dom.pos.x + pts[i * 2]; arr[i * 3 + 1] = dom.pos.y + pts[i * 2 + 1]; arr[i * 3 + 2] = 0.003;
            }
            geo.attributes.position.needsUpdate = true;
            geo.setDrawRange(0, cnt);
            line.computeLineDistances();
            line.visible = true;
            previewInfo = { valid: true, kind: res.kind, ra: res.preview.ra, rp: res.preview.rp, e: res.preview.e };
        }
        const { preview, ...rest } = res;
        return rest;
    }

    return {
        update,
        getPreview() { return previewInfo; },
        setVisible(b) { visible = b; if (!b) line.visible = false; },
        reset() { core.reset(); },
        dispose() { geo.dispose(); mat.dispose(); scene.remove(line); },
    };
}
