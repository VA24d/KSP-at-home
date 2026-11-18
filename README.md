# KSP@ASTRO

KSP@ASTRO is a 2D orbital mechanics sandbox built by the Astronautics Club, IIIT Hyderabad. It runs in the browser: **https://va24d.github.io/KSP-at-home/**

This repository is archived and read-only. The site stays up at the address above, built from the last commit on `main`. The first version of the game is kept on the `legacy-main` branch.

## What you can do

Pick a Saturn V, SLS or Starship, or build a custom rocket, and launch it from a pad on Earth. Each rocket flies its own stages with real thrust, specific impulse and mass, so a Saturn V leaves the pad at 1.18 g and climbs to about 4.4 g before its first stage burns out, while SLS starts at 1.5 g. Saturn V, SLS and Starship throttle back to 70% through the region of highest aerodynamic pressure.

Once in orbit you can fly by hand or hand over to the autopilot, which can circularize, hold altitude, fly to the Moon and settle into lunar orbit, and bring you back to Earth. Mercury, Venus and Mars are there too, on a compressed scale: a year lasts about 25 game days and a Hohmann transfer to Mars takes about 18. There is no autopilot for the planets; you fly those transfers yourself.

The game has two difficulty settings. Easy widens the burn windows, shows a progress bar during a burn and cuts the engine when the burn is done. Real narrows the windows and leaves the cutoff to you. In both, the map marks where to burn, with a countdown: a green band at apoapsis, an orange one at periapsis, and a purple one for a transfer to the Moon or a planet. "Warp to next burn" skips ahead to the next window and stops there. A coach in the corner walks a new player through launch, orbit, transfer and capture.

The HUD changes with the phase of flight (on the pad, ascent, orbit, inside a burn window, burning, autopilot, between planets). On phones the panels move into a bottom sheet with the burn buttons under your thumb; landscape phones get side rails.

## Controls

| Key | Action |
| --- | --- |
| W / S | Burn prograde / retrograde |
| A / D | Burn radial |
| Shift / Ctrl | Raise / lower throttle |
| Z / X | Full throttle / cut throttle |
| Space | Pause |
| , / . | Slow down / speed up time warp (up to 10,000×) |
| 1 / 2 / 3 / 4 / 5 | Focus Earth / Moon / ship / Sun / target |
| M | Solar system map; press again to go back |
| N | Warp to the next burn window |
| C | Circularize |
| T | Altitude hold |
| P | Toggle trajectory prediction |
| H | Hohmann transfer |
| Esc | Cancel the autopilot |
| Ctrl+Z | Undo |
| R | Restart after a crash |

On phones the same actions are touch buttons. If the ship goes off screen, an arrow at the edge points to it; tap the arrow to bring the camera back.

## Physics notes

- Units: 1 length unit is one Earth radius (6,371 km) and 1 time unit is 806 s, so velocities come out in real m/s.
- The physics frame is centred on Earth. The Moon, Sun and planets move on fixed circular orbits, and the frame's own acceleration toward them is subtracted, so orbits around any body come out right.
- Integration uses a kick-drift-kick leapfrog. The step is 0.005 time units near Earth and during any burn, and grows with distance once the ship has left Earth's sphere of influence.
- The solar system is compressed, KSP style: 1 AU is 1,500 Earth radii and the Sun has 17,700 Earth masses (the real figure is about 333,000). Planet sizes, masses and order are real.
- The Moon orbits at 15 Earth radii and has 0.247 Earth masses, both much closer and heavier than the real Moon. That makes Earth's pull on a lunar orbit strong: orbits up to about 2.5 Earth radii from the Moon's centre hold for dozens of laps without fuel, while one at 2.9 is pulled away within five.
- The predicted path is drawn in the frame of whichever body dominates each part of it, so a lunar orbit looks like a circle around the Moon and the path jumps where it crosses into another body's sphere of influence.
- Gravity, simulation rate, Moon mass and the prediction horizon can be changed in the settings.

## Development

```
npm install
npm run dev
npm test
npm run build
```

`npm run dev` starts the Vite dev server. `npm test` runs the Node test runner over `tests/`. `npm run build` writes the site to `dist/`.

The code is in `src/`. `maneuver.js` has the physics, `launch.js` and `launchdata.js` the ascent and per-rocket stage data, `autopilot.js` the autopilot, `solar.js` the solar system constants, `trajectory.js` the path prediction, `burnzones.js` and `burnassist.js` the burn windows and the burn progress bar, `ui.js` the HUD and `main.js` the rendering and game loop. `.trail/learnings/` records why some of the less obvious decisions were made.

## Deployment

`.github/workflows/pages.yml` built and deployed the site to GitHub Pages on every push to `main`. It ran `npm ci`, the tests and the build, then published `dist/`. The Vite `base` is `./`, so the build works from a repository subpath. Archiving the repository stopped new deployments; the published site is the last one that ran.
