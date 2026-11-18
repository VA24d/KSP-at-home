import * as THREE from 'three';

/**
 * Metadata and physical flight parameters for orbital gameplay.
 * The physics values represent in-space stage parameters in game units.
 */
export const ROCKETS = {
  saturn5: {
    id: 'saturn5',
    name: 'Saturn V',
    subtitle: 'Apollo · NASA',
    firstFlight: 1967,
    height_m: 110.6,
    liftoffThrust_kN: 35100,
    payloadLEO_t: 140,
    stages: 3,
    // flight (in-space stage) parameters used by the physics, in game units — use EXACTLY these:
    physics: { Isp: 421, dryMass: 2, fuelMass: 30, thrust: 1.5 }
  },
  sls: {
    id: 'sls',
    name: 'SLS Block 1',
    subtitle: 'Artemis · NASA',
    firstFlight: 2022,
    height_m: 98,
    liftoffThrust_kN: 39100,
    payloadLEO_t: 95,
    stages: 2,
    physics: { Isp: 462, dryMass: 2, fuelMass: 24, thrust: 0.8 }
  },
  starship: {
    id: 'starship',
    name: 'Starship',
    subtitle: 'Super Heavy · SpaceX',
    firstFlight: 2023,
    height_m: 121,
    liftoffThrust_kN: 74400,
    payloadLEO_t: 150,
    stages: 2,
    physics: { Isp: 380, dryMass: 2, fuelMass: 34, thrust: 4 }
  },
  // Player-tuned rocket: the sliders define its physics, these are display defaults only.
  custom: {
    id: 'custom',
    name: 'Custom',
    subtitle: 'Your own design',
    firstFlight: '\u2014',
    height_m: 60,
    liftoffThrust_kN: 9807,
    payloadLEO_t: 24,
    stages: 2,
    physics: { Isp: 450, dryMass: 2, fuelMass: 24, thrust: 1 }
  }
};

/**
 * Helper to create a procedural canvas texture or fallback DataTexture in headless environments.
 * @param {number} width
 * @param {number} height
 * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} drawFn
 * @param {{ textures: THREE.Texture[] }} tracker
 * @returns {THREE.Texture}
 */
