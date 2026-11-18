// Orbit Circularization Module
import { dominantBody, params, rocketParams, controls, maxAcceleration, RCS_FRACTION } from './maneuver.js';

/**
 * The body whose gravity dominates at `pos` (sphere-of-influence test), as
 * { m, pos } — kept for callers that only need the body itself.
 */
export function getNearestBody(pos) {
    return dominantBody(pos).body;
}

/**
 * Orbital eccentricity relative to a (possibly moving) body.
 */
export function computeEccentricity(pos, vel, bodyPos, bodyMass, G, bodyVel = { x: 0, y: 0 }) {
    const rx = pos.x - bodyPos.x, ry = pos.y - bodyPos.y;
    const vx = vel.x - bodyVel.x, vy = vel.y - bodyVel.y;
    const r = Math.hypot(rx, ry);
    const mu = G * bodyMass;
    const v2 = vx * vx + vy * vy;
    const energy = v2 / 2 - mu / r;
    const h = rx * vy - ry * vx;
    return Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
}

/**
 * Velocity correction needed to circularize at the current point, RELATIVE to
 * the dominant body. The target is the circular velocity sqrt(mu/r) along the
 * current tangential direction with zero radial component, offset by the
 * body's own velocity (bodyVel) for a moving body such as the Moon.
 *
 * The error is decomposed onto the craft's thrust axes:
 *   errAlong > 0 → burn prograde, < 0 → retrograde.
 *   errPerp  > 0 → burn normal+,  < 0 → normal-.
 */
export function circularizationError(pos, vel, body, G, bodyVel = { x: 0, y: 0 }) {
    const dx = pos.x - body.pos.x;
    const dy = pos.y - body.pos.y;
    const r = Math.hypot(dx, dy);
    const rHat = { x: dx / r, y: dy / r };
    const vCircular = Math.sqrt((G * body.m) / r);

    const rvx = vel.x - bodyVel.x;
    const rvy = vel.y - bodyVel.y;
    const vDotR = rvx * rHat.x + rvy * rHat.y;
    let tx = rvx - vDotR * rHat.x;
    let ty = rvy - vDotR * rHat.y;
    const tMag = Math.hypot(tx, ty);
    if (tMag > 1e-6) {
        tx /= tMag; ty /= tMag;
    } else {
        // Purely radial motion: pick the clockwise tangent (the game's prograde sense).
        tx = rHat.y; ty = -rHat.x;
    }

    const ex = (bodyVel.x + vCircular * tx) - vel.x;
    const ey = (bodyVel.y + vCircular * ty) - vel.y;
    const errMag = Math.hypot(ex, ey);

    // Thrust axes are relative to the body's frame (see thrustFrameVelocity).
    const speed = Math.hypot(rvx, rvy);
    let vhx, vhy;
    if (speed > 1e-6) { vhx = rvx / speed; vhy = rvy / speed; }
    else { vhx = tx; vhy = ty; }
    const nhx = -vhy, nhy = vhx;

    return {
        errAlong: ex * vhx + ey * vhy,
        errPerp: ex * nhx + ey * nhy,
        errMag,
    };
}

/**
 * Closed-loop burn controller for circularization around the dominant body.
 * Call update() once per physics step while active.
 */
export class CircularizationController {
    constructor() {
        this.active = false;
        this.completed = false;
        this.fuelExhausted = false;
        this.targetDv = 0;
        this.remainingDv = 0;
        this.bodyName = '';
    }

    start(pos, vel) {
        const dom = dominantBody(pos);
        this.active = true;
        this.completed = false;
        this.fuelExhausted = false;
        this.bodyName = dom.name;
        this.targetDv = circularizationError(pos, vel, dom.body, params.G, dom.vel).errMag;
        this.remainingDv = this.targetDv;
    }

    update(pos, vel) {
        if (!this.active) return this._status();

        if (rocketParams.fuelMass <= 0) {
            this.fuelExhausted = true;
            this.active = false;
            this._allOff();
            return this._status();
        }

        const dom = dominantBody(pos);
        this.bodyName = dom.name;
        const { errAlong, errPerp, errMag } = circularizationError(pos, vel, dom.body, params.G, dom.vel);
        this.remainingDv = errMag;

        // Each axis fires only while its error exceeds half of what one step
        // of that thruster delivers; done when nothing would fire.
        const stepMain = maxAcceleration() * params.dt;
        const stepRcs = stepMain * RCS_FRACTION;
        controls.automated = true;
        controls.prograding = errAlong > stepMain / 2;
        controls.retrograding = errAlong < -stepMain / 2;
        controls.normalPos = errPerp > stepRcs / 2;
        controls.normalNeg = errPerp < -stepRcs / 2;
        if (!controls.prograding && !controls.retrograding && !controls.normalPos && !controls.normalNeg) {
            this.active = false;
            this.completed = true;
            this._allOff();
        }
        return this._status();
    }

    cancel() {
        this.active = false;
        this.completed = false;
        this._allOff();
    }

    _allOff() {
        controls.prograding = false;
        controls.retrograding = false;
        controls.normalPos = false;
        controls.normalNeg = false;
        controls.automated = false;
    }

    _status() {
        return {
            active: this.active,
            completed: this.completed,
            fuelExhausted: this.fuelExhausted,
            targetDv: this.targetDv,
            remainingDv: this.remainingDv,
        };
    }
}
