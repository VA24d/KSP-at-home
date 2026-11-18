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

import { AU, PLANETS, SUN_MASS, SUN_RADIUS, SOLAR_EPOCH, helioState, meanMotion, planetSOI } from './solar.js';

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
    syncSolar();
}

// Spacecraft state
export const r = { x: 0, y: 0, z: 0 };
export const v = { x: 0, y: 0, z: 0 };

// Simulation clock (sim time units since the current flight began)
export const sim = { time: 0 };

// Celestial bodies. Earth is the fixed origin of the dynamics; the Moon moves
// on a circular Kepler orbit (see moonAngularRate).
export const bodies = {
    earth: { m: 1, pos: { x: -3, y: -4, z: 0 }, vel: { x: 0, y: 0 }, radius: EARTH_RADIUS },
    moon: { m: params.moonMass, pos: { x: 0, y: 0, z: 0 }, radius: MOON_RADIUS },
    // Sun and planets ride rails (see solar.js); positions/velocities are filled
    // by syncSolar() in this Earth-centred, non-rotating physics frame.
    sun: { m: SUN_MASS, pos: { x: -20, y: 0, z: 0 }, vel: { x: 0, y: 0 }, radius: SUN_RADIUS },
    mercury: { m: PLANETS.mercury.m, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0 }, radius: PLANETS.mercury.radius * EARTH_RADIUS },
    venus: { m: PLANETS.venus.m, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0 }, radius: PLANETS.venus.radius * EARTH_RADIUS },
    mars: { m: PLANETS.mars.m, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0 }, radius: PLANETS.mars.radius * EARTH_RADIUS },
};

/** Body order used by bodyPositionsAt / the trajectory predictor. */
export const BODY_NAMES = ['earth', 'moon', 'sun', 'mercury', 'venus', 'mars'];
const BODY_REFS = BODY_NAMES.map((n) => bodies[n]);
const PLANET_NAMES = ['mercury', 'venus', 'mars'];
const CRASH_MARGIN = 1.02;

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

// ---------------------------------------------------------------------------
// Sun and planets (on rails, solar time = SOLAR_EPOCH + sim.time)

const _he = { x: 0, y: 0, vx: 0, vy: 0 };
const _hp = { x: 0, y: 0, vx: 0, vy: 0 };

/** Solar time of the current simulation instant. */
export function solarTime() {
    return SOLAR_EPOCH + sim.time;
}

/** Place the Sun and planets for the current sim.time. Earth stays fixed, so the
 *  Sun's state is minus Earth's heliocentric state. */
function syncSolar() {
    const t = solarTime();
    const G = params.G;
    helioState('earth', t, G, _he);
    const sun = bodies.sun;
    sun.pos.x = bodies.earth.pos.x - _he.x;
    sun.pos.y = bodies.earth.pos.y - _he.y;
    sun.vel.x = -_he.vx; sun.vel.y = -_he.vy;
    for (const n of PLANET_NAMES) {
        helioState(n, t, G, _hp);
        const b = bodies[n];
        b.pos.x = sun.pos.x + _hp.x; b.pos.y = sun.pos.y + _hp.y;
        b.vel.x = sun.vel.x + _hp.vx; b.vel.y = sun.vel.y + _hp.vy;
    }
}

/** Sphere-of-influence radius of a body (the Sun's is infinite). */
export function soiRadius(name) {
    if (name === 'moon') return moonSOI();
    if (name === 'sun') return Infinity;
    return planetSOI(name);
}

const EARTH_SOI = planetSOI('earth');

/**
 * Position and velocity of a body in the physics frame at sim time tSim
 * (absolute, i.e. compare with sim.time). Moon motion extrapolates from the
 * current moonState.angle.
 */
