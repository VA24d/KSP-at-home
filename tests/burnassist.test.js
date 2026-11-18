import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { EARTH_MOON_R } from '../src/maneuver.js';
import { PLANETS, helioState, hohmann, meanMotion } from '../src/solar.js';
import { gradeOf, ejectionAngle, analyze, planetWait, DIFFICULTY } from '../src/burnzones.js';
import { createAssistCore, neededDv, applyBurn, conicPoints } from '../src/burnassist.js';
import { orbitalElements } from '../src/orbit.js';

const TAU = Math.PI * 2;
const wrap = (a) => ((a % TAU) + TAU) % TAU;
const wrapPi = (a) => wrap(a + Math.PI) - Math.PI;
const MU = 1, G = 1;

// Clockwise circular orbit of radius r at angle `ang`.
function circ(r, ang, mu = MU) {
    const vc = Math.sqrt(mu / r);
    return { rx: r * Math.cos(ang), ry: r * Math.sin(ang), vx: vc * Math.sin(ang), vy: -vc * Math.cos(ang) };
}
const dom = { name: 'earth', mu: MU, radius: 1, pos: { x: 0, y: 0 } };

describe('grading', () => {
    test('thresholds on the half-width', () => {
        const h = 0.5;
        assert.equal(gradeOf(0, h), 'PERFECT');
        assert.equal(gradeOf(0.25 * h, h), 'PERFECT');
        assert.equal(gradeOf(-0.26 * h, h), 'GOOD');
        assert.equal(gradeOf(0.6 * h, h), 'GOOD');
        assert.equal(gradeOf(0.61 * h, h), 'OK');
        assert.equal(gradeOf(h, h), 'OK');
        assert.equal(gradeOf(1.01 * h, h), null);
    });
    test('difficulty widths', () => {
        assert.deepEqual(DIFFICULTY.easy, { circ: 30, tli: 25, planet: 25 });
        assert.deepEqual(DIFFICULTY.real, { circ: 16, tli: 9, planet: 9 });
    });
});

describe('ejection geometry', () => {
    test('outer and inner planets eject on opposite sides of the parking orbit', () => {
        const u = 0.7, vinf = 0.3;
        const out = ejectionAngle(u, 2, vinf, MU, true);
        const inn = ejectionAngle(u + Math.PI, 2, vinf, MU, true);
        assert.ok(Math.abs(Math.abs(wrapPi(out - inn)) - Math.PI) < 1e-9);
        // clockwise: burn point sits ahead (larger angle) of the asymptote direction
        assert.ok(wrapPi(out - u) > 0 && wrapPi(out - u) < Math.PI);
    });
});

describe('moon transfer assist', () => {
    const zone = { kind: 'tli', grade: 'GOOD', target: 'moon' };
    test('progress is monotonic during a prograde burn from r=2 and ends at cutoff', () => {
        const core = createAssistCore();
        let rel = circ(2, 0.3);
        const speed0 = Math.hypot(rel.vx, rel.vy);
        let prev = -1, res;
        for (let i = 0; i < 400; i++) {
            const sp = Math.hypot(rel.vx, rel.vy);
            const k = (sp + 0.002) / sp;                     // tangential burn, position fixed
            rel = { ...rel, vx: rel.vx * k, vy: rel.vy * k };
            res = core.step({ rel, mu: MU, zone: i < 3 ? zone : { kind: null }, burning: true });
            assert.ok(res.progress >= prev - 1e-12, `non-monotonic at ${i}`);
            prev = res.progress;
            if (res.cutoff) break;
        }
        assert.ok(res.cutoff && res.progress === 1 && res.label === 'MOON TRANSFER');
        assert.ok(Math.hypot(rel.vx, rel.vy) > speed0);
    });
    test('preview apoapsis ~ EARTH_MOON_R after the suggested dv', () => {
        const rel = circ(2, 1.0);
        const dv = neededDv(zone, rel, MU);
        const el = applyBurn(rel, MU, dv);
        assert.ok(Math.abs(el.ra - EARTH_MOON_R) / EARTH_MOON_R < 1e-4, `ra ${el.ra}`);
        const analytic = Math.sqrt(MU * (2 / 2 - 2 / (2 + EARTH_MOON_R))) - Math.sqrt(MU / 2);
        assert.ok(Math.abs(dv - analytic) < 1e-6);
        const pts = conicPoints(el, MU, 100);
        const rs = []; for (let i = 0; i < pts.length; i += 2) rs.push(Math.hypot(pts[i], pts[i + 1]));
        assert.ok(Math.abs(Math.max(...rs) - EARTH_MOON_R) < 0.05);
    });
});