function createProceduralTexture(width, height, drawFn, tracker) {
  if (typeof document === 'undefined') {
    const fallback = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    fallback.needsUpdate = true;
    tracker.textures.push(fallback);
    return fallback;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    drawFn(ctx, width, height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  tracker.textures.push(texture);
  return texture;
}

/**
 * Track a material for cleanup.
 * @param {THREE.Material} mat
 * @param {{ materials: THREE.Material[] }} tracker
 * @returns {THREE.Material}
 */
function trackMaterial(mat, tracker) {
  tracker.materials.push(mat);
  return mat;
}

/**
 * Helper to build a lathe mesh aligned with the +X long axis.
 * Lathe points: array of [x, radius].
 * @param {Array<[number, number]>} points
 * @param {number} radialSegments
 * @param {THREE.Material} material
 * @param {{ geometries: THREE.BufferGeometry[] }} tracker
 * @param {{ minX?: number, maxX?: number }} [uvOpts]
 * @returns {THREE.Mesh}
 */
function createLatheMesh(points, radialSegments, material, tracker, uvOpts) {
  const v2Points = points.map(p => new THREE.Vector2(Math.max(0, p[1]), p[0]));
  const geom = new THREE.LatheGeometry(v2Points, radialSegments);
  geom.rotateZ(-Math.PI / 2);

  if (uvOpts && uvOpts.minX !== undefined && uvOpts.maxX !== undefined) {
    const pos = geom.attributes.position;
    const uv = geom.attributes.uv;
    const range = uvOpts.maxX - uvOpts.minX || 1;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      uv.setY(i, (x - uvOpts.minX) / range);
    }
    uv.needsUpdate = true;
  }

  geom.computeVertexNormals();
  tracker.geometries.push(geom);

  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Helper to create an open bell nozzle geometry with realistic expansion curve.
 * Exhaust leaves along -X (nozzle expands toward -X).
 * @param {number} xExit - Aftmost nozzle exit coordinate along X
 * @param {number} xThroat - Forward throat coordinate along X
 * @param {number} rExit - Exit bell radius
 * @param {number} rThroat - Throat radius
 * @param {number} segments - Radial segments
 * @param {THREE.Material} material - DoubleSide material
 * @param {{ geometries: THREE.BufferGeometry[] }} tracker
 * @returns {THREE.Mesh}
 */
function createNozzleMesh(xExit, xThroat, rExit, rThroat, segments, material, tracker) {
  const bellSteps = 6;
  const points = [
    [xThroat + 0.004, 0.0],
    [xThroat, rThroat]
  ];
  for (let i = 1; i <= bellSteps; i++) {
    const t = i / bellSteps;
    const x = xThroat - t * (xThroat - xExit);
    const r = rThroat + (rExit - rThroat) * Math.pow(t, 0.65);
    points.push([x, r]);
  }
  return createLatheMesh(points, segments, material, tracker);
}

/**
 * Create and add an engine nozzle exit anchor.
 * @param {THREE.Group} parent
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {THREE.Object3D}
 */
function createEngineAnchor(parent, x, y, z) {
  const anchor = new THREE.Object3D();
  anchor.position.set(x, y, z);
  parent.add(anchor);
  return anchor;
}

/**
 * Create and add an RCS cold-gas thruster anchor on the hull.
 * @param {THREE.Group} spacecraft
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} dirY
 * @returns {THREE.Object3D}
 */
function createRcsAnchor(spacecraft, x, y, z, dirY) {
  const anchor = new THREE.Object3D();
  anchor.position.set(x, y, z);
  anchor.userData.dir = new THREE.Vector3(0, dirY > 0 ? 1 : -1, 0);
  spacecraft.add(anchor);
  return anchor;
}

/**
 * Build Saturn V (Apollo) model.
 * Total length = exactly 2.0 units [-1.000, +1.000].
 */
function buildSaturn5Model(tracker) {
  const root = new THREE.Group();
  const stage1 = new THREE.Group();
  const stage2 = new THREE.Group();
  const spacecraft = new THREE.Group();
  const escapeTower = new THREE.Group();

  root.add(stage1);
  root.add(stage2);
  root.add(spacecraft);
  root.add(escapeTower);

  // Procedural Textures
  const saturnTex = createProceduralTexture(1024, 512, (ctx, w, h) => {
    ctx.fillStyle = '#f6f7f9';
    ctx.fillRect(0, 0, w, h);

    // Roll pattern on bottom of S-IC: 4 alternating black quadrants
    const numQuadrants = 8;
    const qw = w / numQuadrants;
    ctx.fillStyle = '#0f1115';
    for (let i = 0; i < numQuadrants; i += 2) {
      ctx.fillRect(i * qw, h * 0.45, qw, h * 0.55);
    }

    // Top black band on S-IC
    ctx.fillRect(0, h * 0.08, w, h * 0.08);

    // Vertical "USA" lettering and American flag on white quadrants
    for (let i = 1; i < numQuadrants; i += 2) {
      const cx = (i + 0.5) * qw;

      // "USA" in bold black
      ctx.fillStyle = '#0f1115';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('U', cx, h * 0.58);
      ctx.fillText('S', cx, h * 0.69);
      ctx.fillText('A', cx, h * 0.80);

      // American Flag badge
      const fw = 32;
      const fh = 18;
      const fx = cx - fw / 2;
      const fy = h * 0.84;
      ctx.fillStyle = '#b32228';
      ctx.fillRect(fx, fy, fw, fh);
      for (let s = 1; s < 7; s += 2) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(fx, fy + (s * fh) / 7, fw, fh / 7);
      }
      ctx.fillStyle = '#1e3888';
      ctx.fillRect(fx, fy, fw * 0.42, (fh * 4) / 7);
    }
  }, tracker);

  const interstageTex = createProceduralTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f0f2f5';
    ctx.fillRect(0, 0, w, h);
    // Corrugated ring bands
    for (let y = 0; y < h; y += 8) {
      ctx.fillStyle = y % 16 === 0 ? '#32363e' : '#22252a';
      ctx.fillRect(0, y, w, 2);
    }
  }, tracker);

  const csmTex = createProceduralTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#c8ced6';
    ctx.fillRect(0, 0, w, h);
    // White radiator panels
    ctx.fillStyle = '#f4f6fa';
    ctx.fillRect(w * 0.08, h * 0.18, w * 0.36, h * 0.64);
    ctx.fillRect(w * 0.54, h * 0.18, w * 0.36, h * 0.64);
    // Dark umbilical connection and panel seams
    ctx.fillStyle = '#22252a';
    ctx.fillRect(0, h * 0.08, w, 4);
    ctx.fillRect(0, h * 0.92, w, 4);
    ctx.fillRect(w * 0.47, h * 0.32, 18, 26);
  }, tracker);

  // Materials
  const whiteMat = trackMaterial(new THREE.MeshStandardMaterial({
    map: saturnTex,
    metalness: 0.12,
    roughness: 0.45
  }), tracker);

  const interstageMat = trackMaterial(new THREE.MeshStandardMaterial({
    map: interstageTex,
    metalness: 0.25,
    roughness: 0.55
  }), tracker);

  const csmMat = trackMaterial(new THREE.MeshStandardMaterial({
    map: csmTex,
    metalness: 0.78,
    roughness: 0.28
  }), tracker);

  const cmMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0xdedfe5,
    metalness: 0.42,
    roughness: 0.36
  }), tracker);

  const towerMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0xd43825,
    metalness: 0.2,
    roughness: 0.45
  }), tracker);

  const engineMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0x222428,
    metalness: 0.88,
    roughness: 0.4,
    side: THREE.DoubleSide
  }), tracker);

  const darkBaseMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0x181a1d,
    metalness: 0.6,
    roughness: 0.5
  }), tracker);

  const rS1 = 0.0913; // S-IC & S-II radius (10.1m diameter)
  const rS4 = 0.0597; // S-IVB radius (6.6m diameter)
  const rCSM = 0.0353; // CSM radius (3.9m diameter)

  // ----------------------------------------------------
  // Stage 1: S-IC (x: -1.000 to -0.240)
  // ----------------------------------------------------
  // Main tank
  const s1Body = createLatheMesh([
    [-0.940, rS1],
    [-0.240, rS1]
  ], 28, whiteMat, tracker, { minX: -0.940, maxX: -0.240 });
  stage1.add(s1Body);

  // S-IC base heat shield plate
  const s1Base = createLatheMesh([
    [-0.940, 0.0],
    [-0.940, rS1]
  ], 28, darkBaseMat, tracker);
  stage1.add(s1Base);

  // 4 Outer engine fairing pods & fins (+Y, -Y, +Z, -Z)
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);

    // Fairing pod
    const fairing = createLatheMesh([
      [-0.940, 0.024],
      [-0.880, 0.026],
      [-0.820, 0.012],
      [-0.780, 0.0]
    ], 12, whiteMat, tracker);
    fairing.position.set(0, rS1 * 0.9 * ca, rS1 * 0.9 * sa);
    stage1.add(fairing);

    // Aero fin extending out to radius ~0.166
    const finGeom = new THREE.BoxGeometry(0.12, 0.075, 0.005);
    tracker.geometries.push(finGeom);
    const finMesh = new THREE.Mesh(finGeom, whiteMat);
    finMesh.castShadow = false;
    finMesh.receiveShadow = false;
    finMesh.position.set(-0.880, (rS1 + 0.037) * ca, (rS1 + 0.037) * sa);
    finMesh.rotation.x = angle;
    stage1.add(finMesh);
  }

  // 5 F-1 Engine Nozzles (Quincunx: 1 center + 4 outer)
  const f1Positions = [
    [0, 0],
    [0.046, 0],
    [-0.046, 0],
    [0, 0.046],
    [0, -0.046]
  ];
  const f1Anchors = [];
  for (const [fy, fz] of f1Positions) {
    const nozzle = createNozzleMesh(-1.000, -0.940, 0.034, 0.010, 18, engineMat, tracker);
    nozzle.position.set(0, fy, fz);
    stage1.add(nozzle);

    const anchor = createEngineAnchor(stage1, -1.000, fy, fz);
    f1Anchors.push(anchor);
  }
  stage1.userData.engines = f1Anchors;
  stage1.userData.engineCount = 5;
  stage1.userData.nozzleRadius = 0.034;

  // ----------------------------------------------------
  // Stage 2: S-II + Interstage (x: -0.240 to +0.220)
  // ----------------------------------------------------
  // S-II Interstage (corrugated skirt)
  const s2Interstage = createLatheMesh([
    [-0.240, rS1],
    [-0.140, rS1]
  ], 28, interstageMat, tracker);
  stage2.add(s2Interstage);

  // S-II Main Tank
  const s2Body = createLatheMesh([
    [-0.140, rS1],
    [0.220, rS1]
  ], 28, whiteMat, tracker);
  stage2.add(s2Body);

  // S-II 5 J-2 Engines inside interstage
  const j2PositionsS2 = [
    [0, 0],
    [0.030, 0],
    [-0.030, 0],
    [0, 0.030],
    [0, -0.030]
  ];
  const s2Anchors = [];
  for (const [jy, jz] of j2PositionsS2) {
    const nozzle = createNozzleMesh(-0.210, -0.175, 0.018, 0.006, 14, engineMat, tracker);
    nozzle.position.set(0, jy, jz);
    stage2.add(nozzle);

    const anchor = createEngineAnchor(stage2, -0.210, jy, jz);
    s2Anchors.push(anchor);
  }
  stage2.userData.engines = s2Anchors;
  stage2.userData.engineCount = 5;
  stage2.userData.nozzleRadius = 0.018;

  // ----------------------------------------------------
  // Spacecraft: S-IVB + IU + SLA + CSM (x: +0.220 to +0.865)
  // ----------------------------------------------------
  // S-IVB conical interstage adapter
  const s4Interstage = createLatheMesh([
    [0.220, rS1],
    [0.270, rS4]
  ], 28, interstageMat, tracker);
  spacecraft.add(s4Interstage);

  // S-IVB single J-2 Engine
  const s4J2 = createNozzleMesh(0.170, 0.215, 0.018, 0.006, 16, engineMat, tracker);
  spacecraft.add(s4J2);
  const s4J2Anchor = createEngineAnchor(spacecraft, 0.170, 0, 0);

  // S-IVB Main Tank
  const s4Body = createLatheMesh([
    [0.270, rS4],
    [0.540, rS4]
  ], 28, whiteMat, tracker);
  spacecraft.add(s4Body);

  // Instrument Unit (IU)
  const iu = createLatheMesh([
    [0.540, rS4],
    [0.560, rS4]
  ], 28, interstageMat, tracker);
  spacecraft.add(iu);

  // Spacecraft-to-LM Adapter (SLA) taper
  const sla = createLatheMesh([
    [0.560, rS4],
    [0.700, rCSM]
  ], 28, whiteMat, tracker);
  spacecraft.add(sla);

  // Apollo Service Module (SM)
  const sm = createLatheMesh([
    [0.700, rCSM],
    [0.815, rCSM]
  ], 28, csmMat, tracker, { minX: 0.700, maxX: 0.815 });
  spacecraft.add(sm);

  // Apollo Command Module (CM) cone
  const cm = createLatheMesh([
    [0.815, rCSM],
    [0.825, 0.030],
    [0.850, 0.017],
    [0.865, 0.009]
  ], 28, cmMat, tracker);
  spacecraft.add(cm);

  // Spacecraft engines: S-IVB J-2 first
  spacecraft.userData.engines = [s4J2Anchor];
  spacecraft.userData.engineCount = 1;
  spacecraft.userData.nozzleRadius = 0.018;

  // RCS cold-gas thrusters near nose
  spacecraft.userData.rcs = [
    createRcsAnchor(spacecraft, 0.840, 0.022, 0.008, 1),
    createRcsAnchor(spacecraft, 0.840, 0.022, -0.008, 1),
    createRcsAnchor(spacecraft, 0.840, -0.022, 0.008, -1),
    createRcsAnchor(spacecraft, 0.840, -0.022, -0.008, -1)
  ];

  // ----------------------------------------------------
  // Escape Tower: Apollo LES (x: +0.865 to +1.000)
  // Direct child of root.
  // ----------------------------------------------------
  // 4 Lattice truss legs
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2 + Math.PI / 4;
    const leg = createLatheMesh([
      [0.865, 0.009],
      [0.930, 0.0065]
    ], 6, towerMat, tracker);
    leg.position.set(0, Math.cos(angle) * 0.002, Math.sin(angle) * 0.002);
    escapeTower.add(leg);
  }

  // Escape Rocket Motor + Jettison Motor + Nose Spike (reaching exactly x = +1.000)
  const lesTower = createLatheMesh([
    [0.930, 0.0065],
    [0.970, 0.0065],
    [0.975, 0.0050],
    [0.985, 0.0050],
    [0.990, 0.0025],
    [1.000, 0.0002]
  ], 16, towerMat, tracker);
  escapeTower.add(lesTower);

  // 4 Canted escape nozzles
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const nozzle = createNozzleMesh(0.925, 0.935, 0.0035, 0.001, 8, engineMat, tracker);
    nozzle.position.set(0, Math.cos(angle) * 0.007, Math.sin(angle) * 0.007);
    escapeTower.add(nozzle);
  }

  return { root, stage1, stage2, spacecraft, escapeTower };
}

