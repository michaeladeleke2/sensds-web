// The VEX AIM tab of SensDSv2 (ui/vex_aim_tab.py): drive a VEX AIM robot with
// gestures.
//   Single Command  capture for N seconds, classify, send that one command,
//   RoboSoccer      the robot rolls forward (move_for 500 mm every 0.4 s);
//                   every 20th tick the last frames are classified; a command
//                   above the threshold fires, then a 3 s pause,
//   each class does what Class Actions says. The defaults are the desktop's:
//   swipe_left / swipe_right turn 30 degrees, push kicks hard, idle and any
//   other class send nothing. Five failed drive commands in a row mean the
//   robot is gone.
// The prediction cache, minimum gap between inferences, messages and log are
// the desktop's. Inference uses the Test tab's worker (a separate copy).
//
// The robot speaks plain ws:// on its own WiFi. Chrome (154) lets the https
// site open ws:// to a local network address once the student allows its
// "local network access" prompt; until then the connection fails, and the tab
// shows how to allow it (see docs/procedures/vex_aim.md).

import { LiveProcessorClient } from '../dsp/live_client.js';
import { LiveSpectrogramPlot } from '../viz/live_plot.js';
import { subscribeFrames } from './radar_session.js';
import { currentJetVmin, onReduceNoiseChange } from './settings.js';
import { canChooseFolder } from '../io/folder.js';
import { chooseModelFolder } from './model_folder.js';
import { AimRobot, TurnType, KickType } from '../vex/aim_client.js';

const N_CHIRP = 128, N_SAMPLE = 256;
const PRED_CACHE_CONF = 0.8, PRED_CACHE_FRAMES = 2;
const DRIVE_INTERVAL_MS = 400, INFER_EVERY = 20, MAX_ERRORS = 5;
const COOLDOWN_MS = 3000;
const LIVE_HISTORY = 50;
const LOG_MAX = 300;
const HINTS = [
  "Connect to the VEX AIM robot's WiFi first (look for a network named 'VEX-AIM-…' in your system WiFi settings), then hit Connect here.",
  'Load your model before switching to the robot\'s WiFi: the robot network has no internet, and the model needs it once to start.',
  'Single Command: perform a gesture during the capture window and the robot executes that action once.',
  'RoboSoccer: the robot drives forward continuously. Swipe left/right to steer, push to kick, idle to cruise.',
  'Class Actions: after loading a model, choose what the robot does for each of your classes.',
  'Confidence threshold: the robot only reacts when the model is at least this sure. Raise it to cut false moves; lower it if the robot ignores you.',
  "If the robot powers off mid-session the app detects it automatically and stops safely. Just reconnect when it's back on.",
  'Getting wrong commands? Go to Collect, add more samples for that gesture, then retrain your model.',
];

// What a class can make the robot do (the AIM commands aim_client.js sends)
export const VEX_ACTIONS = [
  ['none', 'Nothing'],
  ['turn_left', 'Turn left 30°'],
  ['turn_right', 'Turn right 30°'],
  ['forward', 'Move forward'],
  ['backward', 'Move backward'],
  ['strafe_left', 'Slide left'],
  ['strafe_right', 'Slide right'],
  ['kick_hard', 'Kick (hard)'],
  ['kick_medium', 'Kick (medium)'],
  ['kick_soft', 'Kick (soft)'],
  ['stop', 'Stop'],
];
const MOVE_MM = 300;
// The desktop's fixed gesture commands, used as each class's starting choice
const DEFAULT_ACTIONS = { swipe_left: 'turn_left', swipe_right: 'turn_right', push: 'kick_hard', idle: 'none' };
export const defaultAction = cls => DEFAULT_ACTIONS[cls] ?? 'none';

const $ = id => document.getElementById(id);
const pane = $('vexPane');
const visible = () => !pane.hidden;

