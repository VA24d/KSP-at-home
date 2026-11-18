import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/maneuver.js';
import { reset, earthElements, moonElements, advance, DEFAULT_ROCKET } from './helpers.js';

// Tests mutate module-global state: keep everything sequential in this file.

const energy = () => {
  const e = M.bodies.earth.pos;
  const rr = Math.hypot(M.r.x - e.x, M.r.y - e.y);
  return 0.5 * (M.v.x ** 2 + M.v.y ** 2) - M.params.G * M.bodies.earth.m / rr;
};
const rEarth = () => Math.hypot(M.r.x - M.bodies.earth.pos.x, M.r.y - M.bodies.earth.pos.y);

describe('integrator', () => {
  test('1. energy conserved over 50 orbits (massless Moon): drift < 1e-5, radius within 1e-3', () => {
    reset({ moonMass: 0 });
    M.setInitialOrbit(2);
    const E0 = energy();
    const T = 2 * Math.PI * Math.sqrt(8);
    let maxDrift = 0, maxDr = 0;
    const end = 50 * T;
    while (M.sim.time < end) {
      M.step();
      maxDrift = Math.max(maxDrift, Math.abs((energy() - E0) / E0));
      maxDr = Math.max(maxDr, Math.abs(rEarth() - 2));
    }
    assert.ok(!M.crashState.crashed);
    assert.ok(maxDrift < 1e-5, `energy drift ${maxDrift}`);
    assert.ok(maxDr < 1e-3, `radius deviation ${maxDr}`);
  });

  test('2. setGravity(4) halves dt; steps per orbit unchanged', () => {
    reset({ G: 1 });
    const dt1 = M.params.dt;
    M.setInitialOrbit(2);
    const period1 = 2 * Math.PI * Math.sqrt(8 / M.params.G);
    const spo1 = period1 / M.params.dt;
    reset({ G: 4 });
    const dt4 = M.params.dt;
    assert.ok(Math.abs(dt4 / dt1 - 0.5) < 1e-12, `dt ratio ${dt4 / dt1}`);
    const period4 = 2 * Math.PI * Math.sqrt(8 / M.params.G);
    const spo4 = period4 / M.params.dt;
    assert.ok(Math.abs(spo4 / spo1 - 1) < 1e-12, `steps/orbit ${spo1} vs ${spo4}`);
    // measure it: count steps until the craft returns to angle 0 crossing (massless moon for cleanliness)
    reset({ G: 4, moonMass: 0 });
    M.setInitialOrbit(2);
    let steps = 0, prevY = M.r.y - M.bodies.earth.pos.y;
    for (let i = 0; i < 1e6; i++) {
      M.step(); steps++;
      const y = M.r.y - M.bodies.earth.pos.y;
      if (steps > 10 && prevY < 0 && y >= 0) break; // clockwise orbit: crosses y=0 upward once per revolution
      prevY = y;
    }
    assert.ok(Math.abs(2 * steps / spo1 - 1) < 0.01, `measured half-orbit steps ${steps} vs ${spo1 / 2}`);
  });
});

describe('moon motion', () => {
  test('3. after one lunar period angle advanced by -2pi (1e-6); velocity tangent, |v| = R|w|', () => {
    reset({});
    const w = M.moonAngularRate();
    assert.ok(w < 0);
    M.setInitialOrbit(2);
    const a0 = M.moonState.angle;
    const T = 2 * Math.PI / Math.abs(w);
    // Orbiting craft would eventually be fine; only the moon angle matters. Use no fuel use.
    while (M.sim.time < T) { M.step(); if (M.crashState.crashed) break; }
    // sim.time overshoots T by < dt; correct for it
    const overshoot = M.sim.time - T;
    const expected = w * M.sim.time;
    assert.ok(Math.abs((M.moonState.angle - a0) - expected) < 1e-9);
    // angle at exactly T:
    const atT = (M.moonState.angle - a0) - w * overshoot;
    assert.ok(Math.abs(atT + 2 * Math.PI) < 1e-6, `angle advance ${atT}, want ${-2 * Math.PI}`);
    // tangent velocity
    const mv = M.moonVelocity();
    const rel = { x: M.bodies.moon.pos.x - M.bodies.earth.pos.x, y: M.bodies.moon.pos.y - M.bodies.earth.pos.y };
    const dot = mv.x * rel.x + mv.y * rel.y;
    assert.ok(Math.abs(dot) < 1e-9, `v.r = ${dot}`);
    assert.ok(Math.abs(Math.hypot(mv.x, mv.y) - M.EARTH_MOON_R * Math.abs(w)) < 1e-12);
    // clockwise: cross(r, v) < 0
    assert.ok(rel.x * mv.y - rel.y * mv.x < 0);
  });
});