/**
 * Build SLS Block 1 (Artemis I with Orion) model.
 * Total length = exactly 2.0 units [-1.000, +1.000].
 */
function buildSlsModel(tracker) {
  const root = new THREE.Group();
  const stage1 = new THREE.Group();
  const stage2 = new THREE.Group();
  const spacecraft = new THREE.Group();
  const escapeTower = new THREE.Group();

  root.add(stage1);
  root.add(stage2);
  root.add(spacecraft);
  root.add(escapeTower);

  // Procedural Textures
  const foamTex = createProceduralTexture(512, 512, (ctx, w, h) => {
    // Burnt orange base gradient
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#be5f23');
    grad.addColorStop(0.5, '#b0541a');
    grad.addColorStop(1, '#c56829');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Circumferential foam spray pass bands
    for (let y = 0; y < h; y += 14) {
      ctx.fillStyle = y % 28 === 0 ? 'rgba(215, 120, 50, 0.16)' : 'rgba(120, 45, 10, 0.14)';
      ctx.fillRect(0, y, w, 7);
    }

    // Intertank vertical stringer corrugated lines in the middle section
    ctx.fillStyle = '#8e380a';
    for (let x = 0; x < w; x += 8) {
      ctx.fillRect(x, h * 0.35, 2, h * 0.25);
    }

    // White NASA worm logo on forward LOX tank
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('NASA', w * 0.25, h * 0.16);
    ctx.fillText('NASA', w * 0.75, h * 0.16);
  }, tracker);

  const srbTex = createProceduralTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f0f3f6';
    ctx.fillRect(0, 0, w, h);

    // 4 Joint bands dividing 5 solid rocket motor segments
    ctx.fillStyle = '#22252a';
    const jointY = [h * 0.2, h * 0.4, h * 0.6, h * 0.8];
    for (const y of jointY) {
      ctx.fillRect(0, y - 3, w, 6);
    }

    // Red NASA worm logo
    ctx.fillStyle = '#df1c24';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('NASA', w * 0.3, h * 0.12);
    ctx.fillText('NASA', w * 0.8, h * 0.12);
  }, tracker);

  // Materials
  const foamMat = trackMaterial(new THREE.MeshStandardMaterial({
    map: foamTex,
    metalness: 0.08,
    roughness: 0.72
  }), tracker);

  const srbMat = trackMaterial(new THREE.MeshStandardMaterial({
    map: srbTex,
    metalness: 0.15,
    roughness: 0.45
  }), tracker);

  const whiteMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0xf2f4f8,
    metalness: 0.18,
    roughness: 0.42
  }), tracker);

  const engineMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0x26292f,
    metalness: 0.86,
    roughness: 0.42,
    side: THREE.DoubleSide
  }), tracker);

  const darkMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0x1d2024,
    metalness: 0.6,
    roughness: 0.55
  }), tracker);

  const rCore = 0.0857;  // 8.4m core diameter
  const rSrb = 0.0378;   // 3.7m SRB diameter
  const ySrb = 0.122;    // SRB offset along Y (profile view)
  const rIcps = 0.0520;  // 5.1m diameter
  const rOrion = 0.0510; // 5.0m diameter

  // ----------------------------------------------------
  // Stage 2: Orange Core Stage (x: -1.000 to +0.306)
  // ----------------------------------------------------
  // Core boat-tail
  const coreBoat = createLatheMesh([
    [-0.955, 0.076],
    [-0.850, rCore]
  ], 28, darkMat, tracker);
  stage2.add(coreBoat);

  // Core baseplate
  const coreBase = createLatheMesh([
    [-0.955, 0.0],
    [-0.955, 0.076]
  ], 28, darkMat, tracker);
  stage2.add(coreBase);

  // Main foam tank
  const coreBody = createLatheMesh([
    [-0.850, rCore],
    [0.306, rCore]
  ], 28, foamMat, tracker, { minX: -0.850, maxX: 0.306 });
  stage2.add(coreBody);

  // System tunnel conduits (+Y and -Y ridges)
  for (const s of [1, -1]) {
    const conduitGeom = new THREE.BoxGeometry(1.15, 0.006, 0.008);
    tracker.geometries.push(conduitGeom);
    const conduit = new THREE.Mesh(conduitGeom, whiteMat);
    conduit.castShadow = false;
    conduit.receiveShadow = false;
    conduit.position.set(-0.270, (rCore + 0.002) * s, 0);
    stage2.add(conduit);
  }

  // 4 RS-25 Core Engines
  const rsPositions = [
    [0.026, 0.026],
    [0.026, -0.026],
    [-0.026, 0.026],
    [-0.026, -0.026]
  ];
  const rsAnchors = [];
  for (const [ry, rz] of rsPositions) {
    const nozzle = createNozzleMesh(-1.000, -0.955, 0.016, 0.005, 16, engineMat, tracker);
    nozzle.position.set(0, ry, rz);
    stage2.add(nozzle);

    const anchor = createEngineAnchor(stage2, -1.000, ry, rz);
    rsAnchors.push(anchor);
  }
  stage2.userData.engines = rsAnchors;
  stage2.userData.engineCount = 4;
  stage2.userData.nozzleRadius = 0.016;

  // ----------------------------------------------------
  // Stage 1: Two SRBs (x: -0.960 to +0.140)
  // ----------------------------------------------------
  const srbAnchors = [];
  for (const s of [1, -1]) {
    const curY = ySrb * s;
    const srbGroup = new THREE.Group();
    srbGroup.position.set(0, curY, 0);

    // Aft skirt flare + 5 segments + forward ogive
    const srbBody = createLatheMesh([
      [-0.920, 0.040],
      [-0.860, rSrb],
      [0.070, rSrb],
      [0.100, rSrb * 0.95],
      [0.125, rSrb * 0.60],
      [0.140, 0.0]
    ], 24, srbMat, tracker, { minX: -0.860, maxX: 0.070 });
    srbGroup.add(srbBody);

    // SRB Engine Nozzle
    const srbNozzle = createNozzleMesh(-0.960, -0.920, 0.024, 0.008, 16, engineMat, tracker);
    srbGroup.add(srbNozzle);

    stage1.add(srbGroup);

    // Engine anchor placed in stage1 local frame
    const anchor = createEngineAnchor(stage1, -0.960, curY, 0);
    srbAnchors.push(anchor);

    // Forward attach strut to core stage
    const fStrutGeom = new THREE.BoxGeometry(0.025, Math.abs(curY) - rCore, 0.010);
    tracker.geometries.push(fStrutGeom);
    const forwardStrut = new THREE.Mesh(fStrutGeom, darkMat);
    forwardStrut.castShadow = false;
    forwardStrut.receiveShadow = false;
    forwardStrut.position.set(0.060, (rCore + (Math.abs(curY) - rCore) * 0.5) * s, 0);
    stage1.add(forwardStrut);

    // Aft attach strut to core stage
    const aStrutGeom = new THREE.BoxGeometry(0.045, Math.abs(curY) - rCore, 0.012);
    tracker.geometries.push(aStrutGeom);
    const aftStrut = new THREE.Mesh(aStrutGeom, darkMat);
    aftStrut.castShadow = false;
    aftStrut.receiveShadow = false;
    aftStrut.position.set(-0.820, (rCore + (Math.abs(curY) - rCore) * 0.5) * s, 0);
    stage1.add(aftStrut);
  }
  stage1.userData.engines = srbAnchors;
  stage1.userData.engineCount = 2;
  stage1.userData.nozzleRadius = 0.024;

  // ----------------------------------------------------
  // Spacecraft: LVSA + ICPS + Orion Stack (x: +0.306 to +0.720)
  // ----------------------------------------------------
  // LVSA Conical Adapter
  const lvsa = createLatheMesh([
    [0.306, rCore],
    [0.450, rIcps]
  ], 28, whiteMat, tracker);
  spacecraft.add(lvsa);

  // RL10 Engine inside LVSA
  const rl10 = createNozzleMesh(0.440, 0.485, 0.015, 0.004, 16, engineMat, tracker);
  spacecraft.add(rl10);
  const rl10Anchor = createEngineAnchor(spacecraft, 0.440, 0, 0);

  // ICPS Tank
  const icps = createLatheMesh([
    [0.450, rIcps],
    [0.570, rIcps]
  ], 28, whiteMat, tracker);
  spacecraft.add(icps);

  // Orion ESM (European Service Module)
  const esm = createLatheMesh([
    [0.570, rOrion],
    [0.650, rOrion]
  ], 28, whiteMat, tracker);
  spacecraft.add(esm);

  // Orion Crew Module
  const cm = createLatheMesh([
    [0.650, rOrion],
    [0.665, 0.042],
    [0.700, 0.028],
    [0.720, 0.018]
  ], 28, whiteMat, tracker);
  spacecraft.add(cm);

  spacecraft.userData.engines = [rl10Anchor];
  spacecraft.userData.engineCount = 1;
  spacecraft.userData.nozzleRadius = 0.015;

  // RCS cold gas thrusters near nose
  spacecraft.userData.rcs = [
    createRcsAnchor(spacecraft, 0.690, 0.030, 0.010, 1),
    createRcsAnchor(spacecraft, 0.690, 0.030, -0.010, 1),
    createRcsAnchor(spacecraft, 0.690, -0.030, 0.010, -1),
    createRcsAnchor(spacecraft, 0.690, -0.030, -0.010, -1)
  ];

  // ----------------------------------------------------
  // Escape Tower: Orion LAS (x: +0.720 to +1.000)
  // Direct child of root.
  // ----------------------------------------------------
  // Fairing shroud over CM + abort motor + jettison + ACM spike
  const las = createLatheMesh([
    [0.720, rOrion + 0.001],
    [0.780, 0.032],
    [0.810, 0.015],
    [0.890, 0.015],
    [0.910, 0.013],
    [0.940, 0.013],
    [0.950, 0.008],
    [0.970, 0.003],
    [1.000, 0.0002]
  ], 24, whiteMat, tracker);
  escapeTower.add(las);

  // 4 Canted abort motor nozzles
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2 + Math.PI / 4;
    const nozzle = createNozzleMesh(0.805, 0.815, 0.004, 0.001, 8, engineMat, tracker);
    nozzle.position.set(0, Math.cos(angle) * 0.015, Math.sin(angle) * 0.015);
    escapeTower.add(nozzle);
  }

  return { root, stage1, stage2, spacecraft, escapeTower };
}

