'use strict';
/*
 * Fourier Draw — any closed path z(t) (as complex numbers x + iy) can be written as
 *   z(t) = Σ c_k · e^{2πi k t}
 * Each term is an arrow of length |c_k| spinning at k turns per loop. Chain them
 * tip-to-tail and the last tip traces the path. We sample the drawing at N equally
 * spaced points along its length and get c_k with a discrete Fourier transform.
 */

const N = 2048;            // samples along the path == number of available circles
const CURVE_RES = 4096;    // resolution of the precomputed traced curve
const ZOOM_CAP = 1e13;     // beyond this float64 precision runs out
const ZOOM_PAST = 30;
const ZOOM_MIN = 1 / 3;     // how far you can zoom out (3× smaller than the default fit)      // how far past "smallest circle fills the screen" you can keep zooming
const $ = (id) => document.getElementById(id);
// analytics.js defines window.track; no-op if it's missing or analytics is off
const track = (name, data) => { try { window.track && window.track(name, data); } catch {} };

/* ---------------- analytics events ----------------
 * Goal: learn how people actually use the app, without noise or personal data.
 * - continuous controls (sliders, zoom) report once the user settles (debounced)
 * - "first time" events fire once per visit
 * - one session-summary when the visitor leaves (sent with keepalive by Umami)
 */
const sent = new Set();
const trackOnce = (name, data, key = name) => { if (!sent.has(key)) { sent.add(key); track(name, data); } };
const timers = {};
const trackSettled = (name, getData, ms = 1500) => { clearTimeout(timers[name]); timers[name] = setTimeout(() => track(name, getData()), ms); };
const bucket = (v, edges) => { for (const [max, label] of edges) if (v <= max) return label; return edges[edges.length - 1][1]; };
const circlesBucket = (m) => bucket(m, [[10, '1-10'], [50, '11-50'], [250, '51-250'], [1000, '251-1000'], [Infinity, '1001-2048']]);
const zoomBucket = (z) => z < 1 ? '<1×' : z < 10 ? '1-10×' : '10^' + Math.floor(Math.log10(z)) + '×';
const session = { start: Date.now(), drawings: 0, presets: 0, imports: 0, dives: 0, pngs: 0, maxCircles: 0, maxZoom: 1, touch: false, used3d: false };
function sendSummary() {
  const secs = (Date.now() - session.start) / 1000;
  trackOnce('session-summary', {
    duration: bucket(secs, [[10, '<10s'], [30, '10-30s'], [120, '30s-2m'], [600, '2-10m'], [Infinity, '10m+']]),
    drawings: session.drawings, presets: session.presets, imports: session.imports, dives: session.dives, pngs: session.pngs,
    maxCircles: circlesBucket(session.maxCircles || 0), maxZoom: zoomBucket(session.maxZoom),
    input: session.touch ? 'touch' : 'mouse',
    used3d: session.used3d,
  });
}
addEventListener('pagehide', sendSummary);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendSummary(); });

const canvas = $('c');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

const state = {
  mode: 'draw',            // 'draw' | 'anim'
  strokes: [],             // array of polylines in screen px (draw mode)
  drawing: null,           // stroke currently being drawn
  coeffs: null,            // [{k, re, im, amp, phase}] — k=0 first, then by amplitude
  M: 256,                  // circles in use
  curve: null,             // Float64Array of traced curve for current M
  original: null,          // normalized sample points
  t: 0, loops: 0, paused: false,
  speed: 0.1,              // loops per second
  zoom: 1,
  autoTimer: null,
  curveDirty: false,
  vmax: 1, rate: 1, rateTarget: 1, dive: null,
  view: '2d',
};
const opts = { circles: true, arrows: true, original: false, follow: true, build: false, auto: true };

/* ---------------- theme colors ---------------- */
let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['bg', 'trail', 'circle', 'arrow', 'orig', 'ink', 'fg']) colors[k] = cs.getPropertyValue('--' + k).trim();
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { readColors(); if (view3d) view3d.updateColors(); });

/* ---------------- layout ---------------- */
function panelOpen() { return !document.body.classList.contains('panel-closed'); }
function wide() { return W > 760; }
function viewBox() {
  const w = panelOpen() && wide() ? W - 340 : W;
  return { cx: w / 2, cy: H / 2, w, h: H };
}
function baseScale() { const v = viewBox(); return Math.min(v.w, v.h) * 0.78; }

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', () => { resize(); if (view3d) view3d.resize(); });

