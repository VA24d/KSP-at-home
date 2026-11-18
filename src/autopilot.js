// Autopilot System
//
// Modes (all converge on, and then HOLD, a circular orbit):
//
//  - 'circularize': burn now to circularize around the nearest body, then stop.
//  - 'moon': phase for the transfer window, prograde TLI to raise apoapsis to
//    the Moon, coast, raise the lunar periapsis to a safe altitude on approach,
//    circularize at the chosen altitude, then ALT-HOLD it.
//  - 'hold' (alt-hold): continuously trim the orbit to hold the current
//    circular altitude against perturbations (lunar tides, Moon pull).

import {
    controls, params, rocketParams, bodies, moonVelocity, moonAngularRate,
    deltaVRemaining, maxAcceleration, thrustFrameVelocity, exhaustVelocity, thrustState, MOON_RADIUS, EARTH_MOON_R,
} from './maneuver.js';
import { circularizationError, getNearestBody } from './circularize.js';
import { orbitalElements } from './orbit.js';
import { RCS_FRACTION } from './maneuver.js';

const RCS_K = RCS_FRACTION;

const MOON_SOI = 6;          // distance at which we start managing the approach
const TLI_APOAPSIS = EARTH_MOON_R - 0.6; // aim just inside the Moon's orbit; its pull does the rest
const CAPTURE_EST = 20;      // rough sim time for approach + capture, for the ETA

export const PHASES = {
    IDLE: 'IDLE',
    PHASING: 'PHASING',
    TLI_BURN: 'TLI_BURN',
    COAST: 'COAST',
    APPROACH: 'APPROACH',
    MCC: 'MCC',
    CAPTURE: 'CAPTURE',
    CIRCULARIZE: 'CIRCULARIZE',
    HOLD: 'HOLD',
    ORBIT_ACHIEVED: 'ORBIT_ACHIEVED',
    RTE_ESCAPE: 'RTE_ESCAPE',
    RTE_BURN: 'RTE_BURN',
    RTE_COAST: 'RTE_COAST',
};

const PHASE_TEXT = {
    IDLE: '-',
    PHASING: 'Phasing: waiting for transfer window',
    TLI_BURN: 'TLI burn: raising orbit toward Moon',
    COAST: 'Coasting toward Moon',
    APPROACH: 'Approach: trimming lunar periapsis',
    MCC: 'Mid-course correction',
    CAPTURE: 'Lunar orbit insertion',
    CIRCULARIZE: 'Circularizing orbit',
    HOLD: 'Alt-hold: maintaining orbit',
    ORBIT_ACHIEVED: 'Orbit achieved',
    RTE_ESCAPE: 'Return: leaving lunar orbit',
    RTE_BURN: 'Return burn: lowering Earth periapsis',
    RTE_COAST: 'Coasting back to Earth',
};

function normalizeAngle(x) {
    x %= 2 * Math.PI;
    if (x < -Math.PI) x += 2 * Math.PI;
    if (x >= Math.PI) x -= 2 * Math.PI;
    return x;
}

const state = {
    active: false,
    phase: PHASES.IDLE,
    mode: 'circularize',        // 'circularize' | 'moon' | 'hold'
    burnType: '',
    plannedDeltaV: 0,
    accumulatedDeltaV: 0,
    remainingDv: 0,
    orbitAchievedTime: 0,
    abortReason: '',
    coastFrames: 0,
    closestApproach: Infinity,
    periapsisReached: false,
    targetLunarR: 1.2,          // desired circular lunar-orbit radius
    targetEarthR: 2,            // desired circular Earth-orbit radius (return)
    simTime: 0,                 // sim-seconds since engage
    tliTime: 0,                 // simTime at which the TLI burn started
    transferTime: 0,            // half-period of the transfer ellipse
    phaseWait: 0,               // estimated sim-seconds left in PHASING
    etaSeconds: 0,              // estimated time to a stable orbit
};

// Getters
export function getPhase() { return state.phase; }
export function isActive() { return state.active; }
export function isHolding() { return state.active && state.phase === PHASES.HOLD; }
export function getAbortReason() { return state.abortReason; }
export function getBurnType() { return state.burnType; }

export function getTelemetry() {
    if (!state.active && state.phase === PHASES.IDLE) {
        return { phaseText: '-', remainingDv: 0, etaSeconds: 0 };
    }
    let phaseText = PHASE_TEXT[state.phase] || state.phase;
    return { phaseText, remainingDv: Math.max(0, state.remainingDv), etaSeconds: state.etaSeconds };
}

