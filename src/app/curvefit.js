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
//   - one to four sinusoids, each with an optional starting frequency,
//   - an Exponential model,
//   - the picture can be the range map (distance over time, range_map_live.py)
//     with MTI on or off and a configurable distance, shared with Visualize,
//   - Auto Fit: the curve is found in the picture, and its positive and
//     negative peaks give the fit its starting point,
//   - the result is shown as cards a student can read: the equation, what
//     every letter means, and what the fit predicts.

import { RdmComputer } from '../dsp/doppler_live.js';
import { LiveProcessorClient } from '../dsp/live_client.js';
import { RangeMapClient } from '../dsp/range_client.js';
import { rangeAxisM, rangeJetClim } from '../dsp/range_map.js';
import { shownBins } from '../viz/range_plot.js';
import { JET_LUT_BYTES, lutIndex } from '../viz/jet.js';
import { referenceRgb } from '../collect/training_image.js';
import { axisTicks } from '../viz/ticks.js';
import { subscribeFrames } from './radar_session.js';
import { currentJetVmin, onReduceNoiseChange, getRangeSettings, setRangeSettings, onRangeSettingsChange, rangeMode, RANGE_MAX_M } from './settings.js';
import { fitCurve, snapToPeak, autoTrace, cleanTrace, findPeaks, peakStart, MODEL_SINUSOID, MODEL_DAMPED, MODEL_EXP, MODEL_LABELS } from '../curvefit/fit.js';
import { explainFit, explainPeaks } from '../curvefit/explain.js';

const FPS = 10;
const REDRAW_MS = 200;
const REBUILD_MS = 300;
const MAX_SPEED = 4.112380411522634;          // the reference script's velocity axis
const VIEW_VEL = 3;                    // shown velocity range, +/- m/s (team feedback)
const STILL_BAND = 0.1;                // m/s around 0 that Auto Fit ignores on the spectrogram (things standing still)
const TRACE_COLOR = '#ff00ff';
const PEAK_UP = '#e8590c', PEAK_DOWN = '#0ca678';
const MIN_TRACE_POINTS = 10;
const N_CHIRP = 128, N_SAMPLE = 256;
const IDLE_TEXT = 'Freeze the display, trace a curve (or press Auto Fit), then fit a model to it.';

const $ = id => document.getElementById(id);
const pane = $('curvefitPane');
const visible = () => !pane.hidden;

const st = {
  kind: 'doppler',           // the picture: 'doppler' (speed) or 'range' (distance)
  window: 5,                 // seconds of history
  width: 50,                 // frames (columns) in the window
  proc: null,               // LiveProcessorClient (worker)
  rangeProc: null,          // RangeMapClient (worker)
  raw: [],                   // raw antenna-0 frames, one window's worth
  liveSpec: null,            // (width x bins) dB, oldest first
  shownSpec: null,           // the spectrogram behind the picture on screen
  dirty: false,
  frozen: false,
  frozenRef: false,
  image: null,               // { canvas, cols, rows } the picture on screen
  snapSpec: null,            // { data, rows, cols }, row 0 the bottom of the axis
  view: [0, 5],              // shown time range
  tracing: false,
  drawing: false,
  points: [],
  auto: false,               // the points came from Auto Fit
  peaks: null,               // findPeaks of the fitted trace
  fit: null,
};
const DOPPLER_BINS = new RdmComputer(N_SAMPLE, N_CHIRP).dopplerFftSize;
const RANGE_BINS = N_SAMPLE * 2;                                  // range_map.py: 4x padding, positive half
const RANGE_M = rangeAxisM(RANGE_BINS, N_SAMPLE * 4, { nSample: N_SAMPLE });
const RANGE_STEP = RANGE_M[1] - RANGE_M[0];
const timeScale = () => st.window / st.width;
const velScale = () => (2 * MAX_SPEED) / DOPPLER_BINS;

