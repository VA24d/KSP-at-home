// HUD, landing screen and input wiring. Pure DOM: no Three.js and no physics
// state is written here. main.js passes handlers in and telemetry out.
import { ROCKETS } from './rockets.js';
import { createGallery } from './gallery.js';
import { MPS_PER_UNIT, TIME_UNIT_S } from './maneuver.js';
import { fmtDistance, fmtSpeed, fmtDuration } from './orbit.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Settings (persisted per viewer; storage may be unavailable)

const SETTINGS_KEY = 'ksp-astro-settings-v1';
export const settings = {
    easy: true,
    coach: true,
    rcsFx: true,
    predict: true,
    reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    hiQuality: !(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches),
};
try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
        for (const k of Object.keys(settings)) if (typeof saved[k] === 'boolean') settings[k] = saved[k];
    }
} catch { /* storage blocked: keep defaults */ }

function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Landing screen

const SLIDERS = {
    'mission-orbit-radius': (v) => `${fmtDistance(v - 1)} alt`,
    'mission-isp': (v) => `${v.toFixed(0)} s`,
    'mission-thrust': (v) => `${(v * 9.80665).toFixed(1)} kN`,
    'mission-dry-mass': (v) => `${v.toFixed(1)} t`,
    'mission-fuel-mass': (v) => `${v.toFixed(1)} t`,
    'mission-g': (v) => `×${v.toFixed(2)}`,
    'mission-rate': (v) => `×${v.toFixed(2)}`,
    'mission-moon-mass': (v) => `${v.toFixed(3)} M⊕`,
    'mission-lookahead': (v) => fmtDuration(v),
};
const PHYSICS_SLIDERS = {
    Isp: 'mission-isp', thrust: 'mission-thrust', dryMass: 'mission-dry-mass', fuelMass: 'mission-fuel-mass',
};

let selectedRocket = 'saturn5';   // which model to fly

function sliderValue(id) {
    const n = Number.parseFloat($(id).value);
    return Number.isFinite(n) ? n : Number.parseFloat($(id).defaultValue);
}

function refreshSlider(id) {
    const input = $(id);
    const out = input.closest('.slider-field')?.querySelector('output.slider-readout');
    if (out) out.textContent = SLIDERS[id](sliderValue(id));
    const min = Number(input.min), max = Number(input.max);
    input.style.setProperty('--fill', `${((sliderValue(id) - min) / (max - min)) * 100}%`);
}

function refreshDerived() {
    const Isp = sliderValue('mission-isp');
    const thrust = sliderValue('mission-thrust');
    const dry = sliderValue('mission-dry-mass');
    const fuel = sliderValue('mission-fuel-mass');
    const ve = Isp / TIME_UNIT_S;
    const dv = ve * Math.log((dry + fuel) / dry);
    const twr = thrust / (dry + fuel);
    const burn = fuel / (thrust / ve);
    $('derived-dv').textContent = fmtSpeed(dv);
    $('derived-twr').textContent = twr.toFixed(3);
    $('derived-burn').textContent = fmtDuration(burn);
    const status = $('landing-status');
    const lowDv = dv * MPS_PER_UNIT < 1500;
    status.textContent = lowDv ? 'LOW ΔV' : 'READY';
    status.classList.toggle('is-warn', lowDv);
}

let gallery = null;

function pressCard(id) {
    gallery?.select(id);
}

function customStats() {
    const Isp = sliderValue('mission-isp');
    const thrust = sliderValue('mission-thrust');
    const dry = sliderValue('mission-dry-mass');
    const fuel = sliderValue('mission-fuel-mass');
    const dv = (Isp / TIME_UNIT_S) * Math.log((dry + fuel) / dry);
    return { Isp, thrust, mass: dry + fuel, dv: fmtSpeed(dv) };
}

function applyPreset(id) {
    const p = ROCKETS[id].physics;
    for (const [k, sid] of Object.entries(PHYSICS_SLIDERS)) {
        $(sid).value = String(p[k]);
        refreshSlider(sid);
    }
    selectedRocket = id;
    pressCard(id);
    refreshDerived();
}

function buildPicker() {
    gallery?.dispose();
    gallery = createGallery($('rocket-picker'), {
        onSelect: (id) => {
            if (id === 'custom') {      // keep the current slider values
                selectedRocket = 'custom';
                gallery?.refreshCustom(customStats());
                return;
            }
            applyPreset(id);
        },
    });
    gallery.refreshCustom(customStats());
}

/** Mission configuration from the landing form. */
export function getMissionConfig() {
    return {
        rocket: selectedRocket,
        orbitRadius: sliderValue('mission-orbit-radius'),
        Isp: sliderValue('mission-isp'),
        thrust: sliderValue('mission-thrust'),
        dryMass: sliderValue('mission-dry-mass'),
        fuelMass: sliderValue('mission-fuel-mass'),
        G: sliderValue('mission-g'),
        simRate: sliderValue('mission-rate'),
        moonMass: sliderValue('mission-moon-mass'),
        lookahead: sliderValue('mission-lookahead'),
    };
}

// ---------------------------------------------------------------------------
// Mode, toasts, countdown, overlays

