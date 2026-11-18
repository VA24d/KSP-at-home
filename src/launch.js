// Launch guidance: a physics-based gravity-turn ascent to a circular orbit.
//
// The launch vehicle flies the same integrator as the spacecraft. Guidance sets
// an explicit acceleration vector (controls.guidance), so the booster has its
// own propellant and the spacecraft reaches orbit with its tanks full.
//
//   ASCENT  vertical rise, then a smooth pitch-over toward the downrange
//           (clockwise) horizontal; main engine cut-off (MECO) once the
//           apoapsis reaches the target radius
//   COAST   unpowered climb to apoapsis (booster separates at MECO)
//   CIRC    upper-stage burn centred on apoapsis, closed loop on the velocity
//           error to the local circular velocity
//   DONE    stable circular orbit; hand control to the pilot

import { params, bodies, controls, r, v } from './maneuver.js';
import { orbitalElements } from './orbit.js';

export const PHASE = { IDLE: 'IDLE', ASCENT: 'ASCENT', COAST: 'COAST', CIRC: 'CIRC', DONE: 'DONE' };

const ASCENT_TWR = 2.0;        // booster thrust-to-weight at the pad
const CIRC_TWR = 2.0;          // upper-stage thrust relative to gravity at target
const MAX_PITCH = (88 * Math.PI) / 180;

export const ascent = {
    phase: PHASE.IDLE,
    target: 2,
    time: 0,          // sim time since liftoff
    circAccel: 0,
    pitch: 0,         // current pitch from local vertical (radians), for HUD
};

const guidanceVec = { x: 0, y: 0 };

export function startAscent(targetRadius) {
    ascent.phase = PHASE.ASCENT;
    ascent.target = Math.max(1.1, targetRadius);
    ascent.time = 0;
    ascent.pitch = 0;
    const mu = params.G * bodies.earth.m;
    ascent.circAccel = CIRC_TWR * mu / (ascent.target * ascent.target);
}

export function abortAscent() {
    ascent.phase = PHASE.IDLE;
    controls.guidance = null;
}

export function isFlying() {
    return ascent.phase === PHASE.ASCENT || ascent.phase === PHASE.COAST || ascent.phase === PHASE.CIRC;
}

/** Real-time pacing: sim time units per real second for the current phase. */
export function timeRate() {
    const mu = params.G * bodies.earth.m;
    const tc = 1 / Math.sqrt(mu);                 // characteristic time at the surface
    switch (ascent.phase) {
        case PHASE.ASCENT: return 0.16 * tc;
        case PHASE.CIRC: return 0.3 * tc * ascent.target ** 1.5;   // scale with the orbital timescale
        case PHASE.COAST: {
            // Speed the coast up so it lasts a few seconds whatever the target.
            const el = relElements();
            const left = Number.isFinite(el.timeToAp) ? el.timeToAp : 1;
            return Math.min(Math.max(left / 3, 0.3 * tc), 20 * tc);
        }
        default: return 0.5 * tc;
    }
}

function relElements() {
    const e = bodies.earth.pos;
    return orbitalElements(r.x - e.x, r.y - e.y, v.x, v.y, params.G * bodies.earth.m);
}

/**
 * Run one guidance cycle; call before every physics step while flying.
 * Returns an event string ('meco' | 'circ' | 'orbit') on a phase change, else null.
 */
export function updateAscent(h) {
    if (!isFlying()) return null;
    ascent.time += h;

    const e = bodies.earth.pos;
    const rx = r.x - e.x, ry = r.y - e.y;
    const rm = Math.hypot(rx, ry);
    const rhx = rx / rm, rhy = ry / rm;               // local vertical
    const thx = rhy, thy = -rhx;                      // downrange (clockwise) horizontal
    const mu = params.G * bodies.earth.m;
    const el = orbitalElements(rx, ry, v.x, v.y, mu);

    switch (ascent.phase) {
        case PHASE.ASCENT: {
            const alt = rm - 1;
            const turnAlt = Math.min(Math.max(0.45 * (ascent.target - 1), 0.05), 1.2);
            const frac = Math.min(Math.max((alt - 0.004) / turnAlt, 0), 1);
            let pitch = MAX_PITCH * Math.sqrt(frac);
            // Never let the climb stall: if falling before MECO, pitch back up.
            if (el.vr < 0.02) pitch = Math.min(pitch, (55 * Math.PI) / 180);
            ascent.pitch = pitch;

            const ra0 = el.bound ? el.ra : Infinity;
            if (ra0 >= ascent.target * 0.9995) {
                controls.guidance = null;
                ascent.phase = PHASE.COAST;
                return 'meco';
            }

            // Exact cut-off: if a full step would overshoot the target apoapsis,
            // scale this final step so it lands on it (apoapsis is monotonic in
            // the added velocity over one small step).
            const c = Math.cos(pitch), s = Math.sin(pitch);
            const dx = c * rhx + s * thx, dy = c * rhy + s * thy;
            let a = ASCENT_TWR * mu;
            const dv = a * h;
            const el1 = orbitalElements(rx, ry, v.x + dx * dv, v.y + dy * dv, mu);
            const ra1 = el1.bound ? el1.ra : Infinity;
            if (ra1 > ascent.target) {
                const frac = Number.isFinite(ra1) && ra1 > ra0
                    ? (ascent.target - ra0) / (ra1 - ra0)
                    : 0.5;
                a *= Math.min(1, Math.max(0.01, frac));
            }
            guidanceVec.x = a * dx;
            guidanceVec.y = a * dy;
            controls.guidance = guidanceVec;
            return null;
        }

        case PHASE.COAST: {
            controls.guidance = null;
            ascent.pitch = Math.PI / 2;
            // Burn centred on apoapsis: start half a burn early.
            const vApo = el.bound ? Math.abs(el.h) / el.ra : 0;
            const dv = Math.max(0, Math.sqrt(mu / el.ra) - vApo);
            const burnTime = dv / ascent.circAccel;
            if (!el.bound || el.vr <= 0 || el.timeToAp <= burnTime / 2) {
                ascent.phase = PHASE.CIRC;
                return 'circ';
            }
            return null;
        }

        case PHASE.CIRC: {
            // Target: circular speed, purely horizontal, downrange.
            const vc = Math.sqrt(mu / rm);
            const exv = vc * thx - v.x;
            const eyv = vc * thy - v.y;
            const err = Math.hypot(exv, eyv);
            if (err < 5e-4 * vc) {
                controls.guidance = null;
                ascent.phase = PHASE.DONE;
                return 'orbit';
            }
            // Dead-beat: cancel the error in one step if the engine allows.
            const want = err / h;
            const a = Math.min(want, ascent.circAccel);
            guidanceVec.x = (exv / err) * a;
            guidanceVec.y = (eyv / err) * a;
            controls.guidance = guidanceVec;
            ascent.pitch = Math.atan2(exv * thx + eyv * thy, exv * rhx + eyv * rhy);
            return null;
        }
    }
    return null;
}
