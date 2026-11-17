// 3D view for Fourier Draw. Loaded on demand (only when the visitor switches to 3D).
//
// Two sources:
//  • "ribbon": the current 2D shape, with time as depth. The usual circles spin in the front plane
//    and the pen's path streams back along z, so the trail becomes a 3D ribbon. The floor shows
//    x(t) and the side wall shows y(t): every drawing is just two waves.
//  • "curve": a real 3D closed curve. Each frequency k contributes a(cos 2πkt) + b(sin 2πkt) with
//    3D vectors a, b — a spinning *tilted ellipse* — and the chain of ellipses traces the curve.
//
// Everything is computed in float64 relative to an anchor point (the pen tip when zoomed) and only
// then scaled into float32 GPU buffers, so deep zoom stays steady.

import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { LineSegments2 } from './vendor/three/lines/LineSegments2.js';
import { LineSegmentsGeometry } from './vendor/three/lines/LineSegmentsGeometry.js';
import { LineMaterial } from './vendor/three/lines/LineMaterial.js';

const TAU = Math.PI * 2;
const RIBBON_LEN = 1.6;        // depth of one full loop in ribbon view
const FLOOR_Y = -0.65;         // floor / wall placement (shapes are normalized to size 1)
const WALL_X = -0.75;
const CLIP = 14;               // clip geometry to this radius (scene units) around the view
const ZOOM_CAP = 1e8;
const ZOOM_PAST = 30;
const MAX_POINTS = 100000;

const PRESETS_3D = {
  '🪢 Trefoil': (s) => { const t = TAU * s; return [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t)]; },
  '🍩 Torus knot': (s) => { const t = TAU * s, r = 2 + Math.cos(5 * t); return [r * Math.cos(2 * t), -Math.sin(5 * t), r * Math.sin(2 * t)]; },
  '🌀 Coil': (s) => { const t = TAU * s, n = 18, R = 1, r = 0.3; return [(R + r * Math.cos(n * t)) * Math.cos(t), r * Math.sin(n * t), (R + r * Math.cos(n * t)) * Math.sin(t)]; },
  '🌐 Sphere 8': (s) => { const t = 2 * TAU * s; return [1 + Math.cos(t), Math.sin(t), 2 * Math.sin(t / 2)]; },
  '⚾ Seam': (s) => {
    const t = 2 * TAU * s, a = 0.4, th = Math.PI / 2 - (Math.PI / 2 - a) * Math.cos(t), ph = t / 2 + a * Math.sin(2 * t);
    return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
  },
  '〰️ Lissajous': (s) => { const t = TAU * s; return [Math.sin(3 * t), Math.sin(2 * t + 0.6), Math.sin(5 * t + 1.1)]; },
};

// Turn the current 2D drawing (normalized, y down) into a 3D curve.
const LIFTS = {
  '〰️ Wave': (x, y, s) => [x, -y, 0.22 * Math.sin(TAU * 3 * s)],
  '🥫 Cylinder': (x, y) => { const th = x * 1.5 * Math.PI, R = 0.42; return [R * Math.sin(th), -y, R * Math.cos(th)]; },
  '🌍 Sphere': (x, y) => { const lon = x * 1.4 * Math.PI, lat = -y * 0.85 * Math.PI, R = 0.5; return [R * Math.cos(lat) * Math.sin(lon), R * Math.sin(lat), R * Math.cos(lat) * Math.cos(lon)]; },
  '🐎 Saddle': (x, y) => [x, -y, 1.2 * (x * x - y * y)],
};

