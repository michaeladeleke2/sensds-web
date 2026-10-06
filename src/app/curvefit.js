// The Curve Fit tab of SensDSv2 (ui/curve_fit_tab.py): freeze the live
// spectrogram, trace the ridge a moving target leaves behind, and fit a
// function to it.
//   - live: the window keeps scrolling; Freeze redraws the window the
//     reference script's way (compute_recorded over the raw frames), so the
//     picture being traced is the one the model learns from,
//   - Start Trace freezes first if needed; drag across the curve,
//   - Snap to strongest signal moves each point onto the brightest bin within
//     20 bins before fitting,
//   - Fit Curve needs 10 points.
// Team feedback on top of the desktop:
//   - the spectrogram shows -3 to 3 m/s,
//   - the time window is configurable (2 to 30 s) and the shown time range is
//     adjustable (From / To, mouse wheel to zoom, drag to pan),
//   - Polynomial and Linear are gone,
//   - one to four sinusoids, each with an optional starting frequency.

import { RdmComputer } from '../dsp/doppler_live.js';
import { LiveProcessorClient } from '../dsp/live_client.js';
import { referenceRgb } from '../collect/training_image.js';
import { axisTicks } from '../viz/ticks.js';
import { subscribeFrames } from './radar_session.js';
import { currentJetVmin, onReduceNoiseChange } from './settings.js';
import { fitCurve, snapToPeak, MODEL_SINUSOID, MODEL_DAMPED } from '../curvefit/fit.js';

const FPS = 10;
const REDRAW_MS = 200;
const REBUILD_MS = 300;
const MAX_SPEED = 6.19405905;          // the reference script's velocity axis
const VIEW_VEL = 3;                    // shown velocity range, +/- m/s (team feedback)
const TRACE_COLOR = '#ff00ff';
const MIN_TRACE_POINTS = 10;
const N_CHIRP = 128, N_SAMPLE = 256;
const IDLE_TEXT = 'Freeze the display, trace a curve, then fit a model to it.';

const $ = id => document.getElementById(id);
const pane = $('curvefitPane');
const visible = () => !pane.hidden;

const st = {
  window: 5,                 // seconds of history
  width: 50,                 // frames (columns) in the window
  proc: null,               // LiveProcessorClient (worker)
  raw: [],                   // raw antenna-0 frames, one window's worth
  liveSpec: null,            // (width x bins) dB, oldest first
  dirty: false,
  frozen: false,
  frozenRef: false,
  image: null,               // { canvas, cols, rows } the picture on screen
  snapSpec: null,            // { data, rows, cols }, row 0 the bottom (most negative on the axis)
  view: [0, 5],              // shown time range
  tracing: false,
  drawing: false,
  points: [],
  fit: null,
};
const DOPPLER_BINS = new RdmComputer(N_SAMPLE, N_CHIRP).dopplerFftSize;
const bins = () => DOPPLER_BINS;
const timeScale = () => st.window / st.width;
const velScale = () => (2 * MAX_SPEED) / bins();

// ══════════════ live buffer ══════════════
function rebuild() {
  st.width = Math.max(2, Math.round(st.window * FPS));
  st.proc ??= new LiveProcessorClient(({ history }) => { if (!st.frozen) { st.liveSpec = history; st.dirty = true; } });
  st.proc.reset({ nSample: N_SAMPLE, nChirp: N_CHIRP, historyLength: st.width });
  st.raw = [];
  st.liveSpec = null;
  st.view = [0, st.window];
  syncViewInputs();
  setImageFromSpec(null);
  draw();
}

subscribeFrames(cube => {
  if (st.frozen || !visible()) return;
  const a0 = cube.slice(0, N_CHIRP * N_SAMPLE);
  st.raw.push(a0);
  if (st.raw.length > st.width) st.raw.shift();
  st.proc.push(a0);
});
setInterval(() => {
  if (!st.dirty || st.frozen || !visible()) return;
  st.dirty = false;
  setImageFromSpec(st.liveSpec);
  draw();
}, REDRAW_MS);

