// The Test tab of SensDSv2 (ui/test_tab.py): load a trained model, then
//   Try a Gesture  capture for N seconds, predict, animate the robot, ask
//                  which gesture was really done,
//   RoboSoccer     the robot drives on; every 20 ticks the last frames are
//                  classified; swipes turn 30 deg, a push gives a speed burst,
//   Maze Game      every 45 ticks the last 50 frames (30 used) are classified;
//                  swipes turn, a push moves forward.
// Timings, thresholds, cooldowns, the prediction cache and every message are
// the desktop's. Inference runs in a Web Worker (src/test/worker.js).

import { subscribeFrames } from './radar_session.js';
import { currentJetVmin } from './settings.js';
import { recordPrediction, announceModel } from './predictions.js';
import { Maze } from '../test/maze.js';
import { currentFolder, canChooseFolder, readText, listNames } from '../io/folder.js';

// ── constants (test_tab.py) ──
const ROBOT_R = 14, BALL_R = 8, TRAIL_MAX = 40, TICK_MS = 33, INFER_EVERY = 20;
const PRED_CACHE_CONF = 0.8, PRED_CACHE_FRAMES = 2;
const MAZE_INFER_EVERY = 45, MAZE_MIN_FRAMES = 30, MAZE_CAPTURE_FRAMES = 50;
const BASE_SPEED = 2.0, PUSH_BURST = 20, PUSH_BURST_TICKS = 10, SINGLE_PUSH_PX = 40, SINGLE_PUSH_STEPS = 20;
const DIFFICULTY_SIZES = [[3, 4], [4, 5], [5, 7]];      // Easy, Medium, Hard (as the desktop builds them)
const MODE_SINGLE = 0, MODE_RS = 1, MODE_MAZE = 2;
const N_CHIRP = 128, N_SAMPLE = 256;
const HINTS = [
  '🎯 Single Prediction: do a gesture, hit Capture, and the model tells you what it thinks!',
  '⚽ RoboSoccer mode: the model watches you continuously. Swipe to steer, push to speed up!',
  '🌀 Maze Game: navigate through the maze using gestures. Swipe to turn, push to move forward!',
  '📊 Confidence: a percentage showing how sure the model is. 90%+ means very confident!',
  '🔧 Confidence threshold: the robot only reacts if the model is at least this confident.',
  '📈 The bar chart shows every gesture\'s score. One tall bar means confident!',
  '🔁 Getting wrong predictions? Go back to Collect, add more samples, then retrain!',
];

const $ = id => document.getElementById(id);
const nice = g => g.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());     // str.title()
const pct0 = v => `${Math.round(v * 100)}%`;

const st = {
  mode: MODE_SINGLE, worker: null, modelReady: false, classes: [], backend: 'cpu',
  frameBuf: [], capturing: false, captureFrames: [],
  inferenceRunning: false, lastFrames: null, reqId: 0, pendingMode: null,
  cacheProbs: {}, cacheRemaining: 0, lastInferDone: 0,
  rsTimer: null, rsTick: 0, rsSpeed: BASE_SPEED, rsBurst: 0, rsCooldown: 0,
  mazeTimer: null, mazeTick: 0, mazeCooldown: 0, mazesSolved: 0, mazeDifficulty: 1,
  animTimer: null, animSteps: 0, animStepPx: 0,
  pending: { gesture: '', conf: 0, threshold: 0 },
  probs: {},
};
const minInferGapMs = () => (st.backend === 'webgpu' || st.backend === 'webgl' ? 300 : 1500);   // min_infer_gap_s

// ══════════════ frames ══════════════
subscribeFrames(cube => {
  const a0 = cube.slice(0, N_CHIRP * N_SAMPLE);      // reference_spectrogram uses antenna 0
  st.frameBuf.push(a0);
  if (st.frameBuf.length > 50) st.frameBuf.shift();  // deque(maxlen=50)
  if (st.capturing) st.captureFrames.push(a0);
});