export function bodyStateAt(name, tSim, out = { x: 0, y: 0, vx: 0, vy: 0 }) {
    const e = bodies.earth.pos;
    if (name === 'earth') { out.x = e.x; out.y = e.y; out.vx = 0; out.vy = 0; return out; }
    if (name === 'moon') {
        const w = moonAngularRate();
        const ang = moonState.angle + w * (tSim - sim.time);
        out.x = e.x + EARTH_MOON_R * Math.cos(ang);
        out.y = e.y + EARTH_MOON_R * Math.sin(ang);
        out.vx = -EARTH_MOON_R * w * Math.sin(ang);
        out.vy = EARTH_MOON_R * w * Math.cos(ang);
        return out;
    }
    const t = SOLAR_EPOCH + tSim;
    const G = params.G;
    helioState('earth', t, G, _he);
    const sx = e.x - _he.x, sy = e.y - _he.y;
    if (name === 'sun') { out.x = sx; out.y = sy; out.vx = -_he.vx; out.vy = -_he.vy; return out; }
    helioState(name, t, G, _hp);
    out.x = sx + _hp.x; out.y = sy + _hp.y;
    out.vx = _hp.vx - _he.vx; out.vy = _hp.vy - _he.vy;
    return out;
}

/** Fill P (length 12; order BODY_NAMES, x,y pairs) with positions at sim time tSim. */
export function bodyPositionsAt(tSim, P) {
    const e = bodies.earth.pos;
    const G = params.G;
    const t = SOLAR_EPOCH + tSim;
    P[0] = e.x; P[1] = e.y;
    const ang = moonState.angle + moonAngularRate() * (tSim - sim.time);
    P[2] = e.x + EARTH_MOON_R * Math.cos(ang);
    P[3] = e.y + EARTH_MOON_R * Math.sin(ang);
    const he = PLANETS.earth;
    const the = he.phase0 + meanMotion('earth', G) * t;
    const sx = e.x - he.a * AU * Math.cos(the), sy = e.y - he.a * AU * Math.sin(the);
    P[4] = sx; P[5] = sy;
    for (let i = 0; i < 3; i++) {
        const n = PLANET_NAMES[i];
        helioState(n, t, G, _hp);
        P[6 + 2 * i] = sx + _hp.x; P[7 + 2 * i] = sy + _hp.y;
    }
    return P;
}

/** Laplace sphere of influence radius of the Moon. */
export function moonSOI() {
    const ratio = Math.max(bodies.moon.m, 1e-6) / bodies.earth.m;
    return EARTH_MOON_R * ratio ** 0.4;
}

/**
 * The body whose gravity dominates at `pos` (patched-conic hierarchy):
 * inside a planet's SOI -> that planet; inside Earth's SOI -> the Moon within
 * its SOI, else Earth; otherwise the Sun.
 * Returns { name, body, mu, radius, pos, vel }.
 */
export function dominantBody(pos) {
    for (const n of PLANET_NAMES) {
        const b = bodies[n];
        if (Math.hypot(pos.x - b.pos.x, pos.y - b.pos.y) < planetSOI(n)) {
            return { name: n, body: b, mu: params.G * b.m, radius: b.radius, pos: b.pos, vel: b.vel };
        }
    }
    const e = bodies.earth.pos;
    if (Math.hypot(pos.x - e.x, pos.y - e.y) < EARTH_SOI) {
        const m = bodies.moon.pos;
        if (bodies.moon.m > 0 && Math.hypot(pos.x - m.x, pos.y - m.y) < moonSOI()) {
            return {
                name: 'moon', body: bodies.moon, mu: params.G * bodies.moon.m,
                radius: MOON_RADIUS, pos: bodies.moon.pos, vel: moonVelocity(),
            };
        }
        return {
            name: 'earth', body: bodies.earth, mu: params.G * bodies.earth.m,
            radius: EARTH_RADIUS, pos: bodies.earth.pos, vel: bodies.earth.vel,
        };
    }
    const s = bodies.sun;
    return { name: 'sun', body: s, mu: params.G * s.m, radius: s.radius, pos: s.pos, vel: s.vel };
}