// The reference picture for a (width x bins) spectrogram, row 0 (the first
// Doppler bin) on top, as the desktop shows it after its row flip.
function setImageFromSpec(spec) {
  const D = DOPPLER_BINS, W = st.width;
  if (!spec) { st.image = null; return; }
  const rgb = referenceRgb(spec, W, D, currentJetVmin());
  const c = st.image?.canvas?.width === W && st.image.canvas.height === D ? st.image.canvas : new OffscreenCanvas(W, D);
  const rgba = new Uint8ClampedArray(W * D * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255; }
  c.getContext('2d').putImageData(new ImageData(rgba, W, D), 0, 0);
  st.image = { canvas: c, cols: W, rows: D };
}

// Snapping works on the picture's rows counted from the bottom, so a traced
// point and the bin it snaps to agree with what is on screen
function snapSpecFrom(spec) {
  const D = DOPPLER_BINS, W = st.width, data = new Float64Array(D * W);
  for (let j = 0; j < D; j++) for (let c = 0; c < W; c++) data[j * W + c] = spec[c * D + (D - 1 - j)];
  return { data, rows: D, cols: W };
}

// ══════════════ freeze and resume ══════════════
let worker = null, freezeId = 0;
function drawRecorded(frames) {
  worker ??= new Worker(new URL('../curvefit/worker.js', import.meta.url), { type: 'module' });
  const id = ++freezeId;
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => { if (data.id === id) (data.error ? reject(new Error(data.error)) : resolve(data.spectrogram)); };
    worker.onerror = e => reject(new Error(e.message || 'the drawing worker failed'));
    worker.postMessage({ id, frames, nChirp: N_CHIRP, nSample: N_SAMPLE });
  });
}

async function freeze() {
  st.frozen = true;
  st.frozenRef = false;
  // Until the reference drawing arrives, trace on the live picture
  st.snapSpec = st.liveSpec ? snapSpecFrom(st.liveSpec) : null;
  $('cfSpecHeading').textContent = 'Frozen Spectrogram (app view)';
  sync();
  draw();
  if (st.raw.length) {
    const id = freezeId + 1;
    setStatus('Drawing the frozen window the reference way...');
    $('cfFreezeBtn').disabled = true;
    try {
      const D = DOPPLER_BINS, W = st.width;
      const frames = st.raw.slice();
      const spectrogram = await drawRecorded(frames);
      if (!st.frozen || id !== freezeId) return;              // resumed, or frozen again, meanwhile
      const n = frames.length;
      let spec = spectrogram;
      if (n < W) {
        // Pad the front with the window's floor, as the desktop does
        let min = Infinity;
        for (const x of spectrogram) min = Math.min(min, x);
        spec = new Float64Array(W * D).fill(min);
        spec.set(spectrogram, (W - n) * D);
      }
      setImageFromSpec(spec);
      st.snapSpec = snapSpecFrom(spec);
      st.frozenRef = true;
      $('cfSpecHeading').textContent = 'Frozen Spectrogram (reference script)';
      draw();
    } catch (e) {
      setStatus(`Reference drawing unavailable: ${e.message}`, true);
      sync();
      return;
    }
  }
  sync();
  if (!st.tracing) setStatus('Frozen. Start Trace, then drag across the curve.');
  else setStatus('Drag across the curve to trace it.');
}

function resume() {
  st.frozen = false;
  st.frozenRef = false;
  st.snapSpec = null;
  if (st.tracing) setTracing(false);
  setImageFromSpec(st.liveSpec);
  $('cfSpecHeading').textContent = 'Live Spectrogram';
  sync();
  draw();
  setStatus('Live.');
}