const st = {
  robot: null, worker: null, modelReady: false, modelName: '', backend: 'cpu', reqId: 0, pendingMode: null,
  frameBuf: [], capturing: false, captureFrames: [],
  inferenceRunning: false, cooldownUntil: 0, cacheProbs: {}, cacheRemaining: 0, lastInferDone: 0,
  driving: false, barTimer: null,
  proc: null, plot: null, count: 0, dirty: false, live: null,
  classes: [], actions: {},
};
const actionsKey = () => `sensds-vex-actions:${st.modelName}`;
const minInferGapMs = () => (st.backend === 'webgpu' || st.backend === 'webgl' ? 300 : 1500);   // min_infer_gap_s
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════ frames and the live spectrogram ══════════════
subscribeFrames(cube => {
  const a0 = cube.slice(0, N_CHIRP * N_SAMPLE);
  st.frameBuf.push(a0);
  if (st.frameBuf.length > 50) st.frameBuf.shift();          // deque(maxlen=50): 5 s, more than one 3 s epoch
  if (st.capturing) st.captureFrames.push(a0);
  if (visible()) st.proc.push(a0);
});
function buildPlot() {
  st.proc ??= new LiveProcessorClient(({ history, dopplerBins, count }) => { st.live = { history, dopplerBins }; st.count = count; st.dirty = true; });
  st.proc.reset({ nSample: N_SAMPLE, nChirp: N_CHIRP, historyLength: LIVE_HISTORY });
  st.live = null;
  st.plot = new LiveSpectrogramPlot($('vexPlot'), { historyLength: LIVE_HISTORY, jetVmin: currentJetVmin() });
  st.count = 0;
  if (visible()) st.plot.drawEmpty();
}
setInterval(() => {
  if (!st.dirty || !visible()) return;
  st.dirty = false;
  st.plot.draw(st.live.history, st.count, st.live.dopplerBins);
}, 200);

// ══════════════ log ══════════════
function log(msg) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const el = $('vexLog');
  el.textContent += `${el.textContent ? '\n' : ''}[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]  ${msg}`;
  const lines = el.textContent.split('\n');
  if (lines.length > LOG_MAX) el.textContent = lines.slice(-LOG_MAX).join('\n');
  el.scrollTop = el.scrollHeight;
}

function setRobotStatus(text, state) {
  const el = $('vexRobotStatus');
  el.textContent = `⬤  ${text}`;
  el.className = `vex-robot-status ${state}`;
}
function refreshStart() { $('vexStartBtn').disabled = !(st.robot && st.modelReady); }

// ══════════════ robot connection ══════════════
async function onConnect() {
  const ip = $('vexIp').value.trim() || '192.168.4.1';
  $('vexConnectBtn').disabled = true; $('vexDisconnectBtn').disabled = true; $('vexIp').disabled = true;
  setRobotStatus('Connecting…', 'busy');
  log(`Connecting to robot at ${ip}…`);
  const robot = new AimRobot(ip, { log });
  try {
    await robot.connect();
    st.robot = robot;
    setRobotStatus('Connected', 'ok');
    $('vexDisconnectBtn').disabled = false;
    log(`✓ Connected to robot at ${ip}`);
    refreshStart();
  } catch (e) {
    if (e.blocked) {
      log('❌ The browser blocked the robot connection.');
      log('See "Connecting from the website" under the Status Log for the fix.');
      $('vexBlocked').hidden = false;
    } else {
      log('❌ Could not reach the robot. Make sure it is powered on and your device is on its WiFi network.');
      log(e.message);
      // On the https site the browser can also refuse quietly (local network
      // access, mixed content), so offer the fix there too
      if (location.protocol === 'https:') $('vexBlocked').hidden = false;
    }
    setRobotDisconnected();
  }
}

async function onDisconnect() {
  await onStop();
  if (st.robot) { try { await st.robot.stopAllMovement(); } catch { /* robot gone */ } st.robot.close(); }
  st.robot = null;
  setRobotDisconnected();
  log('Disconnected from robot.');
}

function setRobotDisconnected() {
  st.robot = null;
  setRobotStatus('Not connected', '');
  $('vexConnectBtn').disabled = false; $('vexDisconnectBtn').disabled = true; $('vexIp').disabled = false;
  $('vexStartBtn').disabled = true;
}