// ══════════════ soccer field ══════════════
const field = { rx: 0, ry: 0, heading: -90, bx: 0, by: 0, trail: [], ready: false, overlay: '', overlaySecs: 0 };
function fieldSize() { const r = $('fieldCanvas').getBoundingClientRect(); return { w: Math.max(1, r.width), h: Math.max(1, r.height) }; }
function placeAtCenter() { const { w, h } = fieldSize(); field.rx = field.bx = w / 2; field.ry = field.by = h / 2; }
function fieldReset() { placeAtCenter(); field.heading = -90; field.trail = []; drawField(); }
function setRobot(x, y, heading) {
  field.trail.push([field.rx, field.ry]);
  if (field.trail.length > TRAIL_MAX) field.trail.shift();
  const { w, h } = fieldSize();
  field.rx = ((x % w) + w) % w; field.ry = ((y % h) + h) % h; field.heading = heading;
  const dx = field.bx - field.rx, dy = field.by - field.ry, dist = Math.hypot(dx, dy), combined = ROBOT_R + BALL_R;
  if (dist > 0 && dist < combined) {
    const overlap = combined - dist + 2.0;
    field.bx = (((field.bx + dx / dist * overlap) % w) + w) % w;
    field.by = (((field.by + dy / dist * overlap) % h) + h) % h;
  }
  drawField();
}
function setFieldOverlay(state, secs = 0) { field.overlay = state; field.overlaySecs = secs; drawField(); }

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

function badge(ctx, w, overlay, secs, radius) {
  if (!overlay) return;
  const cfg = { go: ['rgba(39,174,96,0.9)', '🟢 GO!', ''], stop: ['rgba(192,57,43,0.9)', '⛔ WAIT', `${secs.toFixed(1)}s`], reading: ['rgba(41,128,185,0.82)', '🔵 Reading…', ''] }[overlay];
  if (!cfg) return;
  const bw = Math.max(80, Math.floor(w / 5)), bh = 40, bx = w - bw - 8, by = 10;
  ctx.fillStyle = cfg[0]; ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, radius); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (cfg[2]) {
    ctx.font = 'bold 13px system-ui, sans-serif'; ctx.fillText(cfg[1], bx + bw / 2, by + bh * 0.27);
    ctx.font = 'bold 12px system-ui, sans-serif'; ctx.fillText(cfg[2], bx + bw / 2, by + bh * 0.75);
  } else { ctx.font = 'bold 13px system-ui, sans-serif'; ctx.fillText(cfg[1], bx + bw / 2, by + bh / 2); }
}

function drawField() {
  const c = $('fieldCanvas');
  if (!c || c.offsetParent === null) return;
  const { ctx, w, h } = fitCanvas(c);
  if (!field.ready && w > 1) { placeAtCenter(); field.ready = true; }
  const cx = w / 2, cy = h / 2;
  ctx.fillStyle = '#2d8a3e'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, Math.trunc(cy)); ctx.lineTo(w, Math.trunc(cy)); ctx.stroke();
  const cr = Math.trunc(Math.min(w, h) / 6);
  ctx.beginPath(); ctx.arc(cx, cy, cr, 0, 2 * Math.PI); ctx.stroke();
  const gw = Math.floor(Math.min(w, h) / 3), gh = Math.max(Math.trunc(Math.min(w, h) / 10), 12);
  ctx.strokeRect(Math.trunc(cx - gw / 2), 0, gw, gh); ctx.strokeRect(Math.trunc(cx - gw / 2), h - gh, gw, gh);
  field.trail.forEach(([tx, ty], i) => {
    ctx.fillStyle = `rgba(180,180,180,${(20 + 80 * (i + 1) / Math.max(field.trail.length, 1)) / 255})`;
    ctx.beginPath(); ctx.arc(tx, ty, 3, 0, 2 * Math.PI); ctx.fill();
  });
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
  ctx.font = `${BALL_R * 2}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`; ctx.fillText('⚽', field.bx, field.by);
  ctx.font = `${ROBOT_R * 2}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`; ctx.fillText('🤖', field.rx, field.ry);
  const a = field.heading * Math.PI / 180, s0 = ROBOT_R * 0.5, s1 = ROBOT_R + 22;
  const tipX = field.rx + Math.cos(a) * s1, tipY = field.ry + Math.sin(a) * s1;
  ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(field.rx + Math.cos(a) * s0, field.ry + Math.sin(a) * s0); ctx.lineTo(tipX, tipY); ctx.stroke();
  const hl = 13, hw = 7;
  ctx.fillStyle = '#FFD700'; ctx.beginPath(); ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - Math.cos(a) * hl + Math.sin(a) * hw, tipY - Math.sin(a) * hl - Math.cos(a) * hw);
  ctx.lineTo(tipX - Math.cos(a) * hl - Math.sin(a) * hw, tipY - Math.sin(a) * hl + Math.cos(a) * hw);
  ctx.closePath(); ctx.fill();
  badge(ctx, w, field.overlay, field.overlaySecs, 10);
}