// Helpers
function mag(x, y) { return Math.hypot(x, y); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

// The Moon's velocity at the current sim time (moonPos is always the current
// Moon position at the call sites).
function getMoonVelocity() {
    return moonVelocity();
}

function moonRelPeriapsis(pos, vel, moonPos) {
    const mv = getMoonVelocity(moonPos);
    const rx = pos.x - moonPos.x;
    const ry = pos.y - moonPos.y;
    const vx = vel.x - mv.x;
    const vy = vel.y - mv.y;
    const r = Math.hypot(rx, ry);
    const mu = params.G * bodies.moon.m;
    if (mu <= 0) return { rp: r, h: rx * vy - ry * vx };
    const h = rx * vy - ry * vx;
    const v2 = vx * vx + vy * vy;
    const energy = v2 / 2 - mu / r;
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
    return { rp: (h * h / mu) / (1 + e), h };
}

// dir = +1 raises the lunar periapsis, -1 lowers it.
function raisePeriapsis(pos, vel, moonPos, dir = 1) {
    const { h } = moonRelPeriapsis(pos, vel, moonPos);
    const rx = pos.x - moonPos.x;
    const ry = pos.y - moonPos.y;
    const sign = h >= 0 ? 1 : -1;
    // Gradient of |h| (hence of periapsis) wrt added velocity; thrust along it
    // with whatever main-engine / RCS combination points that way.
    const desX = dir * sign * -ry;
    const desY = dir * sign * rx;
    burnToward(desX, desY, vel);
}

// Thrust to push the velocity toward direction (dx, dy), using whichever
// prograde/retrograde + normal combination is available. The thrust axes are
// the physics' axes (relative to the dominant body), not the absolute velocity.
const _axis = { x: 0, y: 0 };
function burnToward(dx, dy) {
    const fv = thrustFrameVelocity(_axis);
    const s = Math.hypot(fv.x, fv.y) || 1;
    const vhx = fv.x / s, vhy = fv.y / s;
    const nhx = -vhy, nhy = vhx;
    const along = dx * vhx + dy * vhy;
    const perp = dx * nhx + dy * nhy;
    const mag2 = Math.hypot(dx, dy) || 1;
    const gate = 0.04 * mag2;
    controls.prograding = along > gate;
    controls.retrograding = along < -gate;
    controls.normalPos = perp > gate;
    controls.normalNeg = perp < -gate;
    state.burnType = controls.prograding ? 'prograde'
        : controls.retrograding ? 'retrograde'
            : controls.normalPos ? 'normal+'
                : controls.normalNeg ? 'normal-' : '';
}

// Apoapsis distance about the Moon (Infinity if unbound).
function moonRelApoapsis(pos, vel, moonPos) {
    const mv = getMoonVelocity(moonPos);
    const rx = pos.x - moonPos.x, ry = pos.y - moonPos.y;
    const vx = vel.x - mv.x, vy = vel.y - mv.y;
    const r = Math.hypot(rx, ry);
    const mu = params.G * bodies.moon.m;
    if (mu <= 0) return Infinity;
    const h = rx * vy - ry * vx;
    const energy = (vx * vx + vy * vy) / 2 - mu / r;
    if (energy >= 0) return Infinity;
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
    return (h * h / mu) / (1 - e);
}

// Periapsis distance about Earth (Earth is stationary, so absolute velocity).
function earthPeriapsis(pos, vel) {
    const dx = pos.x - bodies.earth.pos.x;
    const dy = pos.y - bodies.earth.pos.y;
    const r = Math.hypot(dx, dy);
    const mu = params.G * bodies.earth.m;
    const h = dx * vel.y - dy * vel.x;
    const v2 = vel.x * vel.x + vel.y * vel.y;
    const energy = v2 / 2 - mu / r;
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
    return { rp: (h * h / mu) / (1 + e), r };
}

function computeAvailableDv() {
    return deltaVRemaining();
}

// Closed-loop circularize step around `body`. Returns the velocity error.
// Closed-loop circularize step around `body`. Each axis fires only while its
// error exceeds half the delta-v one step of that thruster delivers, so the
// loop settles instead of chattering at high thrust. With `hold`, corrections
// start only once the error exceeds a wider band (hysteresis).
// Returns { errMag, firing }.
function circStep(pos, vel, body, moonPos, dt, hold = false) {
    const bodyVel = body === bodies.moon ? getMoonVelocity(moonPos) : { x: 0, y: 0 };
    const { errAlong, errPerp, errMag } = circularizationError(pos, vel, body, params.G, bodyVel);
    const stepMain = maxAcceleration() * dt;
    const stepRcs = stepMain * RCS_K;

    if (hold) {
        const band = Math.max(stepMain * 6, 2e-3);
        if (!state.holdCorrecting && errMag > band) state.holdCorrecting = true;
        if (!state.holdCorrecting) { stopAllBurns(); return { errMag, firing: false }; }
    }

    controls.prograding = errAlong > stepMain / 2;
    controls.retrograding = errAlong < -stepMain / 2;
    controls.normalPos = errPerp > stepRcs / 2;
    controls.normalNeg = errPerp < -stepRcs / 2;
    const firing = controls.prograding || controls.retrograding || controls.normalPos || controls.normalNeg;
    state.burnType = controls.prograding ? 'prograde'
        : controls.retrograding ? 'retrograde'
            : controls.normalPos ? 'normal+'
                : controls.normalNeg ? 'normal-' : '';
    if (!firing) {
        stopAllBurns();
        state.holdCorrecting = false;
    }
    return { errMag, firing };
}

// Public API

export function engage(mode, pos, vel, opts = {}) {
    if (state.active && state.mode !== 'hold') return { success: false, reason: 'Already active' };

    resetTransient();
    if (mode === 'moon') state.mode = 'moon';
    else if (mode === 'earth') state.mode = 'earth';
    else state.mode = 'circularize';

    if (state.mode === 'circularize') {
        state.active = true;
        state.phase = PHASES.CIRCULARIZE;
        return { success: true };
    }

    if (state.mode === 'earth') {
        // Return to Earth: drop the Earth periapsis to a low orbit, coast in,
        // circularize. Works from a lunar orbit or anywhere out near the Moon.
        state.targetEarthR = Number.isFinite(opts.earthR) ? opts.earthR : 2;
        state.active = true;
        state.phase = PHASES.RTE_ESCAPE;
        return { success: true };
    }

    // Moon transfer.
    state.targetLunarR = Number.isFinite(opts.lunarR) ? opts.lunarR : 1.2;
    const earthPos = bodies.earth.pos;
    const r = dist(pos.x, pos.y, earthPos.x, earthPos.y);
    const vCurrent = mag(vel.x, vel.y);
    const a = (r + EARTH_MOON_R) / 2;
    const vTransfer = Math.sqrt(params.G * bodies.earth.m * (2 / r - 1 / a));
    const tliDv = Math.max(0, vTransfer - vCurrent);

    const available = computeAvailableDv();
    if (available < tliDv * 2) {
        state.abortReason = 'LOW ΔV FOR TRANSFER';
        return { success: false, reason: state.abortReason };
    }

    state.active = true;
    state.phase = PHASES.PHASING;
    state.plannedDeltaV = tliDv;
    return { success: true };
}

// Alt-hold: maintain the current circular altitude. Overrides any other mode.
export function engageHold() {
    resetTransient();
    state.mode = 'hold';
    state.active = true;
    state.phase = PHASES.HOLD;
    return { success: true };
}

function resetTransient() {
    state.abortReason = '';
    state.accumulatedDeltaV = 0;
    state.remainingDv = 0;
    state.burnType = '';
    state.coastFrames = 0;
    state.closestApproach = Infinity;
    state.periapsisReached = false;
    state.correctDir = 0;
    state.escapeStarted = false;
    state.escapePlan = null;
    state.mccDone = false;
    state.mcc = null;
    state.mccDvx = 0;
    state.mccDvy = 0;
    state.mccArmed = false;
    state.holdCorrecting = false;
    state.trims = 0;
    state.simTime = 0;
    state.tliTime = 0;
    state.transferTime = 0;
    state.phaseWait = 0;
    state.etaSeconds = 0;
}

export function cancel() {
    stopAllBurns();
    controls.automated = false;
    state.active = false;
    state.phase = PHASES.IDLE;
    state.plannedDeltaV = 0;
    state.accumulatedDeltaV = 0;
    state.remainingDv = 0;
    state.etaSeconds = 0;
    state.burnType = '';
    state.mode = 'circularize';
}

export function update(dt, pos, vel, moonPos) {
    if (!state.active) return;
    state.simTime += dt;
    controls.automated = true;

    const distToMoon = dist(pos.x, pos.y, moonPos.x, moonPos.y);

    switch (state.phase) {
        case PHASES.PHASING: {
            stopAllBurns();
            const earth = bodies.earth.pos;
            const thetaC = Math.atan2(pos.y - earth.y, pos.x - earth.x);
            const thetaM = Math.atan2(moonPos.y - earth.y, moonPos.x - earth.x);
            const r = dist(pos.x, pos.y, earth.x, earth.y);
            const a = (r + EARTH_MOON_R) / 2;
            state.transferTime = Math.PI * Math.sqrt((a * a * a) / (params.G * bodies.earth.m));
            const omegaM = moonAngularRate();
            // Estimate the wait from the closing rate of the phase angle.
            const rxE = pos.x - earth.x, ryE = pos.y - earth.y;
            const omegaC = (rxE * vel.y - ryE * vel.x) / (r * r);
            const relRate = Math.abs(omegaM - omegaC);
            // Centre the finite burn on the impulsive transfer point: start half
            // a burn early (rocket equation gives the burn's duration).
            const vT = Math.sqrt(params.G * bodies.earth.m * (2 / r - 1 / a));
            const dvT = Math.max(0, vT - mag(vel.x, vel.y));
            const ve = exhaustVelocity();
            const m0 = rocketParams.dryMass + rocketParams.fuelMass;
            const m1 = m0 * Math.exp(-dvT / Math.max(ve, 1e-9));
            const burnTime = rocketParams.thrust > 0 ? ((m0 - m1) * ve) / rocketParams.thrust : 0;
            const required = normalizeAngle(-Math.PI - omegaM * state.transferTime
                - (omegaM - omegaC) * burnTime / 2);
            const diff = normalizeAngle((thetaM - thetaC) - required);
            state.phaseWait = relRate > 1e-6 ? Math.abs(diff) / relRate : 0;

            if (Math.abs(diff) < 0.03) {
                const vTransfer = Math.sqrt(params.G * bodies.earth.m * (2 / r - 1 / a));
                state.plannedDeltaV = Math.max(0, vTransfer - mag(vel.x, vel.y));
                state.accumulatedDeltaV = 0;
                state.tliTime = state.simTime;
                state.phase = PHASES.TLI_BURN;
            }
            break;
        }

        case PHASES.TLI_BURN: {
            // Closed loop on the Earth-relative apoapsis (finite-burn losses
            // make an open-loop delta-v target fall short).
            setBurn('prograde');
            accumulateDv(dt);
            state.remainingDv = Math.max(0, state.plannedDeltaV - state.accumulatedDeltaV);
            const e = bodies.earth.pos;
            const el = orbitalElements(pos.x - e.x, pos.y - e.y, vel.x, vel.y, params.G * bodies.earth.m);
            if (!el.bound || el.ra >= TLI_APOAPSIS) {
                stopAllBurns();
                state.phase = PHASES.COAST;
                state.coastFrames = 0;
                state.tliTime = state.simTime;
            }
            break;
        }

        case PHASES.COAST:
            stopAllBurns();
            state.coastFrames++;
            // One mid-course correction, planned by numerical shooting a few
            // time units after TLI (clear of Earth, long before the Moon).
            if (!state.mccDone && state.simTime - state.tliTime > 4 && distToMoon > MOON_SOI) {
                state.mccDone = true;
                const plan = planMidcourse(pos, vel, state.targetLunarR);
                if (plan && plan.dv > 1e-4) {
                    state.mcc = plan;
                    state.mccDvx = 0;
                    state.mccDvy = 0;
                    state.mccArmed = false;
                    state.phase = PHASES.MCC;
                    break;
                }
            }
            {
                const e = bodies.earth.pos;
                const rE = dist(pos.x, pos.y, e.x, e.y);
                const vrE = ((pos.x - e.x) * vel.x + (pos.y - e.y) * vel.y) / rE;
                if (state.simTime - state.tliTime > 10 && vrE < 0 && rE < EARTH_MOON_R * 0.5) {
                    state.abortReason = 'TRAJECTORY MISS';
                    cancel();
                    break;
                }
            }
            if (distToMoon < MOON_SOI) {
                state.phase = PHASES.APPROACH;
                state.closestApproach = distToMoon;
                state.periapsisReached = false;
            }
            if (state.simTime - state.tliTime > 3 * state.transferTime + 50) {
                state.abortReason = 'TRAJECTORY MISS';
                cancel();
            }
            break;

        case PHASES.MCC: {
            // Exact vector burn: account for the delta-v the physics actually
            // delivered last step, then fire each axis only while its remaining
            // component exceeds half a step's worth.
            const plan = state.mcc;
            if (state.mccArmed) {
                state.mccDvx += thrustState.ax * dt;
                state.mccDvy += thrustState.ay * dt;
            }
            const remX = plan.dvx - state.mccDvx, remY = plan.dvy - state.mccDvy;
            const fv = thrustFrameVelocity(_axis);
            const s = Math.hypot(fv.x, fv.y) || 1;
            const ux = fv.x / s, uy = fv.y / s, nx = -uy, ny = ux;
            const along = remX * ux + remY * uy;
            const perp = remX * nx + remY * ny;
            const stepMain = maxAcceleration() * dt;
            const stepRcs = stepMain * RCS_K;
            controls.prograding = along > stepMain / 2;
            controls.retrograding = along < -stepMain / 2;
            controls.normalPos = perp > stepRcs / 2;
            controls.normalNeg = perp < -stepRcs / 2;
            state.burnType = controls.prograding ? 'prograde' : controls.retrograding ? 'retrograde'
                : controls.normalPos ? 'normal+' : controls.normalNeg ? 'normal-' : '';
            state.mccArmed = true;
            state.remainingDv = Math.hypot(remX, remY);
            if (!controls.prograding && !controls.retrograding && !controls.normalPos && !controls.normalNeg) {
                stopAllBurns();
                state.phase = PHASES.COAST;
            }
            break;
        }

        case PHASES.APPROACH: {
            if (distToMoon < state.closestApproach) state.closestApproach = distToMoon;
            const mv = moonVelocity();
            const muM = params.G * bodies.moon.m;
            const el = orbitalElements(pos.x - moonPos.x, pos.y - moonPos.y, vel.x - mv.x, vel.y - mv.y, muM);
            const target = state.targetLunarR;
            const rp = el.rp;
            state.remainingDv = Math.abs(target - rp);

            // Trajectory correction while still well away from the Moon, with
            // hysteresis so the burn doesn't chatter.
            const farEnough = distToMoon > target * 1.6;
            if (farEnough && state.correctDir === 0) {
                if (rp < target * 0.95) state.correctDir = 1;
                else if (rp > target * 1.3) state.correctDir = -1;
            }
            if (state.correctDir === 1 && (rp >= target || !farEnough)) state.correctDir = 0;
            if (state.correctDir === -1 && (rp <= target * 1.05 || !farEnough)) state.correctDir = 0;

            if (state.correctDir !== 0) {
                raisePeriapsis(pos, vel, moonPos, state.correctDir);
            } else {
                stopAllBurns();
                // Capture burn centred on periapsis.
                const vPe = Math.abs(el.h) / Math.max(rp, 1e-6);
                const dvCap = Math.abs(vPe - Math.sqrt(muM / Math.max(rp, 1e-6)));
                const burnTime = dvCap / Math.max(maxAcceleration(), 1e-9);
                if (el.vr >= 0 || el.timeToPe <= burnTime / 2) {
                    state.periapsisReached = true;
                    state.phase = PHASES.CAPTURE;
                }
            }

            if (distToMoon < MOON_RADIUS + 0.05) {
                state.abortReason = 'IMPACT - correction too late';
                cancel();
            } else if (distToMoon > 8 && state.closestApproach < distToMoon - 1.5) {
                state.abortReason = 'FLYBY - no capture';
                cancel();
            }
            break;
        }

        case PHASES.CAPTURE: {
            // Retrograde (Moon-relative) insertion burn until the orbital energy
            // matches a circular orbit at the current distance; the closed-loop
            // circularizer then trims what's left.
            const mv = moonVelocity();
            const muM = params.G * bodies.moon.m;
            const rvx = vel.x - mv.x, rvy = vel.y - mv.y;
            const energy = (rvx * rvx + rvy * rvy) / 2 - muM / distToMoon;
            const eCirc = -muM / (2 * distToMoon);
            state.remainingDv = Math.max(0, Math.sqrt(Math.max(0, 2 * (energy - eCirc))));
            if (energy > eCirc) {
                setBurn('retrograde');
            } else {
                stopAllBurns();
                state.phase = PHASES.CIRCULARIZE;
            }
            break;
        }

        case PHASES.CIRCULARIZE: {
            const body = getNearestBody(pos, bodies);
            if (!body) { finishCircularize(); break; }
            const { errMag, firing } = circStep(pos, vel, body, moonPos, dt, false);
            state.remainingDv = errMag;
            if (!firing) finishCircularize();
            break;
        }

        case PHASES.HOLD: {
            const body = getNearestBody(pos, bodies);
            if (body) {
                const { errMag } = circStep(pos, vel, body, moonPos, dt, true);
                state.remainingDv = errMag;
            } else {
                stopAllBurns();
            }
            break; // never deactivates — alt-hold is sticky
        }

        case PHASES.ORBIT_ACHIEVED:
            stopAllBurns();
            if (Date.now() - state.orbitAchievedTime > 3000) {
                controls.automated = false;
                state.active = false;
                state.phase = PHASES.IDLE;
                state.burnType = '';
            }
            break;

        case PHASES.RTE_ESCAPE: {
            // Return from the Moon. The escape burn (start time and how much
            // energy to add) is chosen by numerical shooting with the real
            // gravity model — patched conics are too crude here because of the
            // long burn and Earth's tide — then flown closed-loop on energy.
            if (distToMoon > MOON_SOI && !state.escapeStarted) {
                stopAllBurns();
                state.phase = PHASES.RTE_BURN;   // not near the Moon: trim directly
                break;
            }
            if (!state.escapePlan) state.escapePlan = planEscape(pos, vel, state.targetEarthR);
            const plan = state.escapePlan;
            const muM = params.G * bodies.moon.m;
            const mv = moonVelocity();
            const rvx = vel.x - mv.x, rvy = vel.y - mv.y;
            const energy = (rvx * rvx + rvy * rvy) / 2 - muM / distToMoon;
            if (!state.escapeStarted) {
                stopAllBurns();
                if (state.simTime < plan.startTime) break;   // waiting for the window
                state.escapeStarted = true;
            }
            if (energy < plan.energy) {
                setBurn('prograde');
            } else {
                stopAllBurns();
                state.phase = PHASES.RTE_COAST;
                state.trims = 0;
            }
            break;
        }

        case PHASES.RTE_BURN: {
            // Outside the Moon now: trim the Earth periapsis to the target by
            // adding/removing Earth-tangential velocity.
            const earth = bodies.earth.pos;
            const dx = pos.x - earth.x, dy = pos.y - earth.y;
            const r = Math.hypot(dx, dy);
            const { rp } = earthPeriapsis(pos, vel);
            const target = state.targetEarthR;
            state.remainingDv = Math.abs(rp - target);
            const rHatx = dx / r, rHaty = dy / r;
            const vDotR = vel.x * rHatx + vel.y * rHaty;
            const tanx = vel.x - vDotR * rHatx; // Earth-tangential velocity
            const tany = vel.y - vDotR * rHaty;
            if (rp > target * 1.05) {
                burnToward(-tanx, -tany, vel);   // lower periapsis
            } else if (rp < target * 0.95) {
                burnToward(tanx, tany, vel);      // raise periapsis (avoid impact)
            } else {
                stopAllBurns();
                state.phase = PHASES.RTE_COAST;
                state.closestApproach = r;
                state.periapsisReached = false;
            }
            break;
        }

        case PHASES.RTE_COAST: {
            stopAllBurns();
            const earth = bodies.earth.pos;
            const muE = params.G * bodies.earth.m;
            const el = orbitalElements(pos.x - earth.x, pos.y - earth.y, vel.x, vel.y, muE);
            const target = state.targetEarthR;
            // Trim the periapsis once clear of the Moon's pull (twice at most),
            // and always if it drifts toward the surface.
            const clear = distToMoon > 10;
            const off = el.rp > target * 1.2 || el.rp < target * 0.85;
            const dangerous = el.rp < 1.05 && clear;
            if ((clear && off && state.trims < 2) || dangerous) {
                state.trims++;
                state.phase = PHASES.RTE_BURN;
                break;
            }
            // Circularization burn centred on periapsis.
            const vPe = Math.abs(el.h) / Math.max(el.rp, 1e-6);
            const dvCirc = Math.abs(vPe - Math.sqrt(muE / Math.max(el.rp, 1e-6)));
            const burnTime = dvCirc / Math.max(maxAcceleration(), 1e-9);
            if (el.r < target * 2 && (el.vr >= 0 || el.timeToPe <= burnTime / 2)) {
                state.phase = PHASES.CIRCULARIZE;
            }
            break;
        }
    }

    updateEta(pos, vel, moonPos, distToMoon);

    // Fuel exhaustion safety during the powered transfer phases (not HOLD —
    // alt-hold simply coasts once it's out of fuel).
    if (rocketParams.fuelMass <= 0 &&
        (state.phase === PHASES.TLI_BURN || state.phase === PHASES.APPROACH
            || state.phase === PHASES.MCC || state.phase === PHASES.CAPTURE
            || state.phase === PHASES.CIRCULARIZE || state.phase === PHASES.RTE_ESCAPE
            || state.phase === PHASES.RTE_BURN)) {
        state.abortReason = 'FUEL EXHAUSTED';
        cancel();
    }
}

// ---------------------------------------------------------------------------
// Escape planner (numerical shooting)

/**
 * Simulate an escape from the Moon: coast `wait`, burn prograde (Moon-relative)
 * until the Moon-relative specific energy reaches `eTarget`, then coast.
 * Returns the Earth periapsis once clear of the Moon (Infinity if retrograde or
 * still captured), and the delta-v spent.
 */
function simulateEscape(pos, vel, wait, eTarget, horizon) {
    const h = 0.01;
    const G = params.G, muM = G * bodies.moon.m, muE = G * bodies.earth.m;
    const E = bodies.earth.pos;
    const w = moonAngularRate();
    let ang = Math.atan2(bodies.moon.pos.y - E.y, bodies.moon.pos.x - E.x);
    let x = pos.x, y = pos.y, vx = vel.x, vy = vel.y;
    let fuel = rocketParams.fuelMass;
    const ve = exhaustVelocity();
    const F = rocketParams.thrust;
    let burning = false, burnt = false, dvUsed = 0;
    for (let t = 0; t < horizon; t += h) {
        const mx = E.x + EARTH_MOON_R * Math.cos(ang), my = E.y + EARTH_MOON_R * Math.sin(ang);
        const mvx = -EARTH_MOON_R * w * Math.sin(ang), mvy = EARTH_MOON_R * w * Math.cos(ang);
        const rx = x - mx, ry = y - my;
        const dM = Math.hypot(rx, ry);
        if (dM < MOON_RADIUS) return { rp: 0, dv: dvUsed };
        const rvx = vx - mvx, rvy = vy - mvy;
        const rv = Math.hypot(rvx, rvy);
        let tx = 0, ty = 0;
        if (!burnt && t >= wait) {
            const energy = (rv * rv) / 2 - muM / dM;
            if (energy < eTarget && fuel > 0) {
                burning = true;
                const m = rocketParams.dryMass + fuel;
                const a = F / m;
                tx = (rvx / rv) * a; ty = (rvy / rv) * a;
                fuel -= (F / ve) * h;
                dvUsed += a * h;
            } else if (burning) {
                burnt = true;
            }
        }
        // leapfrog
        let g = gravityPair(x, y, mx, my, muE, muM, E);
        vx += (g.ax + tx) * h / 2; vy += (g.ay + ty) * h / 2;
        x += vx * h; y += vy * h;
        ang += w * h;
        const mx2 = E.x + EARTH_MOON_R * Math.cos(ang), my2 = E.y + EARTH_MOON_R * Math.sin(ang);
        g = gravityPair(x, y, mx2, my2, muE, muM, E);
        vx += (g.ax + tx) * h / 2; vy += (g.ay + ty) * h / 2;

        if (burnt && Math.hypot(x - mx2, y - my2) > 11) {
            const el = orbitalElements(x - E.x, y - E.y, vx, vy, muE);
            // Must orbit the same way as the Moon (clockwise, h < 0) and head
            // in toward Earth (not out to a long, perturbed high orbit first).
            if (el.h >= 0) return { rp: Infinity, dv: dvUsed, outward: true };
            return { rp: el.rp, dv: dvUsed, outward: el.vr > 0 };
        }
    }
    return { rp: Infinity, dv: dvUsed };
}

const _gp = { ax: 0, ay: 0 };
function gravityPair(x, y, mx, my, muE, muM, E) {
    const dex = E.x - x, dey = E.y - y;
    const de2 = dex * dex + dey * dey;
    const fe = muE / (de2 * Math.sqrt(de2));
    const dmx = mx - x, dmy = my - y;
    const dm2 = dmx * dmx + dmy * dmy;
    const fm = muM / (dm2 * Math.sqrt(dm2));
    // Indirect term (Earth-centred frame): minus the Moon's pull on Earth.
    const emx = mx - E.x, emy = my - E.y;
    const R2 = emx * emx + emy * emy;
    const fi = muM / (R2 * Math.sqrt(R2));
    _gp.ax = fe * dex + fm * dmx - fi * emx;
    _gp.ay = fe * dey + fm * dmy - fi * emy;
    return _gp;
}

/**
 * Coast from (pos, vel + dv) and return the closest approach to the Moon
 * (Infinity if the craft never gets within the SOI on this transfer).
 */
function simulateCoast(pos, vel, dvx, dvy, horizon) {
    const G = params.G, muM = G * bodies.moon.m, muE = G * bodies.earth.m;
    const E = bodies.earth.pos;
    const w = moonAngularRate();
    let ang = Math.atan2(bodies.moon.pos.y - E.y, bodies.moon.pos.x - E.x);
    let x = pos.x, y = pos.y, vx = vel.x + dvx, vy = vel.y + dvy;
    let minD = Infinity;
    let t = 0;
    while (t < horizon) {
        const mx = E.x + EARTH_MOON_R * Math.cos(ang), my = E.y + EARTH_MOON_R * Math.sin(ang);
        const dM = Math.hypot(x - mx, y - my);
        if (dM < minD) minD = dM;
        else if (minD < MOON_SOI && dM > minD + 0.5) break;      // past closest approach
        if (Math.hypot(x - E.x, y - E.y) < 1.05) return 0;      // would hit Earth
        const h = dM < 3 ? 0.004 : 0.02;
        let g = gravityPair(x, y, mx, my, muE, muM, E);
        vx += g.ax * h / 2; vy += g.ay * h / 2;
        x += vx * h; y += vy * h;
        ang += w * h; t += h;
        const mx2 = E.x + EARTH_MOON_R * Math.cos(ang), my2 = E.y + EARTH_MOON_R * Math.sin(ang);
        g = gravityPair(x, y, mx2, my2, muE, muM, E);
        vx += g.ax * h / 2; vy += g.ay * h / 2;
    }
    return minD;
}

/** Search a small delta-v (prograde × normal grid) for the target lunar periapsis. */
function planMidcourse(pos, vel, targetR) {
    const horizon = 3 * state.transferTime + 30;
    const s = Math.hypot(vel.x, vel.y) || 1;
    const ux = vel.x / s, uy = vel.y / s, nx = -uy, ny = ux;
    const scoreOf = (a, b) => {
        const dvx = a * ux + b * nx, dvy = a * uy + b * ny;
        const d = simulateCoast(pos, vel, dvx, dvy, horizon);
        const miss = d < MOON_RADIUS + 0.1 ? 10 : Math.abs(d - targetR);
        return { score: miss + 0.5 * Math.hypot(a, b), dvx, dvy, miss };
    };
    let best = { ...scoreOf(0, 0), a: 0, b: 0 };
    if (best.miss < 0.08 * targetR) return { dv: 0, dvx: 0, dvy: 0 };
    let span = 0.06;
    for (let iter = 0; iter < 3; iter++) {
        const a0 = best.a, b0 = best.b;
        for (let i = -3; i <= 3; i++) {
            for (let j = -3; j <= 3; j++) {
                if (i === 0 && j === 0) continue;
                const a = a0 + (i * span) / 3, b = b0 + (j * span) / 3;
                const res = scoreOf(a, b);
                if (res.score < best.score) best = { ...res, a, b };
            }
        }
        span /= 3;
    }
    const dv = Math.hypot(best.dvx, best.dvy);
    if (dv < 1e-6) return { dv: 0, dvx: 0, dvy: 0 };
    return { dv, dvx: best.dvx, dvy: best.dvy };
}

/** Search burn start time × energy for the Earth periapsis closest to targetR. */
function planEscape(pos, vel, targetR) {
    const muM = params.G * bodies.moon.m;
    const mv = moonVelocity();
    const rx = pos.x - bodies.moon.pos.x, ry = pos.y - bodies.moon.pos.y;
    const rL = Math.hypot(rx, ry);
    const period = 2 * Math.PI * Math.sqrt((rL * rL * rL) / muM);
    const vMoon = Math.hypot(mv.x, mv.y);
    const vInf0 = Math.max(0.05, vMoon * 0.5);
    let best = { startTime: state.simTime, energy: (vInf0 * vInf0) / 2, score: Infinity };
    const N = 16;
    for (let i = 0; i < N; i++) {
        const wait = (period * i) / N;
        for (const f of [0.6, 0.8, 1.0, 1.2, 1.45, 1.75]) {
            const eT = ((vInf0 * f) ** 2) / 2;
            const res = simulateEscape(pos, vel, wait, eT, wait + 160);
            const score = Math.abs(res.rp - targetR) + 0.5 * res.dv + (res.outward ? 5 : 0);
            if (score < best.score) best = { startTime: state.simTime + wait, energy: eT, score, wait, f };
        }
    }
    // Refine around the best candidate.
    if (Number.isFinite(best.score)) {
        const w0 = best.wait, f0 = best.f;
        for (let dw = -2; dw <= 2; dw++) {
            for (const df of [-0.1, -0.05, 0, 0.05, 0.1]) {
                const wait = Math.max(0, w0 + (dw * period) / (N * 4));
                const eT = ((vInf0 * (f0 + df)) ** 2) / 2;
                const res = simulateEscape(pos, vel, wait, eT, wait + 160);
                const score = Math.abs(res.rp - targetR) + 0.5 * res.dv + (res.outward ? 5 : 0);
                if (score < best.score) best = { startTime: state.simTime + wait, energy: eT, score, wait, f: f0 + df };
            }
        }
    }
    return best;
}

function finishCircularize() {
    if (state.mode === 'moon') {
        // Hand off to alt-hold so the (otherwise decaying) lunar orbit is kept.
        state.phase = PHASES.HOLD;
        state.mode = 'hold';
        stopAllBurns();
        state.remainingDv = 0;
    } else {
        stopAllBurns();
        state.phase = PHASES.ORBIT_ACHIEVED;
        state.orbitAchievedTime = Date.now();
        state.remainingDv = 0;
    }
}

function updateEta(pos, vel, moonPos, distToMoon) {
    let eta;
    switch (state.phase) {
        case PHASES.PHASING:
            eta = state.phaseWait + state.transferTime + CAPTURE_EST;
            break;
        case PHASES.TLI_BURN:
        case PHASES.COAST:
            eta = Math.max(0, state.transferTime - (state.simTime - state.tliTime)) + CAPTURE_EST;
            break;
        case PHASES.APPROACH:
            eta = 8 + Math.max(0, distToMoon) * 2;
            break;
        case PHASES.CIRCULARIZE:
            eta = 5;
            break;
        case PHASES.RTE_ESCAPE:
            eta = 40;
            break;
        case PHASES.RTE_BURN:
            eta = 20 + state.remainingDv * 30;
            break;
        case PHASES.RTE_COAST: {
            const dE = Math.hypot(pos.x - bodies.earth.pos.x, pos.y - bodies.earth.pos.y);
            eta = 5 + Math.max(0, dE) * 2;
            break;
        }
        default:
            eta = 0; // HOLD / ORBIT_ACHIEVED / IDLE: already stable
    }
    state.etaSeconds = eta;
}

// Burn Helpers

function setBurn(type) {
    state.burnType = type;
    controls.prograding = type === 'prograde';
    controls.retrograding = type === 'retrograde';
    controls.normalPos = type === 'normal+';
    controls.normalNeg = type === 'normal-';
}

function stopAllBurns() {
    controls.prograding = false;
    controls.retrograding = false;
    controls.normalPos = false;
    controls.normalNeg = false;
    state.burnType = '';
}

function accumulateDv(dt) {
    const mass = rocketParams.dryMass + rocketParams.fuelMass;
    if (mass > 0 && rocketParams.fuelMass > 0) {
        state.accumulatedDeltaV += (rocketParams.thrust / mass) * dt;
    }
}

// Exposed for the headless tests.
export const _internals = { planEscape, simulateEscape, planMidcourse, state };
