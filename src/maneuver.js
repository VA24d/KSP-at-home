// Physics core.
//
// Units: 1 length unit = Earth radius (6371 km), Earth's mu = G·M = 1 at the
// default G, so 1 time unit = sqrt(R/g) ≈ 806 s and 1 velocity unit ≈ 7.9 km/s.
// Isp is entered in real seconds and converted with that same time unit, so the
// rocket equation gives realistic delta-v relative to orbital speed.
//
// Integration: fixed-step kick-drift-kick leapfrog (symplectic, so orbits don't
// gain or lose energy), with thrust folded into the acceleration. The caller
// advances real time through an accumulator, which makes the simulation
// independent of the display's frame rate.

export const TIME_UNIT_S = 806.02;      // seconds of real time per sim time unit
export const KM_PER_UNIT = 6371;        // km per length unit
export const MPS_PER_UNIT = (KM_PER_UNIT * 1000) / TIME_UNIT_S; // ≈ 7904 m/s

export const EARTH_RADIUS = 1;
export const MOON_RADIUS = 0.4;
export const EARTH_MOON_R = 15;
export const EARTH_CRASH_R = 1.02;      // surface contact (rocket base)
export const MOON_CRASH_R = 0.41;

// Simulation parameters
export const params = {
    G: 1,
    dt: 0.005,          // fixed physics step (sim time units)
    simRate: 1,         // sim time units per real second at 1x warp
    moonMass: 0.247,
    lookahead: 150,     // trajectory prediction horizon (sim time units)
};

// Rocket parameters (mass in tonnes, thrust in units of 9.80665 kN)
export const rocketParams = {
    Isp: 450,           // seconds
    dryMass: 2,
    fuelMass: 24,
    thrust: 1,
};

export const RCS_FRACTION = 0.3;        // RCS thrust relative to the main engine

const BASE_DT = 0.005;

/** Set the gravitational constant. The physics step scales with 1/sqrt(G) so
 *  accuracy (steps per orbit) is the same at any gravity. */
export function setGravity(G) {
    if (!(G > 0)) return;
    params.G = G;
    params.dt = BASE_DT / Math.sqrt(G * bodies.earth.m);
}

// Spacecraft state
export const r = { x: 0, y: 0, z: 0 };
export const v = { x: 0, y: 0, z: 0 };

// Simulation clock (sim time units since the current flight began)
export const sim = { time: 0 };

// Celestial bodies. Earth is the fixed origin of the dynamics; the Moon moves
// on a circular Kepler orbit (see moonAngularRate).
export const bodies = {
    earth: { m: 1, pos: { x: -3, y: -4, z: 0 }, radius: EARTH_RADIUS },
    moon: { m: params.moonMass, pos: { x: 0, y: 0, z: 0 }, radius: MOON_RADIUS },
    sun: { m: 0, pos: { x: -20, y: 0, z: 1 } },
};

export const moonState = { angle: Math.PI / 3 };

export const crashState = { crashed: false, message: '', body: '', speed: 0 };

// Burn controls. throttle is the pilot's setting (0..1); automated controllers
// set `automated` so they always get full thrust; `guidance` is an explicit
// launch-vehicle acceleration vector that does not use the spacecraft's fuel.
export const controls = {
    prograding: false,
    retrograding: false,
    normalPos: false,   // thrust perpendicular-left of velocity
    normalNeg: false,   // thrust perpendicular-right of velocity
    throttle: 1,
    automated: false,
    guidance: null,     // { x, y } acceleration, or null
};

// ---------------------------------------------------------------------------
// Moon

/** Moon angular rate (rad per sim time unit). Negative = clockwise, matching
 *  the spacecraft's prograde direction after launch. The frame is centred on
 *  Earth, so the relative two-body rate uses G·(M_earth + M_moon). */
export function moonAngularRate() {
    return -Math.sqrt((params.G * (bodies.earth.m + bodies.moon.m)) / EARTH_MOON_R ** 3);
}

export function moonPosAt(angle, out = { x: 0, y: 0 }) {
    out.x = bodies.earth.pos.x + EARTH_MOON_R * Math.cos(angle);
    out.y = bodies.earth.pos.y + EARTH_MOON_R * Math.sin(angle);
    return out;
}

