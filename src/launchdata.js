// Launch-vehicle staging data (real figures, masses in tonnes, thrust in kN).
// Pure data: safe to import in node tests (no three.js).
//
// stages are listed in burn order. `part` is the 3D part that burns/separates.
// `parallelWithNext` stages burn together with the stage that follows them
// (SLS boosters + core). The final 'spacecraft' entry is the upper stage that
// finishes the ascent and circularises.
// `dvScale` multiplies exhaust velocity so every rocket can reach any target
// orbit radius (1.1-6) in the game's compressed-scale world.
// `ascentShip` is the share of the upper stage's burn that the ascent uses (pacing only).
// `maxQ` throttles to 70% between 8 and 15 km altitude.

export const LAUNCH = {
  saturn5: {
    payloadT: 45,                       // CSM + LM
    dvScale: 1.55,
    maxQ: true,
    stages: [
      { part: 'stage1', name: 'S-IC', thrustKN: 34000, isp: 285, dryT: 140, propT: 2150 },
      { part: 'stage2', name: 'S-II', thrustKN: 5100, isp: 421, dryT: 40, propT: 440 },
      { part: 'spacecraft', name: 'S-IVB', thrustKN: 1000, isp: 421, dryT: 13.5, propT: 106.5 },
    ],
  },
  sls: {
    payloadT: 27,                       // Orion
    dvScale: 1.7,
    maxQ: true,
    stages: [
      { part: 'stage1', name: 'SRB x2', thrustKN: 29400, isp: 269, dryT: 180, propT: 1280, parallelWithNext: true },
      { part: 'stage2', name: 'Core', thrustKN: 9100, isp: 452, dryT: 85, propT: 1005 },
      { part: 'spacecraft', name: 'ICPS', thrustKN: 110, isp: 462, dryT: 3.5, propT: 28.5 },
    ],
  },
  starship: {
    payloadT: 150,
    dvScale: 1.8,
    ascentShip: 0.85,
    maxQ: true,
    stages: [
      { part: 'stage1', name: 'Super Heavy', thrustKN: 74000, isp: 330, dryT: 270, propT: 3330 },
      { part: 'spacecraft', name: 'Ship', thrustKN: 12000, isp: 365, dryT: 120, propT: 1180 },
    ],
  },
  custom: {
    payloadT: 20,                       // generic two-stage, liftoff TWR ~1.4
    dvScale: 1.6,
    ascentShip: 0.85,
    maxQ: false,
    stages: [
      { part: 'stage1', name: 'Stage 1', thrustKN: 14700, isp: 300, dryT: 50, propT: 750 },
      { part: 'spacecraft', name: 'Stage 2', thrustKN: 1800, isp: 400, dryT: 20, propT: 230 },
    ],
  },
};
