import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/maneuver.js';
import * as S from '../src/solar.js';
import { predictPath } from '../src/trajectory.js';
import { reset } from './helpers.js';

// Sequential: shared module state.
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('planet positions match helioState relative to the Sun; Earth fixed', () => {
  reset();
  M.setInitialOrbit(2);
  for (const t of [0, 123.4]) {
    M.sim.time = t;
    M.setGravity(1);
    // step() is the only thing advancing time; re-sync through bodyStateAt instead
    const e = M.bodies.earth.pos;
    const he = S.helioState('earth', t, M.params.G);
    const sun = M.bodyStateAt('sun', t);
    assert.ok(Math.abs(sun.x - (e.x - he.x)) < 1e-9 && Math.abs(sun.y - (e.y - he.y)) < 1e-9);
    for (const n of ['mercury', 'venus', 'mars']) {
      const hp = S.helioState(n, t, M.params.G);
      const p = M.bodyStateAt(n, t);
      assert.ok(Math.abs(p.x - (sun.x + hp.x)) < 1e-9 && Math.abs(p.y - (sun.y + hp.y)) < 1e-9, n);
      assert.ok(Math.abs(p.vx - (hp.vx - he.vx)) < 1e-12);
    }
  }
  M.sim.time = 0;
  M.setInitialOrbit(2);
  for (let i = 0; i < 100; i++) M.step();
  const m = M.bodyStateAt('mars', M.sim.time);
  assert.ok(dist(m, M.bodies.mars.pos) < 1e-9, 'synced body matches bodyStateAt');
  assert.equal(M.bodies.earth.vel.x, 0);
});

test('SOI radii', () => {
  assert.ok(Math.abs(M.soiRadius('earth') - 30) < 1.5);
  assert.ok(Math.abs(M.soiRadius('mars') - 18.7) < 1);
  assert.ok(Math.abs(M.soiRadius('venus') - 20) < 1.5);
  assert.ok(Math.abs(M.soiRadius('mercury') - 3.6) < 0.4);
  assert.equal(M.soiRadius('moon'), M.moonSOI());
  assert.equal(M.soiRadius('sun'), Infinity);
});

test('dominantBody hierarchy', () => {
  reset();
  M.setInitialOrbit(2);
  const e = M.bodies.earth.pos, mo = M.bodies.moon.pos, ma = M.bodies.mars.pos, su = M.bodies.sun.pos;
  assert.equal(M.dominantBody({ x: e.x + 2, y: e.y }).name, 'earth');
  assert.equal(M.dominantBody({ x: mo.x + 0.5, y: mo.y }).name, 'moon');
  assert.equal(M.dominantBody({ x: ma.x + 5, y: ma.y }).name, 'mars');
  const dm = M.dominantBody({ x: ma.x + 5, y: ma.y });
  assert.equal(dm.vel, M.bodies.mars.vel);
  assert.equal(M.dominantBody({ x: su.x + 2000, y: su.y }).name, 'sun');
  assert.equal(M.dominantBody({ x: e.x + 40, y: e.y }).name, 'sun');
  // prograde frame is relative to the dominant body
  M.r.x = ma.x + 5; M.r.y = ma.y; M.v.x = M.bodies.mars.vel.x; M.v.y = M.bodies.mars.vel.y + 0.3;
  const fv = M.thrustFrameVelocity({ x: 0, y: 0 });
  assert.ok(Math.abs(fv.x) < 1e-12 && Math.abs(fv.y - 0.3) < 1e-12);
});

test('LEO unchanged: stepSize == params.dt', () => {
  reset({ moonMass: 0 });
  M.setInitialOrbit(2);
  assert.equal(M.stepSize(), M.params.dt);
  const E = () => 0.5 * (M.v.x ** 2 + M.v.y ** 2) - 1 / dist(M.r, M.bodies.earth.pos);
  const E0 = E();
  const T = 2 * Math.PI * Math.sqrt(8);
  while (M.sim.time < 10 * T) { M.step(M.stepSize()); }
  assert.ok(Math.abs((E() - E0) / E0) < 1e-5);
});

