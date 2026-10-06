// The Visualize tab of SensDSv2 (ui/spectrogram_widget.py VisualizeTab with
// the Infineon SDK method, whose main view is the reference script's live
// plot, ui/reference_view.py ReferenceSpectrogramView):
//   - every frame goes through LiveDopplerProcessor as it arrives,
//   - the plot is redrawn on a 200 ms timer (5 Hz) with the newest history,
//   - history length = max(10, round(time window * 10)) frames,
//   - changing the time window rebuilds the view after 300 ms (history clears),
//   - Reduce noise switches jet_vmin between -20 and -50 dB and rebuilds the view.

import { LiveDopplerProcessor } from '../dsp/doppler_live.js';
import { LiveSpectrogramPlot } from '../viz/live_plot.js';
import { parseNpy, framesFromNpy, writeNpyFloat32 } from '../io/npy.js';

const FPS = 10;                       // frame_repetition_time_s = 0.1
const REDRAW_MS = 200;                // ReferenceSpectrogramView._REDRAW_MS
const REBUILD_MS = 300;               // VisualizeTab._ref_rebuild interval
const REF_JET_VMIN = -20.0;
const REDUCED_NOISE_JET_VMIN = -50.0;
const REF_MAX_SPEED_M_S = 6.19405905;
const REF_ANTENNA = 0;

const $ = id => document.getElementById(id);
const canvas = $('plot');

const state = {
  timeWindow: 5,
  reduceNoise: false,
  dims: { nChirp: 128, nSample: 256 },
  proc: null,
  plot: null,
  count: 0,
  pending: null,
  source: null,          // { name, next(): Float32Array|null, restart(), total? }
  paused: false,
  index: 0,
};

const historyFrames = () => Math.max(10, Math.round(state.timeWindow * FPS));
const jetVmin = () => (state.reduceNoise ? REDUCED_NOISE_JET_VMIN : REF_JET_VMIN);

// ---------- view (processor + plot), rebuilt like the desktop reference view ----------
function buildView() {
  const { nChirp, nSample } = state.dims;
  state.proc = new LiveDopplerProcessor({ nSample, nChirp, historyLength: historyFrames() });
  state.plot = new LiveSpectrogramPlot(canvas, { historyLength: historyFrames(), maxSpeed: REF_MAX_SPEED_M_S, jetVmin: jetVmin() });
  state.count = 0;
  state.pending = null;
  state.plot.drawEmpty();
  updateReadout();
}

