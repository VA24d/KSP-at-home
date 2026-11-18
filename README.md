# KSP@ASTRO

KSP@ASTRO is a 2D orbital mechanics sandbox built by the Astronautics Club, IIIT Hyderabad. It runs in the browser.

You pick a Saturn V, SLS or Starship preset, or build a custom rocket, and launch it from a pad on Earth. The rocket flies a gravity-turn ascent and drops its stages on the way up. Once in orbit you fly by hand or hand control to the autopilot, go to the Moon, and come back.

## Controls

| Key | Action |
| --- | --- |
| W / S | Thrust prograde / retrograde |
| A / D | Thrust radial in / out |
| Shift / Ctrl | Raise / lower throttle |
| Z / X | Full throttle / cut throttle |
| Space | Pause |
| , / . | Slow down / speed up time warp |
| 1 / 2 / 3 | Switch camera focus |
| C | Circularize |
| T | Altitude hold |
| P | Toggle trajectory prediction |
| H | Hohmann transfer |
| Esc | Cancel the autopilot |
| Ctrl+Z | Undo |
| R | Restart after a crash |

On phones the same actions are on-screen touch buttons.

In orbit the map marks the best places to burn: a green band at apoapsis (burn prograde to circularize), an orange band at periapsis (burn retrograde), and a purple band where a transfer burn to the Moon should start, each with a countdown.

## Physics notes

- Units: 1 length unit is one Earth radius (6371 km) and 1 time unit is 806 s. With this choice velocities come out in real m/s.
- Integration: a fixed-step leapfrog integrator.
- The Moon moves on a circular orbit. The simulation switches between Earth and Moon as the dominant body at the sphere-of-influence boundary.
- Four multipliers can be changed: gravity, simulation rate, Moon mass and prediction horizon.

## Development

```
npm install
npm run dev
npm test
npm run build
```

`npm run dev` starts the Vite dev server. `npm test` runs the Node test runner. `npm run build` writes the site to `dist/`.

## Deployment

`.github/workflows/pages.yml` deploys to GitHub Pages on every push to `main`, and it can also be started by hand from the Actions tab. It installs dependencies with `npm ci`, runs the tests, builds, and publishes `dist/`. The Vite `base` is `./`, so the site works from a repository subpath.