export function setMode(mode) {
    document.body.dataset.mode = mode;
    // Sensible default until main.js reports a finer state.
    if (mode === 'landing') setHudState('landing');
    else if (mode === 'launching') { if (hudState === 'landing' || hudState === 'crashed') setHudState('countdown'); }
    else if (hudState === 'landing' || hudState === 'countdown') setHudState('orbit');
}

let toastTimer = 0;
export function toast(msg, kind = 'info', ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.dataset.kind = kind;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-visible'), ms);
}

export function setCountdown(text, liftoff = false) {
    const c = $('launch-countdown');
    if (!text) { c.classList.remove('is-visible', 'is-liftoff'); c.textContent = ''; return; }
    if (c.textContent !== text) {
        c.textContent = text;
        c.classList.remove('is-visible');
        void c.offsetWidth;          // restart the pop animation for each new value
    }
    c.classList.add('is-visible');
    c.classList.toggle('is-liftoff', liftoff);
}

export function showCrash(message, detail) {
    $('crash-message').textContent = message || 'VEHICLE LOST';
    $('crash-target').textContent = detail || '';
    $('crash-overlay').hidden = false;
    $('restart-btn').focus({ preventScroll: true });
}

export function hideCrash() {
    $('crash-overlay').hidden = true;
}

export function crashVisible() {
    return !$('crash-overlay').hidden;
}

// ---------------------------------------------------------------------------
// Map labels (screen-space, positioned by main.js)

const labelPool = [];
/** labels: [{ sx, sy, text, kind }] in CSS pixels. */
export function renderMapLabels(labels) {
    const host = $('map-labels');
    while (labelPool.length < labels.length) {
        const d = document.createElement('div');
        d.className = 'map-label';
        host.append(d);
        labelPool.push({ el: d, text: '', kind: '' });
    }
    for (let i = 0; i < labelPool.length; i++) {
        const p = labelPool[i];
        const l = labels[i];
        if (!l) { if (p.el.style.display !== 'none') p.el.style.display = 'none'; continue; }
        if (p.el.style.display === 'none') p.el.style.display = '';
        if (p.text !== l.text) { p.el.textContent = l.text; p.text = l.text; }
        if (p.kind !== l.kind) { p.el.className = `map-label map-label--${l.kind}`; p.kind = l.kind; }
        p.el.style.transform = `translate(${Math.round(l.sx)}px, ${Math.round(l.sy)}px)`;
    }
}

// ---------------------------------------------------------------------------
// HUD