// ══════════════ maze ══════════════
const maze = new Maze(3, 4);
let mazeOverlay = '', mazeOverlaySecs = 0, bumpTimer = null;
function setMazeOverlay(state, secs = 0) { mazeOverlay = state; mazeOverlaySecs = secs; drawMaze(); }

function drawMaze() {
  const c = $('mazeCanvas');
  if (!c || c.offsetParent === null) return;
  const { ctx, w, h } = fitCanvas(c);
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#f0f4ff'); g.addColorStop(1, '#e8edf8');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const top = 32;
  const cell = Math.min(Math.floor((w - 4) / maze.cols), Math.floor((h - top - 4) / maze.rows));
  if (cell <= 4) return;
  const wall = Math.max(2, Math.floor(cell / 10)), gw = cell * maze.cols, gh = cell * maze.rows;
  const ox = Math.floor((w - gw) / 2), oy = top + Math.floor((h - top - gh) / 2);
  ctx.fillStyle = '#34495e'; ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`Maze #${maze.mazeNum}   •   Moves: ${maze.moves}`, w / 2, 4 + (top - 4) / 2);
  const onPath = (r, c2) => maze.path.some(([a, b]) => a === r && b === c2);
  for (let r = 0; r < maze.rows; r++) for (let c2 = 0; c2 < maze.cols; c2++) {
    ctx.fillStyle = r === maze.rows - 1 && c2 === maze.cols - 1 ? '#ffeaa7' : r === maze.pr && c2 === maze.pc ? '#dfe6fd' : onPath(r, c2) ? '#c8e6ff' : '#ffffff';
    ctx.fillRect(ox + c2 * cell + 1, oy + r * cell + 1, cell - 1, cell - 1);
  }
  ctx.strokeStyle = '#2c3e50'; ctx.lineWidth = wall; ctx.lineCap = 'round';
  for (let r = 0; r < maze.rows; r++) for (let c2 = 0; c2 < maze.cols; c2++) {
    const x = ox + c2 * cell, y = oy + r * cell, wf = maze.walls[r][c2];
    const line = (a, b, cc, d) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(cc, d); ctx.stroke(); };
    if (wf & 1) line(x, y, x + cell, y);
    if (wf & 4) line(x, y + cell, x + cell, y + cell);
    if (wf & 8) line(x, y, x, y + cell);
    if (wf & 2) line(x + cell, y, x + cell, y + cell);
  }
  ctx.strokeStyle = '#1a2a3a'; ctx.lineWidth = wall + 1; ctx.strokeRect(ox, oy, gw, gh);
  const emoji = px => `${px}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.font = emoji(Math.max(10, Math.trunc(cell * 0.55)));
  ctx.fillText('⭐', ox + (maze.cols - 1) * cell + cell / 2, oy + (maze.rows - 1) * cell + cell / 2);
  const px = ox + maze.pc * cell, py = oy + maze.pr * cell;
  if (maze.bump) { ctx.fillStyle = 'rgba(231,76,60,0.55)'; ctx.fillRect(px + 2, py + 2, cell - 3, cell - 3); }
  const emojiH = Math.trunc(cell * 0.55);
  ctx.fillStyle = '#2c3e50'; ctx.font = emoji(Math.max(8, Math.trunc(cell * 0.48)));
  ctx.fillText('🤖', px + cell / 2, py + 2 + emojiH / 2);
  const arrowH = cell - emojiH - 2, arrowW = Math.max(1, Math.trunc(cell * 0.65)), dotW = Math.max(1, cell - 2 - arrowW);
  ctx.fillStyle = '#FF8C00'; ctx.font = `bold ${Math.max(10, Math.trunc(cell * 0.48))}px system-ui, sans-serif`;
  ctx.fillText(maze.facingArrow, px + 1 + arrowW / 2, py + emojiH + arrowH / 2);
  if (mazeOverlay && !maze.won) {
    const col = { go: '#27ae60', stop: '#c0392b', reading: '#2980b9' }[mazeOverlay];
    if (col) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(px + arrowW + Math.floor(dotW / 2), py + emojiH + Math.floor(arrowH / 2), Math.max(4, Math.trunc(cell * 0.11)), 0, 2 * Math.PI); ctx.fill(); }
  }
  if (maze.won) {
    ctx.fillStyle = 'rgba(39,174,96,0.59)'; ctx.fillRect(ox, oy, gw, gh);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(14, Math.min(26, Math.floor(gw / 9)))}px system-ui, sans-serif`; ctx.fillText('🎉 You Did It!', ox + gw / 2, oy + gh * 0.2);
    ctx.font = emoji(Math.max(12, Math.min(22, Math.floor(gw / 10)))); ctx.fillText('⭐'.repeat(maze.starRating), ox + gw / 2, oy + gh * 0.55);
    ctx.font = `${Math.max(10, Math.min(16, Math.floor(gw / 13)))}px system-ui, sans-serif`; ctx.fillText(`${maze.moves} moves. Press Reset for a new maze!`, ox + gw / 2, oy + gh * 0.85);
  }
  if (!maze.won) badge(ctx, w, mazeOverlay, mazeOverlaySecs, 8);
}