/** Moon velocity (absolute frame) at the current angle. */
export function moonVelocity(out = { x: 0, y: 0 }) {
    const w = moonAngularRate();
    out.x = -EARTH_MOON_R * w * Math.sin(moonState.angle);
    out.y = EARTH_MOON_R * w * Math.cos(moonState.angle);
    return out;
}

function syncMoon() {
    moonPosAt(moonState.angle, bodies.moon.pos);
}

/** Laplace sphere of influence radius of the Moon. */
export function moonSOI() {
    const ratio = Math.max(bodies.moon.m, 1e-6) / bodies.earth.m;
    return EARTH_MOON_R * ratio ** 0.4;
}

/**
 * The body whose gravity dominates at `pos` (patched-conic sense).
 * Returns { name, body, mu, radius, pos, vel }.
 */
export function dominantBody(pos) {
    const m = bodies.moon.pos;
    const dMoon = Math.hypot(pos.x - m.x, pos.y - m.y);
    if (bodies.moon.m > 0 && dMoon < moonSOI()) {
        return {
            name: 'moon', body: bodies.moon, mu: params.G * bodies.moon.m,
            radius: MOON_RADIUS, pos: bodies.moon.pos, vel: moonVelocity(),
        };
    }
    return {
        name: 'earth', body: bodies.earth, mu: params.G * bodies.earth.m,
        radius: EARTH_RADIUS, pos: bodies.earth.pos, vel: { x: 0, y: 0 },
    };
}

const _mv = { x: 0, y: 0 };

/**
 * Velocity in the dominant body's frame — the reference for prograde,
 * retrograde and the normal directions (as in an orbit-mode navball).
 */