/* ---------------- geometry ---------------- */
// Concatenate polylines (strokes get joined), close the loop, and sample n points evenly by arc length.
function resample(polys, n) {
  const pts = polys.flat();
  if (pts.length < 2) return null;
  pts.push(pts[0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const L = cum[cum.length - 1];
  if (!(L > 0)) return null;
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = (L * i) / n;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const f = (d - cum[j]) / seg;
    out.push({ x: pts[j].x + (pts[j + 1].x - pts[j].x) * f, y: pts[j].y + (pts[j + 1].y - pts[j].y) * f });
  }
  return out;
}

// Center on bounding box and scale so the larger side is 1.
function normalize(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const s = 1 / (Math.max(maxX - minX, maxY - minY) || 1);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return pts.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s }));
}

/* ---------------- Fourier ---------------- */
const COS = new Float64Array(N), SIN = new Float64Array(N);
for (let n = 0; n < N; n++) { COS[n] = Math.cos((2 * Math.PI * n) / N); SIN[n] = Math.sin((2 * Math.PI * n) / N); }

function dft(pts) {
  const out = [];
  for (let k = -N / 2; k < N / 2; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const idx = (((k * n) % N) + N) % N;
      const x = pts[n].x, y = pts[n].y, c = COS[idx], s = SIN[idx];
      // (x + iy) · e^{-iθ} = (x c + y s) + i (y c − x s)
      re += x * c + y * s;
      im += y * c - x * s;
    }
    re /= N; im /= N;
    out.push({ k, re, im, amp: Math.hypot(re, im), phase: Math.atan2(im, re) });
  }
  const zero = out.find((c) => c.k === 0);
  const rest = out.filter((c) => c.k !== 0).sort((a, b) => b.amp - a.amp);
  return [zero, ...rest];
}

function buildCurve() {
  // Each term is rotated incrementally by e^{2πik/RES} per sample, so no trig in the inner loop.
  const M = state.M, curve = new Float64Array((CURVE_RES + 1) * 2);
  for (let i = 0; i < M; i++) {
    const c = state.coeffs[i], step = (2 * Math.PI * c.k) / CURVE_RES;
    const sr = Math.cos(step), si = Math.sin(step);
    let zr = c.re, zi = c.im;
    for (let j = 0; j <= CURVE_RES; j++) {
      curve[2 * j] += zr; curve[2 * j + 1] += zi;
      const nr = zr * sr - zi * si;
      zi = zr * si + zi * sr; zr = nr;
    }
  }
  state.curve = curve;
  state.curveDirty = false;
  // upper bound on pen speed (world units per loop), used to size the fine trail window
  let vmax = 0;
  for (let i = 0; i < M; i++) vmax += state.coeffs[i].amp * 2 * Math.PI * Math.abs(state.coeffs[i].k);
  state.vmax = vmax;
}

// Sample the curve on [t0, t1] at steps+1 points using the same rotation trick (cheap enough per frame).
let rangeBuf = new Float64Array(0);
function sampleRange(t0, t1, steps, M) {
  if (rangeBuf.length !== (steps + 1) * 2) rangeBuf = new Float64Array((steps + 1) * 2);
  const out = rangeBuf.fill(0), dt = (t1 - t0) / steps;
  for (let i = 0; i < M; i++) {
    const c = state.coeffs[i], a = 2 * Math.PI * c.k * t0 + c.phase, step = 2 * Math.PI * c.k * dt;
    const sr = Math.cos(step), si = Math.sin(step);
    let zr = c.amp * Math.cos(a), zi = c.amp * Math.sin(a);
    for (let j = 0; j <= steps; j++) {
      out[2 * j] += zr; out[2 * j + 1] += zi;
      const nr = zr * sr - zi * si;
      zi = zr * si + zi * sr; zr = nr;
    }
  }
  return out;
}

/* ---------------- loading shapes ---------------- */
// timed: polys is one list of exactly N points already evenly spaced in time (keep that timing)
function loadShape(polys, timed = false) {
  const pts = timed ? polys[0] : resample(polys, N);
  if (!pts) return false;
  const norm = normalize(pts);
  state.original = norm;
  state.coeffs = dft(norm);
  state.mode = 'anim';
  state.t = 0; state.loops = 0;
  if (opts.build) setM(1);
  buildCurve();
  if (state.view === '3d' && view3d) view3d.setSource('ribbon', true);
  setZoom(state.zoom);
  updateUI();
  return true;
}