const textCache = new Map();
function setText(id, text) {
    if (textCache.get(id) === text) return;
    textCache.set(id, text);
    const el = $(id);
    if (el) el.textContent = text;
}
function setClass(el, cls, on) {
    if (el && el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

const LAMP = ['lamp--ok', 'lamp--warn', 'lamp--danger'];

/** Update all HUD readouts. Called ~10 times a second. */
export function updateHud(t) {
    setText('hud-met', t.met);
    const lamp = $('hud-status');
    setText('hud-status', t.status.text);
    for (const c of LAMP) setClass(lamp, c, c === `lamp--${t.status.level}`);
    setText('hud-soi', t.soi);

    setText('ro-alt', t.alt);
    setText('ro-vel', t.vel);
    setText('ro-ap', t.ap);
    setText('ro-pe', t.pe);
    setText('ro-tap', t.tap);
    setText('ro-tpe', t.tpe);
    setText('ro-ecc', t.ecc);
    setText('ro-period', t.period);
    setText('ro-moon-dist', t.moonDist);
    setText('ro-body', t.body);

    const apRow = $('autopilot-status-row');
    if (apRow.hidden === !!t.autopilot) apRow.hidden = !t.autopilot;
    if (t.autopilot) { setText('autopilot-phase', t.autopilot); setText('ap-chip-phase', t.autopilot); }

    const fill = $('fuel-bar-fill');
    const w = `${(t.fuelFrac * 100).toFixed(1)}%`;
    if (fill.style.width !== w) fill.style.width = w;
    setClass(fill, 'is-low', t.fuelFrac < 0.15);
    setText('ro-fuel', t.fuel);
    setText('ro-dv', t.dv);
    setText('ro-twr', t.twr);
}

/** Per-frame button state (cheap class toggles). */
export function updateButtons(s) {
    setClass($('prograde'), 'is-firing', s.firing.prograde);
    setClass($('retrograde'), 'is-firing', s.firing.retrograde);
    setClass($('normal-pos'), 'is-firing', s.firing.normalPos);
    setClass($('normal-neg'), 'is-firing', s.firing.normalNeg);
    setClass($('althold-btn'), 'is-active', s.holding);
    setClass($('circularize-btn'), 'is-active', s.circularizing);
    setClass($('predict'), 'is-active', s.predict);
    setClass($('hohmann-btn'), 'is-active', s.hohmann);
    const apBtn = $('autopilot-btn');
    setClass(apBtn, 'is-active', s.autopilot);
    const apLabel = s.autopilot ? 'AUTOPILOT ENGAGED' : 'ENGAGE AUTOPILOT';
    if (apBtn.textContent !== apLabel) apBtn.textContent = apLabel;
    const cancel = $('autopilot-cancel');
    if (cancel.hidden === s.autopilot) cancel.hidden = !s.autopilot;
    for (const b of document.querySelectorAll('.warp-btn')) {
        setClass(b, 'is-active', Number(b.dataset.warp) === s.warp);
    }
    for (const id of ['focus-earth', 'focus-moon', 'focus-sun', 'focus-ship']) {
        setClass($(id), 'is-active', id === `focus-${s.focus}`);
    }
    setClass($('focus-target'), 'is-active', s.focus === target);
    const ind = $('burn-indicator');
    if (ind) {
        setClass(ind, 'is-visible', !!s.burnText);
        if (s.burnText && ind.textContent !== s.burnText) ind.textContent = s.burnText;
    }
}

// ---------------------------------------------------------------------------
// Navball: ship heading up, prograde/retrograde markers and the local horizon.

let navCtx = null;
/** Angles are world angles (radians, atan2 convention). */
export function drawNavball(heading, prograde, radialOut, hasVel) {
    const cv = $('navball');
    if (!cv || cv.offsetParent === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = cv.clientWidth || 120;
    if (cv.width !== Math.round(size * dpr)) { cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr); }
    navCtx ||= cv.getContext('2d');
    const g = navCtx;
    const W = cv.width, R = W / 2 - 2 * dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.save();
    g.translate(W / 2, W / 2);
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.clip();

    // World angle a → unit vector on screen with the heading pointing up
    // (canvas y grows downward).
    const toScreen = (a) => {
        const rel = a - heading;
        return { x: -Math.sin(rel), y: -Math.cos(rel) };
    };
    const up = toScreen(radialOut);
    g.fillStyle = '#123a5c';
    g.fillRect(-R, -R, 2 * R, 2 * R);
    // Ground half: the side facing away from radial-out.
    const ang = Math.atan2(up.y, up.x);
    g.beginPath();
    g.arc(0, 0, R, ang + Math.PI / 2, ang + Math.PI * 1.5);
    g.closePath();
    g.fillStyle = '#5a3a1c';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.moveTo(-up.y * R, up.x * R);
    g.lineTo(up.y * R, -up.x * R);
    g.stroke();

    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 1 * dpr;
    for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        g.beginPath();
        g.moveTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86);
        g.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        g.stroke();
    }

    if (hasVel) {
        const p = toScreen(prograde);
        const pr = R * 0.62;
        g.strokeStyle = '#7dff9a';
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.arc(p.x * pr, p.y * pr, 7 * dpr, 0, Math.PI * 2);
        g.stroke();
        for (const a of [-Math.PI / 2, 0, Math.PI]) {
            g.beginPath();
            g.moveTo(p.x * pr + Math.cos(a) * 7 * dpr, p.y * pr + Math.sin(a) * 7 * dpr);
            g.lineTo(p.x * pr + Math.cos(a) * 12 * dpr, p.y * pr + Math.sin(a) * 12 * dpr);
            g.stroke();
        }
        g.strokeStyle = '#ffb347';
        const qx = -p.x * pr, qy = -p.y * pr;
        g.beginPath();
        g.arc(qx, qy, 7 * dpr, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.moveTo(qx - 5 * dpr, qy - 5 * dpr); g.lineTo(qx + 5 * dpr, qy + 5 * dpr);
        g.moveTo(qx + 5 * dpr, qy - 5 * dpr); g.lineTo(qx - 5 * dpr, qy + 5 * dpr);
        g.stroke();
    }
    g.restore();

    g.save();
    g.translate(W / 2, W / 2);
    g.strokeStyle = '#ffd34d';
    g.lineWidth = 2.5 * dpr;
    g.beginPath();
    g.moveTo(-R * 0.35, 0); g.lineTo(-R * 0.12, 0); g.lineTo(0, R * 0.1); g.lineTo(R * 0.12, 0); g.lineTo(R * 0.35, 0);
    g.stroke();
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(57,208,255,0.6)';
    g.lineWidth = 2 * dpr;
    g.stroke();
    g.restore();
}

// ---------------------------------------------------------------------------
// Input wiring

const BURN_KEYS = { w: 'prograde', s: 'retrograde', a: 'normalPos', d: 'normalNeg' };
const BURN_BUTTONS = { prograde: 'prograde', retrograde: 'retrograde', 'normal-pos': 'normalPos', 'normal-neg': 'normalNeg' };

/** Held burn inputs, from keys and touch buttons. */
export const held = { prograde: false, retrograde: false, normalPos: false, normalNeg: false };
const keyHeld = { ...held };
const btnHeld = { ...held };
function syncHeld() {
    for (const k of Object.keys(held)) held[k] = keyHeld[k] || btnHeld[k];
}
export function releaseAll() {
    for (const k of Object.keys(held)) { keyHeld[k] = false; btnHeld[k] = false; held[k] = false; }
}
export function anyHeld() {
    return held.prograde || held.retrograde || held.normalPos || held.normalNeg;
}

function isTyping(target) {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * Wire every control. `h` holds the handlers:
 * getMode(), launch(cfg), restart(), undo(), warp(n), warpStep(±1), togglePause(),
 * focus(name), autopilot(mode, opts), cancelAutopilot(), altHold(), circularize(),
 * togglePredict(), toggleHohmann(), throttle(0..1), throttleStep(±d), settingsChanged(s)
 */
export function initUI(h) {
    $('mission-orbit-radius').max = '6';   // higher targets run into the Moon's sphere of influence
    for (const id of Object.keys(SLIDERS)) {
        const input = $(id);
        input.addEventListener('input', () => {
            refreshSlider(id);
            if (Object.values(PHYSICS_SLIDERS).includes(id)) {
                selectedRocket = 'custom';
                pressCard('custom');
                gallery?.refreshCustom(customStats());
                refreshDerived();
            }
        });
        refreshSlider(id);
    }
    buildPicker();
    applyPreset('saturn5');

    let launchGuard = false;
    $('launch-button').addEventListener('click', () => {
        if (launchGuard || h.getMode() !== 'landing') return;    // double-click guard
        launchGuard = true;
        setTimeout(() => { launchGuard = false; }, 800);
        h.launch(getMissionConfig());
    });

    // Settings drawer
    const drawer = $('settings-drawer');
    const openDrawer = () => { drawer.hidden = false; $('settings-close').focus({ preventScroll: true }); };
    const closeDrawer = () => { drawer.hidden = true; };
    $('settings-btn-landing').addEventListener('click', openDrawer);
    $('menu-btn').addEventListener('click', () => (drawer.hidden ? openDrawer() : closeDrawer()));
    $('settings-close').addEventListener('click', closeDrawer);
    const opts = { 'opt-rcs-fx': 'rcsFx', 'opt-predict': 'predict', 'opt-reduced-motion': 'reducedMotion', 'opt-hi-quality': 'hiQuality', 'opt-easy': 'easy', 'opt-coach': 'coach' };
    for (const [id, key] of Object.entries(opts)) {
        const box = $(id);
        box.checked = settings[key];
        box.addEventListener('change', () => {
            settings[key] = box.checked;
            saveSettings();
            applySettingsClasses();
            h.settingsChanged(settings);
        });
    }
    applySettingsClasses();

    // Panels collapse; what the user opened or closed is remembered per HUD state.
    for (const panel of document.querySelectorAll('#hud .panel')) {
        const btn = panel.querySelector('.panel-toggle');
        btn?.setAttribute('aria-expanded', String(!panel.classList.contains('is-collapsed')));
        btn?.addEventListener('click', () => {
            panel.classList.toggle('is-collapsed');
            const collapsed = panel.classList.contains('is-collapsed');
            btn.setAttribute('aria-expanded', String(!collapsed));
            rememberPanel(panel.id, collapsed);
        });
    }
    initSheet();
    window.addEventListener('resize', () => { if (hudState) setHudState(hudState, true); });
    setHudState(hudState || 'landing', true);
    $('ship-indicator')?.addEventListener('click', () => h.focus('ship'));
    $('ap-chip-cancel')?.addEventListener('click', () => h.cancelAutopilot());

    for (const b of document.querySelectorAll('.warp-btn')) {
        b.addEventListener('click', () => h.warp(Number(b.dataset.warp)));
    }
    $('focus-earth').addEventListener('click', () => h.focus('earth'));
    $('focus-moon').addEventListener('click', () => h.focus('moon'));
    $('focus-ship').addEventListener('click', () => h.focus('ship'));
    $('focus-sun').addEventListener('click', () => h.focus('sun'));
    $('focus-target').addEventListener('click', () => h.focus(target));
    $('target-select').addEventListener('change', () => {
        target = $('target-select').value;
        syncTarget();
        h.setTarget?.(target);
    });
    $('warp-burn-btn').addEventListener('click', () => h.warpToBurn?.());
    syncTarget();
    $('autopilot-btn').addEventListener('click', () => {
        h.autopilot($('autopilot-orbit-type').value, { lunarR: Number($('moon-altitude').value) });
    });
    $('autopilot-cancel').addEventListener('click', () => h.cancelAutopilot());
    const syncMoonAlt = () => { $('moon-altitude').hidden = $('autopilot-orbit-type').value !== 'moon'; };
    $('autopilot-orbit-type').addEventListener('change', syncMoonAlt);
    syncMoonAlt();
    $('althold-btn').addEventListener('click', () => h.altHold());
    $('circularize-btn').addEventListener('click', () => h.circularize());
    $('predict').addEventListener('click', () => h.togglePredict());
    $('hohmann-btn').addEventListener('click', () => h.toggleHohmann());
    $('undo-btn').addEventListener('click', () => h.undo());
    $('crash-undo-btn').addEventListener('click', () => h.undo());
    $('restart-btn').addEventListener('click', () => h.restart());
    $('restart-flight-btn').addEventListener('click', () => h.restart());

    const throttle = $('throttle');
    throttle.addEventListener('input', () => h.throttle(Number(throttle.value) / 100));

    // Burn buttons: pointer capture so a finger sliding off still releases.
    for (const [id, key] of Object.entries(BURN_BUTTONS)) {
        const b = $(id);
        const up = () => { btnHeld[key] = false; syncHeld(); };
        b.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            btnHeld[key] = true;
            syncHeld();
        });
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        b.addEventListener('lostpointercapture', up);
        b.addEventListener('contextmenu', (e) => e.preventDefault());
        b.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); btnHeld[key] = true; syncHeld(); }
        });
        b.addEventListener('keyup', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { btnHeld[key] = false; syncHeld(); }
        });
    }

    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

    window.addEventListener('keydown', (e) => {
        const mode = h.getMode();
        if (e.key === 'Escape') {
            if (!drawer.hidden) { closeDrawer(); return; }
            if (mode === 'flight') h.cancelAutopilot();
            return;
        }
        if (isTyping(e.target)) return;
        if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
        const k = e.key.toLowerCase();

        if ((e.ctrlKey || e.metaKey) && k === 'z') {
            if (mode === 'flight' || crashVisible()) { e.preventDefault(); h.undo(); }
            return;
        }
        if (k === 'r' && crashVisible()) { h.restart(); return; }
        if (mode !== 'flight' || crashVisible()) return;

        if (BURN_KEYS[k] && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            if (!e.repeat) { keyHeld[BURN_KEYS[k]] = true; syncHeld(); }
            return;
        }
        // Held keys auto-repeat; toggles must fire once per press.
        if (e.repeat && k !== 'shift' && k !== 'control') { if (k === ' ') e.preventDefault(); return; }
        switch (k) {
            case ' ': e.preventDefault(); h.togglePause(); break;
            case 'shift': h.throttleStep(0.1); break;
            case 'control': h.throttleStep(-0.1); break;
            case 'z': h.throttle(1); break;
            case 'x': h.throttle(0); break;
            case ',': case '<': h.warpStep(-1); break;
            case '.': case '>': h.warpStep(1); break;
            case '1': h.focus('earth'); break;
            case '2': h.focus('moon'); break;
            case '3': h.focus('ship'); break;
            case '4': h.focus('sun'); break;
            case '5': h.focus(target); break;
            case 'n': h.warpToBurn?.(); break;
            case 'c': h.circularize(); break;
            case 't': h.altHold(); break;
            case 'p': h.togglePredict(); break;
            case 'h': h.toggleHohmann(); break;
            default: break;
        }
    });
    window.addEventListener('keyup', (e) => {
        const k = e.key.toLowerCase();
        if (BURN_KEYS[k]) { keyHeld[BURN_KEYS[k]] = false; syncHeld(); }
    });
}