// ══════════════ spectrogram plot ══════════════
const plotCanvas = $('cfPlot');
const PAD = { l: 58, r: 14, t: 12, b: 42 };
function plotBox() {
  const r = plotCanvas.getBoundingClientRect();
  return { x: PAD.l, y: PAD.t, w: Math.max(10, r.width - PAD.l - PAD.r), h: Math.max(10, r.height - PAD.t - PAD.b), W: r.width, H: r.height };
}
const tToX = (t, b) => b.x + (t - st.view[0]) / (st.view[1] - st.view[0]) * b.w;
const vToY = (v, b) => b.y + (VIEW_VEL - v) / (2 * VIEW_VEL) * b.h;
const xToT = (x, b) => st.view[0] + (x - b.x) / b.w * (st.view[1] - st.view[0]);
const yToV = (y, b) => VIEW_VEL - (y - b.y) / b.h * (2 * VIEW_VEL);

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function fit2d(canvas) {
  const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function axes(ctx, b, xr, yr, { xLabel, yLabel, grid = false, fg, gridColor }) {
  const font = px => `${px}px ${css('--font') || 'system-ui, sans-serif'}`;
  const xt = axisTicks(xr[0], xr[1], Math.max(2, Math.floor(b.w / 70)));
  const yt = axisTicks(yr[0], yr[1], Math.max(2, Math.floor(b.h / 40)));
  const px = x => b.x + (x - xr[0]) / (xr[1] - xr[0]) * b.w, py = y => b.y + (1 - (y - yr[0]) / (yr[1] - yr[0])) * b.h;
  if (grid) {
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    for (const t of xt) { const x = Math.round(px(t.value)) + 0.5; ctx.beginPath(); ctx.moveTo(x, b.y); ctx.lineTo(x, b.y + b.h); ctx.stroke(); }
    for (const t of yt) { const y = Math.round(py(t.value)) + 0.5; ctx.beginPath(); ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y); ctx.stroke(); }
  }
  ctx.strokeStyle = fg; ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, Math.round(b.w), Math.round(b.h));
  ctx.fillStyle = fg; ctx.font = font(11);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of xt) { const x = px(t.value); ctx.beginPath(); ctx.moveTo(x, b.y + b.h); ctx.lineTo(x, b.y + b.h + 4); ctx.stroke(); ctx.fillText(t.label, x, b.y + b.h + 6); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const t of yt) { const y = py(t.value); ctx.beginPath(); ctx.moveTo(b.x - 4, y); ctx.lineTo(b.x, y); ctx.stroke(); ctx.fillText(t.label, b.x - 6, y); }
  ctx.font = font(12); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(xLabel, b.x + b.w / 2, b.y + b.h + 38);
  ctx.save(); ctx.translate(14, b.y + b.h / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(yLabel, 0, 0); ctx.restore();
}