/**
 * Velocity in the dominant body's frame — the reference for prograde,
 * retrograde and the normal directions (as in an orbit-mode navball).
 */
export function thrustFrameVelocity(out = { x: 0, y: 0 }) {
    const dom = dominantBody(r);
    out.x = v.x - dom.vel.x;
    out.y = v.y - dom.vel.y;
    return out;
}

// ---------------------------------------------------------------------------
// Gravity

const _g = { ax: 0, ay: 0 };
const _Pnow = new Float64Array(12);
const _Pt = new Float64Array(12);

// Gameplay choice: the compressed Sun (and planets) would raise a tide 3.6% of
// Earth's pull at the Moon's distance (real: 0.6%), which wrecks lunar transfers.
// So the net solar term (direct minus the indirect term on Earth) is faded in
// smoothly between 0.6 and 1.0 Earth-SOI radii from Earth and is zero deep inside.
// Set false to see the raw tide.
export const solarTide = { fade: true };

function tideWeight(d2) {
    if (!solarTide.fade) return 1;
    const lo = 0.6 * EARTH_SOI, hi = EARTH_SOI;
    if (d2 <= lo * lo) return 0;
    if (d2 >= hi * hi) return 1;
    const x = (Math.sqrt(d2) - lo) / (hi - lo);
    return x * x * (3 - 2 * x);
}

/**
 * Acceleration at (px, py) for body positions P (order BODY_NAMES, x,y pairs).
 * The frame accelerates with Earth, so the pull of the Moon, Sun and planets on
 * Earth is subtracted (indirect term). The Sun's indirect term uses G(Ms+Me) so
 * it matches the Sun's rails motion exactly (heliocentric orbits stay Keplerian).
 */
export function accelFromPositions(px, py, P, out = _g) {
    const G = params.G;
    const ex = P[0], ey = P[1];
    let ax = 0, ay = 0;
    const eM = bodies.earth.m;
    const dex = ex - px, dey = ey - py;
    const de2 = dex * dex + dey * dey;
    if (de2 > 1e-8) {
        const f = (G * eM) / (de2 * Math.sqrt(de2));
        ax += f * dex; ay += f * dey;
    }
    const w = tideWeight(de2);
    const mm = bodies.moon.m;
    if (mm > 0) {
        const mx = P[2], my = P[3];
        const dmx = mx - px, dmy = my - py;
        const dm2 = dmx * dmx + dmy * dmy;
        if (dm2 > 1e-8) {
            const f = (G * mm) / (dm2 * Math.sqrt(dm2));
            ax += f * dmx; ay += f * dmy;
        }
        const emx = mx - ex, emy = my - ey;
        const R2 = emx * emx + emy * emy;
        if (R2 > 1e-8) {
            const fi = (G * mm) / (R2 * Math.sqrt(R2));
            // Far from Earth (w -> 1) the wobble of Earth around the Earth-Moon
            // barycentre is dropped: the Sun's rails motion does not include it,
            // so keeping it would add a spurious ~20% rotating solar-gravity error.
            const k = (1 - w) * fi;
            ax -= k * emx; ay -= k * emy;
        }
    }
    if (w > 0) {
        let fx = 0, fy = 0;
        for (let i = 2; i < 6; i++) {
            const m = BODY_REFS[i].m;
            if (!(m > 0)) continue;
            const bx = P[2 * i], by = P[2 * i + 1];
            const dx = bx - px, dy = by - py;
            const d2 = dx * dx + dy * dy;
            if (d2 > 1e-8) {
                const f = (G * m) / (d2 * Math.sqrt(d2));
                fx += f * dx; fy += f * dy;
            }
            const ix = bx - ex, iy = by - ey;
            const R2 = ix * ix + iy * iy;
            const mu = i === 2 ? G * (m + eM) : G * m;
            const fi = mu / (R2 * Math.sqrt(R2));
            fx -= fi * ix; fy -= fi * iy;
        }
        ax += w * fx; ay += w * fy;
    }
    out.ax = ax; out.ay = ay;
    return out;
}