function onRobotLost() {
  log('⚠ Robot connection lost. It may have been powered off.');
  st.driving = false; st.capturing = false;
  stopBar();
  $('vexStartBtn').hidden = false; $('vexStopBtn').hidden = true;
  st.robot?.close();
  setRobotDisconnected();
  setRobotStatus('Connection lost', 'bad');
}

// ══════════════ model ══════════════
function ensureWorker() {
  if (st.worker) return st.worker;
  st.worker = new Worker(new URL('../test/worker.js', import.meta.url), { type: 'module' });
  st.worker.onmessage = ({ data }) => {
    if (data.type === 'loaded') onModelLoaded(data);
    else if (data.type === 'result') onInferenceResult(data.probs, st.pendingMode);
    else if (data.type === 'error') { if (data.id === undefined) onModelLoadError(data.message); else onInferenceError(data.message); }
  };
  st.worker.onerror = e => onModelLoadError(e.message || 'the inference worker failed to start');
  return st.worker;
}

async function loadModel() {
  if (!canChooseFolder()) { log('This browser cannot open folders. Use Chrome or Edge on a computer.'); return; }
  const picked = await chooseModelFolder();
  if (!picked) return;
  setModelLabel('Loading…', 'busy');
  $('vexLoadBtn').disabled = true; $('vexStartBtn').disabled = true;
  try {
    const { name, files } = await picked.read();
    st.modelName = name;
    ensureWorker().postMessage({ type: 'load', files }, [files.weights]);
  } catch (e) { onModelLoadError(e.message); }
}
function setModelLabel(text, state) { const el = $('vexModelLbl'); el.textContent = text; el.className = `model-lbl ${state}`; }
function renderActions() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(actionsKey()) || '{}'); } catch { /* none saved */ }
  st.actions = Object.fromEntries(st.classes.map(c => [c, VEX_ACTIONS.some(([k]) => k === saved[c]) ? saved[c] : defaultAction(c)]));
  const host = $('vexActions');
  host.innerHTML = '';
  for (const c of st.classes) {
    const row = document.createElement('div');
    row.className = 'vex-action-row'; row.dataset.cls = c;
    const name = document.createElement('span'); name.textContent = c.replace(/_/g, ' '); name.title = c;
    const sel = document.createElement('select');
    for (const [k, label] of VEX_ACTIONS) sel.add(new Option(label, k));
    sel.value = st.actions[c];
    sel.onchange = () => {
      st.actions[c] = sel.value;
      try { localStorage.setItem(actionsKey(), JSON.stringify(st.actions)); } catch { /* this visit only */ }
      log(`${c} now does: ${VEX_ACTIONS.find(([k]) => k === sel.value)[1]}`);
    };
    row.append(name, sel);
    host.append(row);
  }
  $('vexActionsBox').hidden = !st.classes.length;
}

function onModelLoaded({ classes, backend }) {
  st.modelReady = true; st.backend = backend;
  st.classes = classes;
  renderActions();
  setModelLabel(`✓  ${st.modelName}`, 'ok');
  $('vexLoadBtn').disabled = false;
  log(`✓ Model loaded: ${st.modelName}  (${classes.length} classes: ${classes.join(', ')})`);
  refreshStart();
}
function onModelLoadError(msg) {
  st.modelReady = false;
  setModelLabel(`✗  ${msg}`, 'err');
  $('vexLoadBtn').disabled = false;
  log(`❌ Model load failed: ${msg}`);
  $('vexStartBtn').disabled = true;
}

// ══════════════ mode, start and stop ══════════════
const singleMode = () => $('vexModeSingle').checked;
function onModeChanged() { $('vexDurBox').hidden = !singleMode(); }

function onStart() { if (singleMode()) startSingle(); else startRobosoccer(); }

async function onStop() {
  stopBar();
  st.driving = false;
  st.capturing = false;
  if (st.robot) { try { await st.robot.stopAllMovement(); } catch { /* robot gone */ } }
  $('vexStartBtn').hidden = false; $('vexStopBtn').hidden = true;
  refreshStart();
  log('Stopped.');
}

