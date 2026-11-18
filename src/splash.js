import './splash.css';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const FONT_STACK = '"Orbitron", "Audiowide", "Rajdhani", system-ui, sans-serif';
const TAU = Math.PI * 2;

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Small deterministic PRNG so the logo looks identical every run. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Value noise + nebula (generated once at low res, then scaled up)    */
/* ------------------------------------------------------------------ */

const NOISE_N = 64;
let noiseTable = null;

function initNoise() {
  const rng = makeRng(1337);
  noiseTable = new Float32Array(NOISE_N * NOISE_N);
  for (let i = 0; i < noiseTable.length; i++) noiseTable[i] = rng();
}

function lattice(ix, iy) {
  return noiseTable[((iy & (NOISE_N - 1)) * NOISE_N) + (ix & (NOISE_N - 1))];
}

function valueNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = lattice(ix, iy);
  const b = lattice(ix + 1, iy);
  const c = lattice(ix, iy + 1);
  const d = lattice(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(x, y) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum / 0.9375;
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

let nebulaCanvas = null;

function getNebula() {
  if (nebulaCanvas) return nebulaCanvas;
  if (!noiseTable) initNoise();
  const R = 128;
  const c = document.createElement('canvas');
  c.width = R;
  c.height = R;
  const cx = c.getContext('2d');
  const img = cx.createImageData(R, R);
  const d = img.data;
  for (let py = 0; py < R; py++) {
    for (let px = 0; px < R; px++) {
      const u = px / R;
      const v = py / R;
      const n1 = fbm(u * 4.2, v * 4.2);
      const n2 = fbm(u * 3.1 + 11.7, v * 3.1 + 5.3);
      const n3 = fbm(u * 6.5 + 3.3, v * 6.5 + 20.1);
      // base deep indigo
      let r = 10;
      let g = 8;
      let b = 46;
      const purple = smooth(0.38, 0.8, n1);
      const blue = smooth(0.4, 0.82, n2);
      const mag = smooth(0.5, 0.85, n1) * smooth(0.4, 0.8, n3);
      const dust = smooth(0.55, 0.9, n3) * 0.5;
      r += 100 * purple + 20 * blue + 190 * mag * 0.7 + 90 * dust;
      g += 36 * purple + 70 * blue + 40 * mag * 0.7 + 60 * dust;
      b += 150 * purple + 190 * blue + 170 * mag * 0.7 + 150 * dust;
      // light bloom upper-left like the original badge
      const dx = u - 0.35;
      const dy = v - 0.3;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 1.6);
      r += 40 * glow;
      g += 28 * glow;
      b += 70 * glow;
      const i = (py * R + px) * 4;
      d[i] = r > 255 ? 255 : r;
      d[i + 1] = g > 255 ? 255 : g;
      d[i + 2] = b > 255 ? 255 : b;
      d[i + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
  nebulaCanvas = c;
  return c;
}

/* ------------------------------------------------------------------ */
/* Logo data                                                           */
/* ------------------------------------------------------------------ */

// Constellation points in unit coords (-1..1, y down), upper-middle landmass.
const CONST_PTS = [
  // outline of the brain/cloud (0-15)
  [-0.66, -0.20], [-0.55, -0.38], [-0.45, -0.58], [-0.22, -0.70], [0.04, -0.64],
  [0.26, -0.74], [0.48, -0.60], [0.64, -0.40], [0.72, -0.15], [0.56, 0.00],
  [0.34, -0.06], [0.16, 0.05], [0.00, 0.14], [-0.14, 0.04], [-0.32, 0.00],
  [-0.52, -0.05],
  // interior nodes (16-24)
  [-0.40, -0.30], [-0.20, -0.45], [0.02, -0.40], [0.24, -0.48], [0.46, -0.32],
  [-0.30, -0.12], [-0.06, -0.20], [0.20, -0.22], [0.42, -0.10],
];
const CONST_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10],
  [10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [15, 0],
  [1, 16], [2, 16], [2, 17], [3, 17], [16, 17], [3, 18], [4, 18], [17, 18], [4, 19],
  [5, 19], [18, 19], [6, 19], [6, 20], [7, 20], [19, 20], [0, 21], [16, 21], [15, 21],
  [17, 21], [17, 22], [18, 22], [21, 22], [14, 21], [13, 22], [22, 23], [18, 23],
  [19, 23], [19, 24], [20, 24], [23, 24], [8, 24], [9, 24], [10, 23], [11, 23], [12, 22],
];

const LOGO_STARS = (() => {
  const rng = makeRng(7);
  const out = [];
  for (let i = 0; i < 110; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * 0.93;
    out.push({
      x: Math.cos(a) * rr,
      y: Math.sin(a) * rr,
      s: i < 10 ? 1.4 + rng() * 0.8 : 0.35 + rng() * rng() * 1.1,
      ph: rng() * TAU,
      sp: 0.8 + rng() * 2.4,
      glint: i < 10,
      tint: rng(),
    });
  }
  return out;
})();

let glowSprite = null;
function getGlow() {
  if (glowSprite) return glowSprite;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.18, 'rgba(235,230,255,0.75)');
  gr.addColorStop(0.5, 'rgba(170,150,255,0.18)');
  gr.addColorStop(1, 'rgba(150,130,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  glowSprite = c;
  return c;
}

const TEXT_LINES = [
  { txt: 'ASTRONAUTICS', cy: 0.27, w: 1.7, weight: 800 },
  { txt: 'CLUB', cy: 0.46, w: 0.5, weight: 900 },
  { txt: 'IIIT HYDERABAD', cy: 0.63, w: 0.98, weight: 700 },
];

/* ------------------------------------------------------------------ */
/* Logo drawing                                                        */
/* ------------------------------------------------------------------ */

/* Real club logo image, preloaded once. Falls back to procedural art. */
let logoImg = null;
let logoReady = false;
function loadLogoImage() {
  if (logoImg || typeof Image === 'undefined') return;
  logoImg = new Image();
  logoImg.decoding = 'async';
  logoImg.onload = () => { logoReady = true; };
  logoImg.onerror = () => { logoReady = false; };
  logoImg.src = 'club-logo.webp';
}
let logoSmall = null;
let logoSmallReady = false;
if (typeof Image !== 'undefined') {
  logoSmall = new Image();
  logoSmall.onload = () => { logoSmallReady = true; };
  logoSmall.src = 'club-logo-192.webp';
}
loadLogoImage();

function drawImageLogo(canvas, t) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const cssW = canvas.clientWidth || canvas.width || 256;
  const cssH = canvas.clientHeight || canvas.height || cssW;
  const S = Math.max(8, Math.min(cssW, cssH));
  const px = Math.max(8, Math.round(S * dpr));
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(px / S, 0, 0, px / S, 0, 0);
  ctx.clearRect(0, 0, S, S);

  const cx = S / 2;
  const cy = S / 2;
  const breathe = 1 + 0.008 * Math.sin(t * 0.9);
  const R = (S / 2) * 0.94 * breathe; // leave room for the glow
  const glow = getGlow();

  // soft outer glow
  const gp = 0.55 + 0.25 * Math.sin(t * 0.7);
  const og = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, S / 2);
  og.addColorStop(0, `rgba(130,110,255,${0.35 * gp})`);
  og.addColorStop(1, 'rgba(90,70,220,0)');
  ctx.fillStyle = og;
  ctx.fillRect(0, 0, S, S);

  // image clipped to circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const src = S * dpr <= 220 && logoSmallReady ? logoSmall : logoImg;
  ctx.drawImage(src, cx - R, cy - R, R * 2, R * 2);

  // twinkling stars on top
  const small = S < 120;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < LOGO_STARS.length; i++) {
    const st = LOGO_STARS[i];
    if (small && !st.glint) continue;
    const tw = 0.5 + 0.5 * Math.sin(t * st.sp + st.ph);
    const sx = cx + st.x * R;
    const sy = cy + st.y * R;
    const size = Math.max(0.6, st.s * (S / 260) * (0.6 + 0.5 * tw));
    ctx.globalAlpha = (0.15 + 0.5 * tw) * (st.glint ? 1 : 0.6);
    ctx.drawImage(glow, sx - size * 2, sy - size * 2, size * 4, size * 4);
    if (st.glint) {
      const g = Math.pow(0.5 + 0.5 * Math.sin(t * st.sp * 0.8 + st.ph * 2), 3);
      const len = S * 0.04 * (0.4 + g * 1.3);
      const th = Math.max(0.5, S * 0.0024);
      ctx.globalAlpha = 0.2 + 0.7 * g;
      ctx.fillStyle = st.tint > 0.5 ? '#cfd6ff' : '#ffe6ff';
      ctx.fillRect(sx - len, sy - th / 2, len * 2, th);
      ctx.fillRect(sx - th / 2, sy - len, th, len * 2);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Draw one frame of the club logo (real image once loaded, else procedural).
 * @param {HTMLCanvasElement} canvas Target canvas.
 * @param {number} t Time in seconds.
 */
export function drawClubLogo(canvas, t) {
  if (logoReady && logoImg && logoImg.naturalWidth > 0) drawImageLogo(canvas, t);
  else drawProceduralLogo(canvas, t);
}

function drawProceduralLogo(canvas, t) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const cssW = canvas.clientWidth || canvas.width || 256;
  const cssH = canvas.clientHeight || canvas.height || cssW;
  const S = Math.max(8, Math.min(cssW, cssH));
  const px = Math.max(8, Math.round(S * dpr));
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(px / S, 0, 0, px / S, 0, 0);
  ctx.clearRect(0, 0, S, S);

  const R = S / 2;
  const cx = R;
  const cy = R;
  const inner = R * 0.94;
  const glow = getGlow();

  // --- nebula, clipped to inner disc, slowly drifting
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, TAU);
  ctx.clip();
  ctx.fillStyle = '#0a0830';
  ctx.fillRect(0, 0, S, S);
  const neb = getNebula();
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.025);
  const nz = S * 1.5;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(neb, -nz / 2 + Math.sin(t * 0.15) * S * 0.03, -nz / 2 + Math.cos(t * 0.12) * S * 0.03, nz, nz);
  ctx.restore();
  // pulse of light
  const pulse = 0.55 + 0.25 * Math.sin(t * 0.7);
  const rg = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, 0, cx - R * 0.25, cy - R * 0.3, R * 0.9);
  rg.addColorStop(0, `rgba(160,110,255,${0.28 * pulse})`);
  rg.addColorStop(1, 'rgba(60,40,160,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, S, S);

  // --- stars
  const small = S < 120;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < LOGO_STARS.length; i++) {
    const st = LOGO_STARS[i];
    if (small && !st.glint && i % 2) continue;
    const tw = 0.5 + 0.5 * Math.sin(t * st.sp + st.ph);
    const sx = cx + st.x * R;
    const sy = cy + st.y * R;
    const size = Math.max(0.6, st.s * (S / 260) * (0.7 + 0.5 * tw));
    ctx.globalAlpha = 0.35 + 0.65 * tw;
    ctx.drawImage(glow, sx - size * 2, sy - size * 2, size * 4, size * 4);
    if (st.glint) {
      const gp = Math.pow(0.5 + 0.5 * Math.sin(t * st.sp * 0.8 + st.ph * 2), 3);
      const len = S * 0.05 * (0.4 + gp * 1.4);
      const th = Math.max(0.5, S * 0.0028);
      ctx.globalAlpha = 0.25 + 0.75 * gp;
      ctx.fillStyle = st.tint > 0.5 ? '#cfd6ff' : '#ffe6ff';
      ctx.fillRect(sx - len, sy - th / 2, len * 2, th);
      ctx.fillRect(sx - th / 2, sy - len, th, len * 2);
    }
  }
  ctx.globalAlpha = 1;

  // --- constellation
  const lw = Math.max(0.6, S * 0.0048);
  ctx.lineCap = 'round';
  ctx.lineWidth = lw * 3;
  ctx.strokeStyle = 'rgba(150,130,255,0.22)';
  ctx.beginPath();
  for (let i = 0; i < CONST_EDGES.length; i++) {
    const a = CONST_PTS[CONST_EDGES[i][0]];
    const b = CONST_PTS[CONST_EDGES[i][1]];
    ctx.moveTo(cx + a[0] * R, cy + a[1] * R);
    ctx.lineTo(cx + b[0] * R, cy + b[1] * R);
  }
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  const dotR = Math.max(1.1, S * 0.011);
  for (let i = 0; i < CONST_PTS.length; i++) {
    const p = CONST_PTS[i];
    const tw = 0.75 + 0.25 * Math.sin(t * 1.6 + i * 1.7);
    const sx = cx + p[0] * R;
    const sy = cy + p[1] * R;
    const gr = dotR * 3.6 * tw;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(glow, sx - gr, sy - gr, gr * 2, gr * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < CONST_PTS.length; i++) {
    const p = CONST_PTS[i];
    ctx.beginPath();
    ctx.arc(cx + p[0] * R, cy + p[1] * R, dotR * 0.62, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  // --- ring: thick black band with thin white outline
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.arc(cx, cy, inner, 0, TAU, true);
  ctx.fillStyle = '#05030c';
  ctx.fill('evenodd');
  ctx.lineWidth = Math.max(1, S * 0.008);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.arc(cx, cy, R - ctx.lineWidth / 2, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = Math.max(0.6, S * 0.005);
  ctx.strokeStyle = 'rgba(150,130,255,0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, TAU);
  ctx.stroke();

  // --- text, fitted to target widths
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (let i = 0; i < TEXT_LINES.length; i++) {
    const L = TEXT_LINES[i];
    ctx.font = `${L.weight} 100px ${FONT_STACK}`;
    const m = ctx.measureText(L.txt).width || 1;
    const size = Math.min((L.w * R) / m * 100, R * 0.2);
    ctx.font = `${L.weight} ${size}px ${FONT_STACK}`;
    const ty = cy + L.cy * R;
    ctx.lineWidth = Math.max(1, size * 0.16);
    ctx.strokeStyle = 'rgba(8,4,30,0.95)';
    ctx.strokeText(L.txt, cx, ty);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(L.txt, cx, ty);
  }
}

/**
 * Start a requestAnimationFrame loop animating the logo on `canvas`.
 * Draws one static frame when the user prefers reduced motion.
 * @param {HTMLCanvasElement} canvas Target canvas.
 * @returns {() => void} stop function that cancels the loop.
 */
export function animateLogo(canvas) {
  if (reducedMotion()) {
    drawClubLogo(canvas, 2);
    let ro = null;
    const redraw = () => drawClubLogo(canvas, 2);
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(redraw);
      ro.observe(canvas);
    }
    // Redraw once fonts arrive so the text uses the real face.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(redraw);
    if (logoImg && !logoReady) logoImg.addEventListener('load', redraw);
    return () => { if (ro) ro.disconnect(); };
  }
  let raf = 0;
  let stopped = false;
  const t0 = performance.now();
  const frame = (now) => {
    if (stopped) return;
    drawClubLogo(canvas, (now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

/* ------------------------------------------------------------------ */
/* Starfield (full-screen, allocation-free per frame)                  */
/* ------------------------------------------------------------------ */

const MAX_STARS = 320;
const LAYER_COLORS = ['#8f9bff', '#cfd6ff', '#ffffff'];

function createStarfield(canvas) {
  const ctx = canvas.getContext('2d');
  const xs = new Float32Array(MAX_STARS);
  const ys = new Float32Array(MAX_STARS);
  const zs = new Float32Array(MAX_STARS);
  const ph = new Float32Array(MAX_STARS);
  const sp = new Float32Array(MAX_STARS);
  const layer = new Uint8Array(MAX_STARS);
  const glint = new Uint8Array(MAX_STARS);
  // shooting star pool
  const SH = 3;
  const shX = new Float32Array(SH);
  const shY = new Float32Array(SH);
  const shVX = new Float32Array(SH);
  const shVY = new Float32Array(SH);
  const shLife = new Float32Array(SH); // remaining seconds, <=0 inactive

  let W = 0;
  let H = 0;
  let count = 0;
  let raf = 0;
  let stopped = false;
  let last = 0;
  let time = 0;
  let nextShoot = 2;
  let warpStart = -1;
  const reduced = reducedMotion();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.min(MAX_STARS, Math.max(90, Math.round((W * H) / 6500)));
    for (let i = count; i < want; i++) {
      xs[i] = Math.random() * W;
      ys[i] = Math.random() * H;
      layer[i] = i % 3;
      zs[i] = 0.25 + layer[i] * 0.3 + Math.random() * 0.15;
      ph[i] = Math.random() * TAU;
      sp[i] = 0.6 + Math.random() * 2.2;
      glint[i] = Math.random() < 0.07 ? 1 : 0;
    }
    count = want;
    for (let i = 0; i < count; i++) {
      if (xs[i] > W) xs[i] = Math.random() * W;
      if (ys[i] > H) ys[i] = Math.random() * H;
    }
  }

  function spawnShooter() {
    for (let i = 0; i < SH; i++) {
      if (shLife[i] <= 0) {
        const ang = (0.15 + Math.random() * 0.35) * Math.PI;
        const speed = 520 + Math.random() * 380;
        shX[i] = Math.random() * W * 0.8;
        shY[i] = Math.random() * H * 0.4;
        shVX[i] = Math.cos(ang) * speed;
        shVY[i] = Math.sin(ang) * speed;
        shLife[i] = 0.7 + Math.random() * 0.5;
        return;
      }
    }
  }

  function draw(now) {
    if (stopped) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    time += dt;
    const cx = W * 0.5;
    const cy = H * 0.5;
    let w = 0;
    if (warpStart >= 0) {
      const k = Math.min(1, (now - warpStart) / 650);
      w = k * k;
    }

    ctx.clearRect(0, 0, W, H);

    // stars
    for (let L = 0; L < 3; L++) {
      ctx.fillStyle = LAYER_COLORS[L];
      ctx.strokeStyle = LAYER_COLORS[L];
      ctx.lineWidth = 0.6 + L * 0.5;
      for (let i = L; i < count; i += 3) {
        const z = zs[i];
        if (w > 0) {
          const dx = xs[i] - cx;
          const dy = ys[i] - cy;
          xs[i] += dx * dt * w * 7 * z;
          ys[i] += dy * dt * w * 7 * z;
          if (xs[i] < -20 || xs[i] > W + 20 || ys[i] < -20 || ys[i] > H + 20) {
            xs[i] = cx + (Math.random() - 0.5) * W * 0.3;
            ys[i] = cy + (Math.random() - 0.5) * H * 0.3;
          }
          const streak = w * 0.55 * z;
          ctx.globalAlpha = 0.3 + 0.7 * z;
          ctx.beginPath();
          ctx.moveTo(xs[i] - dx * streak, ys[i] - dy * streak);
          ctx.lineTo(xs[i], ys[i]);
          ctx.stroke();
          continue;
        }
        // slow weightless drift: nearer layers move faster
        xs[i] -= (3 + 16 * z) * dt;
        ys[i] += (1.2 + 6 * z) * dt;
        if (xs[i] < -4) xs[i] = W + 2;
        if (ys[i] > H + 4) ys[i] = -2;
        const tw = 0.5 + 0.5 * Math.sin(time * sp[i] + ph[i]);
        const size = 0.7 + z * 1.5;
        ctx.globalAlpha = (0.25 + 0.75 * z) * (0.45 + 0.55 * tw);
        ctx.fillRect(xs[i], ys[i], size, size);
        if (glint[i]) {
          const gp = tw * tw * tw;
          const len = 3 + 9 * gp * z * 1.6;
          ctx.globalAlpha = 0.2 + 0.7 * gp;
          ctx.fillRect(xs[i] - len, ys[i] + size * 0.5 - 0.4, len * 2 + size, 0.8);
          ctx.fillRect(xs[i] + size * 0.5 - 0.4, ys[i] - len, 0.8, len * 2 + size);
        }
      }
    }

    // shooting stars
    if (!reduced && w === 0) {
      nextShoot -= dt;
      if (nextShoot <= 0) {
        spawnShooter();
        nextShoot = 2.5 + Math.random() * 4.5;
      }
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    for (let i = 0; i < SH; i++) {
      if (shLife[i] <= 0) continue;
      shLife[i] -= dt;
      shX[i] += shVX[i] * dt;
      shY[i] += shVY[i] * dt;
      const fade = Math.min(1, shLife[i] * 2.5);
      const tx = shVX[i] * 0.07;
      const ty = shVY[i] * 0.07;
      for (let s = 0; s < 8; s++) {
        const a = s / 8;
        ctx.globalAlpha = fade * (1 - a) * 0.8;
        ctx.lineWidth = 1.8 * (1 - a * 0.6);
        ctx.beginPath();
        ctx.moveTo(shX[i] - tx * a, shY[i] - ty * a);
        ctx.lineTo(shX[i] - tx * (a + 0.125), shY[i] - ty * (a + 0.125));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    if (!reduced) raf = requestAnimationFrame(draw);
  }

  resize();
  const onResize = () => {
    resize();
    if (reduced) draw(performance.now());
  };
  window.addEventListener('resize', onResize);
  if (reduced) draw(performance.now());
  else raf = requestAnimationFrame(draw);

  return {
    warp() {
      if (!reduced) warpStart = performance.now();
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Splash screen                                                       */
/* ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Show the full-screen splash/loading screen.
 * `ready()` switches the loader to a "TAP TO BEGIN" / "PRESS ANY KEY" prompt.
 * `done` resolves after the user interacts and the exit animation finished;
 * the splash DOM is then removed and all animation loops are cancelled.
 * @returns {{setProgress: (fraction: number, label?: string) => void, ready: () => void, done: Promise<void>}}
 */
export function showSplash() {
  const reduced = reducedMotion();
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  const root = el('div', 'splash-root');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'KSP@ASTRO loading');

  const starCanvas = el('canvas', 'splash-stars');
  starCanvas.setAttribute('aria-hidden', 'true');
  const haze = el('div', 'splash-haze');
  haze.setAttribute('aria-hidden', 'true');

  const content = el('div', 'splash-content');
  const logo = el('div', 'splash-logo');
  const float = el('div', 'splash-logo-float');
  const halo = el('div', 'splash-logo-halo');
  const logoCanvas = el('canvas', 'splash-logo-canvas');
  logoCanvas.setAttribute('role', 'img');
  logoCanvas.setAttribute('aria-label', 'Astronautics Club, IIIT Hyderabad logo');
  float.append(halo, logoCanvas);
  logo.append(float);

  const title = el('h1', 'splash-title', 'KSP@ASTRO');
  const sub = el('p', 'splash-sub', 'Orbital mechanics sandbox · Astronautics Club, IIIT Hyderabad');

  const loader = el('div', 'splash-loader');
  const bar = el('div', 'splash-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  const fill = el('div', 'splash-bar-fill');
  bar.append(fill);
  const meta = el('div', 'splash-meta');
  const label = el('span', 'splash-label', 'Initialising');
  label.setAttribute('aria-live', 'polite');
  const pct = el('span', 'splash-pct', '0%');
  meta.append(label, pct);
  loader.append(bar, meta);

  const prompt = el('button', 'splash-prompt', coarse ? 'TAP TO BEGIN' : 'PRESS ANY KEY');
  prompt.type = 'button';
  prompt.hidden = true;

  content.append(logo, title, sub, loader, prompt);
  root.append(starCanvas, haze, content);
  document.body.appendChild(root);

  const stars = createStarfield(starCanvas);
  const stopLogo = animateLogo(logoCanvas);

  let isReady = false;
  let leaving = false;
  let cleaned = false;
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });
  const timers = [];

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    timers.forEach(clearTimeout);
    stars.stop();
    stopLogo();
    document.removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerup', onPointer);
    root.remove();
    resolveDone();
  }

  function leave() {
    if (!isReady || leaving) return;
    leaving = true;
    root.classList.add('splash-leaving');
    prompt.disabled = true;
    if (reduced) {
      root.classList.add('splash-fadeout');
      timers.push(setTimeout(cleanup, 340));
      return;
    }
    stars.warp();
    timers.push(setTimeout(() => root.classList.add('splash-fadeout'), 600));
    timers.push(setTimeout(cleanup, 1100));
  }

  function onKey(e) {
    if (!isReady) return;
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    e.preventDefault();
    e.stopPropagation();
    leave();
  }
  function onPointer() { leave(); }

  document.addEventListener('keydown', onKey, true);
  root.addEventListener('pointerup', onPointer);
  prompt.addEventListener('click', leave);

  return {
    /**
     * Update the progress bar.
     * @param {number} fraction 0..1
     * @param {string} [text] status label
     */
    setProgress(fraction, text) {
      if (cleaned) return;
      const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
      fill.style.transform = `scaleX(${f})`;
      const p = Math.round(f * 100);
      pct.textContent = `${p}%`;
      bar.setAttribute('aria-valuenow', String(p));
      if (text != null) label.textContent = text;
    },
    /** Switch to the "tap to begin" prompt and focus it. */
    ready() {
      if (cleaned || isReady) return;
      isReady = true;
      fill.style.transform = 'scaleX(1)';
      pct.textContent = '100%';
      bar.setAttribute('aria-valuenow', '100');
      loader.classList.add('splash-loader-hidden');
      prompt.hidden = false;
      prompt.focus({ preventScroll: true });
    },
    done,
  };
}
