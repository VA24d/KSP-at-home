// Mission coach: checklist + one tip at a time + pointer. nextTip() is pure
// (no DOM) so it can be unit-tested; createCoach() guards every DOM access.

export const STEPS = [
    { id: 'launch', label: 'Launch' },
    { id: 'orbit', label: 'Reach orbit' },
    { id: 'circularize', label: 'Circularize' },
    { id: 'target', label: 'Choose target' },
    { id: 'transfer', label: 'Transfer burn' },
    { id: 'capture', label: 'Capture' },
    { id: 'final', label: 'Orbit target' },
];

const DONE_KEY = 'ksp-astro-coach-v1';
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : 'target');

/** Which steps are complete for this state (array of booleans, STEPS order). */
export function stepsDone(s = {}) {
    const flying = s.mode === 'flight' || s.mode === 'launching';
    const launched = flying && s.phase !== 'pad' && !!s.phase;
    const inOrbit = launched && (s.phase === 'orbit' || s.dominant !== 'earth' || s.orbited === true);
    const circular = inOrbit && (s.dominant !== 'earth' || (typeof s.ecc === 'number' && s.ecc < 0.06));
    const left = !!s.dominant && s.dominant !== 'earth';
    const picked = circular && (s.targetChosen === true || s.apActive === true || left);
    const transfer = circular && left;
    const target = s.target || 'moon';
    const captured = transfer && s.dominant === target;
    const final = captured && typeof s.ecc === 'number' && s.ecc < 0.25 && !s.burning;
    return [launched, inOrbit, circular, picked, transfer, captured, final];
}

/**
 * The single tip to show now: {step, id, text, pointer, done}.
 * pointer is a CSS selector, {x,y} or null. done=true when the mission is complete.
 */
export function nextTip(s = {}) {
    const target = s.target || 'moon';
    const name = cap(target);
    if (s.crashed) return { step: -1, id: 'crashed', text: 'Crashed. Press R or REWIND, then try again.', pointer: '#restart-btn', done: false };
    if (s.mode === 'landing') return { step: 0, id: 'pick', text: 'Pick a rocket and press LAUNCH. Easy mode is on.', pointer: '#launch-button', done: false };
    const d = stepsDone(s);
    const step = d.indexOf(false);
    if (step === -1) return { step: STEPS.length, id: 'done', text: `Mission complete. ${name} orbit reached.`, pointer: null, done: true };
    const id = STEPS[step].id;
    switch (id) {
        case 'launch':
            return { step, id, text: s.mode === 'launching' ? 'Liftoff in progress. Hold on.' : 'Press LAUNCH. The rocket flies itself up.', pointer: null, done: false };
        case 'orbit':
            return { step, id, text: 'Climbing. Wait for the engine cut-off, you are heading to orbit.', pointer: null, done: false };
        case 'circularize':
            if (s.apActive) return { step, id, text: 'Autopilot is circularizing. Watch the bar, or warp.', pointer: null, done: false };
            if (s.inZone) return { step, id, text: s.burning ? 'Keep holding PROGRADE until the orbit turns round.' : 'Hold ▲ PROGRADE (W) inside the green band to circularize.', pointer: '#prograde', done: false };
            return { step, id, text: 'Press WARP TO NEXT BURN, or use Autopilot: Circularize here.', pointer: '#warp-burn-btn', done: false };
        case 'target':
            return { step, id, text: `Choose a target in the propulsion panel (now: ${name}).`, pointer: '#target-select', done: false };
        case 'transfer':
            if (s.apActive) return { step, id, text: `Autopilot is flying the ${name} transfer. Warp to speed it up.`, pointer: '#warp-burn-btn', done: false };
            if (s.inZone) return { step, id, text: s.burning ? 'Keep burning PROGRADE until the bar fills.' : `Hold ▲ PROGRADE (W) in the green band for the ${name} transfer.`, pointer: '#prograde', done: false };
            return { step, id, text: `Press WARP TO NEXT BURN to reach the ${name} window, or pick Transfer to target.`, pointer: '#warp-burn-btn', done: false };
        case 'capture':
            return { step, id, text: s.inZone ? 'Hold ▼ RETRO (S) in the band to slow down and get captured.' : `Coasting to ${name}. Warp, then burn RETRO near closest approach.`, pointer: s.inZone ? '#retrograde' : '#warp-burn-btn', done: false };
        default:
            return { step, id, text: `Circularize around ${name}: burn at the low point of the orbit.`, pointer: s.inZone ? '#prograde' : null, done: false };
    }
}

function loadDone() { try { return localStorage.getItem(DONE_KEY) === 'done'; } catch { return false; } }
function saveDone(v) { try { if (v) localStorage.setItem(DONE_KEY, 'done'); else localStorage.removeItem(DONE_KEY); } catch { /* ignore */ } }

