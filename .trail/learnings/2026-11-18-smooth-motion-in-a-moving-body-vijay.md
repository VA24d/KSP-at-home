---
title: "Smooth motion in a moving body's frame needs per-frame re-anchoring and attitude feed-forward"
author: Vijay
date: 2026-11-18
branch: feature/simulation-improvements
cost: { minutes: 18, tokens: 63812 }
id: l-1c543258
scope: repo
status: active
src: agent
touches:
  - src/autopilot.js
  - src/main.js
  - src/styles.css
  - src/ui.js
  - tests/autopilot.moon.test.js
  - src/trajectory.js
  - src/burnzones.js
---

## Decided
- The predicted path is recomputed only every ~0.1 s, but each point now carries its
  dominant body's index and a vertex-shader offset moves it with that body every frame,
  so a lunar orbit stays glued to the moving Moon. Burn zones are re-anchored every frame.
- The ship is drawn ahead of the last whole physics step by the unspent accumulator time,
  so it glides instead of shuffling by 15-19 steps per frame at warp.
- The attitude spring gets the target's own turn rate as feed-forward; it snaps when
  prograde turns faster than 8 rad/s.
- Focus framing uses hysteresis (re-frame only on a 20% apoapsis change), the HUD waits
  1.2 s before swapping between orbit, zone and transfer layouts, and circularize zones
  appear only above e = 0.05.

## Tried and ruled out
- Updating the prediction only on its 0.12 s timer: at 10x the Moon moves ~0.35 radii
  between updates, so the ring jumped and the ship sat visibly off its own orbit.
- A plain attitude spring (wn 2.4/s): a lunar orbit at 10x turns prograde at ~3.8 rad/s
  and the ship pointed radially outward while it lagged.
- Circularize zones from e = 0.01: Earth's tide keeps lunar orbits at e 0.01-0.06, so the
  game nagged to circularize every half orbit.

## In the code
- `src/trajectory.js` `follow()`, `body` attribute and `uBodyOff` shader uniform.
- `src/main.js` `updateCraftVisual` (lead), `updateAttitude`, `orbitFitDistance`, HUD dwell in `updateAssist`.
- `src/burnzones.js` `MIN_ECC`.