/**
 * Gravitational acceleration at (px, py) with the Moon at (mx, my) and the Sun
 * and planets at their current positions.
 */
export function gravityAt(px, py, mx, my, out = _g) {
    const P = _Pnow;
    const e = bodies.earth.pos;
    P[0] = e.x; P[1] = e.y; P[2] = mx; P[3] = my;
    for (let i = 2; i < 6; i++) {
        const q = BODY_REFS[i].pos;
        P[2 * i] = q.x; P[2 * i + 1] = q.y;
    }
    return accelFromPositions(px, py, P, out);
}

/** Gravity at (px, py) at absolute sim time tSim (Moon, Sun, planets moved). */
export function gravityAtTime(px, py, tSim, out = _g) {
    bodyPositionsAt(tSim, _Pt);
    return accelFromPositions(px, py, _Pt, out);
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
    syncSolar();
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
    syncSolar();
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
    syncSolar();
    clearHistory();
}

// ---------------------------------------------------------------------------
// Integration

/**
 * Integration step for the current state: exactly params.dt inside Earth's SOI
 * or while thrust/guidance is active; in interplanetary cruise it grows with
 * distance from the nearest body (0.005·sqrt(d³/(G·m)), at most 2).
 */
export function stepSize() {
    if (controls.guidance || isBurning()) return params.dt;
    const e = bodies.earth.pos;
    if (Math.hypot(r.x - e.x, r.y - e.y) < EARTH_SOI) return params.dt;
    let k = Infinity;
    for (let i = 0; i < 6; i++) {
        const b = BODY_REFS[i];
        if (!(b.m > 0)) continue;
        const dx = r.x - b.pos.x, dy = r.y - b.pos.y;
        const d2 = dx * dx + dy * dy;
        const q = (d2 * Math.sqrt(d2)) / (params.G * b.m);
        if (q < k) k = q;
    }
    const h = BASE_DT * Math.sqrt(k);
    return h < params.dt ? params.dt : h > 2 ? 2 : h;
}

/**
 * Advance the simulation by one kick-drift-kick step of length h (default
 * params.dt; see stepSize()). Returns true if the craft has crashed.
 */
export function step(h = params.dt) {
    if (crashState.crashed) return true;

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
    sim.time += h;
    syncMoon();
    syncSolar();
    // Kick
    g = gravityAt(r.x, r.y, bodies.moon.pos.x, bodies.moon.pos.y);
    v.x += (g.ax + tx) * 0.5 * h;
    v.y += (g.ay + ty) * 0.5 * h;

    // Collision (steps are far shorter than the crash margins)
    const e = bodies.earth.pos;
    const m = bodies.moon.pos;
    const earthDist = Math.hypot(r.x - e.x, r.y - e.y);
    const moonDist = Math.hypot(r.x - m.x, r.y - m.y);
    if (earthDist < EARTH_CRASH_R) {
        crash('earth', 'CRASHED INTO EARTH', Math.hypot(v.x, v.y));
    } else if (moonDist < MOON_CRASH_R) {
        const mv = moonVelocity();
        crash('moon', 'CRASHED INTO MOON', Math.hypot(v.x - mv.x, v.y - mv.y));
    } else if (earthDist > EARTH_SOI) {
        for (const n of ['sun', ...PLANET_NAMES]) {
            const b = bodies[n];
            if (Math.hypot(r.x - b.pos.x, r.y - b.pos.y) < b.radius * CRASH_MARGIN) {
                crash(n, 'CRASHED INTO ' + n.toUpperCase(), Math.hypot(v.x - b.vel.x, v.y - b.vel.y));
                break;
            }
        }
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
syncSolar();