function startSingle() {
  st.captureFrames = []; st.capturing = true;
  $('vexStartBtn').disabled = true;
  const secs = Number($('vexDuration').value);
  log(`Capturing for ${secs.toFixed(1)} s…`);
  setTimeout(singleCaptureDone, Math.trunc(secs * 1000));
}
function singleCaptureDone() {
  st.capturing = false;
  const frames = st.captureFrames.slice();
  if (frames.length < 5) { log('Too few frames. Connect the radar and try again.'); refreshStart(); return; }
  log(`Running inference on ${frames.length} frames…`);
  runInference(frames, 'single');
}

async function startRobosoccer() {
  log('Starting RoboSoccer. Robot moving forward…');
  $('vexStartBtn').hidden = true; $('vexStopBtn').hidden = false;
  Object.assign(st, { cooldownUntil: 0, cacheProbs: {}, cacheRemaining: 0, lastInferDone: 0 });
  gestureBar('ready');
  st.barTimer = setInterval(updateBar, 200);
  // DriveWorker.run
  st.driving = true;
  let tick = 0, errors = 0;
  while (st.driving && st.robot) {
    try { await st.robot.moveFor(500, 0); errors = 0; } catch (e) {
      errors += 1;
      log(`⚠ Drive error ${errors}/${MAX_ERRORS}: ${String(e.message).split('\n')[0]}`);
      if (errors >= MAX_ERRORS) { log('Robot is not responding. It may have been powered off.'); onRobotLost(); return; }
    }
    tick += 1;
    if (tick % INFER_EVERY === 0) {
      const frames = st.frameBuf.slice();
      if (frames.length >= 5) onRsInferTrigger(frames);
    }
    await sleep(DRIVE_INTERVAL_MS);
  }
}
function onRsInferTrigger(frames) {
  if (!st.inferenceRunning && Date.now() >= st.cooldownUntil && performance.now() - st.lastInferDone >= minInferGapMs()) runInference(frames, 'robosoccer');
}

// ══════════════ gesture window bar ══════════════
function gestureBar(state, secs = 0) {
  const el = $('vexGestureBar');
  if (!state) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `gesture-bar ${state}`;
  const cfg = { ready: ['🟢', 'Gesture window open. Do a gesture now!'], reading: ['🔵', 'Reading your gesture…'], cooldown: ['🟠', 'Wait. Next window opens in'] }[state];
  $('vexGbIcon').textContent = cfg[0]; $('vexGbText').textContent = cfg[1];
  $('vexGbCountdown').textContent = state === 'cooldown' ? `${secs.toFixed(1)}s` : '';
}
function updateBar() {
  const remaining = Math.max(0, st.cooldownUntil - Date.now()) / 1000;
  if (st.inferenceRunning) gestureBar('reading');
  else if (remaining > 0) gestureBar('cooldown', remaining);
  else gestureBar('ready');
}
function stopBar() { clearInterval(st.barTimer); st.barTimer = null; gestureBar(''); }

// ══════════════ inference ══════════════
function runInference(frames, mode) {
  if (st.inferenceRunning || !st.modelReady) return;
  if (mode === 'robosoccer' && st.cacheRemaining > 0 && Object.keys(st.cacheProbs).length) {
    st.cacheRemaining -= 1;
    onInferenceResult(st.cacheProbs, mode, true);
    return;
  }
  st.inferenceRunning = true; st.pendingMode = mode;
  st.worker.postMessage({ type: 'predict', id: ++st.reqId, frames, nChirp: N_CHIRP, nSample: N_SAMPLE, jetVmin: currentJetVmin() });
}