// ══════════════ confidence bars ══════════════
function drawBars() {
  const c = $('barsCanvas');
  if (!c || c.offsetParent === null) return;
  const { ctx, w, h } = fitCanvas(c);
  ctx.clearRect(0, 0, w, h);
  const entries = Object.entries(st.probs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#333';
  ctx.font = '13px system-ui, sans-serif'; ctx.textBaseline = 'middle';
  if (!entries.length) { ctx.fillStyle = '#aaa'; ctx.textAlign = 'center'; ctx.fillText('No prediction yet. Do a gesture!', w / 2, h / 2); return; }
  const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const margin = 6, labelW = 120, pctW = 50, n = entries.length;
  const barH = Math.max(10, Math.floor((h - margin * (n + 1)) / n)), area = w - margin * 2 - labelW - pctW;
  entries.forEach(([label, p], i) => {
    const y = margin + i * (barH + margin);
    ctx.fillStyle = '#e0e0e0'; ctx.beginPath(); ctx.roundRect(margin + labelW, y, area, barH, 4); ctx.fill();
    const bp = Math.trunc(area * p);
    if (bp > 0) { ctx.fillStyle = label === best ? '#27ae60' : '#aaaaaa'; ctx.beginPath(); ctx.roundRect(margin + labelW, y, bp, barH, 4); ctx.fill(); }
    ctx.fillStyle = text;
    ctx.textAlign = 'right'; ctx.fillText(nice(label), margin + labelW - 4, y + barH / 2);
    ctx.textAlign = 'left'; ctx.fillText(pct0(p), margin + labelW + area + 4, y + barH / 2);
  });
}

// ══════════════ gesture window bar ══════════════
function gestureBar(state, secs = 0) {
  const el = $('gestureBar');
  if (!state) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `gesture-bar ${state}`;
  const cfg = { ready: ['🟢', 'Gesture window open. Do a gesture now!'], reading: ['🔵', 'Reading your gesture…'], cooldown: ['🟠', 'Wait. Next window opens in'] }[state];
  $('gbIcon').textContent = cfg[0]; $('gbText').textContent = cfg[1];
  $('gbCountdown').textContent = state === 'cooldown' ? `${secs.toFixed(1)}s` : '';
}
function updatePipelineUi(cooldown, isMaze) {
  const secs = cooldown * TICK_MS / 1000;
  const [s, o] = st.inferenceRunning ? ['reading', 'reading'] : cooldown > 0 ? ['cooldown', 'stop'] : ['ready', 'go'];
  gestureBar(s, secs);
  if (isMaze) setMazeOverlay(o, secs); else setFieldOverlay(o, secs);
}

// ══════════════ status ══════════════
function setStatus(text, color = '#27ae60') { const el = $('testStatus'); el.textContent = text; el.style.color = color; }

// ══════════════ model ══════════════
function ensureWorker() {
  if (st.worker) return st.worker;
  st.worker = new Worker(new URL('../test/worker.js', import.meta.url), { type: 'module' });
  st.worker.onmessage = ({ data }) => {
    if (data.type === 'loaded') onModelLoaded(data);
    else if (data.type === 'result') onInferenceResult(data.probs, st.pendingMode, false, data.image);
    else if (data.type === 'error') {
      if (data.id === undefined) onModelLoadError(data.message); else onInferenceError(data.message, st.pendingMode);
    }
  };
  st.worker.onerror = e => onModelLoadError(e.message || 'the inference worker failed to start');
  return st.worker;
}

let modelName = '';
async function loadModel() {
  if (!canChooseFolder()) { setStatus('⚠️ This browser cannot open folders. Use Chrome or Edge on a computer.', '#c0392b'); return; }
  let dir;
  try {
    let startIn;
    try { startIn = await currentFolder()?.getDirectoryHandle('models'); } catch { startIn = undefined; }
    dir = await window.showDirectoryPicker({ id: 'sensds-models', startIn, mode: 'read' });
  } catch { return; }                                                   // closed the picker
  setStatus('Loading model…', '#e67e22');
  $('modelLbl').textContent = 'Loading…'; $('modelLbl').className = 'model-lbl';
  enableStarts(false);
  try {
    // The model folder itself, or a <name>_vN folder holding model/
    let folder = dir;
    if (!(await readText(dir, 'config.json'))) { try { folder = await dir.getDirectoryHandle('model'); } catch { /* reported below */ } }
    const configText = await readText(folder, 'config.json');
    const preprocessorText = await readText(folder, 'preprocessor_config.json');
    if (!configText) throw new Error(`No config.json in ${dir.name}. Pick the model folder (models/<name>_vN or its model/ folder).`);
    if (!preprocessorText) throw new Error(`No preprocessor_config.json in ${folder.name}.`);
    const { files } = await listNames(folder);
    if (!files.includes('model.safetensors')) {
      throw new Error(files.includes('pytorch_model.bin') ? 'This model was saved in the older PyTorch .bin format, which the browser cannot read. Retrain it (or re-save it with safetensors).' : `No model.safetensors in ${folder.name}.`);
    }
    const weights = await (await (await folder.getFileHandle('model.safetensors')).getFile()).arrayBuffer();
    modelName = folder.name === 'model' && dir.name !== 'model' ? dir.name : folder.name;
    ensureWorker().postMessage({ type: 'load', files: { configText, preprocessorText, weights } }, [weights]);
  } catch (e) { onModelLoadError(e.message); }
}

function onModelLoaded({ classes, backend }) {
  st.modelReady = true; st.classes = classes; st.backend = backend;
  $('modelLbl').textContent = `✓  ${modelName}`; $('modelLbl').className = 'model-lbl ok';
  $('classesLbl').textContent = classes.join('  ·  ');
  $('classesTitle').textContent = `Classes  (${classes.length})`;
  $('classesFrame').hidden = false;
  enableStarts(true);
  setStatus(`✅ Loaded: ${classes.length} classes ready!`, '#27ae60');
  fieldReset();
  rebuildConfirmButtons(classes);
  $('confirmBox').hidden = true;
  announceModel(modelName, classes);                 // model_loaded -> Results tab
}

function onModelLoadError(msg) {
  st.modelReady = false;
  $('modelLbl').textContent = `✗  ${msg}`; $('modelLbl').className = 'model-lbl err';
  $('classesFrame').hidden = true;
  enableStarts(false);
  setStatus('⚠️ Failed to load model. Try a different folder.', '#c0392b');
}

function enableStarts(on) { for (const id of ['captureBtn', 'rsStartBtn', 'mazeStartBtn']) $(id).disabled = !on; }

// ══════════════ confirm ══════════════
function rebuildConfirmButtons(classes) {
  const grid = $('confirmBtns');
  grid.replaceChildren();
  const all = [...classes, 'Skip'];
  grid.style.gridTemplateColumns = `repeat(${Math.min(3, all.length)}, 1fr)`;
  for (const name of all) {
    const b = document.createElement('button');
    b.className = name === 'Skip' ? 'confirm-skip' : 'confirm-btn';
    b.textContent = name === 'Skip' ? 'Skip' : name.replace(/_/g, ' ');
    b.onclick = () => onConfirm(name === 'Skip' ? null : name);
    grid.append(b);
  }
}
function onConfirm(actual) {
  $('confirmBox').hidden = true;
  recordPrediction(st.pending.gesture, st.pending.conf, st.pending.threshold, actual, 'Single');
}

// ══════════════ modes ══════════════
function setMode(mode) {
  if (st.mode === MODE_RS && mode !== MODE_RS && st.rsTimer) stopRobosoccer();
  if (st.mode === MODE_MAZE && mode !== MODE_MAZE && st.mazeTimer) stopMaze();
  st.mode = mode;
  ['modeSingle', 'modeRs', 'modeMaze'].forEach((id, i) => $(id).classList.toggle('active', i === mode));
  ['ctlSingle', 'ctlRs', 'ctlMaze'].forEach((id, i) => { $(id).hidden = i !== mode; });
  $('fieldCanvas').hidden = mode === MODE_MAZE;
  $('mazeCanvas').hidden = mode !== MODE_MAZE;
  $('confirmBox').hidden = true;
  if (mode === MODE_MAZE) updateFacing();
  setStatus('');
  requestAnimationFrame(() => { drawField(); drawMaze(); });
}

// ══════════════ single prediction ══════════════
function startCapture() {
  st.captureFrames = []; st.capturing = true;
  $('captureBtn').disabled = true;
  setStatus('🔴 Capturing… do your gesture now!', '#c0392b');
  setTimeout(captureDone, Math.trunc(Number($('captureDuration').value) * 1000));
}
function captureDone() {
  st.capturing = false;
  const frames = st.captureFrames.slice();
  if (frames.length < 5) { $('captureBtn').disabled = false; setStatus('⚠️ No radar frames. Is the radar connected?', '#c0392b'); return; }
  setStatus('🔍 Running inference…', '#e67e22');
  runInference(frames, 'single');
}

function animateSingle(gesture) {
  if (gesture === 'swipe_left') setRobot(field.rx, field.ry, field.heading - 45);
  else if (gesture === 'swipe_right') setRobot(field.rx, field.ry, field.heading + 45);
  else if (gesture === 'push') {
    st.animSteps = SINGLE_PUSH_STEPS; st.animStepPx = SINGLE_PUSH_PX / SINGLE_PUSH_STEPS;
    clearInterval(st.animTimer);
    st.animTimer = setInterval(() => {
      if (st.animSteps <= 0) { clearInterval(st.animTimer); return; }
      const a = field.heading * Math.PI / 180;
      setRobot(field.rx + Math.cos(a) * st.animStepPx, field.ry + Math.sin(a) * st.animStepPx, field.heading);
      st.animSteps -= 1;
    }, 25);
  }
}

// ══════════════ RoboSoccer ══════════════
function startRobosoccer() {
  fieldReset();
  Object.assign(st, { rsTick: 0, rsSpeed: BASE_SPEED, rsBurst: 0, inferenceRunning: false, rsCooldown: 0, cacheProbs: {}, cacheRemaining: 0, lastInferDone: 0 });
  $('rsStartBtn').hidden = true; $('rsStopBtn').hidden = false;
  setStatus('⚽ RoboSoccer running. Do gestures to steer!', '#27ae60');
  gestureBar('ready'); setFieldOverlay('go');
  st.rsTimer = setInterval(onRsTick, TICK_MS);
}
function stopRobosoccer() {
  clearInterval(st.rsTimer); st.rsTimer = null;
  $('rsStartBtn').hidden = false; $('rsStopBtn').hidden = true;
  gestureBar(''); setFieldOverlay('');
  setStatus('RoboSoccer stopped.', '#888');
}
function onRsTick() {
  st.rsTick += 1;
  const a = field.heading * Math.PI / 180;
  setRobot(field.rx + Math.cos(a) * st.rsSpeed, field.ry + Math.sin(a) * st.rsSpeed, field.heading);
  if (st.rsBurst > 0) { st.rsBurst -= 1; if (st.rsBurst === 0) st.rsSpeed = BASE_SPEED; }
  if (st.rsCooldown > 0) st.rsCooldown -= 1;
  if (st.rsTick % INFER_EVERY === 0 && !st.inferenceRunning && st.rsCooldown === 0 && performance.now() - st.lastInferDone >= minInferGapMs()) {
    const frames = st.frameBuf.slice();
    if (frames.length >= 5) runInference(frames, 'robosoccer');
  }
  updatePipelineUi(st.rsCooldown, false);
}
function applyRsGesture(gesture) {
  const COOLDOWN = 120;   // ~4 s at 30 fps
  if (gesture === 'swipe_left') { setRobot(field.rx, field.ry, field.heading - 30); st.rsCooldown = COOLDOWN; st.frameBuf = []; }
  else if (gesture === 'swipe_right') { setRobot(field.rx, field.ry, field.heading + 30); st.rsCooldown = COOLDOWN; st.frameBuf = []; }
  else if (gesture === 'push') { st.rsSpeed = BASE_SPEED + PUSH_BURST / PUSH_BURST_TICKS; st.rsBurst = PUSH_BURST_TICKS; st.rsCooldown = COOLDOWN; st.frameBuf = []; }
}

// ══════════════ Maze ══════════════
function startMaze() {
  const [rows, cols] = DIFFICULTY_SIZES[st.mazeDifficulty];
  maze.newMaze(rows, cols); updateFacing();
  Object.assign(st, { mazeTick: 0, mazeCooldown: 0, inferenceRunning: false, cacheProbs: {}, cacheRemaining: 0, lastInferDone: 0 });
  $('mazeStartBtn').hidden = true; $('mazeStopBtn').hidden = false;
  setStatus('Maze running. Do a gesture to move!', '#8e44ad');
  gestureBar('ready'); setMazeOverlay('go');
  st.mazeTimer = setInterval(onMazeTick, TICK_MS);
}
function stopMaze() {
  clearInterval(st.mazeTimer); st.mazeTimer = null;
  $('mazeStartBtn').hidden = false; $('mazeStopBtn').hidden = true;
  gestureBar(''); setMazeOverlay('');
  setStatus('Maze stopped. Press Start to try again!', '#555');
}
function onMazeTick() {
  st.mazeTick += 1;
  if (st.mazeCooldown > 0) st.mazeCooldown -= 1;
  if (st.mazeTick % MAZE_INFER_EVERY === 0 && !st.inferenceRunning && st.mazeCooldown === 0 && performance.now() - st.lastInferDone >= minInferGapMs()) {
    const frames = st.frameBuf.slice(-MAZE_CAPTURE_FRAMES);
    if (frames.length >= MAZE_MIN_FRAMES) runInference(frames, 'maze');
  }
  updatePipelineUi(st.mazeCooldown, true);
}
function mazeReset() {
  if (st.mazeTimer) stopMaze();
  maze.reset(); updateFacing(); drawMaze();
  $('mazeStartBtn').hidden = false; $('mazeStopBtn').hidden = true;
  if (st.modelReady) $('mazeStartBtn').disabled = false;
  setStatus('Maze reset! Press Start to play.', '#8e44ad');
}
function updateFacing() { $('facingLbl').textContent = `Facing: ${maze.facingLabel}`; }
function onMazeWon() {
  stopMaze();
  st.mazesSolved += 1;
  $('solvedLbl').textContent = `Solved: ${st.mazesSolved}`;
  setStatus(`🎉 Maze #${maze.mazeNum} done in ${maze.moves} moves! ${'⭐'.repeat(maze.starRating)}  Press ↺ New Maze to keep going.`, '#27ae60');
}
function setDifficulty(idx) {
  st.mazeDifficulty = idx;
  ['diffEasy', 'diffMedium', 'diffHard'].forEach((id, i) => $(id).classList.toggle('active', i === idx));
  const [rows, cols] = DIFFICULTY_SIZES[idx];
  maze.newMaze(rows, cols); updateFacing(); drawMaze();
}

// ══════════════ inference ══════════════
function runInference(frames, mode) {
  if (st.inferenceRunning) return;
  if (!st.modelReady) {
    setStatus('⚠️ No model loaded! Please load a model first.', '#c0392b');
    if (mode === 'single') $('captureBtn').disabled = false;
    return;
  }
  if (mode !== 'single' && st.cacheRemaining > 0 && Object.keys(st.cacheProbs).length) {
    st.cacheRemaining -= 1;
    onInferenceResult(st.cacheProbs, mode, true);
    return;
  }
  st.inferenceRunning = true; st.pendingMode = mode;
  st.worker.postMessage({ type: 'predict', id: ++st.reqId, frames, nChirp: N_CHIRP, nSample: N_SAMPLE, jetVmin: currentJetVmin() });
}

function showPreview(image) {
  if (!image) return;
  const c = $('specPreview'), box = c.parentElement.getBoundingClientRect();
  const size = Math.max(60, Math.min(box.width, box.height));
  const s = Math.min(size / image.width, size / image.height);
  const dpr = window.devicePixelRatio || 1;
  c.style.width = `${image.width * s}px`; c.style.height = `${image.height * s}px`;
  c.width = Math.round(image.width * s * dpr); c.height = Math.round(image.height * s * dpr);
  const off = new OffscreenCanvas(image.width, image.height);
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  for (let i = 0, j = 0; i < image.rgb.length; i += 3, j += 4) { rgba[j] = image.rgb[i]; rgba[j + 1] = image.rgb[i + 1]; rgba[j + 2] = image.rgb[i + 2]; rgba[j + 3] = 255; }
  off.getContext('2d').putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, c.width, c.height);
  $('specHint').hidden = true;
}