export function setThrottleUI(t) {
    const pct = Math.round(t * 100);
    const input = $('throttle');
    if (Number(input.value) !== pct) input.value = String(pct);
    input.style.setProperty('--fill', `${pct}%`);
    setText('ro-throttle', `${pct}%`);
}

/** Change one setting from code (keeps the drawer checkbox in sync). */
export function setSetting(key, value) {
    settings[key] = value;
    const ids = { rcsFx: 'opt-rcs-fx', predict: 'opt-predict', reducedMotion: 'opt-reduced-motion', hiQuality: 'opt-hi-quality', easy: 'opt-easy', coach: 'opt-coach' };
    const box = $(ids[key]);
    if (box) box.checked = value;
    saveSettings();
    applySettingsClasses();
}

function applySettingsClasses() {
    document.body.classList.toggle('reduce-motion', settings.reducedMotion);
}

// ---------------------------------------------------------------------------
// Target selector, burn assist, next-burn and launch telemetry

let target = 'moon';
export function getTarget() { return target; }
function syncTarget() {
    const sel = $('target-select');
    if (sel && sel.value !== target) sel.value = target;
    const b = $('focus-target');
    if (b) {
        b.dataset.target = target;
        b.textContent = target.toUpperCase();
        b.hidden = target === 'moon';   // the Moon already has its own chip
    }
}
/** Change the target from code (keeps select and focus chip in sync). */
export function setTarget(name) { target = name; syncTarget(); }

