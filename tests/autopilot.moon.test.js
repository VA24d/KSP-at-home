import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/maneuver.js';
import * as A from '../src/autopilot.js';
import { reset, earthElements, moonElements } from './helpers.js';
import { PRESETS, run } from './mission.js';

// One independent test per (preset, moon angle). Sequential: shared module state.
for (const preset of Object.keys(PRESETS)) {
  for (const [angName, ang] of [['pi/3', Math.PI / 3], ['2.5', 2.5]]) {
    test(`11. mission preset=${preset} moonAngle=${angName}: lunar orbit then return to Earth`, () => {
      reset({ moonAngle: ang, rocket: PRESETS[preset] });
      M.setInitialOrbit(2);
      const res = A.engage('moon', M.r, M.v, { lunarR: 1.2 });
      assert.ok(res.success, `engage failed: ${res.reason}`);

      // Leg 1: transfer + lunar capture
      const t0 = M.sim.time;
      const leg1 = run(800, () => A.isHolding());
      assert.ok(!leg1.crashed, `leg1 crash: ${M.crashState.message} at t=${(M.sim.time - t0).toFixed(1)} phase=${A.getPhase()}`);
      assert.ok(A.isHolding(), `not holding after ${(M.sim.time - t0).toFixed(1)}t; phase=${A.getPhase()} abort=${A.getAbortReason()} fuel=${M.rocketParams.fuelMass.toFixed(2)}`);
      let el = moonElements();
      assert.ok(el.bound && el.e < 0.02, `lunar e=${el.e} rp=${el.rp} ra=${el.ra}`);
      assert.ok(Math.abs(el.r / 1.2 - 1) < 0.25, `lunar r=${el.r}`);

      // Leg 2: return
      A.cancel(); M.stopAllControls();
      const res2 = A.engage('earth', M.r, M.v, {});
      assert.ok(res2.success, `earth engage failed: ${res2.reason}`);
      const t1 = M.sim.time;
      const leg2 = run(1500);
      assert.ok(!leg2.crashed, `leg2 crash: ${M.crashState.message} after ${(M.sim.time - t1).toFixed(1)}t phase=${A.getPhase()}`);
      el = earthElements();
      assert.ok(el.bound && el.e < 0.02, `earth e=${el.e} rp=${el.rp} ra=${el.ra} phase=${A.getPhase()} abort=${A.getAbortReason()} active=${A.isActive()} fuel=${M.rocketParams.fuelMass.toFixed(2)}`);
      assert.ok(Math.abs(el.r / 2 - 1) < 0.15, `earth r=${el.r}`);
    });
  }
}