export function createView3D(api) {
  const { state, opts, N, CURVE_RES } = api;
  const $ = (id) => document.getElementById(id);

  /* ---------- renderer / scene ---------- */
  const canvas = document.createElement('canvas');
  canvas.id = 'c3d';
  document.body.insertBefore(canvas, document.body.firstChild);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.005, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableZoom = false;     // the wheel drives our own (deep) zoom instead
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.2;
  controls.addEventListener('start', () => api.trackOnce('3d-orbit'));
  canvas.addEventListener('wheel', api.onWheel, { passive: false });

  const view = { source: 'ribbon', active: false };
  const opts3 = { waves: true, shadow: true, spin: false };

  /* ---------- fat line batches ---------- */
  const materials = {};
  const mat = (name, width) => (materials[name] = new LineMaterial({ linewidth: width, transparent: true, depthWrite: false, worldUnits: false }));
  class Lines {
    constructor(material, order) {
      this.geo = new LineSegmentsGeometry();
      this.cap = 0; this.n = 0;
      this.grow(4096);
      this.obj = new LineSegments2(this.geo, material);
      this.obj.frustumCulled = false;
      this.obj.renderOrder = order;
      scene.add(this.obj);
    }
    grow(cap) {
      const arr = new Float32Array(cap * 6);
      if (this.arr) arr.set(this.arr.subarray(0, this.n * 6));
      this.geo.setPositions(arr);
      this.arr = this.geo.attributes.instanceStart.data.array;
      this.cap = cap;
    }
    begin() { this.n = 0; }
    // add a segment (scene coords), clipped to a sphere around the view so huge values never reach the GPU
    seg(x0, y0, z0, x1, y1, z1) {
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const r0 = x0 * x0 + y0 * y0 + z0 * z0, r1 = x1 * x1 + y1 * y1 + z1 * z1, R2 = CLIP * CLIP;
      if (r0 > R2 || r1 > R2) {
        const a = dx * dx + dy * dy + dz * dz;
        if (!(a > 0)) return;
        const b = 2 * (x0 * dx + y0 * dy + z0 * dz), c = r0 - R2, disc = b * b - 4 * a * c;
        if (disc <= 0) return;
        const sq = Math.sqrt(disc), u0 = Math.max(0, (-b - sq) / (2 * a)), u1 = Math.min(1, (-b + sq) / (2 * a));
        if (u0 >= u1) return;
        x1 = x0 + dx * u1; y1 = y0 + dy * u1; z1 = z0 + dz * u1;
        x0 += dx * u0; y0 += dy * u0; z0 += dz * u0;
      }
      if (this.n >= this.cap) this.grow(this.cap * 2);
      const o = this.n++ * 6, A = this.arr;
      A[o] = x0; A[o + 1] = y0; A[o + 2] = z0; A[o + 3] = x1; A[o + 4] = y1; A[o + 5] = z1;
    }
    end() {
      this.geo.attributes.instanceStart.data.needsUpdate = true;
      this.geo.instanceCount = this.n;
      this.obj.visible = this.n > 0;
    }
  }
  const L = {
    guide: new Lines(mat('guide', 1), 0),
    shadow: new Lines(mat('shadow', 1.5), 1),
    original: new Lines(mat('original', 5), 2),
    trailDim: new Lines(mat('trailDim', 2), 3),
    wave: new Lines(mat('wave', 1.6), 4),
    circle: new Lines(mat('circle', 1), 5),
    arrow: new Lines(mat('arrow', 1.4), 6),
    trail: new Lines(mat('trail', 2.6), 7),
  };
  const tipMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false }));
  tipMesh.renderOrder = 10;
  scene.add(tipMesh);

  // drawable floor & side wall for "draw the waves" mode (scene coords at zoom 1: ribbon spans z ∈ [-LEN/2, LEN/2])
  const planeMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, RIBBON_LEN), planeMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set(0, FLOOR_Y, 0);
  const wallMesh = new THREE.Mesh(new THREE.PlaneGeometry(RIBBON_LEN, 0.65 - FLOOR_Y), planeMat);
  wallMesh.rotation.y = Math.PI / 2;
  wallMesh.position.set(WALL_X, (0.65 + FLOOR_Y) / 2, 0);
  for (const m of [floorMesh, wallMesh]) { m.visible = false; m.renderOrder = -1; scene.add(m); }

  function parseColor(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str);
    if (m) {
      const [r, g, b, a = 1] = m[1].split(',').map(Number);
      return { c: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), a };
    }
    return { c: new THREE.Color(str || '#888'), a: 1 };
  }
  function updateColors() {
    const col = api.colors();
    const set = (name, str, alpha) => { const p = parseColor(str); materials[name].color.copy(p.c); materials[name].opacity = alpha ?? p.a; };
    renderer.setClearColor(parseColor(col.bg).c, 1);
    set('guide', col.fg, 0.16); set('shadow', col.fg, 0.2); set('original', col.orig);
    set('trailDim', col.trail, 0.3); set('wave', col.ink, 0.85); set('trail', col.trail, 1);
    set('circle', col.circle, Math.min(1, parseColor(col.circle).a * 1.3)); set('arrow', col.arrow);
    tipMesh.material.color.copy(parseColor(col.trail).c);
    planeMat.color.copy(parseColor(col.trail).c);
  }

  function resize() {
    const W = innerWidth, H = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    camera.aspect = W / H;
    // keep the shape centred in the area not covered by the side panel
    const vb = api.viewBox(), dx = (W - vb.w) / 2;
    if (dx > 0) camera.setViewOffset(W, H, dx, 0, W, H); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    for (const m of Object.values(materials)) m.resolution.set(W, H);
  }

  /* ---------- 3D curve data ---------- */
  const COS = new Float64Array(N), SIN = new Float64Array(N);
  for (let n = 0; n < N; n++) { COS[n] = Math.cos((TAU * n) / N); SIN[n] = Math.sin((TAU * n) / N); }
  let terms3 = null, original3 = null, curve3 = null, curve3M = -1, vmax3 = 1;

  function resample3(pts, n) {
    const P = pts.concat([pts[0]]);
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]));
    const len = cum[cum.length - 1];
    if (!(len > 0)) return null;
    const out = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = (len * i) / n;
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
      out.push([0, 1, 2].map((a) => P[j][a] + (P[j + 1][a] - P[j][a]) * f));
    }
    return out;
  }
  function normalize3(pts) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
    const s = 1 / (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1);
    const c = lo.map((v, a) => (v + hi[a]) / 2);
    return pts.map((p) => [(p[0] - c[0]) * s, (p[1] - c[1]) * s, (p[2] - c[2]) * s]);
  }
  // Per-axis DFT; frequency k (1..N/2-1) becomes a(cos) + b(sin) with a = 2·Re, b = −2·Im.
  function dft3(pts) {
    const out = [];
    for (let k = 0; k < N / 2; k++) {
      const re = [0, 0, 0], im = [0, 0, 0];
      for (let n = 0; n < N; n++) {
        const idx = (k * n) % N, c = COS[idx], s = SIN[idx], p = pts[n];
        re[0] += p[0] * c; re[1] += p[1] * c; re[2] += p[2] * c;
        im[0] -= p[0] * s; im[1] -= p[1] * s; im[2] -= p[2] * s;
      }
      const f = k === 0 ? 1 / N : 2 / N;
      const a = re.map((v) => v * f), b = im.map((v) => -v * f);
      const size = Math.max(Math.hypot(...a), Math.hypot(...b), Math.sqrt((a[0] ** 2 + a[1] ** 2 + a[2] ** 2 + b[0] ** 2 + b[1] ** 2 + b[2] ** 2) / 2));
      out.push({ k, a, b, size });
    }
    // drop frequencies that are only floating-point noise (they'd show up as jitter at deep zoom)
    const rest = out.slice(1).sort((p, q) => q.size - p.size);
    const floor = (rest[0] ? rest[0].size : 1) * 1e-10;
    return [out[0], ...rest.filter((t) => t.size > floor)];
  }
  function loadCurve(pts) {
    const r = resample3(pts, N);
    if (!r) throw new Error('That curve has no length.');
    original3 = normalize3(r);
    terms3 = dft3(original3);
    curve3M = -1;
    setSource('curve', true);
    state.mode = 'anim'; state.t = 0; state.loops = 0; state.paused = false;
    api.afterLoad();
  }
  const curveM = () => Math.min(state.M, terms3 ? terms3.length : 1);
  function buildCurve3() {
    const M = curveM(), R = CURVE_RES, out = new Float64Array((R + 1) * 3);
    let vmax = 0;
    for (let i = 0; i < M; i++) {
      const { k, a, b, size } = terms3[i];
      vmax += TAU * k * size;
      const st = (TAU * k) / R, sc = Math.cos(st), ss = Math.sin(st);
      let c = 1, s = 0;
      for (let j = 0; j <= R; j++) {
        out[3 * j] += a[0] * c + b[0] * s; out[3 * j + 1] += a[1] * c + b[1] * s; out[3 * j + 2] += a[2] * c + b[2] * s;
        const nc = c * sc - s * ss; s = c * ss + s * sc; c = nc;
      }
    }
    curve3 = out; curve3M = M; vmax3 = vmax || 1;
  }
  let fine3 = new Float64Array(0);
  function sampleRange3(t0, t1, steps, M) {
    if (fine3.length !== (steps + 1) * 3) fine3 = new Float64Array((steps + 1) * 3);
    const out = fine3.fill(0), dt = (t1 - t0) / steps;
    for (let i = 0; i < M; i++) {
      const { k, a, b } = terms3[i];
      const th = TAU * k * t0, st = TAU * k * dt, sc = Math.cos(st), ss = Math.sin(st);
      let c = Math.cos(th), s = Math.sin(th);
      for (let j = 0; j <= steps; j++) {
        out[3 * j] += a[0] * c + b[0] * s; out[3 * j + 1] += a[1] * c + b[1] * s; out[3 * j + 2] += a[2] * c + b[2] * s;
        const nc = c * sc - s * ss; s = c * ss + s * sc; c = nc;
      }
    }
    return out;
  }

  /* ---------- per-frame chain ---------- */
  const tv = new Float64Array((N + 1) * 3), rel = new Float64Array((N + 1) * 3);
  const axA = new Float64Array(N * 3), axB = new Float64Array(N * 3), sizes = new Float64Array(N), freqs = new Int32Array(N);

  function cameraDistance() { return view.source === 'ribbon' ? 3.1 : 2.5; }
  function pxPerUnit() { return innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360) * cameraDistance()); }
  function smallestSize() {
    if (view.source === 'curve') { const M = curveM(); return M > 1 ? terms3[M - 1].size : 0; }
    return state.coeffs && state.M > 1 ? state.coeffs[state.M - 1].amp : 0;
  }
  function smallestZoom() {
    const s = smallestSize();
    if (!(s > 0)) return 50;
    const vb = api.viewBox();
    return Math.min(ZOOM_CAP, Math.max(50, (0.38 * Math.min(vb.w, vb.h)) / (s * pxPerUnit())));
  }
  const maxZoom = () => Math.min(ZOOM_CAP, smallestZoom() * ZOOM_PAST);

  // ellipse c + a cos φ + b sin φ (scene units)
  function drawEllipse(lines, cx, cy, cz, a0, a1, a2, b0, b1, b2, rPx) {
    const r = Math.max(Math.hypot(a0, a1, a2), Math.hypot(b0, b1, b2));
    if (Math.hypot(cx, cy, cz) - r > CLIP) return;
    const pt = (f, out) => { const c = Math.cos(f), s = Math.sin(f); out[0] = cx + a0 * c + b0 * s; out[1] = cy + a1 * c + b1 * s; out[2] = cz + a2 * c + b2 * s; return out; };
    const p = [0, 0, 0], q = [0, 0, 0];
    let from = 0, span = TAU, n;
    if (r < CLIP * 2) {
      n = Math.max(12, Math.min(96, Math.ceil(Math.sqrt(rPx) * 4)));
    } else {
      // huge ellipse: only the arc passing near the view matters — find it, then sample it finely
      let best = 0, bd = Infinity;
      for (let pass = 0, lo = 0, w = TAU, cnt = 64; pass < 3; pass++) {
        for (let j = 0; j < cnt; j++) { const f = lo + (w * j) / cnt; pt(f, p); const d = p[0] * p[0] + p[1] * p[1] + p[2] * p[2]; if (d < bd) { bd = d; best = f; } }
        w = (w * 4) / cnt; lo = best - w / 2; cnt = 32;
      }
      if (Math.sqrt(bd) > CLIP) return;
      const vx = -a0 * Math.sin(best) + b0 * Math.cos(best), vy = -a1 * Math.sin(best) + b1 * Math.cos(best), vz = -a2 * Math.sin(best) + b2 * Math.cos(best);
      span = Math.min(TAU, (4 * CLIP) / Math.max(Math.hypot(vx, vy, vz), 1e-12));
      from = best - span / 2;
      n = 64;
    }
    pt(from, p);
    for (let j = 1; j <= n; j++) { pt(from + (span * j) / n, q); lines.seg(p[0], p[1], p[2], q[0], q[1], q[2]); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; }
  }

  function render() {
    if (!state.coeffs) return;
    if (state.curveDirty) api.ensureCurve();
    const ribbon = view.source === 'ribbon' || !terms3;
    if (!ribbon && curve3M !== curveM()) buildCurve3();
    const t = state.t;
    controls.autoRotate = opts3.spin;
    controls.update();
    if (wd.on) return renderWaves();

    // ---- chain terms ----
    let M;
    if (ribbon) {
      M = state.M;
      const cs = state.coeffs;
      for (let i = 0; i < M; i++) {
        const c = cs[i], th = TAU * c.k * t + c.phase, r = c.amp;
        tv[3 * i] = r * Math.cos(th); tv[3 * i + 1] = -r * Math.sin(th); tv[3 * i + 2] = 0;
        axA[3 * i] = r; axA[3 * i + 1] = 0; axA[3 * i + 2] = 0; axB[3 * i] = 0; axB[3 * i + 1] = r; axB[3 * i + 2] = 0;
        sizes[i] = r; freqs[i] = Math.abs(c.k);
      }
    } else {
      M = curveM();
      for (let i = 0; i < M; i++) {
        const { k, a, b, size } = terms3[i], th = TAU * k * t, c = Math.cos(th), s = Math.sin(th);
        tv[3 * i] = a[0] * c + b[0] * s; tv[3 * i + 1] = a[1] * c + b[1] * s; tv[3 * i + 2] = a[2] * c + b[2] * s;
        axA.set(a, 3 * i); axB.set(b, 3 * i);
        sizes[i] = size; freqs[i] = k;
      }
    }
    let tx = 0, ty = 0, tz = 0;
    for (let i = 0; i < M; i++) { tx += tv[3 * i]; ty += tv[3 * i + 1]; tz += tv[3 * i + 2]; }
    rel[3 * M] = rel[3 * M + 1] = rel[3 * M + 2] = 0;
    for (let i = M - 1; i >= 0; i--) for (let a = 0; a < 3; a++) rel[3 * i + a] = rel[3 * i + 3 + a] - tv[3 * i + a];

    // ---- anchor & scale (follow the pen when zoomed in) ----
    const Z = state.zoom;
    const f = opts.follow ? Math.min(1, Math.max(0, Z - 1)) : 0;
    const c0z = ribbon ? -RIBBON_LEN / 2 : 0;
    const ax = f * tx, ay = f * ty, az = c0z + f * (tz - c0z);
    const sx = (x) => (x - ax) * Z, sy = (y) => (y - ay) * Z, sz = (z) => (z - az) * Z;
    const tipX = (1 - f) * tx * Z, tipY = (1 - f) * ty * Z, tipZ = (1 - f) * (tz - c0z) * Z;
    const ppu = pxPerUnit();

    // keep the camera at a fixed distance from the anchor (scene origin)
    const D = cameraDistance();
    camera.position.setLength(D);
    controls.target.set(0, 0, 0);

    for (const l of Object.values(L)) l.begin();

    // ---- walls / floor (unzoomed context only) ----
    if (Z < 3) {
      const g = L.guide;
      if (ribbon) {
        const zs = [0, -RIBBON_LEN];
        for (const z of zs) { g.seg(sx(-0.75), sy(FLOOR_Y), sz(z), sx(0.75), sy(FLOOR_Y), sz(z)); g.seg(sx(WALL_X), sy(FLOOR_Y), sz(z), sx(WALL_X), sy(0.65), sz(z)); }
        for (const x of [-0.75, 0.75]) g.seg(sx(x), sy(FLOOR_Y), sz(0), sx(x), sy(FLOOR_Y), sz(-RIBBON_LEN));
        g.seg(sx(WALL_X), sy(0.65), sz(0), sx(WALL_X), sy(0.65), sz(-RIBBON_LEN));
        for (let q = 1; q < 4; q++) { const z = (-RIBBON_LEN * q) / 4; g.seg(sx(-0.75), sy(FLOOR_Y), sz(z), sx(0.75), sy(FLOOR_Y), sz(z)); g.seg(sx(WALL_X), sy(FLOOR_Y), sz(z), sx(WALL_X), sy(0.65), sz(z)); }
      } else if (opts3.shadow) {
        for (let q = -2; q <= 2; q++) {
          const v = q * 0.4;
          g.seg(sx(v), sy(FLOOR_Y), sz(-0.8), sx(v), sy(FLOOR_Y), sz(0.8));
          g.seg(sx(-0.8), sy(FLOOR_Y), sz(v), sx(0.8), sy(FLOOR_Y), sz(v));
        }
      }
    }

    // ---- original input ----
    if (opts.original) {
      const o = ribbon ? state.original : original3;
      if (o) for (let i = 0; i < o.length; i++) {
        const p = o[i], q = o[(i + 1) % o.length];
        if (ribbon) L.original.seg(sx(p.x), sy(-p.y), sz(0), sx(q.x), sy(-q.y), sz(0));
        else L.original.seg(sx(p[0]), sy(p[1]), sz(p[2]), sx(q[0]), sy(q[1]), sz(q[2]));
      }
    }

    // ---- trail ----
    const R = CURVE_RES;
    const vmax = ribbon ? state.vmax : vmax3;
    const fineSpan = Z > 1.5 ? Math.min(t, 0.02, (3 * CLIP) / ((vmax || 1) * Z)) : 0;
    const FINE = fineSpan > 0 ? 300 : 1;
    if (ribbon) {
      const cv = state.curve;
      const pAt = (tau, out) => { const idx = ((Math.round(tau * R) % R) + R) % R; out[0] = cv[2 * idx]; out[1] = -cv[2 * idx + 1]; out[2] = (tau - t) * RIBBON_LEN; return out; };
      // the drawing plane: full shape, dim
      for (let j = 0; j < R; j += 2) { const k2 = Math.min(R, j + 2); L.trailDim.seg(sx(cv[2 * j]), sy(-cv[2 * j + 1]), sz(0), sx(cv[2 * k2]), sy(-cv[2 * k2 + 1]), sz(0)); }
      // the ribbon: the last loop, streaming back in time
      const startTau = state.loops > 0 ? t - 1 : 0, endTau = t - fineSpan;
      const j0 = Math.ceil(startTau * R), j1 = Math.floor(endTau * R);
      const p = [0, 0, 0], q = [0, 0, 0];
      if (j1 > j0) {
        pAt(j0 / R, p);
        for (let j = j0 + 1; j <= j1; j++) {
          pAt(j / R, q);
          L.trail.seg(sx(p[0]), sy(p[1]), sz(p[2]), sx(q[0]), sy(q[1]), sz(q[2]));
          if (opts3.waves && Z < 3) {
            L.wave.seg(sx(p[0]), sy(FLOOR_Y), sz(p[2]), sx(q[0]), sy(FLOOR_Y), sz(q[2]));
            L.wave.seg(sx(WALL_X), sy(p[1]), sz(p[2]), sx(WALL_X), sy(q[1]), sz(q[2]));
          }
          p[0] = q[0]; p[1] = q[1]; p[2] = q[2];
        }
      }
      // last stretch up to the pen, evaluated finely relative to the pen
      const fine = api.sampleRange(t - fineSpan, t, FINE, M);
      const ex = fine[2 * FINE], ey = fine[2 * FINE + 1];
      const fx = (j) => tipX + (fine[2 * j] - ex) * Z, fy = (j) => tipY - (fine[2 * j + 1] - ey) * Z, fz = (j) => tipZ - fineSpan * (1 - j / FINE) * RIBBON_LEN * Z;
      if (j1 > j0) L.trail.seg(sx(p[0]), sy(p[1]), sz(p[2]), fx(0), fy(0), fz(0));
      for (let j = 0; j < FINE; j++) L.trail.seg(fx(j), fy(j), fz(j), fx(j + 1), fy(j + 1), fz(j + 1));
      if (opts3.waves && Z < 3) {
        L.guide.seg(tipX, tipY, tipZ, sx(tx), sy(FLOOR_Y), sz(tz));
        L.guide.seg(tipX, tipY, tipZ, sx(WALL_X), sy(ty), sz(tz));
      }
    } else {
      const cv = curve3;
      const seg3 = (lines, j, k2, flat) => lines.seg(sx(cv[3 * j]), flat ? sy(FLOOR_Y) : sy(cv[3 * j + 1]), sz(cv[3 * j + 2]), sx(cv[3 * k2]), flat ? sy(FLOOR_Y) : sy(cv[3 * k2 + 1]), sz(cv[3 * k2 + 2]));
      if (state.loops > 0) for (let j = 0; j < R; j++) seg3(L.trailDim, j, j + 1, false);
      const coarseEnd = Math.floor((t - fineSpan) * R);
      for (let j = 0; j < coarseEnd; j++) seg3(L.trail, j, j + 1, false);
      if (opts3.shadow && Z < 3) { const end = state.loops > 0 ? R : coarseEnd; for (let j = 0; j < end; j += 2) seg3(L.shadow, j, Math.min(R, j + 2), true); }
      const fine = sampleRange3(t - fineSpan, t, FINE, M);
      const e0 = fine[3 * FINE], e1 = fine[3 * FINE + 1], e2 = fine[3 * FINE + 2];
      const fp = (j, a) => [tipX, tipY, tipZ][a] + (fine[3 * j + a] - [e0, e1, e2][a]) * Z;
      L.trail.seg(sx(cv[3 * coarseEnd]), sy(cv[3 * coarseEnd + 1]), sz(cv[3 * coarseEnd + 2]), fp(0, 0), fp(0, 1), fp(0, 2));
      for (let j = 0; j < FINE; j++) L.trail.seg(fp(j, 0), fp(j, 1), fp(j, 2), fp(j + 1, 0), fp(j + 1, 1), fp(j + 1, 2));
    }

    // ---- circles / ellipses and arrows ----
    let kVis = 1;
    for (let i = 1; i < M; i++) {
      const rPx = sizes[i] * Z * ppu;
      if (rPx > 30) kVis = Math.max(kVis, freqs[i]);
      if (rPx < 0.5) continue;
      const cx = tipX + rel[3 * i] * Z, cy = tipY + rel[3 * i + 1] * Z, cz = tipZ + rel[3 * i + 2] * Z;
      if (opts.circles) drawEllipse(L.circle, cx, cy, cz, axA[3 * i] * Z, axA[3 * i + 1] * Z, axA[3 * i + 2] * Z, axB[3 * i] * Z, axB[3 * i + 1] * Z, axB[3 * i + 2] * Z, rPx);
      if (opts.arrows) L.arrow.seg(cx, cy, cz, tipX + rel[3 * i + 3] * Z, tipY + rel[3 * i + 4] * Z, tipZ + rel[3 * i + 5] * Z);
    }
    state.rateTarget = Math.min(1, 6 / kVis);

    for (const l of Object.values(L)) l.end();
    tipMesh.position.set(tipX, tipY, tipZ);
    tipMesh.scale.setScalar(0.005 * D);
    renderer.render(scene, camera);
  }

  /* ---------- draw-the-waves mode ---------- */
  // Drag on the floor to draw x(t), on the side wall to draw y(t); the front plane shows the 2D shape
  // those two waves make together. Time runs from the front (t = 0) to the back (t = 1).
  const WB = 480;                                     // time bins
  const wd = { on: false, xs: new Float64Array(WB), ys: new Float64Array(WB), drag: null, edited: { floor: false, wall: false } };
  const binZ = (i) => RIBBON_LEN / 2 - (i / WB) * RIBBON_LEN; // scene z of bin i
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hit = new THREE.Vector3();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
  const wallPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -WALL_X);

  function wavesFromShape() {
    const cv = state.curve, R = CURVE_RES;
    for (let i = 0; i < WB; i++) { const idx = Math.round((i / WB) * R) % R; wd.xs[i] = cv[2 * idx]; wd.ys[i] = -cv[2 * idx + 1]; }
    wd.edited.floor = wd.edited.wall = false;
  }
  function setWaveMode(on) {
    if (on === wd.on) return;
    wd.on = on; wd.drag = null;
    document.body.classList.toggle('wave-draw', on);
    floorMesh.visible = wallMesh.visible = on;
    canvas.style.cursor = '';
    if (on) {
      if (view.source !== 'ribbon') setSource('ribbon', true);
      if (state.curveDirty) api.ensureCurve();
      wavesFromShape();
      api.afterSourceChange();     // back to zoom 1
      opts3.spin = false; $('optSpin').checked = false;
      resetCamera();
      camera.position.setLength(3.8);   // step back so the whole floor & wall fit
      api.track('3d-wave-draw');
    }
    noteText();
  }
  function castPointer(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  function paint(e) {
    const d = wd.drag;
    if (!ray.ray.intersectPlane(d.plane === 'floor' ? floorPlane : wallPlane, hit)) return;
    const s = Math.min(1, Math.max(0, (RIBBON_LEN / 2 - hit.z) / RIBBON_LEN));
    const i = Math.min(WB - 1, Math.round(s * (WB - 1)));
    const arr = d.plane === 'floor' ? wd.xs : wd.ys;
    const v = d.plane === 'floor' ? Math.min(0.75, Math.max(-0.75, hit.x)) : Math.min(0.65, Math.max(FLOOR_Y, hit.y));
    // fill every bin between the previous point and this one so fast strokes leave no gaps
    if (d.i == null) arr[i] = v;
    else { const n = Math.abs(i - d.i); for (let j = 0; j <= n; j++) { const u = n ? j / n : 1; arr[d.i + Math.sign(i - d.i) * j] = d.v + (v - d.v) * u; } }
    d.i = i; d.v = v;
    wd.edited[d.plane] = true;
  }
  // capture phase on the canvas, so a drag that starts on the floor/wall draws instead of orbiting
  canvas.addEventListener('pointerdown', (e) => {
    if (!wd.on || (e.pointerType === 'mouse' && e.button !== 0)) return;
    castPointer(e);
    const h = ray.intersectObjects([floorMesh, wallMesh], false)[0];
    if (!h) return;          // empty space → orbit as usual
    e.stopImmediatePropagation();
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    wd.drag = { id: e.pointerId, plane: h.object === floorMesh ? 'floor' : 'wall', i: null, v: 0 };
    paint(e);
  }, true);
  canvas.addEventListener('pointermove', (e) => {
    if (!wd.on) return;
    castPointer(e);
    if (wd.drag && wd.drag.id === e.pointerId) { e.stopImmediatePropagation(); paint(e); return; }
    if (e.pointerType === 'mouse' && !e.buttons) canvas.style.cursor = ray.intersectObjects([floorMesh, wallMesh], false).length ? 'crosshair' : '';
  }, true);
  const endDrag = (e) => { if (wd.drag && wd.drag.id === e.pointerId) { e.stopImmediatePropagation(); wd.drag = null; } };
  canvas.addEventListener('pointerup', endDrag, true);
  canvas.addEventListener('pointercancel', endDrag, true);

  function renderWaves() {
    const { xs, ys } = wd, z0 = RIBBON_LEN / 2;
    for (const l of Object.values(L)) l.begin();
    const g = L.guide;
    for (const z of [z0, -z0]) { g.seg(-0.75, FLOOR_Y, z, 0.75, FLOOR_Y, z); g.seg(WALL_X, FLOOR_Y, z, WALL_X, 0.65, z); }
    for (const x of [-0.75, 0.75]) g.seg(x, FLOOR_Y, z0, x, FLOOR_Y, -z0);
    g.seg(WALL_X, 0.65, z0, WALL_X, 0.65, -z0);
    for (let q = 1; q < 4; q++) { const z = z0 - (RIBBON_LEN * q) / 4; g.seg(-0.75, FLOOR_Y, z, 0.75, FLOOR_Y, z); g.seg(WALL_X, FLOOR_Y, z, WALL_X, 0.65, z); }
    g.seg(-0.75, 0, z0, 0.75, 0, z0); g.seg(0, FLOOR_Y, z0, 0, 0.65, z0);           // front-plane axes
    for (let i = 0; i < WB; i++) {
      const j = i + 1, za = binZ(i), zb = binZ(j);
      if (j < WB) {
        L.wave.seg(xs[i], FLOOR_Y, za, xs[j], FLOOR_Y, zb);
        L.wave.seg(WALL_X, ys[i], za, WALL_X, ys[j], zb);
        L.trailDim.seg(xs[i], ys[i], za, xs[j], ys[j], zb);
      }
      const k = j % WB;
      L.trail.seg(xs[i], ys[i], z0, xs[k], ys[k], z0);                             // the shape they make
      if (i % 40 === 0) { g.seg(xs[i], ys[i], za, xs[i], FLOOR_Y, za); g.seg(xs[i], ys[i], za, WALL_X, ys[i], za); }
    }
    for (const l of Object.values(L)) l.end();
    tipMesh.visible = false;
    state.rateTarget = 1;
    renderer.render(scene, camera);
    tipMesh.visible = true;
  }
  function applyWaves() {
    const { xs, ys } = wd, n = N, pts = new Array(n);
    let lo = Infinity, hi = -Infinity;
    for (let m = 0; m < n; m++) {
      const u = (m / n) * WB, i = Math.floor(u), f = u - i, j = (i + 1) % WB;
      pts[m] = { x: xs[i] + (xs[j] - xs[i]) * f, y: -(ys[i] + (ys[j] - ys[i]) * f) };
      lo = Math.min(lo, pts[m].x, pts[m].y); hi = Math.max(hi, pts[m].x, pts[m].y);
    }
    if (!(hi - lo > 1e-6)) return err3('Both waves are flat. Draw on the floor or the wall first.');
    const edited = wd.edited.floor && wd.edited.wall ? 'both' : wd.edited.floor ? 'floor' : wd.edited.wall ? 'wall' : 'none';
    setWaveMode(false);
    api.loadTimed(pts);
    api.track('3d-wave-shape', { edited });
  }

  /* ---------- source switching & UI ---------- */
  function resetCamera() {
    const dir = view.source === 'ribbon' ? new THREE.Vector3(0.95, 0.55, 0.75) : new THREE.Vector3(0.45, 0.4, 1);
    camera.position.copy(dir.normalize().multiplyScalar(cameraDistance()));
    controls.target.set(0, 0, 0);
    controls.update();
  }
  function setSource(src, silent) {
    if (src === 'curve' && !terms3) return loadCurve(sampleFn(PRESETS_3D['🪢 Trefoil']));
    const changed = src !== view.source;
    view.source = src;
    $('srcRibbon').classList.toggle('active', src === 'ribbon');
    $('srcCurve').classList.toggle('active', src === 'curve');
    if (src === 'curve') setWaveMode(false);
    else if (wd.on) wavesFromShape();    // a new 2D shape while drawing waves → start from its waves
    noteText();
    document.body.classList.toggle('src-curve', src === 'curve');
    if (changed) { resetCamera(); api.afterSourceChange(); }
    if (changed && !silent) api.track('3d-source', { source: src });
  }
  function noteText() {
    $('note3d').textContent = wd.on
      ? 'Drag on the floor to draw x over time, and on the side wall to draw y over time (front = start, back = end). The bright shape at the front is what the two waves make. Drag empty space to orbit.'
      : view.source === 'ribbon'
        ? 'Your 2D shape with time as depth. Floor = x(t), side wall = y(t): every drawing is two waves.'
        : 'Each circle becomes a spinning tilted ellipse in 3D. Drag to orbit, scroll to zoom.';
  }
  const sampleFn = (fn, n = 2000) => Array.from({ length: n }, (_, i) => fn(i / n));
  const err3 = (msg) => { $('err3d').textContent = msg || ''; };

  const presetBox = $('presets3d');
  for (const [name, fn] of Object.entries(PRESETS_3D)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => { err3(); loadCurve(sampleFn(fn)); api.track('3d-preset', { name: name.replace(/^\S+\s/, '') }); });
    presetBox.appendChild(b);
  }
  const liftBox = $('lift3d');
  for (const [name, fn] of Object.entries(LIFTS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => {
      err3();
      const o = state.original;
      if (!o) return err3('Draw something (or pick a 2D preset) first.');
      loadCurve(o.map((p, i) => fn(p.x, p.y, i / o.length)));
      api.track('3d-from-drawing', { kind: name.replace(/^\S+\s/, '') });
    });
    liftBox.appendChild(b);
  }
  $('points3dBtn').addEventListener('click', () => {
    err3();
    const text = $('points3d').value.trim();
    try {
      if (!text) return;
      if (text.length > 5e6) throw new Error('That’s too much data (max 5 MB).');
      let pts;
      if (text[0] === '[') {
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) throw new Error('Expected an array of [x, y, z].');
        pts = arr.map((p) => (Array.isArray(p) ? p : [p?.x, p?.y, p?.z]).slice(0, 3).map(Number));
      } else {
        pts = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.trim().split(/[\s,;]+/).slice(0, 3).map(Number));
      }
      if (pts.length > MAX_POINTS) throw new Error(`Too many points (max ${MAX_POINTS.toLocaleString()}).`);
      pts = pts.map((p) => (p.length === 2 ? [p[0], p[1], 0] : p));
      if (pts.length < 3 || pts.some((p) => p.length !== 3 || !p.every(Number.isFinite))) throw new Error('Need at least 3 points, each with 3 numbers (x y z).');
      loadCurve(pts);
      api.track('3d-import', { points: pts.length < 100 ? '<100' : pts.length < 1000 ? '100-1k' : '1k+' });
    } catch (e) {
      err3(e.message || String(e));
      api.track('3d-import-failed', { reason: String(e.message || e).slice(0, 60) });
    }
  });
  $('waveDrawBtn').addEventListener('click', () => { err3(); setWaveMode(true); });
  $('waveApplyBtn').addEventListener('click', () => { err3(); applyWaves(); });
  $('waveCancelBtn').addEventListener('click', () => { err3(); setWaveMode(false); });
  $('waveFlatX').addEventListener('click', () => { wd.xs.fill(0); wd.edited.floor = true; });
  $('waveFlatY').addEventListener('click', () => { wd.ys.fill(0); wd.edited.wall = true; });
  $('waveReset').addEventListener('click', () => wavesFromShape());
  $('srcRibbon').addEventListener('click', () => setSource('ribbon'));
  $('srcCurve').addEventListener('click', () => setSource('curve'));
  const bind = (id, key) => $(id).addEventListener('change', (e) => { opts3[key] = e.target.checked; api.track('toggle', { option: '3d-' + key, on: e.target.checked }); });
  bind('optWaves', 'waves'); bind('optShadow', 'shadow'); bind('optSpin', 'spin');

  /* ---------- public API ---------- */
  Object.assign(view, {
    canvas,
    activate() { view.active = true; updateColors(); resize(); setSource(view.source, true); resetCamera(); },
    deactivate() { view.active = false; setWaveMode(false); },
    render, resize, updateColors, setSource,
    termCount: () => (view.source === 'curve' && terms3 ? terms3.length : N),
    smallestZoom, maxZoom,
    savePng(cb) { render(); canvas.toBlob(cb); },
  });
  resize();
  updateColors();
  return view;
}