function onInferenceResult(probs, mode, fromCache, image) {
  st.inferenceRunning = false;
  st.probs = probs; drawBars();
  const best = Object.keys(probs).reduce((a, b) => (probs[b] > probs[a] ? b : a));
  const conf = probs[best], threshold = Number($('rsThreshold').value), n = nice(best);
  if (!fromCache) {
    st.lastInferDone = performance.now();
    if (mode !== 'single' && conf >= PRED_CACHE_CONF) { st.cacheProbs = { ...probs }; st.cacheRemaining = PRED_CACHE_FRAMES; }
    else if (mode !== 'single') st.cacheRemaining = 0;
  }
  if (image) showPreview(image);
  $('specGesture').textContent = `${n} (${pct0(conf)})`;

  if (mode === 'single') {
    st.pending = { gesture: best, conf, threshold };
    setStatus(`✓  ${n}  (${pct0(conf)})`, conf >= 0.7 ? '#27ae60' : conf >= 0.4 ? '#e67e22' : '#c0392b');
    $('captureBtn').disabled = false;
    animateSingle(best);
    $('confirmBox').hidden = false;
  } else if (mode === 'robosoccer') {
    if (conf >= threshold && best !== 'idle') {
      recordPrediction(best, conf, threshold, best, 'RoboSoccer');
      applyRsGesture(best);
      st.cacheProbs = {}; st.cacheRemaining = 0;
    } else {
      recordPrediction(best, conf, threshold, null, 'RoboSoccer');
      st.rsCooldown = 90; st.frameBuf = []; st.cacheProbs = {}; st.cacheRemaining = 0;
    }
  } else if (mode === 'maze') {
    const mazeThreshold = Number($('mazeThreshold').value);
    if (conf < mazeThreshold || best === 'idle') {
      recordPrediction(best, conf, mazeThreshold, null, 'Maze');
      setStatus(`Listening… (${n} ${pct0(conf)})`, '#888');
    } else {
      recordPrediction(best, conf, mazeThreshold, best, 'Maze');
      const wasWon = maze.won;
      const feedback = maze.applyGesture(best);
      if (maze.bump) { clearTimeout(bumpTimer); bumpTimer = setTimeout(() => { maze.bump = false; drawMaze(); }, 300); }
      if (maze.won && !wasWon) onMazeWon();          // MazeWidget.won fires inside apply_gesture
      updateFacing(); drawMaze();
      setStatus(`${n} (${pct0(conf)})  ·  ${feedback}`, feedback.toLowerCase().includes('wall') ? '#e74c3c' : '#27ae60');
    }
    st.mazeCooldown = 90; st.frameBuf = []; st.cacheProbs = {}; st.cacheRemaining = 0;
  }
}

