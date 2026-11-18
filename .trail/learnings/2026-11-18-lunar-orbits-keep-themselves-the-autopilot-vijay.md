---
title: "Lunar orbits keep themselves: the autopilot releases after capture instead of holding"
author: Vijay
date: 2026-11-18
branch: feature/simulation-improvements
cost: { minutes: 11, tokens: 124171 }
id: l-a4d92b02
scope: repo
status: active
src: agent
touches:
  - index.html
  - src/main.js
  - src/ui.js
  - src/burnassist.js
  - src/burnzones.js
  - src/coach.js
  - src/launch.js
  - src/launchdata.js
  - src/maneuver.js
  - src/orbit.js
---

## Decided
- After lunar orbit insertion the Moon autopilot ends in ORBIT_ACHIEVED and lets go.
  It used to hand off to alt-hold, which trims the orbit to perfectly circular forever
  and burns fuel on every small tidal wobble; testers read that as "the orbit needs fuel".
- Unpowered lunar orbits were measured in the real integrator (Moon mass 0.247, Moon at
  15 Earth radii): radius 0.7-2.5 from the Moon's centre stay bounded for 20-30 orbits
  (e < 0.2); radius 2.9 is torn away by Earth's tide within 5 orbits. The autopilot's
  targets (0.8 / 1.2 / 1.8) are all inside the stable range.

## Watch out
- The compressed Earth-Moon system puts the Moon's Laplace SOI (~8.6) outside its Hill
  sphere (~6.5), so the SOI edge is not a stable-orbit limit; keep lunar apoapsis below
  ~2.5 radii from the Moon's centre.

## In the code
- `src/autopilot.js` `finishCircularize()`; `tests/autopilot.moon.test.js` now coasts 200
  time units after capture and checks the orbit stays put with no fuel used.