/**
 * Build Starship (Super Heavy + Ship) model.
 * Total length = exactly 2.0 units [-1.000, +1.000].
 */
function buildStarshipModel(tracker) {
  const root = new THREE.Group();
  const stage1 = new THREE.Group();
  const stage2 = null;
  const spacecraft = new THREE.Group();
  const escapeTower = null;

  root.add(stage1);
  root.add(spacecraft);

  // Procedural Textures
  const boosterTex = createProceduralTexture(512, 512, (ctx, w, h) => {
    // Brushed stainless steel background
    ctx.fillStyle = '#cdd2d9';
    ctx.fillRect(0, 0, w, h);

    // Circumferential ring weld lines
    for (let y = 0; y < h; y += 28) {
      ctx.fillStyle = '#686f7a';
      ctx.fillRect(0, y - 1, w, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(0, y + 1, w, 1);
    }

    // Top section: hot staging ring vents
    ctx.fillStyle = '#22252a';
    ctx.fillRect(0, 0, w, 40);
    const ventCount = 16;
    const vw = w / ventCount;
    ctx.fillStyle = '#0f1114';
    for (let i = 0; i < ventCount; i++) {
      ctx.fillRect(i * vw + vw * 0.2, 8, vw * 0.6, 24);
    }
  }, tracker);

  const shipTex = createProceduralTexture(512, 512, (ctx, w, h) => {
    // Left half: Black hexagonal heat-shield tiles (windward belly)
    ctx.fillStyle = '#111316';
    ctx.fillRect(0, 0, w * 0.5, h);

    // Draw regular hexagonal grid
    const hexR = 7;
    const hexH = Math.sqrt(3) * hexR;
    ctx.strokeStyle = '#23262d';
    ctx.lineWidth = 1;

    for (let y = -hexH; y < h + hexH; y += hexH) {
      let row = 0;
      for (let x = 0; x < w * 0.5; x += hexR * 1.5) {
        const cy = y + (row % 2 === 1 ? hexH * 0.5 : 0);
        ctx.beginPath();
        for (let a = 0; a < 6; a++) {
          const angle = (a * Math.PI) / 3;
          const hx = x + hexR * Math.cos(angle);
          const hy = cy + hexR * Math.sin(angle);
          if (a === 0) ctx.moveTo(hx, hy);
          else ctx.lineTo(hx, hy);
        }
        ctx.closePath();
        ctx.stroke();
        row++;
      }
    }

    // Right half: Brushed stainless steel with weld bands (leeward back)
    ctx.fillStyle = '#d2d6dd';
    ctx.fillRect(w * 0.5, 0, w * 0.5, h);

    for (let y = 0; y < h; y += 32) {
      ctx.fillStyle = '#656b75';
      ctx.fillRect(w * 0.5, y - 1, w * 0.5, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(w * 0.5, y + 1, w * 0.5, 1);
    }
  }, tracker);

  // Materials
  const boosterMat = trackMaterial(new THREE.MeshStandardMaterial({
    map: boosterTex,
    metalness: 0.90,
    roughness: 0.28
  }), tracker);

  const shipMat = trackMaterial(new THREE.MeshStandardMaterial({
    map: shipTex,
    metalness: 0.85,
    roughness: 0.32
  }), tracker);

  const gridFinMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0x42464e,
    metalness: 0.78,
    roughness: 0.42
  }), tracker);

  const raptorMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0x222428,
    metalness: 0.88,
    roughness: 0.38,
    side: THREE.DoubleSide
  }), tracker);

  const flapMat = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0x181a1d,
    metalness: 0.75,
    roughness: 0.35
  }), tracker);

  const rShip = 0.0744; // 9.0m diameter

  // ----------------------------------------------------
  // Stage 1: Super Heavy Booster (x: -1.000 to +0.174)
  // ----------------------------------------------------
  // Booster main tank & vented interstage
  const boosterBody = createLatheMesh([
    [-1.000, rShip],
    [0.130, rShip],
    [0.174, rShip]
  ], 32, boosterMat, tracker, { minX: -1.000, maxX: 0.174 });
  stage1.add(boosterBody);

  // Booster base heatshield
  const boosterBase = createLatheMesh([
    [-1.000, 0.0],
    [-1.000, rShip]
  ], 32, raptorMat, tracker);
  stage1.add(boosterBase);

  // 4 Titanium Grid fins near top of booster (x = 0.110)
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);

    const finGroup = new THREE.Group();
    finGroup.position.set(0.110, (rShip + 0.024) * ca, (rShip + 0.024) * sa);

    // Outer titanium frame
    const frameGeom = new THREE.BoxGeometry(0.040, 0.048, 0.005);
    tracker.geometries.push(frameGeom);
    const frame = new THREE.Mesh(frameGeom, gridFinMat);
    frame.castShadow = false;
    frame.receiveShadow = false;
    frame.rotation.x = angle;
    finGroup.add(frame);

    // Crossbars for waffle grid structure
    for (const offset of [-0.012, 0, 0.012]) {
      const barGeom = new THREE.BoxGeometry(0.038, 0.003, 0.006);
      tracker.geometries.push(barGeom);
      const bar = new THREE.Mesh(barGeom, gridFinMat);
      bar.castShadow = false;
      bar.receiveShadow = false;
      bar.position.set(0, offset, 0);
      bar.rotation.x = angle;
      finGroup.add(bar);
    }
    stage1.add(finGroup);
  }

  // Super Heavy Raptor Engines (ring of outer bells + inner cluster)
  // 14 outer ring bells at radius 0.054
  for (let i = 0; i < 14; i++) {
    const angle = (i * 2 * Math.PI) / 14;
    const ry = 0.054 * Math.cos(angle);
    const rz = 0.054 * Math.sin(angle);
    const nozzle = createNozzleMesh(-1.000, -0.965, 0.012, 0.004, 12, raptorMat, tracker);
    nozzle.position.set(0, ry, rz);
    stage1.add(nozzle);
  }

  // 7 Representative engine anchors (1 center + 6 ring at radius 0.027)
  const shAnchors = [];
  const centerNozzle = createNozzleMesh(-1.000, -0.965, 0.012, 0.004, 12, raptorMat, tracker);
  stage1.add(centerNozzle);
  shAnchors.push(createEngineAnchor(stage1, -1.000, 0, 0));

  for (let i = 0; i < 6; i++) {
    const angle = (i * 2 * Math.PI) / 6;
    const ry = 0.027 * Math.cos(angle);
    const rz = 0.027 * Math.sin(angle);
    const nozzle = createNozzleMesh(-1.000, -0.965, 0.012, 0.004, 12, raptorMat, tracker);
    nozzle.position.set(0, ry, rz);
    stage1.add(nozzle);

    shAnchors.push(createEngineAnchor(stage1, -1.000, ry, rz));
  }
  stage1.userData.engines = shAnchors;
  stage1.userData.engineCount = 7;
  stage1.userData.nozzleRadius = 0.012;

  // ----------------------------------------------------
  // Spacecraft: Starship Ship (x: +0.174 to +1.000)
  // ----------------------------------------------------
  // Tangent ogive nose profile calculation
  const ogiveL = 1.000 - 0.650; // 0.350
  const ogiveRho = (rShip * rShip + ogiveL * ogiveL) / (2 * rShip);

  const shipPoints = [
    [0.174, rShip],
    [0.650, rShip]
  ];
  const ogiveSteps = 10;
  for (let i = 1; i <= ogiveSteps; i++) {
    const x = 0.650 + (i / ogiveSteps) * ogiveL;
    const distFromTip = 1.000 - x;
    const r = Math.sqrt(Math.max(0, ogiveRho * ogiveRho - (ogiveL - distFromTip) * (ogiveL - distFromTip))) + rShip - ogiveRho;
    shipPoints.push([x, Math.max(0, r)]);
  }

  const shipBody = createLatheMesh(shipPoints, 32, shipMat, tracker, { minX: 0.174, maxX: 1.000 });
  spacecraft.add(shipBody);

  // Ship aft baseplate
  const shipBase = createLatheMesh([
    [0.174, 0.0],
    [0.174, rShip]
  ], 32, raptorMat, tracker);
  spacecraft.add(shipBase);

  // Ship Engines: 3 Sea-Level Raptors (center cluster) + 3 Vacuum Raptors (RVac, outer ring)
  const shipEngines = [];

  // 3 Sea-Level Raptors (radius 0.016, nozzleRadius 0.010)
  for (let i = 0; i < 3; i++) {
    const angle = (i * 2 * Math.PI) / 3;
    const ry = 0.016 * Math.cos(angle);
    const rz = 0.016 * Math.sin(angle);
    const nozzle = createNozzleMesh(0.170, 0.205, 0.010, 0.0035, 14, raptorMat, tracker);
    nozzle.position.set(0, ry, rz);
    spacecraft.add(nozzle);

    shipEngines.push(createEngineAnchor(spacecraft, 0.170, ry, rz));
  }

  // 3 Vacuum Raptors (radius 0.042, nozzleRadius 0.018)
  for (let i = 0; i < 3; i++) {
    const angle = (i * 2 * Math.PI) / 3 + Math.PI / 3;
    const ry = 0.042 * Math.cos(angle);
    const rz = 0.042 * Math.sin(angle);
    const nozzle = createNozzleMesh(0.168, 0.215, 0.018, 0.005, 16, raptorMat, tracker);
    nozzle.position.set(0, ry, rz);
    spacecraft.add(nozzle);

    shipEngines.push(createEngineAnchor(spacecraft, 0.168, ry, rz));
  }
  spacecraft.userData.engines = shipEngines;
  spacecraft.userData.engineCount = 6;
  spacecraft.userData.nozzleRadius = 0.016;

  // 2 Aft Flaps (+Y and -Y)
  for (const s of [1, -1]) {
    const flapGeom = new THREE.BoxGeometry(0.18, 0.075, 0.005);
    tracker.geometries.push(flapGeom);
    const flap = new THREE.Mesh(flapGeom, flapMat);
    flap.castShadow = false;
    flap.receiveShadow = false;
    flap.position.set(0.320, (rShip + 0.035) * s, 0);
    spacecraft.add(flap);
  }

  // 2 Forward Flaps (+Y and -Y near nose)
  for (const s of [1, -1]) {
    const flapGeom = new THREE.BoxGeometry(0.11, 0.045, 0.004);
    tracker.geometries.push(flapGeom);
    const flap = new THREE.Mesh(flapGeom, flapMat);
    flap.castShadow = false;
    flap.receiveShadow = false;
    flap.position.set(0.850, (0.045 + 0.020) * s, 0);
    spacecraft.add(flap);
  }

  // RCS cold gas thrusters near nose
  spacecraft.userData.rcs = [
    createRcsAnchor(spacecraft, 0.900, 0.035, 0.010, 1),
    createRcsAnchor(spacecraft, 0.900, 0.035, -0.010, 1),
    createRcsAnchor(spacecraft, 0.900, -0.035, 0.010, -1),
    createRcsAnchor(spacecraft, 0.900, -0.035, -0.010, -1)
  ];

  return { root, stage1, stage2, spacecraft, escapeTower };
}