export function thrustFrameVelocity(out = { x: 0, y: 0 }) {
    const m = bodies.moon.pos;
    const inMoonSOI = bodies.moon.m > 0 && Math.hypot(r.x - m.x, r.y - m.y) < moonSOI();
    if (inMoonSOI) {
        moonVelocity(_mv);
        out.x = v.x - _mv.x;
        out.y = v.y - _mv.y;
    } else {
        out.x = v.x;
        out.y = v.y;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Gravity

const _g = { ax: 0, ay: 0 };

/**
 * Gravitational acceleration at (px, py) with the Moon at (mx, my), in the
 * Earth-centred frame. That frame accelerates with Earth, so the Moon's pull on
 * Earth is subtracted (the "indirect" term): Earth orbits then feel only the
 * lunar tide, and lunar orbits only Earth's tide — as in reality.
 */
export function gravityAt(px, py, mx, my, out = _g) {
    let ax = 0, ay = 0;
    const e = bodies.earth;
    const dex = e.pos.x - px, dey = e.pos.y - py;
    const de2 = dex * dex + dey * dey;
    if (de2 > 1e-8) {
        const f = (params.G * e.m) / (de2 * Math.sqrt(de2));
        ax += f * dex; ay += f * dey;
    }
    if (bodies.moon.m > 0) {
        const dmx = mx - px, dmy = my - py;
        const dm2 = dmx * dmx + dmy * dmy;
        if (dm2 > 1e-8) {
            const f = (params.G * bodies.moon.m) / (dm2 * Math.sqrt(dm2));
            ax += f * dmx; ay += f * dmy;
        }
        // Indirect term: minus the Moon's pull on Earth.
        const emx = mx - e.pos.x, emy = my - e.pos.y;
        const R2 = emx * emx + emy * emy;
        if (R2 > 1e-8) {
            const fi = (params.G * bodies.moon.m) / (R2 * Math.sqrt(R2));
            ax -= fi * emx; ay -= fi * emy;
        }
    }
    out.ax = ax; out.ay = ay;
    return out;
}

/** Gravity at `pos` with the current Moon position. */
export function acc(pos) {
    return gravityAt(pos.x, pos.y, bodies.moon.pos.x, bodies.moon.pos.y, { ax: 0, ay: 0 });
}

// ---------------------------------------------------------------------------
// Rocket

/** Effective exhaust velocity in sim velocity units. */
export function exhaustVelocity() {
    return Math.max(rocketParams.Isp, 1) / TIME_UNIT_S;
}

export function totalMass() {
    return rocketParams.dryMass + rocketParams.fuelMass;
}

/** Remaining delta-v from the rocket equation (sim velocity units). */
export function deltaVRemaining() {
    const dry = rocketParams.dryMass;
    if (dry <= 0) return 0;
    return exhaustVelocity() * Math.log((dry + rocketParams.fuelMass) / dry);
}

/** Main-engine acceleration at full throttle right now. */
export function maxAcceleration() {
    const m = totalMass();
    return m > 0 ? rocketParams.thrust / m : 0;
}

export function isBurning() {
    return controls.prograding || controls.retrograding || controls.normalPos || controls.normalNeg;
}

// Last thrust actually applied (for effects / HUD).
export const thrustState = { main: 0, rcs: 0, ax: 0, ay: 0 };

const _t = { x: 0, y: 0 };
const _fv = { x: 0, y: 0 };

/** Compute the thrust acceleration for this step and burn the fuel it uses. */
function thrustAcceleration(h) {
    _t.x = 0; _t.y = 0;
    thrustState.main = 0; thrustState.rcs = 0;
    thrustState.ax = 0; thrustState.ay = 0;

    if (controls.guidance) {
        _t.x = controls.guidance.x;
        _t.y = controls.guidance.y;
        thrustState.main = Math.hypot(_t.x, _t.y) > 0 ? 1 : 0;
        thrustState.ax = _t.x; thrustState.ay = _t.y;
        return _t;
    }

    if (!isBurning() || rocketParams.fuelMass <= 0) return _t;
    const fv = thrustFrameVelocity(_fv);
    const speed = Math.hypot(fv.x, fv.y);
    if (speed < 1e-9) return _t;
    const ux = fv.x / speed, uy = fv.y / speed;   // prograde unit
    const nx = -uy, ny = ux;                      // perpendicular-left unit

    const throttle = controls.automated ? 1 : Math.min(1, Math.max(0, controls.throttle));
    if (throttle <= 0) return _t;

    const F = rocketParams.thrust * throttle;
    const Frcs = F * RCS_FRACTION;
    let fx = 0, fy = 0, flow = 0;
    if (controls.prograding) { fx += F * ux; fy += F * uy; flow += F; thrustState.main = throttle; }
    if (controls.retrograding) { fx -= F * ux; fy -= F * uy; flow += F; thrustState.main = throttle; }
    if (controls.normalPos) { fx += Frcs * nx; fy += Frcs * ny; flow += Frcs; thrustState.rcs = throttle; }
    if (controls.normalNeg) { fx -= Frcs * nx; fy -= Frcs * ny; flow += Frcs; thrustState.rcs = throttle; }

    // Mass flow = F / ve. Scale down the last partial step so fuel never goes negative.
    const ve = exhaustVelocity();
    let used = (flow / ve) * h;
    let scale = 1;
    if (used > rocketParams.fuelMass) {
        scale = used > 0 ? rocketParams.fuelMass / used : 0;
        used = rocketParams.fuelMass;
    }
    const mass = totalMass();
    rocketParams.fuelMass = Math.max(0, rocketParams.fuelMass - used);
    if (mass <= 0) return _t;
    _t.x = (fx / mass) * scale;
    _t.y = (fy / mass) * scale;
    thrustState.ax = _t.x; thrustState.ay = _t.y;
    return _t;
}

// ---------------------------------------------------------------------------
// State setup / undo

const stateHistory = [];
const MAX_HISTORY = 60;
const SNAPSHOT_INTERVAL = 2;            // sim time units between undo snapshots
let lastSnapshotTime = 0;

function saveSnapshot() {
    stateHistory.push({
        r: { x: r.x, y: r.y },
        v: { x: v.x, y: v.y },
        fuelMass: rocketParams.fuelMass,
        angle: moonState.angle,
        time: sim.time,
    });
    if (stateHistory.length > MAX_HISTORY) stateHistory.shift();
}

/** Restore the newest snapshot that is at least 1 time unit old. */
export function undo() {
    while (stateHistory.length && stateHistory[stateHistory.length - 1].time > sim.time - 1) {
        stateHistory.pop();
    }
    const snap = stateHistory.pop();
    if (!snap) return false;
    r.x = snap.r.x; r.y = snap.r.y;
    v.x = snap.v.x; v.y = snap.v.y;
    rocketParams.fuelMass = snap.fuelMass;
    moonState.angle = snap.angle;
    sim.time = snap.time;
    lastSnapshotTime = snap.time;
    syncMoon();
    resetCrash();
    return true;
}

export function clearHistory() {
    stateHistory.length = 0;
    lastSnapshotTime = sim.time;
}

export function stopAllControls() {
    controls.prograding = false;
    controls.retrograding = false;
    controls.normalPos = false;
    controls.normalNeg = false;
    controls.guidance = null;
    controls.automated = false;
}

function resetCrash() {
    crashState.crashed = false;
    crashState.message = '';
    crashState.body = '';
    crashState.speed = 0;
}

/** Place the craft at rest on the launch pad (Earth's north pole). */
export function setOnPad(padAltitude = 0.03) {
    r.x = bodies.earth.pos.x;
    r.y = bodies.earth.pos.y + EARTH_RADIUS + padAltitude;
    r.z = 0;
    v.x = 0; v.y = 0; v.z = 0;
    sim.time = 0;
    resetCrash();
    syncMoon();
    clearHistory();
}

/** Place the craft directly in a circular clockwise orbit of the given radius. */
export function setInitialOrbit(orbitRadius) {
    const ex = bodies.earth.pos.x;
    const ey = bodies.earth.pos.y;
    r.x = ex + orbitRadius;
    r.y = ey;
    r.z = 0;
    const vCirc = Math.sqrt((params.G * bodies.earth.m) / orbitRadius);
    v.x = 0;
    v.y = -vCirc;
    v.z = 0;
    resetCrash();
    syncMoon();
    clearHistory();
}

// ---------------------------------------------------------------------------
// Integration

/**
 * Advance the simulation by one fixed step of params.dt.
 * Returns true if the craft has crashed.
 */
export function step() {
    if (crashState.crashed) return true;
    const h = params.dt;

    if (sim.time - lastSnapshotTime >= SNAPSHOT_INTERVAL) {
        saveSnapshot();
        lastSnapshotTime = sim.time;
    }

    const t = thrustAcceleration(h);
    const tx = t.x, ty = t.y;

    // Kick
    let g = gravityAt(r.x, r.y, bodies.moon.pos.x, bodies.moon.pos.y);
    v.x += (g.ax + tx) * 0.5 * h;
    v.y += (g.ay + ty) * 0.5 * h;
    // Drift
    r.x += v.x * h;
    r.y += v.y * h;
    moonState.angle += moonAngularRate() * h;
    syncMoon();
    // Kick
    g = gravityAt(r.x, r.y, bodies.moon.pos.x, bodies.moon.pos.y);
    v.x += (g.ax + tx) * 0.5 * h;
    v.y += (g.ay + ty) * 0.5 * h;

    sim.time += h;

    // Collision (step length is ~0.01 units, far below the crash margins)
    const e = bodies.earth.pos;
    const m = bodies.moon.pos;
    const earthDist = Math.hypot(r.x - e.x, r.y - e.y);
    const moonDist = Math.hypot(r.x - m.x, r.y - m.y);
    if (earthDist < EARTH_CRASH_R) {
        crash('earth', 'CRASHED INTO EARTH', Math.hypot(v.x, v.y));
    } else if (moonDist < MOON_CRASH_R) {
        const mv = moonVelocity();
        crash('moon', 'CRASHED INTO MOON', Math.hypot(v.x - mv.x, v.y - mv.y));
    }
    return crashState.crashed;
}

function crash(body, message, speed) {
    crashState.crashed = true;
    crashState.body = body;
    crashState.message = message;
    crashState.speed = speed;
    stopAllControls();
}

syncMoon();