describe('circularize assist', () => {
    test('progress rises as the apoapsis burn rounds the orbit', () => {
        const core = createAssistCore();
        const ra = 4, rp = 2, a = 3;
        const vap = Math.sqrt(MU * (2 / ra - 1 / a));
        let rel = { rx: ra, ry: 0, vx: 0, vy: -vap };
        const zone = { kind: 'ap', grade: 'PERFECT' };
        let prev = -1, res;
        for (let i = 0; i < 300; i++) {
            rel.vy -= 0.002;
            res = core.step({ rel, mu: MU, zone, burning: true });
            assert.ok(res.progress >= prev - 1e-12);
            prev = res.progress;
            if (res.cutoff) break;
        }
        assert.ok(res.done && rp < ra);
    });
});

describe('nextWindow timing', () => {
    test('TLI wait within 2% of a brute-force scan on a circular orbit', () => {
        const here = 0.4, thM0 = 2.0, w = -0.02;
        const rel = circ(2, here);
        const ctx = { rel, dom, moon: { pos: { x: 15 * Math.cos(thM0), y: 15 * Math.sin(thM0) }, rate: w, present: true },
            time: 0, G, target: 'moon', difficulty: 'real' };
        const res = analyze(ctx);
        const tli = res.zones.find((z) => z.kind === 'tli');
        const n = -Math.sqrt(MU / 8);
        const aT = (2 + EARTH_MOON_R) / 2;
        const tT = Math.PI * Math.sqrt(aT ** 3 / MU);
        let truth = null;
        for (let t = 0; t < 400; t += 0.001) {
            const craft = here + n * t;
            const dep = thM0 + w * t + w * tT + Math.PI;
            if (Math.abs(wrapPi(craft - dep)) < 1e-3 && t > 0) { truth = t; break; }
        }
        // tli.timeTo is 0 inside the zone; use the marker wait via next window when outside
        const wait = tli.inside ? 0 : tli.timeTo;
        assert.ok(truth !== null);
        assert.ok(Math.abs(wait - truth) / truth < 0.02, `wait ${wait} vs ${truth}`);
        assert.equal(res.next.kind === 'tli' || res.next.kind === undefined, true);
    });
    test('planet alignment wait matches the synodic analytic value', () => {
        const t0 = 5;
        const { wait, hoh } = planetWait('mars', t0, G);
        const rate = meanMotion('mars', G) - meanMotion('earth', G);
        const d = (t) => wrap(PLANETS.mars.phase0 + meanMotion('mars', G) * t - meanMotion('earth', G) * t + hoh.phase);
        const e = Math.min(d(t0 + wait), TAU - d(t0 + wait));
        assert.ok(e < 1e-6 && rate > 0, `residual ${e}`);
    });
    test('planet window reports far alignment and a reachable point otherwise', () => {
        const res = analyze({ rel: circ(2, 0), dom, moon: { present: false }, time: 0, G, target: 'mars', difficulty: 'easy' });
        const z = res.zones.find((q) => q.kind === 'planet');
        assert.ok(z && /MARS (ALIGNMENT|WINDOW)/.test(z.markerLabel));
        assert.ok(res.next && res.next.timeTo >= 0);
    });
});