function animateDrawing(via = 'button') {
  clearTimeout(state.autoTimer);
  state.paused = false;
  const polys = state.strokes.filter((s) => s.length > 0);
  if (state.mode === 'draw' && polys.length) {
    loadShape(polys);
    session.drawings++;
    track('draw', { strokes: polys.length, via, count: session.drawings });
  } else if (state.mode === 'anim') { // replay current shape
    state.t = 0; state.loops = 0; if (opts.build) setM(1);
    track('replay', { via });
  }
  updateUI();
}

function startNewDrawing() {
  clearTimeout(state.autoTimer);
  state.mode = 'draw';
  state.strokes = [];
  state.drawing = null;
  updateUI();
}

/* ---------------- SVG import ---------------- */
// Untrusted SVG is never inserted as-is. We rebuild a fresh SVG that contains only geometry
// elements and geometric attributes (allowlist), so scripts, links, styles, external refs,
// event handlers, <use>, <foreignObject>, animations etc. can't survive.
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_SVG_BYTES = 5 * 1024 * 1024;
const SAFE_TAGS = new Set(['svg', 'g', 'path', 'polygon', 'polyline', 'circle', 'ellipse', 'rect', 'line']);
const SAFE_ATTRS = new Set(['d', 'points', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry',
  'x1', 'y1', 'x2', 'y2', 'transform', 'viewBox', 'preserveAspectRatio']);
const SAFE_VALUE = /^[0-9eE.,+\-\s a-zA-Z()%]*$/; // numbers, path commands, transform functions

function sanitizeSvg(srcRoot) {
  const copy = (src, depth) => {
    if (depth > 64) return null;
    const tag = src.localName;
    if (!SAFE_TAGS.has(tag) || (src.namespaceURI && src.namespaceURI !== SVG_NS)) return null;
    const el = document.createElementNS(SVG_NS, tag);
    for (const a of src.attributes) {
      if (!a.namespaceURI && SAFE_ATTRS.has(a.name) && a.value.length < 1e6 && SAFE_VALUE.test(a.value)) el.setAttribute(a.name, a.value);
    }
    for (const child of src.children) { const c = copy(child, depth + 1); if (c) el.appendChild(c); }
    return el;
  };
  return copy(srcRoot, 0);
}

function sampleSvgElement(svg, total = 3000) {
  const host = $('svgHost');
  host.replaceChildren(svg);
  try {
    const els = [...svg.querySelectorAll('path, polygon, polyline, circle, ellipse, rect, line')];
    const lens = els.map((el) => { try { return el.getTotalLength(); } catch { return 0; } });
    const sum = lens.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) throw new Error('No drawable paths found in that SVG.');
    const polys = [];
    els.forEach((el, i) => {
      const len = lens[i];
      if (!(len > 0)) return;
      const m = el.getCTM();
      const count = Math.max(24, Math.round((total * len) / sum));
      const poly = [];
      for (let j = 0; j <= count; j++) {
        const p = el.getPointAtLength((len * j) / count);
        const q = m ? new DOMPoint(p.x, p.y).matrixTransform(m) : p;
        poly.push({ x: q.x, y: q.y });
      }
      polys.push(poly);
    });
    return polys;
  } finally {
    host.replaceChildren();
  }
}

function sampleSvg(svgText, total) {
  if (svgText.length > MAX_SVG_BYTES) throw new Error('That SVG is too large (max 5 MB).');
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('Could not parse that SVG.');
  const svg = sanitizeSvg(doc.documentElement);
  if (!svg) throw new Error('Could not parse that SVG.');
  return sampleSvgElement(svg, total);
}

function samplePathData(d, total) {
  const svg = document.createElementNS(SVG_NS, 'svg'), path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return sampleSvgElement(svg, total);
}

