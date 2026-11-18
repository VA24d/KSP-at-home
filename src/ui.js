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
    if (t.autopilot) setText('autopilot-phase', t.autopilot);

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
    for (const id of ['focus-earth', 'focus-moon', 'focus-ship']) {
        setClass($(id), 'is-active', id === `focus-${s.focus}`);
    }
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
    const opts = { 'opt-rcs-fx': 'rcsFx', 'opt-predict': 'predict', 'opt-reduced-motion': 'reducedMotion', 'opt-hi-quality': 'hiQuality' };
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

    // Panels collapse; start collapsed on phones.
    const phone = window.matchMedia('(max-width: 720px)').matches;
    for (const panel of document.querySelectorAll('#hud .panel')) {
        const btn = panel.querySelector('.panel-toggle');
        if (phone) panel.classList.add('is-collapsed');
        btn?.setAttribute('aria-expanded', String(!panel.classList.contains('is-collapsed')));
        btn?.addEventListener('click', () => {
            panel.classList.toggle('is-collapsed');
            btn.setAttribute('aria-expanded', String(!panel.classList.contains('is-collapsed')));
        });
    }

    for (const b of document.querySelectorAll('.warp-btn')) {
        b.addEventListener('click', () => h.warp(Number(b.dataset.warp)));
    }
    $('focus-earth').addEventListener('click', () => h.focus('earth'));
    $('focus-moon').addEventListener('click', () => h.focus('moon'));
    $('focus-ship').addEventListener('click', () => h.focus('ship'));
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
    const ids = { rcsFx: 'opt-rcs-fx', predict: 'opt-predict', reducedMotion: 'opt-reduced-motion', hiQuality: 'opt-hi-quality' };
    const box = $(ids[key]);
    if (box) box.checked = value;
    saveSettings();
    applySettingsClasses();
}

function applySettingsClasses() {
    document.body.classList.toggle('reduce-motion', settings.reducedMotion);
}