function updateReadout() {
  const frames = state.plot ? state.plot.historyLength : historyFrames();
  const vmin = state.plot ? state.plot.jetVmin : jetVmin();
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

function redraw() {
  if (!state.pending) return;
  const { history, count } = state.pending;
  state.pending = null;
  state.plot.draw(history, count, state.proc.dopplerFftSize);
}
setInterval(redraw, REDRAW_MS);

// Frame clock: delivers frames at 10 fps without drifting.
let nextDue = 0;
function tick() {
  requestAnimationFrame(tick);
  if (!state.source || state.paused) return;
  const now = performance.now();
  if (now < nextDue) return;
  nextDue = Math.max(nextDue + 1000 / FPS, now - 1000 / FPS);
  let frame = state.source.next();
  if (!frame) {
    if ($('loopChk').checked && state.source.restart) { state.source.restart(); frame = state.source.next(); }
    if (!frame) { setStatus(`${state.source.name}: finished after ${state.count} frames.`); stopSource(false); return; }
  }
  onFrame(frame);
  if (state.source.total) setStatus(`${state.source.name}: frame ${state.source.position} of ${state.source.total}`);
}
requestAnimationFrame(tick);

// ---------- sources ----------
function startSource(source, dims) {
  state.source = source;
  state.paused = false;
  if (dims.nChirp !== state.dims.nChirp || dims.nSample !== state.dims.nSample) state.dims = dims;
  buildView();
  nextDue = performance.now();
  $('pauseBtn').disabled = false;
  $('pauseBtn').textContent = 'Pause';
}

function stopSource(clear = true) {
  if (clear) state.source = null;
  state.paused = true;
  $('pauseBtn').disabled = !state.source;
  $('pauseBtn').textContent = 'Resume';
}

function setStatus(text) { $('status').textContent = text; }

$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const rec = framesFromNpy(parseNpy(await file.arrayBuffer()));
    if (radar.device) await disconnectRadar(false);
    const src = {
      name: file.name,
      total: rec.nFrame,
      position: 0,
      next() { if (this.position >= rec.nFrame) return null; return rec.antenna0(this.position++); },
      restart() { this.position = 0; },
    };
    startSource(src, { nChirp: rec.nChirp, nSample: rec.nSample });
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

// ---------- live radar ----------
// The radar code (Strata derived) is loaded only when Connect Radar is clicked,
// so a published build can leave it out and still play recordings.
const radar = { device: null, running: false, drops: 0, capture: null };
const connectBtn = $('connectBtn');

if ('serial' in navigator) {
  connectBtn.disabled = false;
  connectBtn.title = 'Connect to the Infineon radar board over USB and show the live spectrogram.';
} else {
  connectBtn.title = 'This browser has no Web Serial. Use Chrome or Edge on a computer.';
}

connectBtn.onclick = () => (radar.device ? disconnectRadar() : connectRadar());

async function connectRadar() {
  let mod;
  try { mod = await import('../avian/device.js'); }
  catch { setStatus('Live radar is not included in this website build yet. Open a recording instead.'); return; }

  let port;
  try { port = await navigator.serial.requestPort({ filters: [{ usbVendorId: mod.INFINEON_VID }] }); }
  catch { setStatus('No radar selected.'); return; }

  stopSource();                                    // a playing recording gives way to the radar
  connectBtn.disabled = true;
  setStatus('Connecting to the radar…');
  const device = new mod.RadarDevice(port, { log: m => console.debug('[radar]', m) });
  try {
    const { firmware } = await device.open();
    setStatus(`Radar found: BGT60TR13C, firmware ${firmware}. Starting…`);
    await device.start();
  } catch (e) {
    await device.close().catch(() => {});
    connectBtn.disabled = false;
    setStatus(`Could not start the radar: ${e.message}`);
    return;
  }

  radar.device = device;
  radar.running = true;
  radar.drops = 0;
  state.dims = { nChirp: device.acq.numChirps, nSample: device.acq.samplesPerChirp };
  buildView();
  connectBtn.disabled = false;
  connectBtn.textContent = 'Disconnect Radar';
  setStatus('Radar streaming: BGT60TR13C, 3 antennas, 10 frames per second.');
  radarLoop(mod);
}

async function radarLoop(mod) {
  const per = state.dims.nChirp * state.dims.nSample;
  while (radar.running) {
    try {
      const cube = await radar.device.nextFrame();
      if (!radar.running) break;
      if (radar.capture) takeCaptureFrame(cube);
      onFrame(cube.subarray(REF_ANTENNA * per, (REF_ANTENNA + 1) * per));
      if (state.count % 10 === 0) setStatus(`Radar streaming: frame ${state.count}${radar.drops ? `, ${radar.drops} dropped` : ''}.`);
    } catch (e) {
      if (!radar.running) break;
      // Dropped frames are skipped and streaming continues, as in SensDSv2.
      if (e instanceof mod.FrameAcquisitionFailed) { radar.drops++; continue; }
      setStatus(`Radar stopped: ${e.message}`);
      await disconnectRadar(false);
      return;
    }
  }
}

// Saving live frames for comparison with the Python reference.
// In the browser console: sensds.saveFrames(20)
function takeCaptureFrame(cube) {
  const c = radar.capture;
  c.frames.push(cube.slice());
  if (c.frames.length < c.n) return;
  radar.capture = null;
  const per = c.frames[0].length;
  const all = new Float32Array(per * c.n);
  c.frames.forEach((f, i) => all.set(f, i * per));
  const blob = new Blob([writeNpyFloat32(all, [c.n, 3, state.dims.nChirp, state.dims.nSample])], { type: 'application/octet-stream' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `browser_frames_${c.n}.npy` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  c.resolve(`Saved browser_frames_${c.n}.npy`);
}

window.sensds = {
  saveFrames(n = 20) {
    if (!radar.running) return Promise.reject(new Error('Connect the radar first.'));
    return new Promise(resolve => { radar.capture = { n, frames: [], resolve }; });
  },
};

async function disconnectRadar(updateStatus = true) {
  const device = radar.device;
  radar.running = false;
  radar.device = null;
  connectBtn.disabled = true;
  if (device) await device.close();
  connectBtn.disabled = false;
  connectBtn.textContent = 'Connect Radar';
  if (updateStatus) setStatus(`Radar disconnected after ${state.count} frames.`);
}

// ---------- panel controls ----------
let rebuildTimer = null;
$('timeSlider').oninput = e => {
  state.timeWindow = Number(e.target.value);
  $('timeValue').textContent = `${state.timeWindow} s`;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(buildView, REBUILD_MS);   // a dragged slider rebuilds once
};

$('noiseChk').onchange = e => { state.reduceNoise = e.target.checked; buildView(); };

$('sizeSel').onchange = e => { applyPlotSize(e.target.value); };
function applyPlotSize(value) {
  // Maximum, not fixed, so the plot still shrinks on a small screen.
  const [w, h] = value ? value.split('x').map(Number) : [null, null];
  canvas.style.maxWidth = w ? `${w}px` : '';
  canvas.style.maxHeight = h ? `${h}px` : '';
  state.plot?.redraw();
}

new ResizeObserver(() => state.plot?.redraw()).observe(canvas);

buildView();