/**
 * Build the generic Custom rocket: white/charcoal two-stage with a purple band.
 * Total length = exactly 2.0 units [-1.000, +1.000].
 */
function buildCustomModel(tracker) {
  const root = new THREE.Group();
  const stage1 = new THREE.Group();
  const spacecraft = new THREE.Group();
  root.add(stage1);
  root.add(spacecraft);

  const mk = (o) => trackMaterial(new THREE.MeshStandardMaterial(o), tracker);
  const whiteMat = mk({ color: 0xf1f2f6, metalness: 0.35, roughness: 0.4 });
  const charMat = mk({ color: 0x2b2d35, metalness: 0.6, roughness: 0.45 });
  const accentMat = mk({ color: 0x8b5cf6, metalness: 0.4, roughness: 0.35, emissive: 0x2a1458, emissiveIntensity: 0.6 });
  const bellMat = mk({ color: 0x1c1d22, metalness: 0.85, roughness: 0.4, side: THREE.DoubleSide });

  const r1 = 0.12, r2 = 0.1;
  const xSplit = -0.08;

  // Stage 1 booster
  stage1.add(createLatheMesh([[-1.0, r1], [-0.30, r1], [xSplit, r1]], 32, whiteMat, tracker));
  stage1.add(createLatheMesh([[-1.0, 0], [-1.0, r1]], 32, charMat, tracker));
  stage1.add(createLatheMesh([[xSplit, r1], [xSplit, 0]], 32, charMat, tracker));
  stage1.add(createLatheMesh([[-1.0, r1 + 0.002], [-0.86, r1 + 0.002]], 32, charMat, tracker));
  stage1.add(createLatheMesh([[-0.30, r1 + 0.003], [-0.22, r1 + 0.003]], 32, accentMat, tracker));
  stage1.add(createLatheMesh([[-0.14, r1 + 0.002], [xSplit, r1 + 0.002]], 32, charMat, tracker));

  // 4 grid fins
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const fin = new THREE.Group();
    fin.position.set(-0.20, (r1 + 0.022) * Math.cos(a), (r1 + 0.022) * Math.sin(a));
    const fg = new THREE.BoxGeometry(0.04, 0.044, 0.005);
    tracker.geometries.push(fg);
    const frame = new THREE.Mesh(fg, charMat);
    frame.rotation.x = a;
    fin.add(frame);
    for (const off of [-0.011, 0.011]) {
      const bg = new THREE.BoxGeometry(0.038, 0.003, 0.006);
      tracker.geometries.push(bg);
      const bar = new THREE.Mesh(bg, charMat);
      bar.position.set(0, off, 0);
      bar.rotation.x = a;
      fin.add(bar);
    }
    stage1.add(fin);
  }

  // 3 engines
  const anchors = [];
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3;
    const y = 0.055 * Math.cos(a), z = 0.055 * Math.sin(a);
    const n = createNozzleMesh(-1.0, -0.93, 0.04, 0.012, 16, bellMat, tracker);
    n.position.set(0, y, z);
    stage1.add(n);
    anchors.push(createEngineAnchor(stage1, -1.0, y, z));
  }
  stage1.userData.engines = anchors;
  stage1.userData.engineCount = 3;
  stage1.userData.nozzleRadius = 0.04;

  // Upper stage + fairing (spacecraft)
  const xF = 0.58, L = 1.0 - xF;
  const pts = [[xSplit, r2], [xF, r2]];
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push([xF + t * L, Math.max(0, r2 * Math.sqrt(1 - Math.pow(t, 2.2)))]);
  }
  spacecraft.add(createLatheMesh(pts, 32, whiteMat, tracker, { minX: xSplit, maxX: 1.0 }));
  spacecraft.add(createLatheMesh([[xSplit, 0], [xSplit, r2]], 32, charMat, tracker));
  spacecraft.add(createLatheMesh([[0.02, r2 + 0.002], [0.09, r2 + 0.002]], 32, accentMat, tracker));
  spacecraft.add(createLatheMesh([[xF - 0.02, r2 + 0.002], [xF, r2 + 0.002]], 32, charMat, tracker));

  const vac = createNozzleMesh(xSplit - 0.04, xSplit + 0.03, 0.035, 0.01, 16, bellMat, tracker);
  spacecraft.add(vac);
  spacecraft.userData.engines = [createEngineAnchor(spacecraft, xSplit - 0.04, 0, 0)];
  spacecraft.userData.engineCount = 1;
  spacecraft.userData.nozzleRadius = 0.035;

  spacecraft.userData.rcs = [
    createRcsAnchor(spacecraft, 0.50, r2, 0.012, 1),
    createRcsAnchor(spacecraft, 0.50, r2, -0.012, 1),
    createRcsAnchor(spacecraft, 0.50, -r2, 0.012, -1),
    createRcsAnchor(spacecraft, 0.50, -r2, -0.012, -1)
  ];

  return { root, stage1, stage2: null, spacecraft, escapeTower: null };
}