let assistKey = '';
/** info = {label, progress 0..1, grade: 'PERFECT'|'GOOD'|'OK'|null, hint, done} or null. */
export function setBurnAssist(info) {
    const box = $('burn-assist');
    if (!box) return;
    if (!info) { if (!box.hidden) box.hidden = true; assistKey = ''; return; }
    const p = Math.max(0, Math.min(1, info.progress || 0));
    const key = `${info.label}|${Math.round(p * 200)}|${info.grade}|${info.hint}|${info.done}`;
    if (key === assistKey) return;
    assistKey = key;
    box.hidden = false;
    setText('ba-label', info.label || '');
    setText('ba-hint', info.hint || '');
    $('ba-fill').style.width = `${(p * 100).toFixed(1)}%`;
    setClass(box, 'is-done', !!info.done);
    const g = $('ba-grade');
    g.hidden = !info.grade;
    if (info.grade) {
        setText('ba-grade', info.grade);
        g.className = `ba-grade grade-${String(info.grade).toLowerCase()}`;
    }
}

/** info = {label, timeText} or null. Shows the WARP TO NEXT BURN button. */
export function setNextBurn(info) {
    const b = $('warp-burn-btn');
    if (!b) return;
    b.hidden = !info;
    if (info) setText('warp-burn-label', info.timeText ? `${info.label} \u00B7 ${info.timeText}` : info.label);
}

