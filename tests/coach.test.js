import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTip, stepsDone, createCoach } from '../src/coach.js';

const base = { mode: 'flight', phase: 'pad', ecc: 1, inZone: null, target: 'mars', dominant: 'earth', burning: false, apActive: false, crashed: false };

test('landing tells to launch', () => {
    assert.equal(nextTip({ ...base, mode: 'landing' }).id, 'pick');
});
test('pad -> launch step', () => {
    assert.equal(nextTip({ ...base, mode: 'launching' }).id, 'launch');
});
test('ascent -> reach orbit', () => {
    assert.equal(nextTip({ ...base, phase: 'ascent' }).id, 'orbit');
});
test('orbit eccentric -> circularize, band changes pointer', () => {
    const s = { ...base, phase: 'orbit', ecc: 0.3 };
    assert.equal(nextTip(s).id, 'circularize');
    assert.equal(nextTip(s).pointer, '#warp-burn-btn');
    const z = nextTip({ ...s, inZone: { grade: 'GOOD' } });
    assert.equal(z.pointer, '#prograde');
    assert.match(z.text, /green band/);
});
test('circular -> choose target, then transfer', () => {
    const s = { ...base, phase: 'orbit', ecc: 0.01 };
    assert.equal(nextTip(s).id, 'target');
    const t = nextTip({ ...s, targetChosen: true });
    assert.equal(t.id, 'transfer');
    assert.match(t.text, /Mars/);
});
test('leaving earth SOI -> capture, then final, then done', () => {
    const s = { ...base, phase: 'orbit', ecc: 0.9, dominant: 'sun' };
    assert.equal(nextTip(s).id, 'capture');
    const c = { ...s, dominant: 'mars', ecc: 0.7 };
    assert.equal(nextTip(c).id, 'final');
    const done = nextTip({ ...c, ecc: 0.05 });
    assert.equal(done.done, true);
});
test('steps are monotonic', () => {
    const d = stepsDone({ ...base, phase: 'orbit', ecc: 0.01, targetChosen: true });
    assert.deepEqual(d, [true, true, true, true, false, false, false]);
});
test('crash tip wins', () => {
    assert.equal(nextTip({ ...base, crashed: true }).id, 'crashed');
});
test('createCoach works without DOM', () => {
    const c = createCoach();
    assert.equal(c.update({ ...base, phase: 'ascent' }).id, 'orbit');
    c.pointAt({ x: 1, y: 2 }); c.hide(); c.show(); c.reset(); c.dispose();
});