function loadSvgText(text, source) {
  const err = $('err');
  err.textContent = '';
  text = text.trim();
  if (!text) return;
  try {
    let polys;
    if (/<svg[\s>]/i.test(text)) polys = sampleSvg(text);
    else {
      const d = text.replace(/^d\s*=\s*["']?|["']$/g, '');
      if (d.length > MAX_SVG_BYTES || !SAFE_VALUE.test(d)) throw new Error('That doesn\'t look like SVG path data.');
      polys = samplePathData(d);
    }
    if (!loadShape(polys)) throw new Error('That path has no length.');
    state.strokes = [];
    session.imports++;
    track('svg-import', { source });
  } catch (e) {
    err.textContent = e.message || String(e);
    track('svg-import-failed', { source, reason: String(e.message || e).slice(0, 60) });
  }
}

/* ---------------- presets ---------------- */
function param(fn, n = 600) {
  const pts = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pts.push(fn(t)); }
  return [pts];
}
const PRESETS = {
  '🦕 Dino': () => sampleSvg(`<svg xmlns="http://www.w3.org/2000/svg"><path d="
    M330 40 C350 35 370 45 372 55 C373 62 360 66 345 64 C335 64 331 70 328 80
    C322 110 315 130 302 146 C296 158 295 172 293 200 L292 232 L274 232 L274 196
    C250 202 212 202 186 196 L186 232 L167 232 L163 190 C150 181 138 176 120 172
    C82 166 42 176 8 192 C38 160 80 140 130 124 C170 100 220 94 262 104
    C282 109 296 100 305 80 C312 60 315 45 330 40 Z"/></svg>`),
  '❤️ Heart': () => param((t) => ({ x: 16 * Math.sin(t) ** 3, y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) })),
  '⭐ Star': () => {
    const pts = [];
    for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.4 : 1; pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) }); }
    return [pts];
  },
  '⬛ Square': () => [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]],
  '∞ Infinity': () => param((t) => ({ x: Math.cos(t) / (1 + Math.sin(t) ** 2), y: (Math.sin(t) * Math.cos(t)) / (1 + Math.sin(t) ** 2) })),
  '🌸 Flower': () => param((t) => { const r = 0.55 + 0.45 * Math.cos(5 * t); return { x: r * Math.cos(t), y: r * Math.sin(t) }; }),
  '🐌 Spiral': () => param((t) => { const a = t * 3, r = 0.1 + a / 20; return { x: r * Math.cos(a), y: r * Math.sin(a) }; }),
  '♣ Club': () => sampleSvg(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M50 10 C35 10 28 24 32 35 C20 30 8 38 8 52 C8 66 24 74 38 64 C36 76 32 84 24 90 L76 90 C68 84 64 76 62 64 C76 74 92 66 92 52 C92 38 80 30 68 35 C72 24 65 10 50 10 Z"/></svg>`),
  '✍️ Hello': () => sampleSvg(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M10 80 C30 60 40 20 30 15 C20 12 15 60 18 90 C25 60 40 55 45 65 C48 75 44 88 52 88 C62 88 72 70 66 64 C58 58 54 82 64 88 C76 94 88 60 92 30 C95 10 84 12 84 40 C84 70 88 90 98 88 C108 86 112 60 118 30 C121 10 110 12 110 40 C110 70 114 90 124 88 C136 86 140 64 134 62 C124 60 124 90 138 88 C148 86 150 66 142 64"/></svg>`),
};

/* ---------------- UI wiring ---------------- */
const in3d = () => state.view === '3d' && view3d;
const maxTerms = () => (in3d() ? view3d.termCount() : N);
const termsFromSlider = (v) => Math.max(1, Math.round(Math.pow(maxTerms(), v / 1000)));
const sliderFromTerms = (m) => Math.round((Math.log(m) / Math.log(maxTerms())) * 1000);
// Zoom at which the smallest circle in use fills most of the view.
function smallestCircleZoom() {
  if (in3d()) return view3d.smallestZoom();
  if (!state.coeffs || state.M < 2) return 50;
  const r = state.coeffs[state.M - 1].amp, v = viewBox();
  return Math.min(ZOOM_CAP, Math.max(50, (0.38 * Math.min(v.w, v.h)) / (Math.max(r, 1e-300) * baseScale())));
}
const maxZoom = () => (in3d() ? view3d.maxZoom() : Math.min(ZOOM_CAP, smallestCircleZoom() * ZOOM_PAST));
// slider is logarithmic from ZOOM_MIN to maxZoom()
const zoomFromSlider = (v) => ZOOM_MIN * Math.pow(maxZoom() / ZOOM_MIN, v / 1000);
const sliderFromZoom = (z) => Math.round((Math.log(z / ZOOM_MIN) / Math.log(maxZoom() / ZOOM_MIN)) * 1000);
const fmtZoom = (z) => z < 0.995 ? z.toFixed(2) + '×' : z < 10 ? z.toFixed(1) + '×' : z < 1e6 ? Math.round(z).toLocaleString() + '×' : z.toExponential(1).replace('e+', '·10^') + '×';

function setM(m) {
  state.M = Math.min(maxTerms(), Math.max(1, m));
  $('terms').value = sliderFromTerms(state.M);
  $('termsOut').textContent = state.M;
  state.curveDirty = true;
  if (state.coeffs) setZoom(state.zoom);
}
function setZoom(z) {
  state.zoom = Math.min(maxZoom(), Math.max(ZOOM_MIN, z));
  $('zoom').value = sliderFromZoom(state.zoom);
  $('zoomOut').textContent = fmtZoom(state.zoom);
}
function setSpeed(v) {
  state.speed = (v / 100) * 0.5;
  $('speedOut').textContent = (1 / state.speed).toFixed(1) + ' s / loop';
}

function updateUI() {
  $('hint').classList.toggle('hidden', !(state.mode === 'draw' && state.strokes.length === 0));
  $('pauseBtn').textContent = state.paused ? '▶ Resume' : '⏸ Pause';
}

$('terms').addEventListener('input', (e) => {
  setM(termsFromSlider(+e.target.value));
  session.maxCircles = Math.max(session.maxCircles, state.M);
  trackSettled('circles', () => ({ count: circlesBucket(state.M) }));
});
$('speed').addEventListener('input', (e) => {
  setSpeed(+e.target.value);
  trackSettled('speed', () => ({ secondsPerLoop: Math.round(1 / state.speed) }));
});
$('zoom').addEventListener('input', (e) => { state.dive = null; setZoom(zoomFromSlider(+e.target.value)); userZoomed('slider'); });
// manual zooming (slider / wheel / keys) → one event once they stop
function userZoomed(via) {
  session.maxZoom = Math.max(session.maxZoom, state.zoom);
  trackSettled('zoom', () => ({ level: zoomBucket(state.zoom), via }), 2000);
}
$('diveBtn').addEventListener('click', () => userDive('button'));
$('zoomResetBtn').addEventListener('click', () => { dive(1); track('zoom-reset'); });
function userDive(via) {
  const z = smallestCircleZoom();
  dive(z);
  session.dives++;
  session.maxZoom = Math.max(session.maxZoom, z);
  track('dive', { via, circles: circlesBucket(state.M), depth: zoomBucket(z) });
}
// smooth logarithmic zoom animation
function dive(target) {
  if (target > 1) { opts.follow = true; $('optFollow').checked = true; }
  const from = Math.log(state.zoom), to = Math.log(target);
  state.dive = { from, to, start: performance.now(), dur: Math.min(9000, 800 + Math.abs(to - from) * 300) };
}
$('drawBtn').addEventListener('click', () => { if (state.view === '3d') setView('2d'); startNewDrawing(); track('new-drawing'); });
$('animBtn').addEventListener('click', () => animateDrawing('button'));
$('undoBtn').addEventListener('click', () => { undo(); trackOnce('undo'); });
$('pauseBtn').addEventListener('click', () => togglePause('button'));
function togglePause(via) {
  state.paused = !state.paused;
  updateUI();
  if (state.paused) track('pause', { via });
}
$('pngBtn').addEventListener('click', () => {
  session.pngs++;
  track('save-png', { mode: state.mode === 'anim' ? 'animation' : 'drawing', zoomed: state.zoom > 1.5, view: in3d() ? '3d-' + view3d.source : '2d' });
  const save = (b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = 'fourier-drawing.png'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  if (in3d()) view3d.savePng(save); else canvas.toBlob(save);
});
$('panelToggle').addEventListener('click', () => {
  document.body.classList.toggle('panel-closed');
  if (view3d) view3d.resize();
  track('panel', { open: panelOpen(), screen: wide() ? 'wide' : 'narrow' });
});

const bindOpt = (id, key) => $(id).addEventListener('change', (e) => { opts[key] = e.target.checked; track('toggle', { option: key, on: e.target.checked }); });
bindOpt('optCircles', 'circles'); bindOpt('optArrows', 'arrows'); bindOpt('optOriginal', 'original');
bindOpt('optFollow', 'follow'); bindOpt('optAuto', 'auto');
$('optBuild').addEventListener('change', (e) => { opts.build = e.target.checked; track('toggle', { option: 'build', on: opts.build }); if (opts.build && state.mode === 'anim') { setM(1); state.t = 0; state.loops = 0; } });

$('svgFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) {
    if (f.size > MAX_SVG_BYTES) { $('err').textContent = 'That SVG is too large (max 5 MB).'; e.target.value = ''; return; }
    loadSvgText(await f.text(), 'file');
  }
  e.target.value = '';
});
$('pathBtn').addEventListener('click', () => loadSvgText($('pathInput').value, 'paste'));