// _apply_gesture, with the class's chosen action
async function applyAction(action) {
  const r = st.robot;
  switch (action) {
    case 'turn_left': await r.turnFor(TurnType.LEFT, 30); return 'turn left';
    case 'turn_right': await r.turnFor(TurnType.RIGHT, 30); return 'turn right';
    case 'forward': await r.moveFor(MOVE_MM, 0); return 'move forward';
    case 'backward': await r.moveFor(MOVE_MM, 180); return 'move backward';
    case 'strafe_left': await r.moveFor(MOVE_MM, -90); return 'slide left';
    case 'strafe_right': await r.moveFor(MOVE_MM, 90); return 'slide right';
    case 'kick_hard': await r.kick(KickType.HARD); return 'kick / surge';
    case 'kick_medium': await r.kick(KickType.MEDIUM); return 'kick (medium)';
    case 'kick_soft': await r.kick(KickType.SOFT); return 'kick (soft)';
    case 'stop': await r.stopAllMovement(); return 'stop';
    default: return 'idle (no command)';
  }
}

async function onInferenceResult(probs, mode, fromCache = false) {
  st.inferenceRunning = false;
  const best = Object.keys(probs).reduce((a, b) => (probs[b] > probs[a] ? b : a));
  const conf = probs[best], threshold = Number($('vexThreshold').value);
  const pct = v => `${Math.round(v * 100)}%`;
  if (!fromCache) {
    st.lastInferDone = performance.now();
    if (mode === 'robosoccer' && conf >= PRED_CACHE_CONF) { st.cacheProbs = { ...probs }; st.cacheRemaining = PRED_CACHE_FRAMES; }
    else if (mode === 'robosoccer') st.cacheRemaining = 0;
  }
  $('vexPredGesture').textContent = best.replace(/_/g, ' ');
  for (const row of $('vexActions').children) row.classList.toggle('active', row.dataset.cls === best);
  $('vexPredConf').textContent = `Confidence: ${pct(conf)}`;

  let cmd = 'none';
  if (st.robot && conf >= threshold) {
    try {
      // Hold off the next RoboSoccer inference for 3 s so the robot has time
      // to act before the next classification
      const action = st.actions[best] ?? defaultAction(best);
      if (action !== 'none') { st.cooldownUntil = Date.now() + COOLDOWN_MS; st.cacheProbs = {}; st.cacheRemaining = 0; }
      cmd = await applyAction(action);
    } catch (e) { cmd = 'error'; log(`Command error: ${e.message}`); }
  } else if (conf < threshold) cmd = `skipped (${pct(conf)} < ${pct(threshold)} threshold)`;
  $('vexPredCmd').textContent = `Command: ${cmd}`;
  log(`${best}  ${pct(conf)}  →  ${cmd}`);
  if (mode === 'single') refreshStart();
}
function onInferenceError(msg) {
  st.inferenceRunning = false;
  log(`Inference error: ${msg.split('\n')[0]}`);
  refreshStart();
}

// ══════════════ wiring ══════════════
export function initVex() {
  $('vexConnectBtn').onclick = onConnect;
  $('vexDisconnectBtn').onclick = onDisconnect;
  $('vexLoadBtn').onclick = loadModel;
  $('vexModeSingle').onchange = onModeChanged;
  $('vexModeRs').onchange = onModeChanged;
  $('vexStartBtn').onclick = onStart;
  $('vexStopBtn').onclick = onStop;
  const ul = $('vexHints');
  for (const h of HINTS) { const li = document.createElement('li'); li.textContent = h; ul.append(li); }
  $('vexOrigin').textContent = location.origin;
  onReduceNoiseChange(buildPlot);
  new ResizeObserver(() => { if (visible() && st.plot) { if (st.live) st.plot.draw(st.live.history, st.count, st.live.dopplerBins); else st.plot.drawEmpty(); } }).observe($('vexPlotWrap'));
  buildPlot();
  onModeChanged();
}
// Leaving the tab stops a running session (VexAimTab.stop_if_running)
export function hideVex() { if (st.driving || st.capturing) onStop(); }
export function showVex() { requestAnimationFrame(() => { if (st.live) st.plot.draw(st.live.history, st.count, st.live.dopplerBins); else st.plot.drawEmpty(); }); }
// For automated checks: pretend a model loaded / a prediction arrived
export const vexTestHooks = { modelLoaded: onModelLoaded, prediction: (probs, mode = 'single') => onInferenceResult(probs, mode) };
