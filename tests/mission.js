// Shared mission runner for autopilot tests (not a test file).
import * as M from '../src/maneuver.js';
import * as A from '../src/autopilot.js';

export const PRESETS = {
  default: { Isp: 450, dryMass: 2, fuelMass: 24, thrust: 1 },
  p1: { Isp: 421, dryMass: 2, fuelMass: 30, thrust: 1.5 },
  p2: { Isp: 462, dryMass: 2, fuelMass: 24, thrust: 0.8 },
  p3: { Isp: 380, dryMass: 2, fuelMass: 34, thrust: 4 },
};

/** Run Autopilot+physics for up to maxT sim time. Returns { crashed, done(reason) }. */
export function run(maxT, until) {
  const end = M.sim.time + maxT;
  while (M.sim.time < end) {
    A.update(M.params.dt, M.r, M.v, M.bodies.moon.pos);
    if (M.step()) return { crashed: true, hit: false };
    if (until && until()) return { crashed: false, hit: true };
    if (!A.isActive()) return { crashed: false, hit: false, inactive: true };
  }
  return { crashed: false, hit: false };
}
