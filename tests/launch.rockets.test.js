import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/maneuver.js';
import * as L from '../src/launch.js';
import { LAUNCH } from '../src/launchdata.js';
import { reset, earthElements } from './helpers.js';

const IDS = ['saturn5', 'sls', 'starship', 'custom'];

/** Fly a full ascent, recording events and the accelG trace. */
function fly(id, target, G = 1) {
  reset({ G });
  M.setOnPad();
  L.startAscent(target, id);
  const events = [], trace = [];
  let steps = 0, crashed = false, realS = 0;
  while (L.isFlying() && steps < 3e6) {
    const ev = L.updateAscent(M.params.dt);
    if (ev) events.push({ ev, step: steps, g: L.ascent.accelG });
    if (L.ascent.phase === L.PHASE.ASCENT) {
      trace.push({ g: L.ascent.accelG, stage: L.ascent.stage });
      realS += M.params.dt / L.timeRate();
    }
    if (M.step()) { crashed = true; break; }
    steps++;
  }
  return { events, trace, crashed, realS, steps };
}

for (const id of IDS) {
  for (const G of [1, 2]) {
    for (const target of [1.5, 2, 4, 6]) {
      test(`${id} G=${G} target=${target}: circular orbit, tanks full`, () => {
        const fuel = M.rocketParams.fuelMass;
        const out = fly(id, target, G);
        assert.ok(!out.crashed, M.crashState.message);
        assert.equal(L.ascent.phase, L.PHASE.DONE);
        const el = earthElements();
        assert.ok(el.e < 0.01, `e=${el.e}`);
        assert.ok(Math.abs(el.r - target) / target < 0.1, `r=${el.r}`);
        assert.equal(M.rocketParams.fuelMass, fuel);
      });
    }
  }
}

test('liftoff acceleration: Saturn V lowest, all real-ish', () => {
  const g0 = {};
  for (const id of IDS) {
    reset({});
    M.setOnPad();
    L.startAscent(3, id);
    L.updateAscent(M.params.dt);
    g0[id] = L.ascent.accelG;
  }
  assert.ok(g0.saturn5 > 1.05 && g0.saturn5 < 1.3, JSON.stringify(g0));
  for (const id of ['sls', 'starship', 'custom']) assert.ok(g0[id] > g0.saturn5, `${id} ${g0[id]}`);
  assert.ok(g0.sls > 1.4 && g0.sls < 1.6 && g0.starship > 1.4 && g0.starship < 1.6, JSON.stringify(g0));
});

test('Saturn V: g rises during S-IC burn, drops at staging, events in order', () => {
  const { events, trace } = fly('saturn5', 6);
  const names = events.map(e => e.ev);
  assert.deepEqual(names, ['stage:stage1', 'stage:stage2', 'meco', 'circ', 'orbit'].filter(n => names.includes(n)));
  assert.equal(names[0], 'stage:stage1');
  assert.equal(names[1], 'stage:stage2');
  const s1 = trace.filter(t => t.stage === 'stage1').map(t => t.g);
  const s2 = trace.filter(t => t.stage === 'stage2').map(t => t.g);
  assert.ok(s1.length && s2.length);
  const maxS1 = Math.max(...s1);
  assert.ok(maxS1 > 3.2, `S-IC peak ${maxS1}`);
  assert.ok(maxS1 > 3 * s1[0]);
  assert.ok(s2[0] < 1, `S-II start ${s2[0]}`);
  assert.ok(s2[0] < 0.4 * maxS1);
  assert.ok(Math.max(...s2) > s2[0] * 1.5, 'S-II accel rises too');
});

test('SLS: boosters then core; Starship: booster then ship', () => {
  let r = fly('sls', 6);
  assert.deepEqual(r.events.filter(e => e.ev.startsWith('stage:')).map(e => e.ev).slice(0, 1), ['stage:stage1']);
  r = fly('starship', 6);
  assert.equal(r.events[0].ev, 'stage:stage1');
});

test('stage data sane and real-time ascent 4-8 s for every rocket', () => {
  for (const id of IDS) {
    const d = LAUNCH[id];
    assert.equal(d.stages[d.stages.length - 1].part, 'spacecraft');
    const r = fly(id, 6);
    assert.ok(r.realS > 4 && r.realS < 8.5, `${id} ${r.realS.toFixed(1)}s`);
  }
});