describe('orbit stability', () => {
  test('4. lunar orbit r=1.2 stable for 300 time units (rp, ra within 15%, no crash)', () => {
    reset({});
    M.setInitialOrbit(2);
    const mp = M.bodies.moon.pos, mv = M.moonVelocity();
    // clockwise circular orbit about the Moon, craft on the Earth-side/outside: place at +x of Moon
    const vc = Math.sqrt(M.params.G * M.bodies.moon.m / 1.2);
    M.r.x = mp.x + 1.2; M.r.y = mp.y;
    M.v.x = mv.x; M.v.y = mv.y - vc;
    const crashed = advance(300);
    assert.ok(!crashed, `crashed: ${M.crashState.message}`);
    const el = moonElements();
    assert.ok(Math.abs(el.rp / 1.2 - 1) < 0.15, `rp ${el.rp}`);
    assert.ok(Math.abs(el.ra / 1.2 - 1) < 0.15, `ra ${el.ra}`);
  });

  test('5. Earth orbit r=2 with Moon present stable for 400 time units (within 5%)', () => {
    reset({});
    M.setInitialOrbit(2);
    let minR = 9, maxR = 0;
    const crashed = advance(400, () => { const x = rEarth(); minR = Math.min(minR, x); maxR = Math.max(maxR, x); });
    assert.ok(!crashed);
    const el = earthElements();
    assert.ok(Math.abs(el.rp / 2 - 1) < 0.05, `rp ${el.rp} (min r seen ${minR})`);
    assert.ok(Math.abs(el.ra / 2 - 1) < 0.05, `ra ${el.ra} (max r seen ${maxR})`);
  });
});

describe('rocket', () => {
  test('6. rocket equation: |dv| within 0.5% of ve*ln(m0/mdry); fuel never negative', () => {
    reset({ G: 1e-6, moonMass: 0 });
    // G this small makes the default dt huge (5 time units, ~3 burn steps); use a fine step so
    // the explicit mass-flow discretisation error is negligible.
    M.params.dt = 0.001;
    M.setInitialOrbit(2);
    const sp0 = Math.hypot(M.v.x, M.v.y);
    const m0 = M.totalMass(), md = M.rocketParams.dryMass;
    const expected = M.exhaustVelocity() * Math.log(m0 / md);
    M.controls.prograding = true; M.controls.automated = true;
    let minFuel = Infinity, steps = 0;
    while (M.rocketParams.fuelMass > 0 && steps < 5e6) {
      M.step(); steps++;
      minFuel = Math.min(minFuel, M.rocketParams.fuelMass);
    }
    assert.ok(minFuel >= 0, `fuel ${minFuel}`);
    assert.equal(M.rocketParams.fuelMass, 0);
    const dv = Math.hypot(M.v.x, M.v.y) - sp0; // thrust is along velocity, so speed gain = |dv|
    assert.ok(Math.abs(dv / expected - 1) < 0.005, `dv ${dv} expected ${expected} (${(dv / expected - 1) * 100}%)`);
  });

  test('7. throttle 0.5 halves acceleration and fuel flow', () => {
    const run = (throttle) => {
      reset({ G: 1e-6, moonMass: 0 });
      M.params.dt = 0.001;
      M.setInitialOrbit(2);
      M.controls.prograding = true; M.controls.throttle = throttle;
      const v0 = Math.hypot(M.v.x, M.v.y), f0 = M.rocketParams.fuelMass;
      for (let i = 0; i < 100; i++) M.step();
      return { dv: Math.hypot(M.v.x, M.v.y) - v0, fuel: f0 - M.rocketParams.fuelMass };
    };
    const full = run(1), half = run(0.5);
    assert.ok(full.dv > 0 && full.fuel > 0);
    assert.ok(Math.abs(half.dv / full.dv - 0.5) < 1e-3, `dv ratio ${half.dv / full.dv}`);
    assert.ok(Math.abs(half.fuel / full.fuel - 0.5) < 1e-9, `fuel ratio ${half.fuel / full.fuel}`);
  });

  test('7b. automated flag forces full throttle', () => {
    reset({ G: 1e-6, moonMass: 0 });
    M.params.dt = 0.001; M.setInitialOrbit(2);
    M.controls.prograding = true; M.controls.throttle = 0.2; M.controls.automated = true;
    const f0 = M.rocketParams.fuelMass;
    M.step();
    const full = M.rocketParams.thrust / M.exhaustVelocity() * M.params.dt;
    assert.ok(Math.abs((f0 - M.rocketParams.fuelMass) / full - 1) < 1e-9);
  });

  test('8. normal burn is perpendicular to velocity over one step (regression, rel 1e-6)', () => {
    for (const ctl of ['normalPos', 'normalNeg']) {
      reset({ G: 1e-12, moonMass: 0 }); // gravity must be negligible vs the 1e-5 thrust kick
      M.params.dt = 0.001;
      M.setInitialOrbit(2);
      // large speed relative to gravity so velocity is well defined; skewed direction
      M.v.x = 0.3; M.v.y = -0.4;
      M.controls[ctl] = true; M.controls.automated = true;
      const vx0 = M.v.x, vy0 = M.v.y;
      M.step();
      const dvx = M.v.x - vx0, dvy = M.v.y - vy0;
      const dot = dvx * vx0 + dvy * vy0;
      const norm = Math.hypot(dvx, dvy) * Math.hypot(vx0, vy0);
      assert.ok(norm > 0, 'no delta-v produced');
      assert.ok(Math.abs(dot / norm) < 1e-6, `${ctl}: cos angle ${dot / norm}`);
    }
  });

  test('8b. normalPos thrusts to the left of velocity (cross(v, dv) > 0)', () => {
    reset({ G: 1e-6, moonMass: 0 });
    M.params.dt = 0.001; M.setInitialOrbit(2);
    M.v.x = 0.3; M.v.y = -0.4;
    M.controls.normalPos = true; M.controls.automated = true;
    const vx0 = M.v.x, vy0 = M.v.y;
    M.step();
    assert.ok(vx0 * (M.v.y - vy0) - vy0 * (M.v.x - vx0) > 0);
  });
});

