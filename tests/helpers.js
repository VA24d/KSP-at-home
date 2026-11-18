// Shared test helpers. NOT a test file (contains no tests); safe if the runner loads it.
import * as M from '../src/maneuver.js';
import * as A from '../src/autopilot.js';
import { orbitalElements } from '../src/orbit.js';

export const DEFAULT_ROCKET = { Isp: 450, dryMass: 2, fuelMass: 24, thrust: 1 };
export const DEFAULT_MOON_MASS = 0.247;
export const MU1 = 1; // G*M_earth at G=1

/** Reset all global simulation state to defaults. */
export function reset({ G = 1, moonAngle = Math.PI / 3, rocket = DEFAULT_ROCKET, moonMass = DEFAULT_MOON_MASS } = {}) {
  A.cancel();
  M.stopAllControls();
  M.controls.throttle = 1;
  M.params.moonMass = moonMass;
  M.bodies.moon.m = moonMass;
  Object.assign(M.rocketParams, rocket);
  M.moonState.angle = moonAngle;
  M.setGravity(G);
  M.crashState.crashed = false;
  M.sim.time = 0;
  M.clearHistory();
}

export function earthElements() {
  const e = M.bodies.earth.pos;
  return orbitalElements(M.r.x - e.x, M.r.y - e.y, M.v.x, M.v.y, M.params.G * M.bodies.earth.m);
}

export function moonElements() {
  const mp = M.bodies.moon.pos, mv = M.moonVelocity();
  return orbitalElements(M.r.x - mp.x, M.r.y - mp.y, M.v.x - mv.x, M.v.y - mv.y, M.params.G * M.bodies.moon.m);
}

/** Step the physics for `time` sim units (no autopilot). Returns true if crashed. */
export function advance(time, each) {
  const end = M.sim.time + time;
  while (M.sim.time < end) {
    if (each) each();
    if (M.step()) return true;
  }
  return false;
}
