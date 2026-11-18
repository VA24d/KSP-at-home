import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { orbitalElements } from '../src/orbit.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

// Build state at periapsis for an ellipse with given rp, ra, mu (counter-clockwise).
function ellipseAtPe(rp, ra, mu) {
  const a = (rp + ra) / 2;
  const vp = Math.sqrt(mu * (2 / rp - 1 / a));
  return [rp, 0, 0, vp];
}

describe('orbitalElements', () => {
  test('9a. circular orbit: e~0, period 2pi sqrt(r^3/mu), rp=ra=r', () => {
    for (const [r, mu] of [[2, 1], [1.2, 0.247], [7, 4]]) {
      const el = orbitalElements(r, 0, 0, -Math.sqrt(mu / r), mu);
      assert.ok(el.e < 1e-9, `e ${el.e}`);
      close(el.period, 2 * Math.PI * Math.sqrt(r ** 3 / mu), 1e-9, 'period');
      close(el.rp, r, 1e-9, 'rp'); close(el.ra, r, 1e-9, 'ra');
      assert.ok(el.bound);
      assert.ok(el.h < 0, 'clockwise => h<0');
    }
  });

  test('9b. ellipse rp=2, ra=6 recovered, from periapsis and from arbitrary point', () => {
    const mu = 1;
    const [x, y, vx, vy] = ellipseAtPe(2, 6, mu);
    let el = orbitalElements(x, y, vx, vy, mu);
    close(el.rp, 2, 1e-9, 'rp'); close(el.ra, 6, 1e-9, 'ra');
    close(el.e, 0.5, 1e-9, 'e'); close(el.a, 4, 1e-9, 'a');
    close(el.period, 2 * Math.PI * Math.sqrt(64), 1e-9, 'period');
    assert.ok(el.timeToPe < 1e-6 || Math.abs(el.timeToPe - el.period) < 1e-6, `timeToPe at Pe ${el.timeToPe}`);
    // rotate by 1.0 rad and move along orbit: propagate analytically via eccentric anomaly E=1
    const a = 4, e = 0.5, E = 1;
    const px = a * (Math.cos(E) - e), py = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const n = Math.sqrt(mu / a ** 3);
    const rr = a * (1 - e * Math.cos(E));
    const pvx = -a * a * n * Math.sin(E) / rr, pvy = a * a * n * Math.sqrt(1 - e * e) * Math.cos(E) / rr;
    el = orbitalElements(px, py, pvx, pvy, mu);
    close(el.rp, 2, 1e-9, 'rp'); close(el.ra, 6, 1e-9, 'ra'); close(el.e, 0.5, 1e-9, 'e');
    // Kepler: M = E - e sinE ; timeToPe = (2pi - M)/n, timeToAp = (pi - M)/n (mod period)
    const M = E - e * Math.sin(E);
    close(el.timeToPe, (2 * Math.PI - M) / n, 1e-9, 'timeToPe');
    close(el.timeToAp, (Math.PI - M) / n, 1e-9, 'timeToAp');
  });

  test('9c. time-to-Pe / time-to-Ap sanity on an ellipse (sum relationships)', () => {
    const mu = 1, a = 4, e = 0.5, n = Math.sqrt(mu / a ** 3), T = 2 * Math.PI / n;
    for (const E of [0.3, 1.0, 2.0, Math.PI - 0.2, Math.PI + 0.4, 4.5, 6.0]) {
      const rr = a * (1 - e * Math.cos(E));
      const px = a * (Math.cos(E) - e), py = a * Math.sqrt(1 - e * e) * Math.sin(E);
      const pvx = -a * a * n * Math.sin(E) / rr, pvy = a * a * n * Math.sqrt(1 - e * e) * Math.cos(E) / rr;
      const el = orbitalElements(px, py, pvx, pvy, mu);
      assert.ok(el.timeToPe >= 0 && el.timeToPe <= T + 1e-9, `timeToPe ${el.timeToPe}`);
      assert.ok(el.timeToAp >= 0 && el.timeToAp <= T + 1e-9, `timeToAp ${el.timeToAp}`);
      // Pe and Ap are half a period apart: difference is T/2 modulo T
      const d = ((el.timeToAp - el.timeToPe) % T + T) % T;
      assert.ok(Math.abs(d - T / 2) < 1e-6, `E=${E}: Ap-Pe ${d} vs T/2 ${T / 2}`);
      // radial velocity sign: moving outward (E in (0,pi)) means Ap comes before Pe
      if (el.vr > 1e-9) assert.ok(el.timeToAp < el.timeToPe, `E=${E} outbound`);
      if (el.vr < -1e-9) assert.ok(el.timeToPe < el.timeToAp, `E=${E} inbound`);
    }
  });

  test('9d. hyperbola: ra = Infinity, bound = false, e > 1, period Infinity', () => {
    const mu = 1, r = 3, vEsc = Math.sqrt(2 * mu / r);
    const el = orbitalElements(r, 0, 0.2, -vEsc * 1.3, mu);
    assert.equal(el.bound, false);
    assert.equal(el.ra, Infinity);
    assert.equal(el.period, Infinity);
    assert.ok(el.e > 1);
    assert.ok(el.energy > 0);
    assert.ok(el.rp < r);
  });

  test('9e. exactly escape velocity is unbound; inbound hyperbola has finite timeToPe', () => {
    const el = orbitalElements(3, 0, -0.5, -0.9, 1);
    assert.equal(el.bound, false);
    assert.ok(Number.isFinite(el.timeToPe) && el.timeToPe > 0, `timeToPe ${el.timeToPe}`);
    assert.equal(el.timeToAp, Infinity);
  });

  test('9f. energy and angular momentum invariants', () => {
    const el = orbitalElements(2, 1, -0.3, 0.5, 1);
    close(el.energy, (0.09 + 0.25) / 2 - 1 / Math.hypot(2, 1), 1e-12, 'energy');
    close(el.h, 2 * 0.5 - 1 * -0.3, 1e-12, 'h');
  });
});