const presetBox = $('presets');
for (const [name, fn] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => { $('err').textContent = ''; try { loadShape(fn()); state.strokes = []; session.presets++; track('preset', { name: name.replace(/^\S+\s/, '') }); } catch (e) { $('err').textContent = e.message; } });
  presetBox.appendChild(b);
}

function undo() {
  if (state.mode !== 'draw') { state.mode = 'draw'; updateUI(); return; }
  state.strokes.pop();
  clearTimeout(state.autoTimer);
  updateUI();
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest('textarea, input[type=file]')) return;
  const k = e.code === 'Space' ? 'space' : e.key.toLowerCase();
  if (k === 'space') { e.preventDefault(); togglePause('key'); }
  else if (k === 'enter') animateDrawing('key');
  else if (k === 'z') undo();
  else if (k === '+' || k === '=') { state.dive = null; setZoom(state.zoom * 2); userZoomed('keys'); }
  else if (k === '-' || k === '_') { state.dive = null; setZoom(state.zoom / 2); userZoomed('keys'); }
  else if (k === 'd') userDive('key');
  else if (k === '0') dive(1);
  else if (k === '3') setView(state.view === '3d' ? '2d' : '3d');
  else return;
  trackOnce('shortcut', { key: k }, 'shortcut:' + k); // which shortcuts people discover (once each per visit)
});

