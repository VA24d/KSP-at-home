---
title: Warp-to-burn must clamp sim time to the window and re-read it every frame
author: Vijay
date: 2026-11-18
branch: feature/simulation-improvements
cost: { minutes: 1, tokens: 2361 }
id: l-367c7c7f
scope: repo
status: active
src: agent
touches:
  - src/main.js
  - src/burnzones.js
---

## Decided
- Warp-to-burn recomputes the burn-zone analysis every frame while warping and caps the
  frame's simulation advance at the window time, so high warp can never step over a window.
- The interplanetary alignment window spans one full craft orbital period either side of
  the planet alignment, and the time-to-window is the craft's actual pass over the
  ejection point inside that span.

## Tried and ruled out
- Choosing the warp level from the remaining time alone: at 1000x with slow frames one
  frame advanced ~8 time units, the Mars zone is open for only a couple of units, and the
  window was skipped every synodic period (4-5 Mars windows went by before one was hit).
- Reading `burnZones.nextWindow()` from the throttled prediction pass: it refreshes every
  0.12 s real time, ~60 time units at 1000x, so the target time kept sliding forward.
- A quarter-period alignment tolerance: when the craft was on the far side of Earth at
  alignment it never crossed the ejection point inside the window.

## In the code
- `src/main.js` `updateWarpToBurn()` calls `burnZones.update()`; `stepFlight` clamps
  `game.acc` to `warpBurn.until - M.sim.time`.
- `src/burnzones.js` planet branch of `analyze()`: `tol = el.period`, `passAfter(tA)`.
