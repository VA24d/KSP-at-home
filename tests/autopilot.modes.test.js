import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/maneuver.js';
import * as A from '../src/autopilot.js';
import { reset, earthElements } from './helpers.js';
import { run } from './mission.js';

test('circularize mode turns an eccentric Earth orbit near-circular without crashing', () => {
  reset({});
  M.setInitialOrbit(2);
  M.v.x *= 1; M.v.y *= 1.15; // raise apoapsis: ellipse with rp=2
  const before = earthElements();
  assert.ok(before.e > 0.1, `setup e=${before.e}`);
  const res = A.engage('circularize', M.r, M.v, {});
  assert.ok(res.success);
  assert.ok(A.isActive());
  const out = run(400, () => !A.isActive() || A.isHolding());
  assert.ok(!out.crashed, M.crashState.message);
  const el = earthElements();
  assert.ok(el.e < 0.02, `e after circularize ${el.e} (was ${before.e}), phase ${A.getPhase()}`);
  assert.ok(el.rp > 1.5, `rp ${el.rp}`);
});

test('moon engage aborts with a reason when delta-v is far too low', () => {
  reset({ rocket: { Isp: 450, dryMass: 2, fuelMass: 0.3, thrust: 1 } });
  M.setInitialOrbit(2);
  const res = A.engage('moon', M.r, M.v, { lunarR: 1.2 });
  assert.equal(res.success, false);
  assert.ok(A.getAbortReason(), 'abort reason set');
  assert.equal(A.isActive(), false);
});

test('engage while active is refused; cancel clears state', () => {
  reset({});
  M.setInitialOrbit(2);
  assert.ok(A.engage('moon', M.r, M.v, { lunarR: 1.2 }).success);
  assert.equal(A.engage('earth', M.r, M.v, {}).success, false);
  A.cancel();
  assert.equal(A.isActive(), false);
  assert.equal(A.isHolding(), false);
});

test('autopilot does not consume more fuel than available (fuel >= 0) over a transfer', () => {
  reset({});
  M.setInitialOrbit(2);
  A.engage('moon', M.r, M.v, { lunarR: 1.2 });
  let minFuel = Infinity;
  run(800, () => { minFuel = Math.min(minFuel, M.rocketParams.fuelMass); return A.isHolding(); });
  assert.ok(minFuel >= 0, `fuel ${minFuel}`);
});