function onWheel(e) {
  e.preventDefault();
  state.dive = null;
  setZoom(state.zoom * Math.exp(-e.deltaY * (e.shiftKey ? 0.01 : 0.003)));
  userZoomed('wheel');
}
canvas.addEventListener('wheel', onWheel, { passive: false });

/* ---------------- 3D view (loaded on demand) ---------------- */
let view3d = null;
async function setView(v) {
  if (v === state.view) return;
  if (v === '3d' && !view3d) {
    try {
      const mod = await import('./fourier3d.js');
      view3d = mod.createView3D({
        state, opts, N, CURVE_RES, sampleRange, viewBox, onWheel, track, trackOnce,
        colors: () => colors,
        ensureCurve: () => { if (state.curveDirty) buildCurve(); },
        afterLoad: () => { if (opts.build) setM(1); else setM(state.M); setZoom(1); state.dive = null; updateUI(); },
        loadTimed: (pts) => { clearTimeout(state.autoTimer); state.strokes = []; state.paused = false; loadShape([pts], true); },
        afterSourceChange: () => { setM(state.M); setZoom(1); state.dive = null; },
      });
    } catch (e) {
      $('err').textContent = '3D isn’t available in this browser (' + (e.message || e) + ').';
      track('3d-failed', { reason: String(e.message || e).slice(0, 60) });
      return;
    }
  }
  if (v === '3d' && state.mode !== 'anim') { // make sure there's a shape to show
    if (state.strokes.some((s) => s.length)) animateDrawing('3d'); else loadShape(PRESETS['🦕 Dino']());
  }
  state.view = v;
  document.body.classList.toggle('view-3d', v === '3d');
  $('view2dBtn').classList.toggle('active', v === '2d');
  $('view3dBtn').classList.toggle('active', v === '3d');
  if (v === '3d') { view3d.activate(); session.used3d = true; } else if (view3d) view3d.deactivate();
  state.dive = null;
  setM(state.M);
  setZoom(1);
  track('view', { mode: v });
}
$('view2dBtn').addEventListener('click', () => setView('2d'));
$('view3dBtn').addEventListener('click', () => setView('3d'));

/* ---------------- freehand drawing ---------------- */
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  clearTimeout(state.autoTimer);
  if (state.mode !== 'draw') { state.mode = 'draw'; state.strokes = []; }
  canvas.setPointerCapture(e.pointerId);
  if (e.pointerType !== 'mouse') session.touch = true;
  trackOnce('first-stroke', { input: e.pointerType || 'mouse' }); // did they try drawing at all?
  state.drawing = [{ x: e.clientX, y: e.clientY }];
  state.strokes.push(state.drawing);
  updateUI();
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.drawing) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events) {
    const last = state.drawing[state.drawing.length - 1];
    if (Math.hypot(ev.clientX - last.x, ev.clientY - last.y) > 1.5) state.drawing.push({ x: ev.clientX, y: ev.clientY });
  }
});
const endStroke = () => {
  if (!state.drawing) return;
  state.drawing = null;
  if (opts.auto) state.autoTimer = setTimeout(() => animateDrawing('auto'), 900);
};
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

/* ---------------- rendering ---------------- */
const terms = new Float64Array((N + 1) * 2), rel = new Float64Array((N + 1) * 2);