// What the vertical axis is for the current picture
function axis() {
  if (st.kind === 'range') {
    const { min, max } = getRangeSettings();
    return {
      quantity: 'range', label: 'Distance from radar (m)', unit: 'm', yr: [min, max], rows: RANGE_BINS,
      scale: RANGE_STEP, rowOffset: 0, top: RANGE_M[RANGE_BINS - 1] + RANGE_STEP / 2,
    };
  }
  return {
    quantity: 'velocity', label: 'Velocity (m/s)', unit: 'm/s', yr: [-VIEW_VEL, VIEW_VEL], rows: DOPPLER_BINS,
    scale: velScale(), rowOffset: DOPPLER_BINS / 2, top: MAX_SPEED,
  };
}

// ══════════════ live buffer ══════════════
function rebuild() {
  st.width = Math.max(2, Math.round(st.window * FPS));
  st.raw = [];
  st.liveSpec = null;
  if (st.kind === 'range') {
    st.rangeProc ??= new RangeMapClient(r => { if (!st.frozen && st.kind === 'range' && r.kind === 'live') { st.liveSpec = r.history; st.dirty = true; } });
    st.rangeProc.reset({ nSample: N_SAMPLE, nChirp: N_CHIRP, historyLength: st.width, mode: rangeMode() });
  } else {
    st.proc ??= new LiveProcessorClient(({ history }) => { if (!st.frozen && st.kind === 'doppler') { st.liveSpec = history; st.dirty = true; } });
    st.proc.reset({ nSample: N_SAMPLE, nChirp: N_CHIRP, historyLength: st.width });
  }
  st.view = [0, st.window];
  syncViewInputs();
  setImageFromSpec(null);
  draw();
}