function draw() {
  if (!visible()) return;
  const ctx = fit2d(plotCanvas), b = plotBox();
  ctx.fillStyle = css('--panel'); ctx.fillRect(0, 0, b.W, b.H);
  ctx.fillStyle = '#00008F';                         // the desktop's plot background (jet's floor)
  ctx.fillRect(b.x, b.y, b.w, b.h);
  if (st.image) {
    // Crop the picture to the shown time range and +/- 3 m/s. Columns span
    // [c, c + 1) * timeScale; rows span the full +/- max speed, top row on top.
    const ts = timeScale(), vs = velScale(), D = st.image.rows;
    const sx = st.view[0] / ts, sw = (st.view[1] - st.view[0]) / ts;
    const sy = (MAX_SPEED - VIEW_VEL) / vs, sh = (2 * VIEW_VEL) / vs;
    ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(st.image.canvas, sx, Math.max(0, sy), sw, Math.min(D, sh), b.x, b.y, b.w, b.h);
    ctx.restore();
  }
  if (st.points.length) {
    ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
    ctx.strokeStyle = TRACE_COLOR; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    st.points.forEach(([t, v], i) => { const x = tToX(t, b), y = vToY(v, b); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.restore();
  }
  axes(ctx, b, st.view, [-VIEW_VEL, VIEW_VEL], { xLabel: 'Time (s)', yLabel: 'Velocity (m/s)', fg: css('--subtext') });
  plotCanvas.style.cursor = st.tracing ? 'crosshair' : 'grab';
}

// ══════════════ fitted curve plot ══════════════
const fitCanvas = $('cfFitPlot');
function drawFit() {
  if (!visible()) return;
  const ctx = fit2d(fitCanvas), r = fitCanvas.getBoundingClientRect();
  const b = { x: PAD.l, y: PAD.t, w: Math.max(10, r.width - PAD.l - PAD.r), h: Math.max(10, r.height - PAD.t - PAD.b) };
  ctx.fillStyle = css('--panel'); ctx.fillRect(0, 0, r.width, r.height);
  const f = st.fit;
  let xr = [0, 1], yr = [-1, 1], line = null;
  if (f) {
    const t0 = f.t[0], t1 = f.t[f.t.length - 1];
    const ts = Array.from({ length: 400 }, (_, i) => t0 + (t1 - t0) * i / 399);
    line = { ts, vs: f.predict(ts) };
    const ys = [...f.v, ...line.vs];
    const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo || 1) * 0.08;
    const tp = (t1 - t0 || 1) * 0.03;
    xr = [t0 - tp, t1 + tp]; yr = [lo - pad, hi + pad];
  }
  axes(ctx, b, xr, yr, { xLabel: 'Time (s)', yLabel: 'Velocity (m/s)', grid: true, fg: css('--subtext'), gridColor: css('--divider') });
  if (!f) return;
  const px = x => b.x + (x - xr[0]) / (xr[1] - xr[0]) * b.w, py = y => b.y + (1 - (y - yr[0]) / (yr[1] - yr[0])) * b.h;
  ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
  ctx.fillStyle = TRACE_COLOR;
  f.t.forEach((t, i) => { ctx.beginPath(); ctx.arc(px(t), py(f.v[i]), 3.5, 0, 2 * Math.PI); ctx.fill(); });
  ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2;
  ctx.beginPath();
  line.ts.forEach((t, i) => { const x = px(t), y = py(line.vs[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.restore();
}

// ══════════════ time axis ══════════════
function syncViewInputs() {
  $('cfFrom').value = st.view[0].toFixed(1);
  $('cfTo').value = st.view[1].toFixed(1);
  $('cfFrom').max = $('cfTo').max = String(st.window);
}
function setView(t0, t1) {
  const minSpan = 0.5;
  t0 = Math.max(0, Math.min(t0, st.window - minSpan));
  t1 = Math.min(st.window, Math.max(t1, t0 + minSpan));
  st.view = [t0, t1];
  syncViewInputs();
  draw();
}

// ══════════════ tracing ══════════════
function setTracing(on) {
  if (on && !st.frozen) freeze();       // tracing a moving picture would fit a curve that has already gone
  st.tracing = on;
  st.drawing = false;
  $('cfTraceBtn').textContent = on ? '✎  Stop Trace' : '✎  Start Trace';
  $('cfTraceBtn').classList.toggle('checked', on);
  if (on) setStatus('Drag across the curve to trace it.');
  draw();
}

function addPoint(e) {
  const b = plotBox(), r = plotCanvas.getBoundingClientRect();
  const t = Math.min(st.window, Math.max(0, xToT(e.clientX - r.left, b)));
  const v = Math.min(MAX_SPEED, Math.max(-MAX_SPEED, yToV(e.clientY - r.top, b)));
  st.points.push([t, v]);
  draw();
  sync();
}

let pan = null;
plotCanvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  plotCanvas.setPointerCapture(e.pointerId);
  if (st.tracing) { st.drawing = true; addPoint(e); return; }
  pan = { x: e.clientX, view: st.view.slice() };
  plotCanvas.style.cursor = 'grabbing';
});
plotCanvas.addEventListener('pointermove', e => {
  if (st.tracing && st.drawing) { addPoint(e); return; }
  if (pan) {
    const b = plotBox(), dt = (e.clientX - pan.x) / b.w * (pan.view[1] - pan.view[0]);
    const span = pan.view[1] - pan.view[0];
    const t0 = Math.max(0, Math.min(st.window - span, pan.view[0] - dt));
    setView(t0, t0 + span);
  }
});
const endPointer = e => {
  if (st.tracing && st.drawing) { addPoint(e); st.drawing = false; }
  if (pan) { pan = null; plotCanvas.style.cursor = st.tracing ? 'crosshair' : 'grab'; }
};
plotCanvas.addEventListener('pointerup', endPointer);
plotCanvas.addEventListener('pointercancel', () => { st.drawing = false; pan = null; });
plotCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const b = plotBox(), r = plotCanvas.getBoundingClientRect();
  const at = Math.min(st.view[1], Math.max(st.view[0], xToT(e.clientX - r.left, b)));
  const k = Math.exp(e.deltaY * 0.0015);
  setView(at - (at - st.view[0]) * k, at + (st.view[1] - at) * k);
}, { passive: false });

function clearTrace() {
  st.points = [];
  st.fit = null;
  $('cfEquation').textContent = IDLE_TEXT;
  $('cfPhysics').hidden = true;
  draw(); drawFit(); sync();
  setStatus('Trace cleared.');
}

// ══════════════ fitting ══════════════
const model = () => ($('cfModelDamped').checked ? MODEL_DAMPED : MODEL_SINUSOID);
const components = () => Number($('cfCurves').value);

function renderFreqInputs() {
  const k = components(), box = $('cfFreqs');
  const old = [...box.querySelectorAll('input')].map(i => i.value);
  box.replaceChildren();
  for (let j = 0; j < k; j++) {
    const row = document.createElement('label');
    row.className = 'cf-freq-row';
    row.innerHTML = `<span>${k === 1 ? 'Starting frequency' : `Curve ${j + 1}`}</span><input type="number" min="0" step="0.05" placeholder="auto" aria-label="Starting frequency for curve ${j + 1}, Hz"><span class="cf-unit">Hz</span>`;
    row.querySelector('input').value = old[j] ?? '';
    box.append(row);
  }
}

function onFit() {
  let points = st.points.slice();
  if ($('cfSnap').checked && st.snapSpec) points = snapToPeakView(points);
  const startFreqs = [...$('cfFreqs').querySelectorAll('input')].map(i => (i.value === '' ? null : Number(i.value)));
  const r = fitCurve(points, model(), { components: components(), startFreqs });
  if (!r.ok) {
    st.fit = null; drawFit();
    $('cfPhysics').hidden = true;
    $('cfEquation').textContent = r.message;
    setStatus(r.message, true);
    return;
  }
  st.fit = r;
  drawFit();
  $('cfEquation').textContent = `${r.equation}\n${r.paramText}\nR² = ${r.rSquared.toFixed(4)}`;
  $('cfPhysics').textContent = r.physics;
  $('cfPhysics').hidden = !r.physics;
  setStatus(`Fitted ${r.t.length} points, R² = ${r.rSquared.toFixed(3)}`);
}
const snapToPeakView = points => snapToPeak(points, st.snapSpec, timeScale(), velScale());

// ══════════════ state ══════════════
function sync() {
  $('cfFreezeBtn').disabled = st.frozen;
  $('cfResumeBtn').disabled = !st.frozen;
  $('cfClearBtn').disabled = !st.points.length;
  $('cfFitBtn').disabled = st.points.length < MIN_TRACE_POINTS;
  $('cfWindow').disabled = st.frozen;
  $('cfWindowNote').hidden = !st.frozen;
}
function setStatus(msg, error = false) {
  const el = $('cfStatus');
  el.textContent = msg;
  el.className = error ? 'cf-status err' : 'cf-status';
}

// ══════════════ wiring ══════════════
export function initCurveFit() {
  $('cfFreezeBtn').onclick = freeze;
  $('cfResumeBtn').onclick = resume;
  $('cfTraceBtn').onclick = () => setTracing(!st.tracing);
  $('cfClearBtn').onclick = clearTrace;
  $('cfFitBtn').onclick = onFit;
  $('cfCurves').onchange = renderFreqInputs;
  let timer = null;
  $('cfWindow').oninput = () => {
    st.window = Number($('cfWindow').value);
    $('cfWindowValue').textContent = `${st.window} s`;
    clearTimeout(timer);
    timer = setTimeout(() => { clearTrace(); rebuild(); setStatus(`Time window ${st.window} s. Live.`); }, REBUILD_MS);
  };
  const applyRange = () => setView(Number($('cfFrom').value), Number($('cfTo').value));
  $('cfFrom').onchange = applyRange;
  $('cfTo').onchange = applyRange;
  $('cfViewReset').onclick = () => setView(0, st.window);
  onReduceNoiseChange(() => { if (!st.frozen) { setImageFromSpec(st.liveSpec); draw(); } });
  new ResizeObserver(() => { draw(); drawFit(); }).observe($('cfPlotWrap'));
  new ResizeObserver(drawFit).observe(fitCanvas);
  renderFreqInputs();
  rebuild();
  $('cfEquation').textContent = IDLE_TEXT;
  sync();
}
export function showCurveFit() { requestAnimationFrame(() => { draw(); drawFit(); }); }