function drawFrame() {
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, W, H);
  if (state.mode === 'draw') return drawStrokes();
  if (state.curveDirty) buildCurve();

  const { coeffs, M, t } = state;
  // Arrow terms, and each arrow's start point measured *relative to the pen tip*.
  // Measuring from the tip keeps tiny circles precise when zoomed in ~1e11× on the pen.
  let x = 0, y = 0;
  for (let i = 0; i < M; i++) {
    const c = coeffs[i], a = 2 * Math.PI * c.k * t + c.phase;
    const tx = c.amp * Math.cos(a), ty = c.amp * Math.sin(a);
    terms[2 * i] = tx; terms[2 * i + 1] = ty;
    x += tx; y += ty;
  }
  rel[2 * M] = 0; rel[2 * M + 1] = 0;
  for (let i = M - 1; i >= 0; i--) { rel[2 * i] = rel[2 * i + 2] - terms[2 * i]; rel[2 * i + 1] = rel[2 * i + 3] - terms[2 * i + 1]; }

  // camera: blend from center (zoom 1) to following the pen tip (zoom ≥ 2)
  const f = opts.follow ? Math.min(1, Math.max(0, state.zoom - 1)) : 0;
  const camX = x * f, camY = y * f;
  const v = viewBox(), S = baseScale() * state.zoom, cx = v.cx, cy = v.cy;
  const sx = (wx) => cx + (wx - camX) * S, sy = (wy) => cy + (wy - camY) * S;     // world → screen
  const tipX = cx + x * (1 - f) * S, tipY = cy + y * (1 - f) * S;                 // pen tip on screen
  const rx = (i) => tipX + rel[2 * i] * S, ry = (i) => tipY + rel[2 * i + 1] * S; // chain node i on screen

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // original drawing
  if (opts.original && state.original) {
    const o = state.original;
    ctx.beginPath(); pathReset();
    for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length]; seg(sx(a.x), sy(a.y), sx(b.x), sy(b.y)); }
    ctx.strokeStyle = colors.orig; ctx.lineWidth = 6; ctx.stroke();
  }

  // traced curve
  const curve = state.curve;
  const pathCurve = (from, to) => {
    for (let j = from; j < to; j++) seg(sx(curve[2 * j]), sy(curve[2 * j + 1]), sx(curve[2 * j + 2]), sy(curve[2 * j + 3]));
  };
  if (state.loops > 0) {
    ctx.beginPath(); pathReset(); pathCurve(0, CURVE_RES);
    ctx.globalAlpha = 0.28; ctx.strokeStyle = colors.trail; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
  }

  // bright part drawn so far this loop; the stretch just behind the pen is evaluated finely
  // (window sized to roughly the screen) so it stays smooth at any zoom
  const diag = Math.hypot(W, H);
  const fineSpan = state.zoom > 1.5 ? Math.min(t, 0.02, (3 * diag) / (state.vmax * S || 1)) : 0;
  const ts = t - fineSpan, coarseEnd = Math.floor(ts * CURVE_RES);
  ctx.beginPath(); pathReset();
  pathCurve(0, coarseEnd);
  const FINE = 400, fine = sampleRange(ts, t, FINE, M);
  // fine samples are placed relative to the last one (= the pen at time t) for precision at deep zoom
  const ex = fine[2 * FINE], ey = fine[2 * FINE + 1];
  const fx = (j) => tipX + (fine[2 * j] - ex) * S, fy = (j) => tipY + (fine[2 * j + 1] - ey) * S;
  seg(sx(curve[2 * coarseEnd]), sy(curve[2 * coarseEnd + 1]), fx(0), fy(0));
  for (let j = 0; j < FINE; j++) seg(fx(j), fy(j), fx(j + 1), fy(j + 1));
  ctx.shadowColor = colors.trail; ctx.shadowBlur = 8;
  ctx.strokeStyle = colors.trail; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.shadowBlur = 0;

  // circles (culled when invisible; huge ones drawn as just the visible arc)
  if (opts.circles) {
    ctx.beginPath(); pathReset();
    for (let i = 1; i < M; i++) {
      const r = coeffs[i].amp * S;
      if (r < 0.6) continue;
      const px = rx(i), py = ry(i);
      const dx = W / 2 - px, dy = H / 2 - py, d = Math.hypot(dx, dy);
      if (d - r > diag || r - d > diag) continue;
      if (r < 2e4) { ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, Math.PI * 2); continue; }
      const mid = Math.atan2(dy, dx), span = Math.min(Math.PI, (2 * diag) / r), n = 48;
      let ax = px + r * Math.cos(mid - span), ay = py + r * Math.sin(mid - span);
      for (let j = 1; j <= n; j++) {
        const a = mid - span + (2 * span * j) / n, bx = px + r * Math.cos(a), by = py + r * Math.sin(a);
        seg(ax, ay, bx, by); ax = bx; ay = by;
      }
    }
    ctx.strokeStyle = colors.circle; ctx.lineWidth = 1; ctx.stroke();
  }
  if (opts.arrows) {
    ctx.beginPath(); pathReset();
    const heads = [];
    for (let i = 1; i < M; i++) {
      const ax = rx(i), ay = ry(i), bx = rx(i + 1), by = ry(i + 1);
      const len = coeffs[i].amp * S;
      if (len < 0.6) continue;
      if (!seg(ax, ay, bx, by)) continue;
      if (len > 8 && bx > -20 && bx < W + 20 && by > -20 && by < H + 20) heads.push(ax, ay, bx, by, len);
    }
    for (let h = 0; h < heads.length; h += 5) {
      const ax = heads[h], ay = heads[h + 1], bx = heads[h + 2], by = heads[h + 3], len = heads[h + 4];
      const hs = Math.min(9, len * 0.3), ux = (bx - ax) / len, uy = (by - ay) / len;
      ctx.moveTo(bx - ux * hs - uy * hs * 0.5, by - uy * hs + ux * hs * 0.5);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx - ux * hs + uy * hs * 0.5, by - uy * hs - ux * hs * 0.5);
    }
    ctx.strokeStyle = colors.arrow; ctx.lineWidth = 1.4; ctx.stroke();
  }

  // pen tip
  ctx.beginPath();
  ctx.arc(tipX, tipY, 4, 0, Math.PI * 2);
  ctx.fillStyle = colors.trail; ctx.fill();

  // pick a playback rate so the circles that are on screen turn at a watchable speed
  let kVis = 1;
  for (let i = 1; i < M; i++) if (coeffs[i].amp * S > 30) kVis = Math.max(kVis, Math.abs(coeffs[i].k));
  state.rateTarget = Math.min(1, 6 / kVis);
}

