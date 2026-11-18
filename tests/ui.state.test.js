import test from 'node:test';
import assert from 'node:assert/strict';
import { HUD_STATES, hudLayout, hudVisibility, computeSafeRect, clampToRect } from '../src/ui.js';

test('layout buckets', () => {
    assert.equal(hudLayout(390, 844), 'phone');
    assert.equal(hudLayout(844, 390), 'rail');
    assert.equal(hudLayout(667, 375), 'rail');
    assert.equal(hudLayout(820, 1180), 'medium');
    assert.equal(hudLayout(1440, 900), 'desktop');
});

test('every state resolves at every width', () => {
    for (const s of HUD_STATES) for (const [w, h] of [[390, 844], [844, 390], [820, 1180], [1440, 900]]) {
        const v = hudVisibility(s, w, h);
        assert.equal(v.state, s);
        assert.ok(['min', 'compact', 'full'].includes(v.readouts));
    }
});

test('ascent: telemetry and minimal readouts, no burn deck', () => {
    const v = hudVisibility('ascent', 1440, 900);
    assert.ok(v.telemetry && v.orbit && v.assist);
    assert.equal(v.burnButtons, false);
    assert.equal(v.navball, false);
    assert.equal(v.systems, false);
    assert.equal(v.readouts, 'min');
});

test('orbit: deck and navball, autopilot panel as a chip', () => {
    const v = hudVisibility('orbit', 1440, 900);
    assert.ok(v.burnButtons && v.navball && v.chips);
    assert.equal(v.systemsMode, 'chip');
    assert.equal(v.collapsed['panel-systems'], true);
    assert.equal(v.collapsed['panel-orbit'], false);
});

test('zone and burning emphasise assist and dim panels', () => {
    for (const s of ['zone', 'burning']) {
        const v = hudVisibility(s, 1440, 900);
        assert.ok(v.emphasize.includes('assist'));
        assert.ok(v.dim.includes('systems') && v.dim.includes('orbit'));
    }
});

test('autopilot: panel open, cancel emphasised, burn buttons dimmed', () => {
    const v = hudVisibility('autopilot', 1440, 900);
    assert.equal(v.systemsMode, 'full');
    assert.equal(v.collapsed['panel-systems'], false);
    assert.ok(v.autopilot && v.emphasize.includes('autopilot') && v.dim.includes('burn'));
});

test('transfer: warp and target prominent, full readouts on big screens', () => {
    const d = hudVisibility('transfer', 1440, 900);
    assert.ok(d.targetInfo && d.emphasize.includes('warp'));
    assert.equal(d.readouts, 'full');
    assert.equal(hudVisibility('transfer', 390, 844).readouts, 'compact');
});

test('crashed and landing hide everything', () => {
    for (const s of ['crashed', 'landing']) {
        const v = hudVisibility(s, 1440, 900);
        assert.ok(!v.orbit && !v.systems && !v.deck && !v.chips);
    }
});

test('phone: sheet keeps panels open, top bar is minimal; medium collapses to chips', () => {
    const p = hudVisibility('orbit', 390, 844);
    assert.equal(p.topBar, 'min');
    assert.deepEqual(p.collapsed, { 'panel-orbit': false, 'panel-systems': false });
    assert.equal(hudVisibility('orbit', 820, 1180).collapsed['panel-orbit'], true);
});

test('safe rect: desktop columns and bottom-centre deck', () => {
    const r = computeSafeRect(1440, 900, [
        { left: 0, top: 0, right: 1440, bottom: 64 },      // top bar
        { left: 16, top: 80, right: 316, bottom: 500 },    // orbit panel
        { left: 1094, top: 80, right: 1424, bottom: 600 }, // systems panel
        { left: 520, top: 700, right: 920, bottom: 890 },  // deck
        null,
    ]);
    assert.deepEqual(r, { top: 64, bottom: 700, left: 316, right: 1094 });
});

test('safe rect: phone sheet and right-aligned thumb cluster', () => {
    const r = computeSafeRect(390, 844, [
        { left: 0, top: 0, right: 390, bottom: 52 },
        { left: 0, top: 768, right: 390, bottom: 844 },
        { left: 182, top: 560, right: 382, bottom: 760 },
    ]);
    assert.equal(r.top, 52);
    assert.equal(r.bottom, 560);
    assert.equal(r.left, 0);
    assert.equal(r.right, 390);
});

test('safe rect: landscape rails and degenerate fallback', () => {
    const r = computeSafeRect(844, 390, [
        { left: 0, top: 0, right: 844, bottom: 44 },
        { left: 0, top: 50, right: 250, bottom: 380 },
        { left: 600, top: 200, right: 844, bottom: 380 },
    ]);
    assert.equal(r.left, 250);
    assert.equal(r.right, 600);
    const full = computeSafeRect(400, 800, [{ left: 0, top: 0, right: 400, bottom: 700 }]);
    assert.deepEqual(full, { top: 0, bottom: 800, left: 0, right: 400 });
});

test('clampToRect keeps on-screen points and clamps far ones along the ray', () => {
    const rect = { top: 0, bottom: 800, left: 0, right: 1000 };
    const inside = clampToRect(500, 300, rect, 24);
    assert.equal(inside.clamped, false);
    const far = clampToRect(5000, 400, rect, 24);
    assert.equal(far.clamped, true);
    assert.equal(far.x, 976);
    assert.equal(far.y, 400);
    assert.ok(Math.abs(far.angle) < 1e-9);
    const diag = clampToRect(-3000, -3000, rect, 24);
    assert.ok(diag.x >= 24 - 1e-6 && diag.y >= 24 - 1e-6);
});