// Energy drift is measured with the planets' masses zeroed (they perturb a real
// orbit by ~2e-3 over a year, which is physics, not integrator error); with the
// planets on the orbit must stay bound with drift < 1e-2.
for (const [label, planetsOn, tol] of [['planets off', false, 1e-3], ['planets on', true, 1e-2]]) test(`heliocentric circular orbit at 1.2 AU stays bound (${label}), energy drift < ${tol}`, () => {
  reset();
  const saved = {};
  for (const n of ['mercury', 'venus', 'mars']) { saved[n] = M.bodies[n].m; if (!planetsOn) M.bodies[n].m = 0; }
  try {
  M.setInitialOrbit(2);
  const sun = M.bodies.sun;
  const R = 1.2 * S.AU, mu = M.params.G * (S.SUN_MASS);
  const ang = 3.3;   // away from planets
  const sp = M.bodyStateAt('sun', 0);
  M.r.x = sp.x + R * Math.cos(ang); M.r.y = sp.y + R * Math.sin(ang);
  const vc = Math.sqrt(mu / R);
  M.v.x = sun.vel.x + vc * Math.sin(ang); M.v.y = sun.vel.y - vc * Math.cos(ang); // clockwise
  const en = () => 0.5 * ((M.v.x - sun.vel.x) ** 2 + (M.v.y - sun.vel.y) ** 2) - mu / dist(M.r, sun.pos);
  const E0 = en();
  assert.equal(M.dominantBody(M.r).name, 'sun');
  const Tper = 2 * Math.PI * Math.sqrt(R ** 3 / mu);
  let maxD = 0, steps = 0;
  while (M.sim.time < Tper) {
    const h = M.stepSize();
    assert.ok(h > M.params.dt);
    if (M.step(h)) break;
    steps++;
    maxD = Math.max(maxD, Math.abs((en() - E0) / E0));
  }
  assert.ok(!M.crashState.crashed, M.crashState.message);
  assert.ok(maxD < tol, `drift ${maxD}`);
  assert.ok(steps < 5000, `steps ${steps}`);
  } finally { for (const n in saved) M.bodies[n].m = saved[n]; }
});

test('crash on Mars', () => {
  reset();
  M.setInitialOrbit(2);
  const ma = M.bodies.mars;
  M.r.x = ma.pos.x + 6; M.r.y = ma.pos.y; M.v.x = ma.vel.x - 0.5; M.v.y = ma.vel.y;
  let crashed = false;
  for (let i = 0; i < 200000 && !crashed; i++) crashed = M.step(M.stepSize());
  assert.ok(crashed);
  assert.equal(M.crashState.body, 'mars');
  assert.equal(M.crashState.message, 'CRASHED INTO MARS');
});

test('Hohmann departure leaves Earth SOI and becomes Sun-dominant', () => {
  reset({ moonMass: 0 });
  M.setInitialOrbit(2);
  const hm = S.hohmann('mars', M.params.G);
  // Start at SOI edge-ish: launch from r=2 with hyperbolic speed along +Earth heliocentric velocity.
  const he = S.helioState('earth', 0, M.params.G);
  const ux = he.vx / Math.hypot(he.vx, he.vy), uy = he.vy / Math.hypot(he.vx, he.vy);
  const vEsc2 = 2 / 2 + hm.vInf ** 2;     // v^2 = 2mu/r + vinf^2
  const e = M.bodies.earth.pos;
  M.r.x = e.x + 2 * uy; M.r.y = e.y - 2 * ux;   // perpendicular start, velocity along ux,uy
  M.v.x = Math.sqrt(vEsc2) * ux; M.v.y = Math.sqrt(vEsc2) * uy;
  let n = 0;
  while (M.dominantBody(M.r).name !== 'sun' && n++ < 400000) { if (M.step(M.stepSize())) break; }
  assert.ok(!M.crashState.crashed);
  assert.equal(M.dominantBody(M.r).name, 'sun');
  assert.ok(M.sim.time < 600, `left SOI at t=${M.sim.time}`);
});

test('predictPath: Earth orbit unchanged, cruise path extends to long horizon', () => {
  reset();
  M.setInitialOrbit(2);
  const out = new Float64Array(6000 * 3);
  let res = predictPath(6000, out);
  assert.equal(res.horizon, M.params.lookahead);
  assert.ok(Math.abs(Math.hypot(out[0] - M.bodies.earth.pos.x, out[1] - M.bodies.earth.pos.y) - 2) < 1e-9);
  // craft well outside Earth SOI on a heliocentric orbit
  const sp = M.bodyStateAt('sun', 0);
  const R = 1.2 * S.AU, ang = 3.3, mu = S.SUN_MASS;
  M.r.x = sp.x + R * Math.cos(ang); M.r.y = sp.y + R * Math.sin(ang);
  const vc = Math.sqrt(mu / R);
  M.v.x = M.bodies.sun.vel.x + vc * Math.sin(ang); M.v.y = M.bodies.sun.vel.y - vc * Math.cos(ang);
  res = predictPath(6000, out);
  assert.equal(res.horizon, 2500);
  assert.ok(res.count > 50 && res.count < 6000);
  assert.ok(res.endTime > 2400);
  // drawn around the Sun's current position at ~1.2 AU
  for (let i = 0; i < res.count; i += 50) {
    const d = Math.hypot(out[3 * i] - M.bodies.sun.pos.x, out[3 * i + 1] - M.bodies.sun.pos.y);
    assert.ok(Math.abs(d / R - 1) < 0.02, `point ${i} at ${d}`);
  }
});
