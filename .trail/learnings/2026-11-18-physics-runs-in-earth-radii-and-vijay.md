---
title: Physics runs in Earth radii and 806 s time units on a fixed leapfrog step; launch guidance flies the same integrator
author: Vijay
date: 2026-11-18
branch: feature/simulation-improvements
cost: { minutes: 85, tokens: 834257 }
id: l-d73e921e
scope: repo
status: active
src: agent
touches:
  - src/maneuver.js
  - src/orbit.js
  - src/launch.js
  - src/circularize.js
  - src/ui.js
  - src/main.js
  - src/burnzones.js
  - src/autopilot.js
  - src/trajectory.js
---

## Decided
- Units: 1 length unit = Earth radius (6371 km), G=1 and Earth mass 1, so 1 time unit = 806.02 s and velocities convert straight to m/s (×7904). Isp in seconds becomes ve = Isp/806.02. Keeps real-world readouts without fudge factors.
- Fixed-step kick-drift-kick leapfrog, dt = 0.005/sqrt(G) so steps per orbit stay constant when the gravity multiplier changes. main.js advances a real-time accumulator (realDt × simRate × warp) and runs whole steps, capped at 4000 per frame; autopilot and circularize controllers update once per physics step, never per frame, so results do not depend on frame rate or warp.
- Frame is Earth-centred and non-inertial: gravityAt subtracts the Moon's pull on Earth (indirect term) and the Moon moves at -sqrt(G(Me+Mm)/R^3). Without the indirect term low Earth orbits drift badly.
- Thrust axes (prograde/retro/normal) are relative to the dominant body's frame (thrustFrameVelocity), chosen by Laplace SOI R·(m/M)^0.4.
- Launch (launch.js) sets controls.guidance, an acceleration vector that burns no spacecraft fuel, so the craft reaches orbit with full tanks. MECO uses an exact apoapsis cutoff (scale the last step) and circularization is dead-beat; both were needed to hit e<0.001 at high G and high targets.
## Tried and ruled out
- Proportional throttle-down near MECO: caused crashes for target radius 1.1.
- Patched-conic escape for the return-to-Earth autopilot: off by ~36°; replaced with numerical shooting (planEscape).
- Mid-course correction via burnToward: inaccurate; replaced by an exact vector burn using thrustState.
## Watch out
- Launch target radius above ~6 gets captured by or crashes into the Moon (test todo); the slider is capped at 6 in ui.js.
- Run tests with bare `node --test` on Node 22.13; `node --test tests/` fails.
In the code: src/maneuver.js (step, gravityAt, setGravity), src/launch.js, src/autopilot.js, src/main.js stepFlight/stepLaunch, tests/.
