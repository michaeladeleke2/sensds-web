// The Test tab (app/ui/tabs/test.py): runs the trained model live on the
// camera (5, 10 or 15 predictions a second) or the microphone (a new
// prediction every 0.25 or 0.5 s, on the last second of sound), with the top
// prediction, a bar per class and a badge on the live view.

import { $, setChip, setIcon, segmented, fillDevices, icon } from '../ui/ui.js';
import { CameraView, SpectrogramView } from '../ui/views.js';
import { listCameras } from '../capture/camera.js';
import { listMicrophones } from '../capture/microphone.js';
import { MODE_LABELS } from '../storage/project.js';
import { IMAGE_RATES, AUDIO_HOPS_MS } from '../ml/inference.js';

const MODEL_CHIPS = { current: ['Model up to date', 'success'], samples_changed: ['New samples since training', 'warning'], classes_changed: ['Classes changed since training', 'warning'] };
const PROBLEM_TITLES = { permission_denied: 'Permission needed', no_camera: 'No camera found', no_microphone: 'No microphone found', open_failed: 'Device problem', lost: 'Device disconnected' };

export function initTest(state, shell) {
  const cameraView = new CameraView($('testCam')), spectrogramView = new SpectrogramView($('testSpec'));
  const sources = { image: state.camera, audio: state.microphone };
  let running = false, rowIds = [], names = {}, colors = {}, rows = new Map(), times = [], error = null, deviceMode = null;
  const mode = () => state.mode, source = () => sources[mode()];
  const speed = segmented($('speedSwitch'), onSpeed);

  $('startTestButton').onclick = start;
  $('stopTestButton').onclick = stop;
  $('goTrainButton').onclick = () => shell.setTab('train');
  $('testDevice').onchange = () => {
    if (mode() === 'image') state.settings.camera_id = $('testDevice').value; else state.settings.microphone_id = $('testDevice').value;
    state.saveSettings();
    if (running) source().start($('testDevice').value || null);
  };
  state.inference.on('state', () => sync());
  state.inference.on('ready', () => sync());
  state.inference.on('prediction', onPrediction);
  state.inference.on('failed', message => { if (state.inference.purpose !== 'test') return; error = message; running = false; for (const s of Object.values(sources)) s.stop(); sync(); });
  for (const [m, src] of Object.entries(sources)) src.on('state', () => { if (m === mode()) sync(); });
  state.camera.on('frame', v => { if (running && mode() === 'image') cameraView.setFrame(v); });
  state.microphone.on('columns', c => { if (running && mode() === 'audio') spectrogramView.appendDb(c); });
  state.on('project', () => { stop(); refresh(); });
  state.on('mode', () => { stop(); refresh(); });
  state.on('classes', () => refresh());
  state.on('model', m => { if (m !== mode()) return; const was = running; stop(); refresh(); if (was) start(); });

  async function populateDevices() {
    const m = mode();
    fillDevices($('testDevice'), m === 'image' ? await listCameras() : await listMicrophones(), m === 'image' ? state.settings.camera_id : state.settings.microphone_id);
  }

  function buildSpeed() {
    if (mode() === 'image') {
      speed.value = String(state.settings.image_predictions_per_second);
      speed.setOptions(IMAGE_RATES.map(r => [String(r), `${r} per second`]));
      $('speedCaption').textContent = 'Speed';
    } else {
      speed.value = String(state.settings.audio_hop_ms);
      speed.setOptions(AUDIO_HOPS_MS.map(h => [String(h), `Every ${h / 1000} s`]));
      $('speedCaption').textContent = 'New prediction';
    }
  }

  function onSpeed(value) {
    if (mode() === 'image') state.settings.image_predictions_per_second = Number(value); else state.settings.audio_hop_ms = Number(value);
    state.saveSettings();
    state.inference.setInterval(state.predictionInterval());
    times = [];
  }

  function refresh() {
    const p = state.project;
    if (!p) return;
    const m = mode(), noun = MODE_LABELS[m].toLowerCase(), report = state.modelReport(m);
    const has = Boolean(report);
    $('testNoModel').hidden = has; $('testHeader').hidden = !has; $('testBody').hidden = !has;
    if (!has) {
      $('testNoModelTitle').textContent = `Train your ${noun} model first`;
      $('testNoModelBody').textContent = `Once your ${noun} model is trained, you can try it live here and watch how sure it is about each class.`;
      return;
    }
    $('testTitle').textContent = `Test your ${noun} model`;
    $('testSubtitle').textContent = `Try the model on brand new ${m === 'image' ? 'pictures from the camera.' : 'sounds from the microphone.'} The bars show how sure it is about each class.`;
    setIcon($('testInputIcon'), m === 'image' ? 'camera' : 'mic');
    $('testInputTitle').textContent = m === 'image' ? 'Live camera' : 'Live microphone';
    if (deviceMode !== m) { deviceMode = m; populateDevices(); buildSpeed(); }
    const byId = new Map(p.classes(m).map(c => [c.id, c]));
    const labels = report.classes ?? [];
    rowIds = labels.map(c => String(c.id));
    names = Object.fromEntries(labels.map(c => [String(c.id), byId.get(String(c.id))?.name ?? String(c.name ?? '')]));
    colors = Object.fromEntries(labels.map(c => [String(c.id), byId.get(String(c.id))?.color ?? String(c.color ?? '#8E8E93')]));
    const host = $('predRows');
    host.innerHTML = ''; rows = new Map();
    for (const id of rowIds) {
      const r = document.createElement('div');
      r.className = 'pred-row';
      r.style.setProperty('--c', colors[id]);
      r.innerHTML = `<div class="line"><span class="swatch" style="width:10px;height:10px;background:var(--c)"></span><span class="n"></span><span class="p">0%</span></div><div class="track"><i style="width:0%"></i></div>`;
      r.querySelector('.n').textContent = names[id];
      host.append(r); rows.set(id, r);
    }
    const status = state.modelStatus(m);
    const [ct, ck] = MODEL_CHIPS[status] ?? MODEL_CHIPS.current;
    setChip($('testModelChip'), ct, ck);
    const note = $('staleNote');
    note.textContent = status === 'classes_changed' ? 'Your classes changed after training, so these bars show the classes the model learned. Train again to test your current classes.'
      : status === 'samples_changed' ? 'You added or removed samples after training. Train again to include them.' : '';
    note.hidden = status === 'current';
    if (!running) clearPrediction();
    sync();
  }

  async function start() {
    if (!state.project || !state.modelReport(mode())) return;
    error = null; running = true; times = [];
    clearPrediction();
    sync();
    await source().start($('testDevice').value || null);
    if (!running) return;
    populateDevices();
    state.startInference('test');
    sync();
  }

  function stop() {
    if (!running) return;
    running = false;
    state.inference.stop();
    for (const s of Object.values(sources)) s.stop();
    cameraView.clear(); spectrogramView.clear();
    clearPrediction();
    sync();
  }

  function onPrediction(pr) {
    if (!running || pr.mode !== mode() || state.inference.purpose !== 'test') return;
    const now = performance.now();
    times.push(now); if (times.length > 40) times.shift();
    const order = new Map(pr.labels.map((l, i) => [String(l.id), i]));
    const probs = rowIds.map(id => (order.has(id) ? pr.probabilities[order.get(id)] : 0));
    const top = probs.reduce((b, v, i) => (v > probs[b] ? i : b), 0);
    rowIds.forEach((id, i) => {
      const r = rows.get(id);
      r.classList.toggle('top', i === top);
      r.querySelector('.p').textContent = `${Math.round(probs[i] * 100)}%`;
      r.querySelector('.track i').style.width = `${probs[i] > 0.001 ? Math.max(2, probs[i] * 100) : 0}%`;
    });
    const name = names[pr.classId] ?? pr.className, color = colors[pr.classId] ?? '#8E8E93', percent = Math.round(pr.confidence * 100);
    $('topName').textContent = name; $('topName').style.color = color;
    $('topDetail').textContent = `${percent}% sure`;
    (pr.mode === 'image' ? cameraView : spectrogramView).setPrediction(`${name}  ${percent}%`, color);
    if (pr.mode === 'audio') spectrogramView.requestDraw();
    if (times.length >= 2) {
      const span = (times.at(-1) - times[0]) / 1000, rate = span > 0 ? (times.length - 1) / span : 0;
      $('testStats').textContent = `${rate.toFixed(1)} predictions per second  ·  ${Math.round(pr.latencyMs)} ms each`;
    }
  }

  function clearPrediction() {
    for (const r of rows.values()) { r.classList.remove('top'); r.querySelector('.p').textContent = '0%'; r.querySelector('.track i').style.width = '0%'; }
    $('topName').textContent = 'Nothing yet'; $('topName').style.color = '';
    $('topDetail').textContent = 'Start testing to see what the model thinks.';
    cameraView.setPrediction(null); spectrogramView.setPrediction(null);
    $('testStats').textContent = '';
  }

  function stageMessage(iconName, title, body, buttons = []) {
    const msg = $('testMsg');
    msg.hidden = false; $('testCam').hidden = true; $('testSpec').hidden = true;
    msg.innerHTML = `${icon(iconName, 30)}<b></b><p></p><div class="row"></div>`;
    msg.querySelector('b').textContent = title; msg.querySelector('p').textContent = body;
    for (const [text, fn, primary, ic] of buttons) {
      const b = document.createElement('button');
      b.className = primary ? 'btn primary' : 'btn';
      b.innerHTML = `${ic ? icon(ic, 18) : ''}<span></span>`; b.querySelector('span').textContent = text;
      b.onclick = fn; msg.querySelector('.row').append(b);
    }
  }

  function sync() {
    if (!state.project || $('testBody').hidden) return;
    const m = mode(), dev = m === 'image' ? 'camera' : 'microphone', st = source().state;
    $('startTestButton').hidden = running; $('stopTestButton').hidden = !running;
    if (error) { stageMessage('info', 'Testing stopped', error, [['Try again', () => { stop(); start(); }, true]]); setChip($('testChip'), 'Problem', 'accent'); return; }
    if (!running) { stageMessage('test', 'Ready to test', `Click Start testing to turn on the ${dev} and see live predictions.`, [['Start testing', start, true, 'test']]); setChip($('testChip'), 'Off'); return; }
    if (st === 'error' && source().lastProblem) {
      const [kind, message] = source().lastProblem;
      stageMessage('info', PROBLEM_TITLES[kind] ?? 'Device problem', message, [['Try again', () => { stop(); start(); }, true]]);
      setChip($('testChip'), 'Problem', 'accent');
      return;
    }
    if (st !== 'live' || state.inference.state === 'loading') {
      stageMessage(m === 'image' ? 'camera' : 'mic', 'Starting', `Turning on the ${dev} and loading your model.`);
      setChip($('testChip'), 'Starting', 'warning');
      return;
    }
    $('testMsg').hidden = true;
    $('testCam').hidden = m !== 'image'; $('testSpec').hidden = m !== 'audio';
    (m === 'image' ? cameraView : spectrogramView).draw();
    setChip($('testChip'), 'Live', 'success');
  }

  return { onEnter: refresh, onLeave: stop, refresh };
}
