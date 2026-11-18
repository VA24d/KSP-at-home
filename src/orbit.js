// Two-body orbital elements and display formatting.
import { KM_PER_UNIT, MPS_PER_UNIT, TIME_UNIT_S } from './maneuver.js';

const TWO_PI = Math.PI * 2;

/**
 * Osculating two-body elements of a craft relative to a central body.
 * rx, ry / vx, vy are RELATIVE position and velocity; mu = G·M of the body.
 *
 * Returns:
 *   r, speed, vr (radial speed, + outward), a, e, rp, ra (Infinity if unbound),
 *   period (Infinity if unbound), energy, h (signed angular momentum; < 0 = clockwise),
 *   peAngle (direction of periapsis, radians), timeToPe, timeToAp (Infinity if n/a),
 *   bound (boolean)
 */
export function orbitalElements(rx, ry, vx, vy, mu) {
    const r = Math.hypot(rx, ry);
    const v2 = vx * vx + vy * vy;
    const speed = Math.sqrt(v2);
    const rdotv = rx * vx + ry * vy;
    const vr = r > 0 ? rdotv / r : 0;
    const h = rx * vy - ry * vx;
    const energy = v2 / 2 - mu / r;

    // Eccentricity vector: ((v² − mu/r)·r − (r·v)·v) / mu
    const k = v2 - mu / r;
    const ex = (k * rx - rdotv * vx) / mu;
    const ey = (k * ry - rdotv * vy) / mu;
    const e = Math.hypot(ex, ey);
    const peAngle = e > 1e-9 ? Math.atan2(ey, ex) : Math.atan2(ry, rx);

    const p = (h * h) / mu;                 // semi-latus rectum
    const rp = p / (1 + e);
    // Negative energy = bound (includes the degenerate radial case e = 1).
    const bound = energy < 0;
    const a = Math.abs(energy) > 1e-12 ? -mu / (2 * energy) : Infinity;
    const ra = bound ? a * (1 + Math.min(e, 1)) : Infinity;
    const period = bound ? TWO_PI * Math.sqrt((a * a * a) / mu) : Infinity;

    let timeToPe = Infinity;
    let timeToAp = Infinity;
    if (bound && e > 1e-6) {
        // Eccentric anomaly from r = a(1 − e cos E); sign from radial velocity.
        const cosE = Math.min(1, Math.max(-1, (1 - r / a) / e));
        let E = Math.acos(cosE);
        if (rdotv < 0) E = TWO_PI - E;
        const M = E - e * Math.sin(E);
        const n = Math.sqrt(mu / (a * a * a));
        timeToPe = ((TWO_PI - M) % TWO_PI) / n;
        timeToAp = ((((Math.PI - M) % TWO_PI) + TWO_PI) % TWO_PI) / n;
    } else if (!bound && rdotv < 0 && e > 1) {
        // Hyperbolic approach: time to periapsis via hyperbolic anomaly.
        const aH = -a; // positive
        const coshF = Math.max(1, (1 + r / aH) / e);
        const F = Math.acosh(coshF);
        const Mh = e * Math.sinh(F) - F;
        timeToPe = Mh / Math.sqrt(mu / (aH * aH * aH));
    }

    return { r, speed, vr, a, e, rp, ra, period, energy, h, peAngle, timeToPe, timeToAp, bound };
}

// ---------------------------------------------------------------------------
// Formatting (sim units → real-world units)

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtDistance(units) {
    if (!Number.isFinite(units)) return '∞';
    const km = units * KM_PER_UNIT;
    if (Math.abs(km) >= 1e6) return (km / 1e6).toFixed(2) + ' Gm';
    return nf0.format(km) + ' km';
}

export function fmtSpeed(unitsPerTime) {
    if (!Number.isFinite(unitsPerTime)) return '∞';
    const mps = unitsPerTime * MPS_PER_UNIT;
    if (Math.abs(mps) >= 10000) return (mps / 1000).toFixed(2) + ' km/s';
    return nf0.format(mps) + ' m/s';
}

/** 1 sim acceleration unit = 1 g₀ by construction of the units. */
export function fmtAccel(unitsPerTime2) {
    return (unitsPerTime2 * 9.80665).toFixed(2) + ' m/s²';
}

/** Sim time units → "1d 02:03:04" / "02:03:04" / "03:04". */
export function fmtDuration(simTime) {
    if (!Number.isFinite(simTime)) return '—';
    let s = Math.max(0, Math.round(simTime * TIME_UNIT_S));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
}

export function fmtMET(simTime) {
    let s = Math.max(0, Math.floor(simTime * TIME_UNIT_S));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `T+ ${d > 0 ? d + 'd ' : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}
