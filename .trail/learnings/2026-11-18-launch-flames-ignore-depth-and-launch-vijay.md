---
title: Launch flames ignore depth and launch effects measure altitude above the visual pad
author: Vijay
date: 2026-11-18
branch: feature/simulation-improvements
cost: { minutes: 1, tokens: 1138 }
id: l-8b9116eb
scope: repo
status: active
src: agent
touches:
  - src/main.js
---

## Decided
- Engine plumes, nozzle glows and every particle system render with `depthTest: false`. The camera looks straight down at the orbital plane (z=0), so on the pad the planet's near bulge (z>0) sits in front of the nozzle and hid the flame and pad smoke entirely. Nothing in the game leaves z=0, so skipping the depth test cannot show anything that should be hidden.
- Launch visuals (sky tint, plume expansion, camera rumble, condensation collar) use `launchAltitude()`, which subtracts `PAD_ALT`. The sim starts the craft PAD_ALT (0.03 radii, ~190 km) above the surface and `visualPos()` squashes that away; using raw `|r| - 1` made every altitude-driven effect think the pad was already in space.
- In flight the craft is scaled so the remaining stack (often just the upper stage) spans `vis.length`; scaling by the full-stack length left the spacecraft a few pixels long after staging.

## Watch out
- `plume.set(..., expand)` with `expand` omitted (or -1) keeps the old orbital look; only the launch passes 0..1.
- Dev builds have `window.__ksp.freeze = true` to hold a frame for screenshots; the frame loop still renders.

In the code: src/effects.js (particle + plume materials, `createPlume().set`), src/main.js (`launchAltitude`, `padSquash`, `updateCraftVisual`, `updateSky`, `updateCamera` shake).
