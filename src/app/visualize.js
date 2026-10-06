// The Visualize tab of SensDSv2 (ui/spectrogram_widget.py VisualizeTab with
// the Infineon SDK method, whose main view is the reference script's live
// plot, ui/reference_view.py ReferenceSpectrogramView):
//   - every frame goes through LiveDopplerProcessor as it arrives,
//   - the plot is redrawn on a 200 ms timer (5 Hz) with the newest history,
//   - history length = max(10, round(time window * 10)) frames,
//   - changing the time window rebuilds the view after 300 ms (history clears),
//   - Reduce noise switches jet_vmin between -20 and -50 dB and rebuilds the view,
//   - frames are not processed while the tab is hidden (VisualizeTab.on_raw_frame).

import { LiveDopplerProcessor } from '../dsp/doppler_live.js';
import { LiveSpectrogramPlot } from '../viz/live_plot.js';
import { parseNpy, framesFromNpy, writeNpyFloat32 } from '../io/npy.js';
import { subscribeFrames, isConnected, radarStats, disconnectRadar } from './radar_session.js';
import { currentJetVmin, getReduceNoise, setReduceNoise, onReduceNoiseChange } from './settings.js';

const FPS = 10;                       // frame_repetition_time_s = 0.1
const REDRAW_MS = 200;                // ReferenceSpectrogramView._REDRAW_MS
const REBUILD_MS = 300;               // VisualizeTab._ref_rebuild interval
const REF_MAX_SPEED_M_S = 6.19405905;
const REF_ANTENNA = 0;

const $ = id => document.getElementById(id);
const canvas = $('plot');
const pane = $('visualizePane');
let setStatus = () => {};

const state = {
  timeWindow: 5,
  dims: { nChirp: 128, nSample: 256 },
  proc: null,
  plot: null,
  count: 0,
  pending: null,
  source: null,          // a playing recording: { name, next(), restart(), total, position }
  paused: false,
  capture: null,         // sensds.saveFrames in progress
};

const visible = () => !pane.hidden;
const historyFrames = () => Math.max(10, Math.round(state.timeWindow * FPS));

// ---------- view (processor + plot), rebuilt like the desktop reference view ----------
function buildView() {
  const { nChirp, nSample } = state.dims;
  state.proc = new LiveDopplerProcessor({ nSample, nChirp, historyLength: historyFrames() });
  state.plot = new LiveSpectrogramPlot(canvas, { historyLength: historyFrames(), maxSpeed: REF_MAX_SPEED_M_S, jetVmin: currentJetVmin() });
  state.count = 0;
  state.pending = null;
  if (visible()) state.plot.drawEmpty();
  updateReadout();
}

function updateReadout() {
  const frames = state.plot ? state.plot.historyLength : historyFrames();
  const vmin = state.plot ? state.plot.jetVmin : currentJetVmin();
  $('readout').textContent =
    `Drawn by       reference script\n` +
    `Antenna        ${REF_ANTENNA}\n` +
    `History        ${frames} frames (${(frames / 10).toFixed(0)} s)\n` +
    `Velocity       +/-${REF_MAX_SPEED_M_S.toFixed(2)} m/s\n` +
    `Color floor    ${vmin.toFixed(0)} dB (jet_vmin)\n` +
    `Redraw         ${(1000 / REDRAW_MS).toFixed(0)} per second\n` +
    `Toward radar   below the center`;
}

// ---------- frame intake ----------
function onFrame(antenna0) {
  const out = state.proc.processFrame(antenna0);
  state.count += 1;
  state.pending = { history: out.history, count: state.count };   // keep only the newest
}

setInterval(() => {
  if (!state.pending || !visible()) return;
  const { history, count } = state.pending;
  state.pending = null;
  state.plot.draw(history, count, state.proc.dopplerFftSize);
}, REDRAW_MS);

// Live radar frames
subscribeFrames(cube => {
  if (state.capture) takeCaptureFrame(cube);
  if (!visible() || state.source) return;
  const per = state.dims.nChirp * state.dims.nSample;
  onFrame(cube.subarray(REF_ANTENNA * per, (REF_ANTENNA + 1) * per));
  if (state.count % 10 === 0) {
    const { drops } = radarStats();
    setStatus(`Radar streaming: frame ${state.count}${drops ? `, ${drops} dropped` : ''}.`);
  }
});

