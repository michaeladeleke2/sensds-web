// The Visualize tab of SensDSv2 (ui/spectrogram_widget.py VisualizeTab with
// the Infineon SDK method, whose main view is the reference script's live
// plot, ui/reference_view.py ReferenceSpectrogramView):
//   - every frame goes through LiveDopplerProcessor as it arrives,
//   - the plot is redrawn on a 200 ms timer (5 Hz) with the newest history,
//   - history length = max(10, round(time window * 10)) frames,
//   - changing the time window rebuilds the view after 300 ms (history clears),
//   - Reduce noise switches jet_vmin between -20 and -50 dB and rebuilds the view,
//   - frames are not processed while the tab is hidden (VisualizeTab.on_raw_frame).
// The View choice switches to the range map (range_map_live.py, and
// range_map_v1.py for a whole recording at once); MTI is set in src/config.js.

import { LiveProcessorClient } from '../dsp/live_client.js';
import { LiveSpectrogramPlot } from '../viz/live_plot.js';
import { RangeMapClient } from '../dsp/range_client.js';
import { RangeMapPlot } from '../viz/range_plot.js';
import { rangeMapMode } from '../config.js';
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
  view: (() => { try { return localStorage.getItem('sensds-view') === 'range' ? 'range' : 'doppler'; } catch { return 'doppler'; } })(),
  rangeProc: null,
  rangeRec: 'play',      // a recording in the range view: 'play' like live, or the 'whole' file at once
  rec: null,             // the open recording (for the whole-file range map)
};
const RANGE_MODE = rangeMapMode();
const rangeTitle = live => `Range map (${live ? 'live, ' : ''}${RANGE_MODE === 'mti' ? 'moving' : 'raw'})`;

const visible = () => !pane.hidden;
const historyFrames = () => Math.max(10, Math.round(state.timeWindow * FPS));

// ---------- view (processor + plot), rebuilt like the desktop reference view ----------
function buildView() {
  const { nChirp, nSample } = state.dims;
  $('methodRow').hidden = state.view !== 'doppler';
  $('rangeRecRow').hidden = state.view !== 'range';
  $('viewDesc').textContent = state.view === 'range' ? `512 range bins, 0 to 3.48 m  ·  MTI ${RANGE_MODE === 'mti' ? 'on' : 'off'}` : '';
  if (state.view === 'range') { buildRangeView(); return; }
  state.proc ??= new LiveProcessorClient(({ history, dopplerBins, count }) => { state.count = count; state.pending = { history, count, dopplerBins }; });
  state.proc.reset({ nSample, nChirp, historyLength: historyFrames() });
  state.plot = new LiveSpectrogramPlot(canvas, { historyLength: historyFrames(), maxSpeed: REF_MAX_SPEED_M_S, jetVmin: currentJetVmin() });
  state.count = 0;
  state.pending = null;
  if (visible()) state.plot.drawEmpty();
  updateReadout();
}

function buildRangeView() {
  const { nChirp, nSample } = state.dims;
  state.rangeProc ??= new RangeMapClient(result => { if (result.kind === 'live') state.count = result.count; state.pending = result; });
  state.count = 0;
  state.pending = null;
  const whole = state.rangeRec === 'whole' && state.source;
  state.plot = new RangeMapPlot(canvas, { layout: whole ? 'recording' : 'live', jetVmin: currentJetVmin(), title: rangeTitle(!whole) });
  if (whole) {
    const { rec } = state, per = rec.nChirp * rec.nSample, all = new Float32Array(rec.nFrame * per);
    for (let i = 0; i < rec.nFrame; i++) all.set(rec.antenna0(i), i * per);
    state.rangeProc.whole({ frames: all, nFrame: rec.nFrame, nChirp: rec.nChirp, nSample: rec.nSample, mode: RANGE_MODE });
    setStatus(`${state.source.name}: range map of all ${rec.nFrame} frames`);
  } else state.rangeProc.reset({ nSample, nChirp, historyLength: historyFrames(), mode: RANGE_MODE });
  if (visible()) state.plot.drawEmpty();
  updateReadout();
}

function updateReadout() {
  if (state.view === 'range') {
    const frames = historyFrames();
    $('readout').textContent =
      `Drawn by       range_map${state.rangeRec === 'whole' && state.source ? '_v1' : '_live'}.py\n` +
      `Antenna        ${REF_ANTENNA}\n` +
      `Mode           ${RANGE_MODE === 'mti' ? 'MTI (moving only)' : 'raw (no MTI)'}\n` +
      `History        ${frames} frames (${(frames / 10).toFixed(0)} s)\n` +
      `Range          0 to 3.48 m, 512 bins\n` +
      `Color floor    ${currentJetVmin().toFixed(0)} dB (jet_vmin)\n` +
      `Redraw         ${(1000 / REDRAW_MS).toFixed(0)} per second`;
    return;
  }
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
// The spectrogram is computed in a worker; the newest result waits in
// state.pending for the next redraw
function onFrame(antenna0) {
  if (state.view === 'doppler') state.proc.push(antenna0);
  else if (!(state.rangeRec === 'whole' && state.source)) state.rangeProc.push(antenna0);
}

setInterval(() => {
  if (!state.pending || !visible()) return;
  const p = state.pending;
  state.pending = null;
  if (state.view === 'doppler') { if (p.dopplerBins) state.plot.draw(p.history, p.count, p.dopplerBins); return; }
  if (p.kind === 'live') state.plot.draw({ rows: p.history, nFilled: p.nFilled, nBins: p.nBins, rangeM: p.rangeM, frameEnd: p.count });
  else if (p.kind === 'whole') state.plot.draw({ rows: p.map, nFilled: p.nFrame, nBins: p.nBins, rangeM: p.rangeM, durationS: p.nFrame * 0.1 });
}, REDRAW_MS);

// Live radar frames
subscribeFrames(cube => {
  if (state.capture) takeCaptureFrame(cube);
  if (!visible() || state.source) return;
  const per = state.dims.nChirp * state.dims.nSample;
  onFrame(cube.subarray(REF_ANTENNA * per, (REF_ANTENNA + 1) * per));
  const { frames, drops } = radarStats();
  if (frames % 10 === 0) setStatus(`Radar streaming: frame ${frames}${drops ? `, ${drops} dropped` : ''}.`);
});

// Recording playback: 10 fps without drifting.
let nextDue = 0;
function tick() {
  requestAnimationFrame(tick);
  if (!state.source || state.paused || !visible()) return;
  if (state.view === 'range' && state.rangeRec === 'whole') return;      // drawn once, not played
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
  state.rec = null;
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
    state.rec = rec;
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
$('viewSel').value = state.view;
$('viewSel').onchange = e => {
  state.view = e.target.value;
  try { localStorage.setItem('sensds-view', state.view); } catch { /* this visit only */ }
  buildView();
};
$('rangeRecSel').onchange = e => { state.rangeRec = e.target.value; buildView(); };

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