describe('state', () => {
  test('12. undo restores a state >= 1 time unit old (time, position, fuel) and clears crash', () => {
    reset({});
    M.setInitialOrbit(2);
    M.controls.prograding = true; M.controls.throttle = 0.3; // burn some fuel
    advance(10, () => {});
    assert.ok(M.sim.time >= 10);
    const tNow = M.sim.time, fuelNow = M.rocketParams.fuelMass, rNow = { x: M.r.x, y: M.r.y };
    M.crashState.crashed = true; // force crash flag
    assert.equal(M.undo(), true);
    assert.ok(M.sim.time <= tNow - 1, `time ${M.sim.time} vs now ${tNow}`);
    assert.ok(M.sim.time >= 0);
    assert.ok(M.rocketParams.fuelMass > fuelNow, `fuel ${M.rocketParams.fuelMass} vs ${fuelNow}`);
    assert.ok(Math.hypot(M.r.x - rNow.x, M.r.y - rNow.y) > 1e-3, 'position did not change');
    assert.equal(M.crashState.crashed, false);
  });

  test('12b. undo with no history returns false', () => {
    reset({});
    M.setInitialOrbit(2);
    assert.equal(M.undo(), false);
  });

  test('13. radial drop from r=1.5 crashes into Earth and stops motion', () => {
    reset({});
    M.setInitialOrbit(1.5);
    M.v.x = 0; M.v.y = 0;
    let crashed = false, steps = 0;
    while (!crashed && steps < 1e6) { crashed = M.step(); steps++; }
    assert.ok(crashed, 'no crash');
    assert.equal(M.crashState.body, 'earth');
    assert.ok(M.crashState.speed > 0);
    const snap = { x: M.r.x, y: M.r.y, vx: M.v.x, vy: M.v.y, t: M.sim.time };
    for (let i = 0; i < 100; i++) assert.equal(M.step(), true);
    assert.deepEqual({ x: M.r.x, y: M.r.y, vx: M.v.x, vy: M.v.y, t: M.sim.time }, snap);
  });

  test('13b. dropping into the Moon crashes with body moon', () => {
    reset({});
    M.setInitialOrbit(2);
    const mp = M.bodies.moon.pos, mv = M.moonVelocity();
    M.r.x = mp.x + 1; M.r.y = mp.y; M.v.x = mv.x; M.v.y = mv.y;
    let crashed = false, steps = 0;
    while (!crashed && steps < 1e6) { crashed = M.step(); steps++; }
    assert.ok(crashed);
    assert.equal(M.crashState.body, 'moon');
  });

  test('helpers: gravityAt matches inverse-square; dominantBody switches in Moon SOI', () => {
    reset({ moonMass: 0 });
    const e = M.bodies.earth.pos;
    const g = M.gravityAt(e.x + 2, e.y, 0, 0, { ax: 0, ay: 0 });
    assert.ok(Math.abs(g.ax + 0.25) < 1e-12 && Math.abs(g.ay) < 1e-12);
    reset({});
    M.setInitialOrbit(2);
    assert.equal(M.dominantBody(M.r).name, 'earth');
    const mp = M.bodies.moon.pos;
    assert.equal(M.dominantBody({ x: mp.x + 0.5, y: mp.y }).name, 'moon');
    assert.ok(M.moonSOI() > 0.5 && M.moonSOI() < M.EARTH_MOON_R);
  });

  test('deltaVRemaining equals exhaustVelocity * ln(total/dry)', () => {
    reset({});
    const expect = M.exhaustVelocity() * Math.log(26 / 2);
    assert.ok(Math.abs(M.deltaVRemaining() - expect) < 1e-12);
    assert.deepEqual({ ...M.rocketParams }, DEFAULT_ROCKET);
  });
});