/** info = {accelG, stage, stageFuel 0..1, massT} or null (hide after launch). */
export function setLaunchTelemetry(info) {
    const box = $('launch-telemetry');
    if (!box) return;
    if (!info) { if (!box.hidden) box.hidden = true; return; }
    box.hidden = false;
    setText('lt-accel', info.accelG.toFixed(1));
    $('lt-g-fill').style.width = `${Math.min(100, (info.accelG / 6) * 100).toFixed(0)}%`;
    setClass(box, 'is-high-g', info.accelG > 4.5);
    setText('lt-stage', `STAGE ${info.stage}`);
    $('lt-fuel-fill').style.width = `${Math.max(0, Math.min(1, info.stageFuel)) * 100}%`;
    setText('lt-mass', info.massT != null ? `${info.massT.toFixed(0)} t` : '');
}

// ---------------------------------------------------------------------------
// State-based HUD layout (pure helpers first: they run in node tests)

export const HUD_STATES = ['landing', 'countdown', 'ascent', 'orbit', 'burning', 'zone', 'autopilot', 'transfer', 'crashed'];

/** 'phone' (<700 portrait), 'rail' (landscape phone / short), 'medium' (<1024), 'desktop'. */
export function hudLayout(width, height) {
    const h = height == null ? Infinity : height;
    if (width < 700) return width > h ? 'rail' : 'phone';
    if (h <= 560 && width > h) return 'rail';
    return width >= 1024 ? 'desktop' : 'medium';
}

// Per-state base table. ro = readout depth; dim/emph name HUD blocks.
const BASE = {
    landing:   { orbit: 0, systems: 0, chips: 0, burn: 0, navball: 0, assist: 0, ro: 'min', dim: [], emph: [], sysOpen: false },
    countdown: { orbit: 1, systems: 0, chips: 0, burn: 0, navball: 0, assist: 1, ro: 'min', dim: [], emph: [], sysOpen: false },
    ascent:    { orbit: 1, systems: 0, chips: 0, burn: 0, navball: 0, assist: 1, ro: 'min', dim: [], emph: ['telemetry'], sysOpen: false },
    orbit:     { orbit: 1, systems: 1, chips: 1, burn: 1, navball: 1, assist: 1, ro: 'compact', dim: [], emph: [], sysOpen: false },
    burning:   { orbit: 1, systems: 1, chips: 1, burn: 1, navball: 1, assist: 1, ro: 'compact', dim: ['orbit', 'systems'], emph: ['assist', 'burn'], sysOpen: false },
    zone:      { orbit: 1, systems: 1, chips: 1, burn: 1, navball: 1, assist: 1, ro: 'compact', dim: ['orbit', 'systems'], emph: ['assist', 'burn'], sysOpen: false },
    autopilot: { orbit: 1, systems: 1, chips: 1, burn: 1, navball: 1, assist: 1, ro: 'compact', dim: ['burn'], emph: ['autopilot'], sysOpen: true },
    transfer:  { orbit: 1, systems: 1, chips: 1, burn: 1, navball: 1, assist: 1, ro: 'full', dim: [], emph: ['warp', 'target'], sysOpen: false },
    crashed:   { orbit: 0, systems: 0, chips: 0, burn: 0, navball: 0, assist: 0, ro: 'min', dim: [], emph: [], sysOpen: false },
};

/**
 * Which HUD blocks show for a state at a viewport size.
 * collapsed = default is-collapsed per panel (the user's own toggles override it).
 */
export function hudVisibility(state, width, height) {
    const b = BASE[state] || BASE.orbit;
    const layout = hudLayout(width, height);
    const small = layout === 'phone' || layout === 'rail';
    const bar = (state === 'landing' || state === 'crashed' || state === 'countdown' || state === 'ascent' || layout === 'phone') ? 'min' : 'full';
    const sysChip = !b.sysOpen;
    return {
        state, layout,
        topBar: bar,
        chips: !!b.chips,
        warp: !!b.chips,
        focus: !!b.chips,
        orbit: !!b.orbit,
        systems: !!b.systems,
        systemsMode: !b.systems ? 'hidden' : (sysChip ? 'chip' : 'full'),
        deck: !!(b.assist || b.burn),
        assist: !!b.assist,
        burnButtons: !!b.burn,
        navball: !!b.navball,
        telemetry: state === 'ascent' || state === 'countdown',
        autopilot: state === 'autopilot',
        targetInfo: state === 'transfer',
        readouts: small && b.ro === 'full' ? 'compact' : b.ro,
        dim: b.dim.slice(),
        emphasize: b.emph.slice(),
        // phones keep panels open inside the sheet; medium collapses both to chips
        collapsed: layout === 'phone'
            ? { 'panel-orbit': false, 'panel-systems': false }
            : { 'panel-orbit': layout === 'medium' || layout === 'rail', 'panel-systems': sysChip },
    };
}