export function createCoach({ root } = {}) {
    const hasDom = typeof document !== 'undefined';
    const host = root || (hasDom ? document.body : null);
    let el = null, ptr = null, tipEl = null, listEl = null, collapsed = false, dismissed = false, hiddenByCaller = false;
    let completed = loadDone(), lastId = '', ptrTarget = null, raf = 0, lastTip = null, disposed = false;

    if (hasDom && host) {
        el = document.createElement('aside');
        el.id = 'coach';
        el.className = 'coach';
        el.setAttribute('aria-label', 'Mission coach');
        el.hidden = true;
        el.innerHTML = '<header class="coach-head"><span class="coach-code">COACH</span>'
            + '<button type="button" class="coach-btn" data-act="fold" aria-label="Collapse coach">&minus;</button></header>'
            + '<ol class="coach-steps"></ol><p class="coach-tip" role="status" aria-live="polite"></p>'
            + '<button type="button" class="coach-btn coach-got" data-act="got">Got it</button>';
        host.appendChild(el);
        ptr = document.createElement('div');
        ptr.className = 'coach-pointer';
        ptr.hidden = true;
        ptr.setAttribute('aria-hidden', 'true');
        ptr.innerHTML = '<span class="coach-ring"></span><span class="coach-arrow">&#9660;</span>';
        host.appendChild(ptr);
        tipEl = el.querySelector('.coach-tip');
        listEl = el.querySelector('.coach-steps');
        el.addEventListener('click', (e) => {
            const act = e.target?.dataset?.act;
            if (act === 'fold') { collapsed = !collapsed; el.classList.toggle('is-collapsed', collapsed); }
            if (act === 'got') { dismissed = true; refreshVisibility(); }
        });
    }

    function refreshVisibility() {
        const off = hiddenByCaller || dismissed || completed;
        if (el) el.hidden = off;
        if (ptr && off) ptr.hidden = true;
    }

    function place() {
        raf = 0;
        if (!ptr || !ptrTarget || disposed) return;
        let x, y, w = 0, h = 0;
        if (typeof ptrTarget === 'string') {
            const t = document.querySelector(ptrTarget);
            if (!t || t.offsetParent === null) { ptr.hidden = true; return; }
            const r = t.getBoundingClientRect();
            x = r.left + r.width / 2; y = r.top; w = r.width; h = r.height;
        } else { x = ptrTarget.x; y = ptrTarget.y; }
        ptr.hidden = hiddenByCaller || dismissed || completed;
        ptr.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        ptr.style.setProperty('--w', `${Math.round(w)}px`);
        ptr.style.setProperty('--h', `${Math.round(h)}px`);
    }

    function pointAt(target) {
        ptrTarget = target || null;
        if (!ptr) return;
        if (!ptrTarget) { ptr.hidden = true; return; }
        place();
    }

    function render(tip, d) {
        if (!el) return;
        if (listEl.children.length !== STEPS.length) {
            listEl.innerHTML = STEPS.map((st) => `<li data-id="${st.id}">${st.label}</li>`).join('');
        }
        STEPS.forEach((st, i) => {
            const li = listEl.children[i];
            li.classList.toggle('is-done', !!d[i]);
            li.classList.toggle('is-now', i === tip.step);
        });
        if (tipEl.textContent !== tip.text) tipEl.textContent = tip.text;
    }

    function update(state) {
        if (disposed) return null;
        const tip = nextTip(state);
        lastTip = tip;
        if (tip.done && !completed) { completed = true; saveDone(true); refreshVisibility(); }
        render(tip, stepsDone(state));
        if (tip.id !== lastId) { lastId = tip.id; refreshVisibility(); }
        // pointer: caller may override with pointAt(); otherwise follow the tip
        if (typeof tip.pointer === 'string' || tip.pointer === null) {
            if (!ptrTarget || typeof ptrTarget === 'string') { ptrTarget = tip.pointer; }
        }
        if (ptrTarget) place(); else if (ptr) ptr.hidden = true;
        return tip;
    }

    return {
        update, pointAt,
        hide() { hiddenByCaller = true; refreshVisibility(); },
        show() { hiddenByCaller = false; dismissed = false; refreshVisibility(); },
        /** New mission: show again (unless the first mission is done and coach stays off). */
        reset() { dismissed = false; lastId = ''; ptrTarget = null; refreshVisibility(); },
        /** Settings "coach" re-enabled: forget completion so tips come back. */
        reenable() { completed = false; saveDone(false); dismissed = false; hiddenByCaller = false; refreshVisibility(); },
        isCompleted: () => completed,
        get tip() { return lastTip; },
        dispose() { disposed = true; if (raf) cancelAnimationFrame(raf); el?.remove(); ptr?.remove(); },
    };
}