function onInferenceError(msg, mode) {
  st.inferenceRunning = false;
  setStatus(`⚠️ ${msg.split('\n')[0]}`, '#c0392b');
  if (mode === 'single') $('captureBtn').disabled = false;
}

// ══════════════ wiring ══════════════
export function initTest() {
  $('loadModelBtn').onclick = loadModel;
  $('modeSingle').onclick = () => setMode(MODE_SINGLE);
  $('modeRs').onclick = () => setMode(MODE_RS);
  $('modeMaze').onclick = () => setMode(MODE_MAZE);
  $('captureBtn').onclick = startCapture;
  $('rsStartBtn').onclick = startRobosoccer;
  $('rsStopBtn').onclick = stopRobosoccer;
  $('mazeStartBtn').onclick = startMaze;
  $('mazeStopBtn').onclick = stopMaze;
  $('mazeResetBtn').onclick = mazeReset;
  ['diffEasy', 'diffMedium', 'diffHard'].forEach((id, i) => { $(id).onclick = () => setDifficulty(i); });
  let hint = 0;
  $('testHint').textContent = HINTS[0];
  setInterval(() => { hint = (hint + 1) % HINTS.length; $('testHint').textContent = HINTS[hint]; }, 6000);
  new ResizeObserver(() => { drawField(); drawMaze(); drawBars(); }).observe($('gameArea'));
  new ResizeObserver(drawBars).observe($('barsCanvas'));
  // Medium is selected, but the first maze shown is the widget's 3 x 4 until Start
  st.mazeDifficulty = 1;
  ['diffEasy', 'diffMedium', 'diffHard'].forEach((id, i) => $(id).classList.toggle('active', i === 1));
  setMode(MODE_SINGLE);
}

// Leaving the tab stops any running game (TestTab.stop_all_games)
export function hideTest() {
  if (st.rsTimer) stopRobosoccer();
  if (st.mazeTimer) stopMaze();
  st.capturing = false;
}
export function showTest() { requestAnimationFrame(() => { drawField(); drawMaze(); drawBars(); }); }