// Recording playback: 10 fps without drifting.
let nextDue = 0;
function tick() {
  requestAnimationFrame(tick);
  if (!state.source || state.paused || !visible()) return;
  const now = performance.now();
  if (now < nextDue) return;
  nextDue = Math.max(nextDue + 1000 / FPS, now - 1000 / FPS);
  let frame = state.source.next();
  if (!frame) {
    if ($('loopChk').checked) { state.source.restart(); frame = state.source.next(); }
    if (!frame) { setStatus(`${state.source.name}: finished after ${state.count} frames.`); stopSource(); return; }
  }
  onFrame(frame);
  setStatus(`${state.source.name}: frame ${state.source.position} of ${state.source.total}`);
}
requestAnimationFrame(tick);

function stopSource() {
  state.source = null;
  $('pauseBtn').disabled = true;
  $('pauseBtn').textContent = 'Pause';
}

$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const rec = framesFromNpy(parseNpy(await file.arrayBuffer()));
    if (isConnected()) await disconnectRadar();        // a recording takes over the view
    state.source = {
      name: file.name, total: rec.nFrame, position: 0,
      next() { return this.position >= rec.nFrame ? null : rec.antenna0(this.position++); },
      restart() { this.position = 0; },
    };
    state.paused = false;
    state.dims = { nChirp: rec.nChirp, nSample: rec.nSample };
    buildView();
    nextDue = performance.now();
    $('pauseBtn').disabled = false;
    $('pauseBtn').textContent = 'Pause';
    setStatus(`${file.name}: ${rec.nFrame} frames, ${rec.nAnt} antennas, ${rec.nChirp} chirps, ${rec.nSample} samples`);
  } catch (err) {
    setStatus(`Could not open ${file.name}: ${err.message}`);
  }
};

$('pauseBtn').onclick = () => {
  if (!state.source) return;
  state.paused = !state.paused;
  if (!state.paused) nextDue = performance.now();
  $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
};

// ---------- saving live frames for comparison with the Python reference ----------
// In the browser console: sensds.saveFrames(20)
function takeCaptureFrame(cube) {
  const c = state.capture;
  c.frames.push(cube.slice());
  if (c.frames.length < c.n) return;
  state.capture = null;
  const per = c.frames[0].length;
  const all = new Float32Array(per * c.n);
  c.frames.forEach((f, i) => all.set(f, i * per));
  const blob = new Blob([writeNpyFloat32(all, [c.n, 3, 128, 256])], { type: 'application/octet-stream' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `browser_frames_${c.n}.npy` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  c.resolve(`Saved browser_frames_${c.n}.npy`);
}

window.sensds = {
  saveFrames(n = 20) {
    if (!isConnected()) return Promise.reject(new Error('Connect the radar first.'));
    return new Promise(resolve => { state.capture = { n, frames: [], resolve }; });
  },
};

// ---------- panel controls ----------
let rebuildTimer = null;
$('timeSlider').oninput = e => {
  state.timeWindow = Number(e.target.value);
  $('timeValue').textContent = `${state.timeWindow} s`;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(buildView, REBUILD_MS);   // a dragged slider rebuilds once
};

$('noiseChk').checked = getReduceNoise();
$('noiseChk').onchange = e => setReduceNoise(e.target.checked);
onReduceNoiseChange(on => { $('noiseChk').checked = on; buildView(); });

$('sizeSel').onchange = e => {
  // Maximum, not fixed, so the plot still shrinks on a small screen.
  const [w, h] = e.target.value ? e.target.value.split('x').map(Number) : [null, null];
  canvas.style.maxWidth = w ? `${w}px` : '';
  canvas.style.maxHeight = h ? `${h}px` : '';
  state.plot?.redraw();
};

new ResizeObserver(() => { if (visible()) state.plot?.redraw(); }).observe(canvas);

export function initVisualize({ status }) {
  setStatus = status;
  buildView();
}

// Called when the tab is shown again: draw what has been kept.
export function showVisualize() {
  state.plot?.redraw();
  updateReadout();
}

// Live radar starting: the view starts fresh at the radar's frame size.
export function onRadarConnected() {
  stopSource();
  state.dims = { nChirp: 128, nSample: 256 };
  buildView();
}