/**
 * Build a rocket model.
 * Returns {
 *   root: THREE.Group,          // the full stack. Long axis = +X (nose points +X). Total length exactly 2.0 units,
 *                               // centred so the stack's midpoint is at x = 0. Max radius ~0.1–0.18 (keep real proportions).
 *   stage1: THREE.Group,        // first stage hardware dropped first (Saturn: S-IC; SLS: the two SRBs; Starship: Super Heavy)
 *   stage2: THREE.Group|null,   // second stage dropped at end of ascent (Saturn: S-II + interstage; SLS: orange core stage; Starship: null)
 *   spacecraft: THREE.Group,    // what reaches orbit (Saturn: S-IVB + instrument unit + SLA + CSM; SLS: ICPS + Orion stack; Starship: Ship)
 *   escapeTower: THREE.Group|null, // Saturn: LES tower; SLS: Orion LAS; Starship: null. Part of spacecraft hierarchy is NOT allowed: make it a direct child of root.
 *   dispose(): void             // dispose every geometry, material and texture created
 * }
 * stage1, stage2, spacecraft and escapeTower must be DIRECT children of root, positioned in root's local frame.
 * @param {'saturn5' | 'sls' | 'starship' | 'custom'} id - The rocket identifier
 */
export function buildRocket(id) {
  const tracker = {
    geometries: [],
    materials: [],
    textures: []
  };

  let built;
  if (id === 'saturn5') {
    built = buildSaturn5Model(tracker);
  } else if (id === 'sls') {
    built = buildSlsModel(tracker);
  } else if (id === 'starship') {
    built = buildStarshipModel(tracker);
  } else if (id === 'custom') {
    built = buildCustomModel(tracker);
  } else {
    throw new Error(`Unknown rocket id: "${id}"`);
  }

  const dispose = () => {
    const geoms = new Set(tracker.geometries);
    for (const g of geoms) {
      if (typeof g.dispose === 'function') g.dispose();
    }

    const mats = new Set(tracker.materials);
    for (const m of mats) {
      if (typeof m.dispose === 'function') m.dispose();
    }

    const texs = new Set(tracker.textures);
    for (const t of texs) {
      if (typeof t.dispose === 'function') t.dispose();
    }

    tracker.geometries.length = 0;
    tracker.materials.length = 0;
    tracker.textures.length = 0;
  };

  return {
    root: built.root,
    stage1: built.stage1,
    stage2: built.stage2,
    spacecraft: built.spacecraft,
    escapeTower: built.escapeTower,
    dispose
  };
}