subscribeFrames(cube => {
  if (st.frozen || !visible()) return;
  const a0 = cube.slice(0, N_CHIRP * N_SAMPLE);
  if (st.kind === 'range') { st.rangeProc.push(a0); return; }
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

// The picture for a (width x bins) spectrogram or range map, with the top of
// the axis in row 0: for the spectrogram the reference picture, as the
// desktop shows it after its row flip; for the range map the farthest bin on
// top, coloured over the distance shown as on the Visualize tab.
function setImageFromSpec(spec) {
  st.shownSpec = spec;
  if (!spec) { st.image = null; return; }
  const W = st.width, D = st.kind === 'range' ? RANGE_BINS : DOPPLER_BINS;
  const rgba = new Uint8ClampedArray(W * D * 4);
  if (st.kind === 'range') {
    const { min, max } = getRangeSettings(), { lo, hi } = shownBins(RANGE_M, { min, max });
    const inside = new Float64Array(W * (hi - lo + 1));
    for (let c = 0, i = 0; c < W; c++) for (let b = lo; b <= hi; b++) inside[i++] = spec[c * D + b];
    const { vmin, vmax } = rangeJetClim(inside, currentJetVmin());
    for (let row = 0; row < D; row++) {
      const b = D - 1 - row;
      for (let c = 0; c < W; c++) {
        const v = vmin === vmax ? 0 : (Math.min(vmax, Math.max(vmin, spec[c * D + b])) - vmin) / (vmax - vmin);
        const k = lutIndex(v) * 3, j = (row * W + c) * 4;
        rgba[j] = JET_LUT_BYTES[k]; rgba[j + 1] = JET_LUT_BYTES[k + 1]; rgba[j + 2] = JET_LUT_BYTES[k + 2]; rgba[j + 3] = 255;
      }
    }
  } else {
    const rgb = referenceRgb(spec, W, D, currentJetVmin());
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255; }
  }
  const c = st.image?.canvas?.width === W && st.image.canvas.height === D ? st.image.canvas : new OffscreenCanvas(W, D);
  c.getContext('2d').putImageData(new ImageData(rgba, W, D), 0, 0);
  st.image = { canvas: c, cols: W, rows: D };
}

// Snapping and Auto Fit work on the picture's rows counted from the bottom,
// so a traced point and the bin it snaps to agree with what is on screen
function snapSpecFrom(spec) {
  const D = st.kind === 'range' ? RANGE_BINS : DOPPLER_BINS, W = st.width, data = new Float64Array(D * W);
  if (st.kind === 'range') for (let j = 0; j < D; j++) for (let c = 0; c < W; c++) data[j * W + c] = spec[c * D + j];
  else for (let j = 0; j < D; j++) for (let c = 0; c < W; c++) data[j * W + c] = spec[c * D + (D - 1 - j)];
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

const liveHeading = () => (st.kind === 'range' ? `Live Range Map (MTI ${rangeMode() === 'mti' ? 'on' : 'off'})` : 'Live Spectrogram');

async function freeze() {
  st.frozen = true;
  st.frozenRef = false;
  // Until the reference drawing arrives, trace on the live picture
  st.snapSpec = st.liveSpec ? snapSpecFrom(st.liveSpec) : null;
  if (st.kind === 'range') {
    // The live range map is already range_map_live.py's own picture
    st.frozenRef = true;
    $('cfSpecHeading').textContent = `Frozen Range Map (MTI ${rangeMode() === 'mti' ? 'on' : 'off'})`;
    sync(); draw();
    if (!st.tracing) setStatus('Frozen. Start Trace and drag across the curve, or press Auto Fit.');
    return;
  }
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
      if (!st.frozen || id !== freezeId || st.kind !== 'doppler') return;   // resumed, switched, or frozen again meanwhile
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
  if (!st.tracing) setStatus('Frozen. Start Trace and drag across the curve, or press Auto Fit.');
  else setStatus('Drag across the curve to trace it.');
}

function resume() {
  st.frozen = false;
  st.frozenRef = false;
  st.snapSpec = null;
  if (st.tracing) setTracing(false);
  setImageFromSpec(st.liveSpec);
  $('cfSpecHeading').textContent = liveHeading();
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
const vToY = (v, b, yr = axis().yr) => b.y + (yr[1] - v) / (yr[1] - yr[0]) * b.h;
const xToT = (x, b) => st.view[0] + (x - b.x) / b.w * (st.view[1] - st.view[0]);
const yToV = (y, b, yr = axis().yr) => yr[1] - (y - b.y) / b.h * (yr[1] - yr[0]);

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

function triangle(ctx, x, y, up, size = 6) {
  ctx.beginPath();
  if (up) { ctx.moveTo(x, y - size); ctx.lineTo(x + size, y + size * 0.7); ctx.lineTo(x - size, y + size * 0.7); }
  else { ctx.moveTo(x, y + size); ctx.lineTo(x + size, y - size * 0.7); ctx.lineTo(x - size, y - size * 0.7); }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function draw() {
  if (!visible()) return;
  const ctx = fit2d(plotCanvas), b = plotBox(), a = axis();
  ctx.fillStyle = css('--panel'); ctx.fillRect(0, 0, b.W, b.H);
  ctx.fillStyle = '#00008F';                         // the desktop's plot background (jet's floor)
  ctx.fillRect(b.x, b.y, b.w, b.h);
  if (st.image) {
    // Crop the picture to the shown time range and the shown part of the
    // axis. Columns span [c, c + 1) * timeScale; row 0 is the top of the axis.
    const ts = timeScale(), D = st.image.rows;
    const sx = st.view[0] / ts, sw = (st.view[1] - st.view[0]) / ts;
    const sy = (a.top - a.yr[1]) / a.scale, sh = (a.yr[1] - a.yr[0]) / a.scale;
    ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(st.image.canvas, sx, Math.max(0, sy), sw, Math.min(D, sh), b.x, b.y, b.w, b.h);
    ctx.restore();
  }
  if (st.points.length) {
    ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
    ctx.strokeStyle = TRACE_COLOR; ctx.fillStyle = TRACE_COLOR; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    if (st.auto) {
      // Found, not drawn: dots, since columns without a clear signal are skipped
      for (const [t, v] of st.points) { ctx.beginPath(); ctx.arc(tToX(t, b), vToY(v, b), 2.5, 0, 2 * Math.PI); ctx.fill(); }
    } else {
      ctx.beginPath();
      st.points.forEach(([t, v], i) => { const x = tToX(t, b), y = vToY(v, b); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
    if (st.peaks) {
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff';
      for (const p of st.peaks.all) { ctx.fillStyle = p.sign > 0 ? PEAK_UP : PEAK_DOWN; triangle(ctx, tToX(p.t, b), vToY(p.v, b), p.sign > 0, 7); }
    }
    ctx.restore();
  }
  axes(ctx, b, st.view, a.yr, { xLabel: 'Time (s)', yLabel: a.label, fg: css('--subtext') });
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
    const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo || 1) * 0.1;
    const tp = (t1 - t0 || 1) * 0.03;
    xr = [t0 - tp, t1 + tp]; yr = [lo - pad, hi + pad];
  }
  const label = f?.quantity === 'range' ? 'Distance (m)' : f ? 'Velocity (m/s)' : axis().label;
  axes(ctx, b, xr, yr, { xLabel: 'Time (s)', yLabel: label, grid: true, fg: css('--subtext'), gridColor: css('--divider') });
  if (!f) return;
  const px = x => b.x + (x - xr[0]) / (xr[1] - xr[0]) * b.w, py = y => b.y + (1 - (y - yr[0]) / (yr[1] - yr[0])) * b.h;
  ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
  ctx.fillStyle = TRACE_COLOR;
  f.t.forEach((t, i) => { ctx.beginPath(); ctx.arc(px(t), py(f.v[i]), 3, 0, 2 * Math.PI); ctx.fill(); });
  ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2.5;
  ctx.beginPath();
  line.ts.forEach((t, i) => { const x = px(t), y = py(line.vs[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.stroke();
  if (st.peaks) {
    ctx.lineWidth = 1.5; ctx.strokeStyle = css('--panel');
    for (const p of st.peaks.all) { ctx.fillStyle = p.sign > 0 ? PEAK_UP : PEAK_DOWN; triangle(ctx, px(p.t), py(p.v), p.sign > 0, 7); }
  }
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
  if (st.auto) { st.points = []; st.auto = false; st.peaks = null; }    // drawing by hand replaces what Auto Fit found
  const b = plotBox(), r = plotCanvas.getBoundingClientRect(), { yr } = axis();
  const t = Math.min(st.window, Math.max(0, xToT(e.clientX - r.left, b)));
  const v = Math.min(yr[1], Math.max(yr[0], yToV(e.clientY - r.top, b)));
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

function clearTrace(quiet = false) {
  st.points = [];
  st.auto = false;
  st.peaks = null;
  st.fit = null;
  showIdle(IDLE_TEXT);
  draw(); drawFit(); sync();
  if (!quiet) setStatus('Trace cleared.');
}

// ══════════════ fitting ══════════════
const model = () => ($('cfModelDamped').checked ? MODEL_DAMPED : $('cfModelExp').checked ? MODEL_EXP : MODEL_SINUSOID);
const components = () => (model() === MODEL_EXP ? 1 : Number($('cfCurves').value));

function renderFreqInputs() {
  const k = Number($('cfCurves').value), box = $('cfFreqs');
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
function syncModelInputs() { $('cfSineOpts').hidden = model() === MODEL_EXP; }

function onFit() {
  const a = axis();
  let points = st.points.slice();
  if (!st.auto && $('cfSnap').checked && st.snapSpec) points = snapToPeak(points, st.snapSpec, timeScale(), a.scale, 20, a.rowOffset);
  const startFreqs = model() === MODEL_EXP ? [] : [...$('cfFreqs').querySelectorAll('input')].map(i => (i.value === '' ? null : Number(i.value)));
  // The positive and negative peaks of the trace give a starting point of
  // their own; the fit keeps whichever start ends lower
  const { t, v } = cleanTrace(points);
  const peaks = model() === MODEL_EXP ? null : findPeaks(t, v);
  const fromPeaks = peaks && components() === 1 && !(startFreqs[0] > 0) ? peakStart(model(), peaks) : null;
  const r = fitCurve(points, model(), { components: components(), startFreqs, quantity: a.quantity, extraStarts: fromPeaks ? [fromPeaks.params] : [] });
  if (!r.ok) {
    st.fit = null; st.peaks = null; drawFit(); draw();
    showIdle(r.message, true);
    setStatus(r.message, true);
    return false;
  }
  st.fit = r;
  st.peaks = peaks && peaks.all.length ? peaks : null;
  drawFit(); draw();
  renderResults(r, st.peaks);
  setStatus(`Fitted ${r.t.length} points, R² = ${r.rSquared.toFixed(3)}`);
  return true;
}

// Auto Fit: freeze, find the curve in the picture (the strongest signal in
// each column of the shown time range), then fit it from its peaks
async function autoFit() {
  if (st.tracing) setTracing(false);
  if (!st.frozen || !st.frozenRef) await freeze();
  if (!st.snapSpec) { setStatus('Nothing to fit yet: connect the radar and let the picture fill first.', true); return; }
  const a = axis();
  const pts = autoTrace(st.snapSpec, {
    timeScale: timeScale(), scale: a.scale, rowOffset: a.rowOffset, yRange: a.yr,
    deadZone: st.kind === 'doppler' ? STILL_BAND : 0,
  }).filter(([t]) => t >= st.view[0] && t <= st.view[1]);
  if (pts.length < MIN_TRACE_POINTS) {
    st.points = []; st.auto = false; st.peaks = null; st.fit = null;
    draw(); drawFit(); sync();
    const msg = `Auto Fit found a clear signal in only ${pts.length} moment${pts.length === 1 ? '' : 's'}; it needs ${MIN_TRACE_POINTS}. ` +
      (st.kind === 'range' ? 'Try turning MTI on, or narrow the distance shown to where the target is.' : 'Move the target in front of the radar, then freeze again.');
    showIdle(msg, true);
    setStatus(msg, true);
    return;
  }
  st.points = pts;
  st.auto = true;
  sync();
  if (onFit()) setStatus(`Auto Fit: ${pts.length} points found, R² = ${st.fit.rSquared.toFixed(3)}`);
}

// ══════════════ results ══════════════
function showIdle(text, error = false) {
  const p = document.createElement('p');
  p.className = error ? 'cf-idle err' : 'cf-idle';
  p.textContent = text;
  $('cfResults').replaceChildren(p);
}

function card({ sym, name, value, unit, meaning }) {
  return `<div class="cf-param">
      <div class="cf-param-top">${sym ? `<span class="cf-sym">${sym}</span>` : ''}<span class="cf-pname">${name}</span></div>
      <div class="cf-val">${value}<small>${unit}</small></div>
      <div class="cf-meaning">${meaning}</div>
    </div>`;
}

function renderResults(r, peaks) {
  const x = explainFit(r);
  let groups = '', lastGroup = '';
  for (const p of x.params) {
    if (p.group && p.group !== lastGroup) { groups += `<div class="cf-group">${p.group}</div>`; lastGroup = p.group; }
    else if (!p.group && lastGroup) { groups += '<div class="cf-group">Whole curve</div>'; lastGroup = ''; }
    groups += card(p);
  }
  const y = r.quantity === 'range' ? '<i>r</i>(<i>t</i>)' : '<i>v</i>(<i>t</i>)';
  const peaksText = explainPeaks(peaks, x.unit);
  $('cfResults').innerHTML = `
    <div class="cf-res-head">
      <h3>Your fitted curve: ${MODEL_LABELS[r.model]}${r.components > 1 ? ` × ${r.components}` : ''}</h3>
      <span class="cf-badge ${x.quality.level}" title="R² (R squared) measures how well the curve matches your points.">${x.quality.word}<small>R² = ${r.rSquared.toFixed(3)}</small></span>
    </div>
    <div class="cf-eq-box">
      <span class="cf-kicker">The model</span>
      <div class="cf-eq">${x.general}</div>
      <span class="cf-kicker">With your numbers</span>
      <div class="cf-eq nums">${x.numbers}</div>
    </div>
    <p class="cf-r2-note"><i>t</i> is the time in seconds and ${y} is the ${x.what} at that time, in ${x.unit}. R² is 1 for a perfect match and 0 when the curve is no better than a flat line.</p>
    <h4 class="cf-section-title">What each letter means</h4>
    <div class="cf-params">${groups}</div>
    ${x.results.length ? `<h4 class="cf-section-title">What the fit tells you</h4><div class="cf-predict">${x.results.map(card).join('')}</div>` : ''}
    ${peaksText ? `<div class="cf-peaks">${peaksText}</div>` : ''}`;
}

// ══════════════ picture: spectrogram or range map ══════════════
function syncRangeInputs() {
  const r = getRangeSettings(), trim = v => v.toFixed(2).replace(/\.?0+$/, '') || '0';
  $('cfMtiChk').checked = r.mti;
  $('cfRFrom').value = trim(r.min);
  $('cfRTo').value = trim(r.max);
}

function setKind(kind) {
  st.kind = kind;
  $('cfRangeOpts').hidden = kind !== 'range';
  if (st.tracing) setTracing(false);
  st.frozen = false; st.frozenRef = false; st.snapSpec = null;
  clearTrace(true);
  rebuild();
  $('cfSpecHeading').textContent = liveHeading();
  sync();
  setStatus(kind === 'range' ? 'Range map. Live.' : 'Spectrogram. Live.');
}

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
  $('cfClearBtn').onclick = () => clearTrace();
  $('cfFitBtn').onclick = onFit;
  $('cfAutoBtn').onclick = autoFit;
  $('cfCurves').onchange = renderFreqInputs;
  for (const id of ['cfModelSine', 'cfModelDamped', 'cfModelExp']) $(id).onchange = syncModelInputs;
  $('cfKind').onchange = e => setKind(e.target.value);
  let timer = null;
  $('cfWindow').oninput = () => {
    st.window = Number($('cfWindow').value);
    $('cfWindowValue').textContent = `${st.window} s`;
    clearTimeout(timer);
    timer = setTimeout(() => { clearTrace(true); rebuild(); setStatus(`Time window ${st.window} s. Live.`); }, REBUILD_MS);
  };
  const applyRange = () => setView(Number($('cfFrom').value), Number($('cfTo').value));
  $('cfFrom').onchange = applyRange;
  $('cfTo').onchange = applyRange;
  $('cfViewReset').onclick = () => setView(0, st.window);

  syncRangeInputs();
  $('cfMtiChk').onchange = e => setRangeSettings({ mti: e.target.checked });
  const applyDistance = () => setRangeSettings({ min: Number($('cfRFrom').value), max: Number($('cfRTo').value) });
  $('cfRFrom').onchange = applyDistance;
  $('cfRTo').onchange = applyDistance;
  $('cfRReset').onclick = () => setRangeSettings({ min: 0, max: RANGE_MAX_M });
  onRangeSettingsChange((r, changed) => {
    syncRangeInputs();
    if (st.kind !== 'range') return;
    if (changed.mti) { setKind('range'); return; }       // a new mode starts the history again
    setImageFromSpec(st.shownSpec);                        // the colours follow the distance shown
    draw();
  });

  onReduceNoiseChange(() => { setImageFromSpec(st.shownSpec); draw(); });
  new ResizeObserver(() => { draw(); drawFit(); }).observe($('cfPlotWrap'));
  new ResizeObserver(drawFit).observe(fitCanvas);
  renderFreqInputs();
  syncModelInputs();
  rebuild();
  showIdle(IDLE_TEXT);
  sync();
}
export function showCurveFit() { requestAnimationFrame(() => { draw(); drawFit(); }); }