/** Free canvas rect from occluder rects [{left,top,right,bottom}] (CSS px). */
export function computeSafeRect(vw, vh, rects) {
    let top = 0, bottom = vh, left = 0, right = vw;
    for (const r of rects) {
        if (!r || r.right <= r.left || r.bottom <= r.top) continue;
        const w = r.right - r.left;
        const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        const wide = w >= vw * 0.45;
        const central = Math.abs(cx - vw / 2) < vw * 0.2;
        if (cy < vh * 0.3 && (wide || central)) top = Math.max(top, r.bottom);
        else if (cy > vh * 0.55 && (wide || central)) bottom = Math.min(bottom, r.top);
        else if (cx < vw / 2) left = Math.max(left, r.right);
        else right = Math.min(right, r.left);
    }
    if (bottom - top < vh * 0.2) { top = 0; bottom = vh; }
    if (right - left < vw * 0.3) { left = 0; right = vw; }
    return { top, bottom, left, right };
}

/** Clamp a screen point to a rect (inset by margin) along the ray from the rect centre. */
export function clampToRect(x, y, rect, margin = 24) {
    const l = rect.left + margin, r = rect.right - margin, t = rect.top + margin, b = rect.bottom - margin;
    const cx = (rect.left + rect.right) / 2, cy = (rect.top + rect.bottom) / 2;
    const dx = x - cx, dy = y - cy;
    const hw = Math.max(1, (r - l) / 2), hh = Math.max(1, (b - t) / 2);
    const angle = Math.atan2(dy, dx);
    if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) return { x, y, angle, clamped: false };
    const k = Math.min(hw / (Math.abs(dx) || 1e-9), hh / (Math.abs(dy) || 1e-9));
    return { x: cx + dx * k, y: cy + dy * k, angle, clamped: true };
}

// ---------------------------------------------------------------------------
// DOM side (guarded so the pure helpers import cleanly in node)

const HAS_DOM = typeof document !== 'undefined';
let hudState = null;
let hudLayoutName = null;
const panelMemory = {};     // state -> { panelId: collapsed }
const sheetMemory = {};     // state -> snap

function rememberPanel(id, collapsed) {
    (panelMemory[hudState] ||= {})[id] = collapsed;
}

function viewport() {
    return { w: window.innerWidth, h: window.innerHeight };
}

function relocateChips(layout) {
    const chips = document.querySelector('.hud-chips');
    const sheet = $('hud-main');
    const top = $('hud-top');
    if (!chips || !sheet || !top) return;
    if (layout === 'phone') {
        if (chips.parentElement !== sheet) sheet.insertBefore(chips, $('sheet-handle')?.nextSibling || sheet.firstChild);
    } else if (chips.parentElement !== top) {
        top.insertBefore(chips, $('menu-btn'));
    }
}

function setSnap(snap) {
    const sheet = $('hud-main');
    if (!sheet) return;
    sheet.dataset.snap = String(snap);
    document.body.dataset.sheet = String(snap);
    $('sheet-handle')?.setAttribute('aria-expanded', String(snap > 0));
}

/** Switch the HUD to a state. Cheap to call every frame. */
export function setHudState(state, force = false) {
    if (!HAS_DOM || !HUD_STATES.includes(state)) return;
    const { w, h } = viewport();
    const v = hudVisibility(state, w, h);
    const changed = state !== hudState;
    if (!changed && !force && v.layout === hudLayoutName) return;
    const layoutChanged = v.layout !== hudLayoutName;
    hudState = state;
    hudLayoutName = v.layout;
    const body = document.body;
    body.dataset.hud = state;
    body.dataset.layout = v.layout;
    body.dataset.ro = v.readouts;
    const flag = (c, on) => { if (body.classList.contains(c) !== on) body.classList.toggle(c, on); };
    flag('hud-no-orbit', !v.orbit);
    flag('hud-no-systems', !v.systems);
    flag('hud-no-chips', !v.chips);
    flag('hud-no-burn', !v.burnButtons);
    flag('hud-no-navball', !v.navball);
    flag('hud-no-assist', !v.assist);
    flag('hud-bar-min', v.topBar === 'min');
    for (const k of ['orbit', 'systems', 'burn']) flag(`hud-dim-${k}`, v.dim.includes(k));
    for (const k of ['assist', 'burn', 'autopilot', 'warp', 'target', 'telemetry']) flag(`hud-emph-${k}`, v.emphasize.includes(k));
    relocateChips(v.layout);
    if (changed || layoutChanged) {
        const mem = panelMemory[state] || {};
        for (const panel of document.querySelectorAll('#hud .panel')) {
            const collapsed = mem[panel.id] !== undefined && v.layout !== 'phone' ? mem[panel.id] : v.collapsed[panel.id];
            panel.classList.toggle('is-collapsed', !!collapsed);
            panel.querySelector('.panel-toggle')?.setAttribute('aria-expanded', String(!collapsed));
        }
        setSnap(v.layout === 'phone' ? (sheetMemory[state] ?? 0) : 0);
    }
    cachedSafeAt = 0;
}

export function getHudState() { return hudState; }

