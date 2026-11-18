// Landing-screen rocket carousel: one rotating 3D model, arrows, pager, stats.
import * as THREE from 'three';
import { ROCKETS, buildRocket } from './rockets.js';

const IDS = ['saturn5', 'sls', 'starship', 'custom'];
const SLIDE_S = 0.55;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

export function createGallery(container, { onSelect } = {}) {
    container.textContent = '';
    container.classList.add('gallery');

    // ---- DOM
    const stage = el('div', 'gal-stage');
    const canvas = el('canvas', 'gal-canvas');
    canvas.setAttribute('aria-hidden', 'true');
    stage.append(canvas);
    const prevBtn = el('button', 'gal-arrow gal-prev', '‹');
    const nextBtn = el('button', 'gal-arrow gal-next', '›');
    prevBtn.type = nextBtn.type = 'button';
    prevBtn.setAttribute('aria-label', 'Previous rocket');
    nextBtn.setAttribute('aria-label', 'Next rocket');
    stage.append(prevBtn, nextBtn);

    const info = el('div', 'gal-info');
    info.setAttribute('aria-live', 'polite');
    const nameEl = el('div', 'rc-name');
    const subEl = el('div', 'rc-sub');
    const dl = el('dl', 'rc-stats');
    info.append(nameEl, subEl, dl);
    const dots = el('div', 'gal-dots');
    dots.setAttribute('role', 'tablist');
    const dotEls = IDS.map((id, i) => {
        const d = el('button', 'gal-dot');
        d.type = 'button';
        d.setAttribute('role', 'tab');
        d.setAttribute('aria-label', ROCKETS[id].name);
        d.addEventListener('click', () => go(i));
        dots.append(d);
        return d;
    });
    container.append(stage, info, dots);

    // ---- three
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    camera.position.set(0, 0.1, 6.2);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0x9ecbff, 0x1a1020, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 4, 4);
    const rim = new THREE.DirectionalLight(0x39d0ff, 2.2);
    rim.position.set(-4, 1, -3);
    const warm = new THREE.PointLight(0xffb347, 1.4, 8);
    warm.position.set(0, -1.4, 1);
    scene.add(key, rim, warm);

    // ring + glow under the model
    const ringGroup = new THREE.Group();
    ringGroup.position.y = -1.22;
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x39d0ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.008, 8, 96), ringMat);
    ring.rotation.x = Math.PI / 2;
    const ring2Mat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.005, 8, 96, Math.PI * 1.3), ring2Mat);
    ring2.rotation.x = Math.PI / 2;
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x39d0ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false });
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 48), glowMat);
    glow.rotation.x = -Math.PI / 2;
    ringGroup.add(ring, ring2, glow);
    scene.add(ringGroup);

    const slots = IDS.map((id) => {
        const rocket = buildRocket(id);
        const tilt = new THREE.Group();
        tilt.rotation.z = Math.PI / 2;          // +X (nose) -> +Y (up)
        tilt.add(rocket.root);
        const spin = new THREE.Group();
        spin.add(tilt);
        const slot = new THREE.Group();
        slot.add(spin);
        slot.visible = false;
        scene.add(slot);
        return { rocket, spin, slot, phase: Math.random() * 6 };
    });

    // ---- state
    let index = 0;
    let from = -1;           // outgoing index during a transition
    let dir = 1;
    let t = 1;               // transition progress 0..1
    let customStats = null;  // {Isp, thrust, mass, dv} from the sliders
    let spinA = 0;
    let raf = 0;
    let last = 0;
    let onScreen = true;
    let disposed = false;

    // ui.js keeps this class in sync with the setting (which defaults to the OS preference).
    const reduced = () => document.body.classList.contains('reduce-motion');

    function stat(label, value) {
        dl.append(el('dt', '', label), el('dd', '', value));
    }
    function renderInfo() {
        const r = ROCKETS[IDS[index]];
        nameEl.textContent = r.name;
        subEl.textContent = r.subtitle;
        dl.textContent = '';
        if (r.id === 'custom') {
            const c = customStats || { Isp: r.physics.Isp, thrust: r.physics.thrust, mass: r.physics.dryMass + r.physics.fuelMass, dv: '' };
            stat('ISP', `${Math.round(c.Isp)} s`);
            stat('THRUST', `${(c.thrust * 9.80665).toFixed(1)} kN`);
            stat('MASS', `${Number(c.mass).toFixed(1)} t`);
            stat('ΔV', String(c.dv || '—'));
        } else {
            stat('HEIGHT', `${r.height_m} m`);
            stat('THRUST', `${(r.liftoffThrust_kN / 1000).toFixed(1)} MN`);
            stat('LEO', `${r.payloadLEO_t} t`);
            stat('FLEW', String(r.firstFlight));
        }
        dotEls.forEach((d, i) => {
            d.setAttribute('aria-selected', String(i === index));
            d.classList.toggle('is-on', i === index);
        });
        container.classList.toggle('is-custom', IDS[index] === 'custom');
    }

    function setIndex(i, d, notify) {
        i = (i + IDS.length) % IDS.length;
        if (i === index) return;
        from = index; index = i; dir = d;
        t = reduced() ? 1 : 0;
        renderInfo();
        wake();
        if (notify && onSelect) onSelect(IDS[index]);
    }
    function go(i) {
        const d = i > index ? 1 : -1;
        setIndex(i, d, true);
    }

    function select(id) {
        const i = IDS.indexOf(id);
        if (i < 0) return;
        if (i === index) { renderInfo(); return; }
        setIndex(i, i > index ? 1 : -1, false);
    }
    const next = () => setIndex(index + 1, 1, true);
    const prev = () => setIndex(index - 1, -1, true);

    prevBtn.addEventListener('click', prev);
    nextBtn.addEventListener('click', next);
    function refreshCustom(stats) {
        customStats = stats || null;
        if (IDS[index] === 'custom') renderInfo();
    }

    function onKey(e) {
        if (document.body.dataset.mode !== 'landing') return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const a = document.activeElement;
        if (a && (/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) || a.isContentEditable)) return;
        e.preventDefault();
        if (e.key === 'ArrowLeft') prev(); else next();
    }
    window.addEventListener('keydown', onKey);

    // swipe
    let sx = null, sy = 0;
    canvas.style.touchAction = 'pan-y';
    const down = (e) => { sx = e.clientX; sy = e.clientY; };
    const up = (e) => {
        if (sx === null) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        sx = null;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) (dx < 0 ? next : prev)();
    };
    const cancel = () => { sx = null; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);

    // ---- sizing
    function resize() {
        const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        // keep the rocket fully visible in tall or narrow stages
        const fitH = 2.9;
        const vfov = THREE.MathUtils.degToRad(camera.fov);
        let dist = (fitH / 2) / Math.tan(vfov / 2);
        const needW = 1.5 / camera.aspect;
        dist = Math.max(dist, (needW / 2) / Math.tan(vfov / 2));
        camera.position.z = dist;
        camera.updateProjectionMatrix();
        wake();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(stage);

    // ---- loop
    const shouldRun = () => !disposed && onScreen && document.body.dataset.mode === 'landing' && !document.hidden;
    function wake() {
        if (!raf && shouldRun()) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    function frame(now) {
        raf = 0;
        if (!shouldRun()) return;
        const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
        last = now;
        const calm = reduced();
        if (!calm) spinA += dt * 0.5;
        const time = now / 1000;
        if (t < 1) t = Math.min(1, t + dt / SLIDE_S);
        const e = ease(t);

        slots.forEach((s, i) => {
            const isCur = i === index, isOut = i === from && t < 1;
            s.slot.visible = isCur || isOut;
            if (!s.slot.visible) return;
            let x = 0, scale = 1;
            if (isCur) { x = (1 - e) * dir * 2.2; scale = 0.85 + 0.15 * e; }
            else { x = -e * dir * 2.2; scale = 1 - 0.15 * e; }
            s.slot.position.x = x;
            s.slot.position.y = calm ? 0 : Math.sin(time * 0.9 + s.phase) * 0.06;
            s.slot.scale.setScalar(scale);
            s.slot.rotation.z = calm ? 0 : Math.sin(time * 0.6 + s.phase) * 0.025;
            s.spin.rotation.y = calm ? 0.5 : spinA + s.phase;
        });
        if (!calm) {
            ring.rotation.z += dt * 0.6;
            ring2.rotation.z -= dt * 0.9;
        }
        const pulse = calm ? 1 : 0.85 + 0.15 * Math.sin(time * 1.6);
        ringMat.opacity = 0.5 * pulse;
        glowMat.opacity = 0.12 * pulse;
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
    }

    const mo = new MutationObserver(() => { if (shouldRun()) wake(); });
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-mode', 'class'] });
    const io = new IntersectionObserver((en) => { onScreen = en[en.length - 1].isIntersecting; wake(); });
    io.observe(stage);
    const onVis = () => wake();
    document.addEventListener('visibilitychange', onVis);

    renderInfo();
    resize();
    wake();

    function dispose() {
        disposed = true;
        cancelAnimationFrame(raf);
        raf = 0;
        ro.disconnect(); mo.disconnect(); io.disconnect();
        window.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onVis);
        for (const s of slots) { scene.remove(s.slot); s.rocket.dispose?.(); }
        for (const m of [ring, ring2, glow]) m.geometry.dispose();
        for (const m of [ringMat, ring2Mat, glowMat]) m.dispose();
        renderer.dispose();
        container.textContent = '';
        container.classList.remove('gallery', 'is-custom');
    }

    return { select, next, prev, refreshCustom, dispose };
}
