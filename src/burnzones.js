// Optimal burn zones drawn on the current orbit:
//   - circularize: around apoapsis (prograde raises periapsis) and periapsis
//     (retrograde lowers apoapsis), while the orbit is noticeably eccentric;
//   - TLI window: the departure point for a Hohmann transfer that meets the
//     Moon, with the time until the craft reaches it.
import * as THREE from 'three';
import { params, bodies, r, v, EARTH_MOON_R, moonAngularRate, dominantBody } from './maneuver.js';
import { orbitalElements, fmtDuration } from './orbit.js';

const SEG = 40;
const TAU = Math.PI * 2;
const CIRC_HALF = (16 * Math.PI) / 180;   // half-width of the Ap/Pe zones
const TLI_HALF = (9 * Math.PI) / 180;
const MIN_ECC = 0.01;

function wrap(a) {
    a %= TAU;
    return a < 0 ? a + TAU : a;
}

function makeArc(color) {
    // A ribbon (triangle strip) along the orbit, so the zone reads as a band.
    const n = SEG + 1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const alpha = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        const t = i / SEG;
        const a = Math.sin(Math.PI * t) ** 0.6;        // fade at both ends
        alpha[i * 2] = a; alpha[i * 2 + 1] = a;
    }
    geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    const idx = [];
    for (let i = 0; i < SEG; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 } },
        vertexShader: `attribute float alpha; varying float vA; varying float vS;
            void main(){ vA = alpha; vS = float(gl_VertexID % 2); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uTime; varying float vA; varying float vS;
            void main(){ float edge = 1.0 - abs(vS * 2.0 - 1.0); float pulse = 0.75 + 0.25 * sin(uTime * 3.0);
              gl_FragColor = vec4(uColor, vA * (0.35 + 0.45 * edge) * pulse); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    const group = new THREE.Group();
    group.add(mesh);
    group.visible = false;
    return { group, geo, mats: [mat] };
}

/** Fill a band on the osculating ellipse (focus at cx,cy) centred on angle c. */
function fillArc(arc, cx, cy, p, e, peAngle, c, half, width) {
    const arr = arc.geo.attributes.position.array;
    for (let i = 0; i <= SEG; i++) {
        const th = c - half + (2 * half * i) / SEG;
        const rr = p / (1 + e * Math.cos(th - peAngle));
        const co = Math.cos(th), si = Math.sin(th);
        const r0 = rr - width, r1 = rr + width;
        arr[i * 6] = r0 * co; arr[i * 6 + 1] = r0 * si; arr[i * 6 + 2] = 0.002;
        arr[i * 6 + 3] = r1 * co; arr[i * 6 + 4] = r1 * si; arr[i * 6 + 5] = 0.002;
    }
    arc.geo.attributes.position.needsUpdate = true;
    arc.group.position.set(cx, cy, 0);
    arc.group.visible = true;
}

export function createBurnZones(scene) {
    const root = new THREE.Group();
    scene.add(root);
    const ap = makeArc(0x4dff9a);
    const pe = makeArc(0xffb347);
    const tli = makeArc(0xd36bff);
    root.add(ap.group, pe.group, tli.group);
    const markers = [];
    let visible = true;
    let zone = '';
    let width = 0.03;
    let time = 0;

    function hideAll() {
        ap.group.visible = pe.group.visible = tli.group.visible = false;
        markers.length = 0;
        zone = '';
    }

    function update() {
        hideAll();
        if (!visible) return;
        const dom = dominantBody(r);
        const cx = dom.pos.x, cy = dom.pos.y;
        const rx = r.x - cx, ry = r.y - cy;
        const el = orbitalElements(rx, ry, v.x - dom.vel.x, v.y - dom.vel.y, dom.mu);
        if (!el.bound || !Number.isFinite(el.a) || el.rp < dom.radius) return;   // no full orbit to mark
        const p = (el.h * el.h) / dom.mu;
        const here = wrap(Math.atan2(ry, rx));
        const near = (c, half) => Math.abs((((here - c + Math.PI) % TAU) + TAU) % TAU - Math.PI) <= half;

        if (el.e > MIN_ECC) {
            const apA = el.peAngle + Math.PI;
            fillArc(ap, cx, cy, p, el.e, el.peAngle, apA, CIRC_HALF, width);
            fillArc(pe, cx, cy, p, el.e, el.peAngle, el.peAngle, CIRC_HALF, width);
            markers.push({
                id: 'burn-ap', x: cx + el.ra * Math.cos(apA), y: cy + el.ra * Math.sin(apA),
                label: `BURN ▲ PROGRADE · in ${fmtDuration(el.timeToAp)}`,
            });
            markers.push({
                id: 'burn-pe', x: cx + el.rp * Math.cos(el.peAngle), y: cy + el.rp * Math.sin(el.peAngle),
                label: `BURN ▼ RETRO · in ${fmtDuration(el.timeToPe)}`,
            });
            if (near(apA, CIRC_HALF)) zone = 'AP ZONE · BURN PROGRADE TO CIRCULARIZE';
            else if (near(el.peAngle, CIRC_HALF)) zone = 'PE ZONE · BURN RETRO TO CIRCULARIZE';
        }

        // Lunar transfer window from a low, near-circular Earth orbit.
        if (dom.name === 'earth' && el.ra < EARTH_MOON_R * 0.5 && el.e < 0.2 && bodies.moon.m > 0) {
            const mu = dom.mu;
            const aT = (el.a + EARTH_MOON_R) / 2;
            const tT = Math.PI * Math.sqrt((aT * aT * aT) / mu);
            const w = moonAngularRate();
            const thM = Math.atan2(bodies.moon.pos.y - cy, bodies.moon.pos.x - cx);
            // Depart half a revolution before the point where the Moon will be on arrival.
            const dep = wrap(thM + w * tT + Math.PI);
            fillArc(tli, cx, cy, p, el.e, el.peAngle, dep, TLI_HALF, width);
            const n = (el.h < 0 ? -1 : 1) * Math.sqrt(mu / (el.a * el.a * el.a));
            const rel = n - w;                          // rate the craft closes on the moving window
            const gap = rel < 0 ? wrap(here - dep) : wrap(dep - here);
            const wait = Math.abs(rel) > 1e-9 ? gap / Math.abs(rel) : Infinity;
            const rd = p / (1 + el.e * Math.cos(dep - el.peAngle));
            markers.push({
                id: 'burn-tli', x: cx + rd * Math.cos(dep), y: cy + rd * Math.sin(dep),
                label: `TLI WINDOW · in ${fmtDuration(wait)}`,
            });
            if (near(dep, TLI_HALF)) zone = 'TLI WINDOW · BURN PROGRADE FOR THE MOON';
        }
    }

    return {
        update,
        /** Band half-width in world units (scale with the camera distance). */
        setWidth(w) { width = w; },
        /** Advance the pulse animation (real seconds). */
        tick(dt) { time += dt; for (const a of [ap, pe, tli]) a.mats[0].uniforms.uTime.value = time; },
        setVisible(b) { visible = b; if (!b) hideAll(); },
        getMarkers() { return markers; },
        /** Text when the craft is inside a zone, else ''. */
        inZone() { return zone; },
        clear: hideAll,
        dispose() {
            for (const a of [ap, pe, tli]) { a.geo.dispose(); a.mats.forEach((m) => m.dispose()); }
            scene.remove(root);
        },
    };
}