// Bottom sheet (phones): tap handle cycles snaps, drag snaps to the nearest.
function initSheet() {
    const sheet = $('hud-main');
    if (!sheet || $('sheet-handle')) return;
    const handle = document.createElement('button');
    handle.id = 'sheet-handle';
    handle.type = 'button';
    handle.className = 'sheet-handle';
    handle.setAttribute('aria-label', 'Panels: tap or drag to resize');
    handle.setAttribute('aria-expanded', 'false');
    handle.innerHTML = '<i></i>';
    sheet.prepend(handle);
    const heights = () => {
        const vh = window.innerHeight;
        const peek = sheet.dataset.snap === '0' ? sheet.getBoundingClientRect().height : 76;
        return [Math.max(40, peek), vh * 0.44, vh * 0.8];
    };
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        drag = { y: e.clientY, h0: sheet.getBoundingClientRect().height, moved: false, hs: heights() };
    });
    handle.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dy = drag.y - e.clientY;
        if (Math.abs(dy) > 6) drag.moved = true;
        if (!drag.moved) return;
        document.body.classList.add('sheet-drag');
        const hh = Math.max(drag.hs[0], Math.min(drag.hs[2], drag.h0 + dy));
        sheet.style.setProperty('--sheet-drag', `${hh}px`);
    });
    const end = (e) => {
        if (!drag) return;
        const d = drag; drag = null;
        const cur = parseFloat(sheet.style.getPropertyValue('--sheet-drag')) || d.h0;
        sheet.style.removeProperty('--sheet-drag');
        document.body.classList.remove('sheet-drag');
        let snap = Number(sheet.dataset.snap || 0);
        if (d.moved && e.type === 'pointerup') {
            snap = d.hs.reduce((best, hv, i) => (Math.abs(hv - cur) < Math.abs(d.hs[best] - cur) ? i : best), 0);
        } else if (e.type === 'pointerup') {
            snap = (snap + 1) % 3;
        }
        setSnap(snap);
        sheetMemory[hudState] = snap;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const snap = (Number(sheet.dataset.snap || 0) + 1) % 3;
            setSnap(snap);
            sheetMemory[hudState] = snap;
        }
    });
    setSnap(0);
}

function visibleRect(el) {
    if (!el || el.offsetParent === null) {
        if (!el || getComputedStyle(el).position !== 'fixed') return null;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function unionRects(els) {
    let u = null;
    for (const el of els) {
        const r = visibleRect(el);
        if (!r) continue;
        u = u ? { left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) } : r;
    }
    return u;
}

let cachedSafe = null;
let cachedSafeAt = 0;
/** Free canvas area ({top,bottom,left,right}, CSS px) after the current HUD layout. */
export function getSafeViewRect() {
    const { w, h } = viewport();
    if (!HAS_DOM || document.body.dataset.mode === 'landing') return { top: 0, bottom: h, left: 0, right: w };
    const now = performance.now();
    if (cachedSafe && now - cachedSafeAt < 150 && cachedSafe.w === w && cachedSafe.h === h) return cachedSafe.rect;
    const phone = hudLayoutName === 'phone';
    const rects = [visibleRect($('hud-top'))];
    if (phone) rects.push(visibleRect($('hud-main')));
    else rects.push(visibleRect($('panel-orbit')), visibleRect($('panel-systems')));
    const deck = $('control-deck');
    rects.push(deck ? unionRects(deck.children) : null);
    rects.push(visibleRect($('coach')));   // the coach card must never sit on the ship
    const rect = computeSafeRect(w, h, rects);
    cachedSafe = { w, h, rect };
    cachedSafeAt = now;
    return rect;
}

// ---------------------------------------------------------------------------
// Ship locator: edge arrow when off-screen, bracket reticle when tiny.

let shipKey = '';
/** info = {x, y, onScreen, angle, distText, small?} in CSS px, or null to hide both. */
export function setShipIndicator(info) {
    if (!HAS_DOM) return;
    const arrow = $('ship-indicator');
    const ret = $('ship-reticle');
    if (!arrow || !ret) return;
    if (!info) {
        if (!arrow.hidden) arrow.hidden = true;
        if (!ret.hidden) ret.hidden = true;
        shipKey = '';
        return;
    }
    if (info.onScreen) {
        if (!arrow.hidden) arrow.hidden = true;
        const show = !!info.small;
        if (ret.hidden === show) ret.hidden = !show;
        if (show) ret.style.transform = `translate(${info.x.toFixed(1)}px, ${info.y.toFixed(1)}px)`;
        return;
    }
    if (!ret.hidden) ret.hidden = true;
    const { w, h } = viewport();
    const safe = getSafeViewRect();
    const rect = safe.right - safe.left > 120 && safe.bottom - safe.top > 120 ? safe : { top: 0, bottom: h, left: 0, right: w };
    const p = Number.isFinite(info.x) && Number.isFinite(info.y)
        ? clampToRect(info.x, info.y, rect, 30)
        : clampToRect(w / 2 + Math.cos(info.angle) * 1e5, h / 2 + Math.sin(info.angle) * 1e5, rect, 30);
    const key = `${p.x.toFixed(0)}|${p.y.toFixed(0)}|${info.distText}`;
    if (key === shipKey) return;
    shipKey = key;
    arrow.hidden = false;
    arrow.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    arrow.style.setProperty('--si-rot', `${p.angle}rad`);
    arrow.style.setProperty('--si-lx', `${(-Math.cos(p.angle) * 36).toFixed(0)}px`);
    arrow.style.setProperty('--si-ly', `${(-Math.sin(p.angle) * 30).toFixed(0)}px`);
    setText('si-dist', info.distText || '');
}