// Line segments clipped to the (padded) viewport — keeps the canvas happy when points are ~1e13 px away.
let penX = NaN, penY = NaN;
function pathReset() { penX = NaN; penY = NaN; }
function seg(x0, y0, x1, y1) {
  const P = 40, dx = x1 - x0, dy = y1 - y0;
  let u0 = 0, u1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > u1) return false; if (r > u0) u0 = r; }
    else { if (r < u0) return false; if (r < u1) u1 = r; }
    return true;
  };
  if (!(clip(-dx, x0 + P) && clip(dx, W + P - x0) && clip(-dy, y0 + P) && clip(dy, H + P - y0))) return false;
  const ax = x0 + u0 * dx, ay = y0 + u0 * dy, bx = x0 + u1 * dx, by = y0 + u1 * dy;
  if (ax !== penX || ay !== penY) ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  penX = bx; penY = by;
  return true;
}

function drawStrokes() {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = colors.ink; ctx.lineWidth = 3;
  for (const s of state.strokes) {
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y);
    ctx.stroke();
  }
  // dashed hint of how strokes will be joined / closed
  const flat = state.strokes.flat();
  if (flat.length > 2 && !state.drawing) {
    ctx.setLineDash([4, 6]); ctx.lineWidth = 1.5; ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let i = 1; i < state.strokes.length; i++) {
      const a = state.strokes[i - 1].at(-1), b = state.strokes[i][0];
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.moveTo(flat.at(-1).x, flat.at(-1).y); ctx.lineTo(flat[0].x, flat[0].y);
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
}

let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.dive) {
    const d = state.dive, u = Math.min(1, (now - d.start) / d.dur), e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
    setZoom(Math.exp(d.from + (d.to - d.from) * e));
    if (u >= 1) state.dive = null;
  }
  // ease the playback rate toward what drawFrame picked (slower when tiny fast circles are on screen)
  state.rate += (state.rateTarget - state.rate) * Math.min(1, dt * 4);
  if (state.mode === 'anim' && !state.paused) {
    state.t += dt * state.speed * state.rate;
    if (state.t >= 1) {
      state.t -= 1; state.loops++;
      if (opts.build) {
        if (state.M >= maxTerms()) setM(1), (state.loops = 0);
        else setM(Math.max(state.M + 1, Math.ceil(state.M * 1.6)));
      }
    }
  }
  if (in3d()) view3d.render(); else drawFrame();
  requestAnimationFrame(tick);
}

/* ---------------- boot ---------------- */
readColors();
resize();
if (!wide()) document.body.classList.add('panel-closed');
setM(termsFromSlider(+$('terms').value));
setSpeed(+$('speed').value);
setZoom(1);
loadShape(PRESETS['🦕 Dino']());
requestAnimationFrame(tick);
