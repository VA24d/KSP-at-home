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
import { LAUNCH } from './launchdata.js';

export const PHASE = { IDLE: 'IDLE', ASCENT: 'ASCENT', COAST: 'COAST', CIRC: 'CIRC', DONE: 'DONE' };

const ASCENT_TWR = 2.0;        // fallback thrust-to-weight if every stage is empty
const G0 = 9.81;               // m/s^2, real surface gravity
const REAL_S_PER_UNIT = 806.02; // real seconds per sim time unit at G=1
const PAD_ALT = 0.03;
const EARTH_KM = 6371;
const ASCENT_REAL_SECONDS = 7;  // target real-time length of a full-stack burn
const CIRC_TWR = 2.0;          // upper-stage thrust relative to gravity at target
const MAX_PITCH = (88 * Math.PI) / 180;

export const ascent = {
    phase: PHASE.IDLE,
    target: 2,
    time: 0,          // sim time since liftoff
    circAccel: 0,
    pitch: 0,         // current pitch from local vertical (radians), for HUD
    rocket: 'saturn5',
    accelG: 0,        // current thrust acceleration / surface g
    stage: 'stage1',  // part currently burning
    stageFuel: 1,     // 0..1 propellant left in the current stage
    vehicleMassT: 0,  // current stack mass, tonnes
    rate: 0.16,       // ascent pacing, in units of tc
    mecoDrop: [],     // parts still attached at MECO (main separates them)
};

let cfg = null;       // LAUNCH entry in use
let stg = [];         // live stage state
let pending = [];     // stage events waiting to be returned

const guidanceVec = { x: 0, y: 0 };

function stackMass() {
    let m = cfg.payloadT;
    for (const s of stg) if (!s.separated) m += s.dryT + s.prop;
    return m;
}

function activeStages() {
    const out = [];
    for (let i = 0; i < stg.length; i++) {
        if (stg[i].separated) continue;
        if (stg[i].prop <= 0 && stg[i].part === 'spacecraft') continue;
        if (stg[i].prop <= 0) continue;
        out.push(stg[i]);
        if (!stg[i].parallel) break;
    }
    return out;
}

function totalThrust(list, thr) {
    let f = 0;
    for (const s of list) f += s.thrustKN;
    return f * thr;
}

/** Max acceleration (sim units) of the given stages at throttle `thr`. */
function accelOf(list, thr = 1) {
    const mu = params.G * bodies.earth.m;
    return (totalThrust(list, thr) / (stackMass() * G0)) * mu;
}

function setHud(list, a) {
    const mu = params.G * bodies.earth.m;
    ascent.accelG = a / mu;
    ascent.vehicleMassT = stackMass();
    const lead = list[list.length - 1];
    if (lead) {
        ascent.stage = lead.part;
        ascent.stageFuel = Math.max(0, lead.prop / lead.propT);
    }
}

/** Burn propellant for one step of sim time h at `used` fraction of full thrust. */
function burn(list, thr, used, h) {
    const mu = params.G * bodies.earth.m;
    const dtReal = h * REAL_S_PER_UNIT * Math.sqrt(mu);
    for (const s of list) {
        const ve = s.isp * G0 * cfg.dvScale;
        s.prop = Math.max(0, s.prop - (s.thrustKN * thr * used / ve) * dtReal);
        if (s.prop <= 0 && s.part !== 'spacecraft') pending.push(s);
    }
}

