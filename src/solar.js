// Compressed inner solar system (KSP-style): real planet order, relative sizes
// and masses, but distances shrunk ~16x and the Sun lightened so a year lasts
// ~2,700 time units (about 25 game days) and a Mars transfer ~1,900 units.
//
// Units are the simulation's: 1 length = Earth radius, G = params.G, Earth mass
// = 1. Planets ride circular, coplanar, clockwise (same sense as the Moon and a
// post-launch orbit) Kepler orbits around the Sun, so their state is an exact
// function of time. The physics frame stays centred on Earth (see maneuver.js):
// the Sun and planets are placed relative to Earth's fixed position.
//
// Solar time = SOLAR_EPOCH + sim.time. sim.time restarts each flight, so every
// flight starts with the planets in the same place.

export const AU = 1500;                 // Earth radii per astronomical unit
export const SUN_MASS = 17700;          // Earth masses (real: 333,000)
export const SUN_RADIUS = 109;          // real ratio to Earth

/**
 * Planets, Earth included for its heliocentric orbit.
 * a: semi-major axis (AU), m: mass (Earth = 1), radius (Earth = 1),
 * phase0: heliocentric angle (rad) at solar time 0, color: map/orbit tint.
 */
export const PLANETS = {
    mercury: { name: 'mercury', label: 'MERCURY', a: 0.387, m: 0.0553, radius: 0.383, phase0: 2.1, color: 0xb7a99a },
    venus: { name: 'venus', label: 'VENUS', a: 0.723, m: 0.815, radius: 0.949, phase0: 4.0, color: 0xe8c68a },
    earth: { name: 'earth', label: 'EARTH', a: 1.0, m: 1, radius: 1, phase0: 0.0, color: 0x39d0ff },
    mars: { name: 'mars', label: 'MARS', a: 1.524, m: 0.107, radius: 0.532, phase0: 1.2, color: 0xd9663a },
};

/** Bodies a craft can travel to besides Earth and the Moon. */
export const DESTINATIONS = ['mercury', 'venus', 'mars'];

/** Solar time offset at the start of every flight. */
export const SOLAR_EPOCH = 0;

/** Heliocentric angular rate (rad / time unit, negative = clockwise). */
export function meanMotion(name, G) {
    const p = PLANETS[name];
    const a = p.a * AU;
    return -Math.sqrt((G * (SUN_MASS + p.m)) / (a * a * a));
}

/** Orbital period (time units). */
export function period(name, G) {
    return (2 * Math.PI) / Math.abs(meanMotion(name, G));
}

/** Heliocentric angle of a planet at solar time t. */
export function helioAngle(name, t, G) {
    return PLANETS[name].phase0 + meanMotion(name, G) * t;
}

/** Heliocentric position and velocity of planet `name` at solar time t. */
export function helioState(name, t, G, out = { x: 0, y: 0, vx: 0, vy: 0 }) {
    const a = PLANETS[name].a * AU;
    const n = meanMotion(name, G);
    const th = helioAngle(name, t, G);
    const c = Math.cos(th), s = Math.sin(th);
    out.x = a * c; out.y = a * s;
    out.vx = -a * n * s; out.vy = a * n * c;
    return out;
}

/** Laplace sphere-of-influence radius around the Sun (Earth's is ~30). */
export function planetSOI(name) {
    const p = PLANETS[name];
    return p.a * AU * (p.m / SUN_MASS) ** 0.4;
}

/**
 * Hohmann transfer from Earth to `target`: transfer time, the angle the target
 * must lead Earth by (in the clockwise direction of motion) at departure, and
 * the heliocentric speed change at departure (negative for inner planets:
 * leave Earth's SOI moving retrograde to Earth's orbit).
 */
export function hohmann(target, G) {
    const mu = G * SUN_MASS;
    const r1 = PLANETS.earth.a * AU, r2 = PLANETS[target].a * AU;
    const at = (r1 + r2) / 2;
    const tTransfer = Math.PI * Math.sqrt((at * at * at) / mu);
    const nT = Math.abs(meanMotion(target, G));
    const phase = Math.PI - nT * tTransfer;
    const vPeri = Math.sqrt(mu * (2 / r1 - 1 / at));
    const vInf = vPeri - Math.sqrt(mu / r1);
    return { tTransfer, phase, vInf };
}