export function startAscent(targetRadius, rocketId = 'saturn5') {
    cfg = LAUNCH[rocketId] || LAUNCH.saturn5;
    ascent.rocket = LAUNCH[rocketId] ? rocketId : 'saturn5';
    stg = cfg.stages.map(s => ({
        part: s.part, thrustKN: s.thrustKN, isp: s.isp, dryT: s.dryT, propT: s.propT,
        prop: s.propT, parallel: !!s.parallelWithNext, separated: false,
    }));
    pending = [];
    ascent.mecoDrop = [];
    {   // pace so a full-stack burn of the booster stages lasts ~ASCENT_REAL_SECONDS
        const mu = params.G * bodies.earth.m;
        let tReal = 0, i = 0;
        const ve = s => s.isp * G0 * cfg.dvScale;
        while (i < stg.length) {
            const share = stg[i].part === 'spacecraft' ? (cfg.ascentShip ?? 0) : 1;
            if (share === 0) break;
            let dur = stg[i].propT * ve(stg[i]) / stg[i].thrustKN;
            while (stg[i].parallel && i + 1 < stg.length) {
                i++;
                dur = Math.max(dur, stg[i].propT * ve(stg[i]) / stg[i].thrustKN);
            }
            tReal += dur * share; i++;
        }
        ascent.rate = (tReal / REAL_S_PER_UNIT) / ASCENT_REAL_SECONDS;   // in tc units (tc applied in timeRate)
        void mu;
    }
    ascent.accelG = 0;
    ascent.stage = stg[0].part;
    ascent.stageFuel = 1;
    ascent.vehicleMassT = stackMass();
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
        case PHASE.ASCENT: return ascent.rate * tc;
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

/** Peak acceleration the circularisation burn can use right now. */
function circMax() {
    const list = activeStages();
    return list.length ? accelOf(list) : ascent.circAccel;
}

function relElements() {
    const e = bodies.earth.pos;
    return orbitalElements(r.x - e.x, r.y - e.y, v.x, v.y, params.G * bodies.earth.m);
}

/**
 * Run one guidance cycle; call before every physics step while flying.
 * Returns an event string ('stage:<part>' | 'meco' | 'circ' | 'orbit') or null.
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

            // Staging: a depleted stage separates; the next one takes over.
            if (pending.length) {
                const done = pending.shift();
                done.separated = true;
                return 'stage:' + done.part;
            }

            const ra0 = el.bound ? el.ra : Infinity;
            if (ra0 >= ascent.target * 0.9995) {
                controls.guidance = null;
                ascent.mecoDrop = stg.filter(q => !q.separated && q.part !== 'spacecraft').map(q => q.part);
                for (const q of stg) if (q.part !== 'spacecraft') q.separated = true;
                ascent.accelG = 0;
                ascent.vehicleMassT = stackMass();
                ascent.stage = 'spacecraft';
                ascent.stageFuel = Math.max(0, ...stg.filter(q => q.part === 'spacecraft').map(q => q.prop / q.propT));
                ascent.phase = PHASE.COAST;
                return 'meco';
            }

            const list = activeStages();
            let thr = 1;
            if (cfg.maxQ) {
                const altKm = (rm - 1 - PAD_ALT) * EARTH_KM;
                if (altKm > 8 && altKm < 15) thr = 0.7;
            }

            // Exact cut-off: if a full step would overshoot the target apoapsis,
            // scale this final step so it lands on it (apoapsis is monotonic in
            // the added velocity over one small step).
            const useFallback = list.length === 0;
            let a = useFallback ? ASCENT_TWR * mu : accelOf(list, thr);
            const aFull = a;
            // A weak stage must not tip over faster than it can hold altitude:
            // vertical thrust has to cover gravity less centrifugal relief.
            if (el.vr < 0.15 && a > 0) {
                const vh = Math.abs(el.h) / rm;
                const need = Math.max(0, mu / (rm * rm) - vh * vh / rm) * 1.08;
                pitch = Math.min(pitch, Math.acos(Math.min(1, need / a)));
            }
            ascent.pitch = pitch;
            const c = Math.cos(pitch), s = Math.sin(pitch);
            const dx = c * rhx + s * thx, dy = c * rhy + s * thy;

            const dv = a * h;
            const el1 = orbitalElements(rx, ry, v.x + dx * dv, v.y + dy * dv, mu);
            const ra1 = el1.bound ? el1.ra : Infinity;
            if (ra1 > ascent.target) {
                const frac = Number.isFinite(ra1) && ra1 > ra0
                    ? (ascent.target - ra0) / (ra1 - ra0)
                    : 0.5;
                a *= Math.min(1, Math.max(0.01, frac));
            }
            if (!useFallback) burn(list, thr, a / aFull, h);
            guidanceVec.x = a * dx;
            guidanceVec.y = a * dy;
            controls.guidance = guidanceVec;
            setHud(list, a);
            return null;
        }

        case PHASE.COAST: {
            controls.guidance = null;
            ascent.pitch = Math.PI / 2;
            // Burn centred on apoapsis: start half a burn early.
            const vApo = el.bound ? Math.abs(el.h) / el.ra : 0;
            const dv = Math.max(0, Math.sqrt(mu / el.ra) - vApo);
            const burnTime = dv / circMax();
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
            const list = activeStages();
            const useFallback = list.length === 0;
            const amax = useFallback ? ascent.circAccel : accelOf(list);
            const a = Math.min(want, amax);
            if (!useFallback) burn(list, 1, a / amax, h);
            setHud(list, a);
            guidanceVec.x = (exv / err) * a;
            guidanceVec.y = (eyv / err) * a;
            controls.guidance = guidanceVec;
            ascent.pitch = Math.atan2(exv * thx + eyv * thy, exv * rhx + eyv * rhy);
            return null;
        }
    }
    return null;
}
