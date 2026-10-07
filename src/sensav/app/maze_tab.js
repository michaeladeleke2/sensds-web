// The Maze tab: the trained model's live predictions steer a robot through a
// maze (the game is in maze_game.js). A smaller live view of the camera or
// microphone on the left, the maze on the right. Runs the model the same way
// the Test tab does, at the speed chosen there.

import { $, setChip, setIcon, fillDevices, icon } from '../ui/ui.js';
import { CameraView, SpectrogramView } from '../ui/views.js';
import { listCameras } from '../capture/camera.js';
import { listMicrophones } from '../capture/microphone.js';
import { MODE_LABELS } from '../storage/project.js';
import { initMaze } from './maze_game.js';

const PROBLEM_TITLES = { permission_denied: 'Permission needed', no_camera: 'No camera found', no_microphone: 'No microphone found', open_failed: 'Device problem', lost: 'Device disconnected' };

export function initMazeTab(state, shell) {
  const cameraView = new CameraView($('mazeCam')), spectrogramView = new SpectrogramView($('mazeSpec'));
  const sources = { image: state.camera, audio: state.microphone };
  const maze = initMaze(state);
  let running = false, error = null, names = {}, colors = {}, times = [], deviceMode = null, shown = false;
  const mode = () => state.mode, source = () => sources[mode()];

  $('startMazeButton').onclick = start;
  $('stopMazeButton').onclick = stop;
  $('mazeGoTrain').onclick = () => shell.setTab('train');
  $('mazeDevice').onchange = () => {
    if (mode() === 'image') state.settings.camera_id = $('mazeDevice').value; else state.settings.microphone_id = $('mazeDevice').value;
    state.saveSettings();
    if (running) source().start($('mazeDevice').value || null);
  };
  state.inference.on('state', () => sync());
  state.inference.on('prediction', onPrediction);
  state.inference.on('failed', message => { if (state.inference.purpose !== 'maze') return; error = message; running = false; for (const s of Object.values(sources)) s.stop(); sync(); });
  for (const [m, src] of Object.entries(sources)) src.on('state', () => { if (m === mode()) sync(); });
  state.camera.on('frame', v => { if (running && mode() === 'image') cameraView.setFrame(v); });
  state.microphone.on('columns', c => { if (running && mode() === 'audio') spectrogramView.appendDb(c); });
  state.on('project', () => { stop(); refresh(); });
  state.on('mode', () => { stop(); refresh(); });
  state.on('classes', () => refresh());
  state.on('model', m => { if (m !== mode()) return; const was = running; stop(); refresh(); if (was) start(); });

  async function populateDevices() {
    const m = mode();
    fillDevices($('mazeDevice'), m === 'image' ? await listCameras() : await listMicrophones(), m === 'image' ? state.settings.camera_id : state.settings.microphone_id);
  }

  function refresh() {
    const p = state.project;
    if (!p) return;
    const m = mode(), noun = MODE_LABELS[m].toLowerCase(), report = state.modelReport(m), has = Boolean(report);
    $('mazeNoModel').hidden = has; $('mazeHeader').hidden = !has; $('mazeBody').hidden = !has;
    if (!has) {
      $('mazeNoModelTitle').textContent = `Train your ${noun} model first`;
      $('mazeNoModelBody').textContent = `Once your ${noun} model is trained, you can use it to steer a robot through a maze here.`;
      return;
    }
    $('mazeSubtitle').textContent = `Steer the robot to the ⭐ with your ${m === 'image' ? 'camera' : 'sounds'}. Choose what each class does under the maze.`;
    setIcon($('mazeInputIcon'), m === 'image' ? 'camera' : 'mic');
    $('mazeInputTitle').textContent = m === 'image' ? 'Live camera' : 'Live microphone';
    if (deviceMode !== m) { deviceMode = m; populateDevices(); }
    const byId = new Map(p.classes(m).map(c => [c.id, c]));
    const labels = report.classes ?? [];
    names = Object.fromEntries(labels.map(c => [String(c.id), byId.get(String(c.id))?.name ?? String(c.name ?? '')]));
    colors = Object.fromEntries(labels.map(c => [String(c.id), byId.get(String(c.id))?.color ?? String(c.color ?? '#8E8E93')]));
    maze.setClasses(labels.map(c => ({ id: String(c.id), name: names[String(c.id)], color: colors[String(c.id)] })));
    sync();
  }

  async function start() {
    if (!state.project || !state.modelReport(mode())) return;
    error = null; running = true; times = [];
    clearPrediction();
    sync();
    await source().start($('mazeDevice').value || null);
    if (!running) return;
    populateDevices();
    state.startInference('maze');
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
    if (!running || pr.mode !== mode() || state.inference.purpose !== 'maze') return;
    const name = names[pr.classId] ?? pr.className, color = colors[pr.classId] ?? '#8E8E93', percent = Math.round(pr.confidence * 100);
    maze.onPrediction({ ...pr, className: name });
    $('mazeTop').textContent = `${name}  ${percent}%`; $('mazeTop').style.color = color;
    (pr.mode === 'image' ? cameraView : spectrogramView).setPrediction(`${name}  ${percent}%`, color);
    if (pr.mode === 'audio') spectrogramView.requestDraw();
    times.push(performance.now()); if (times.length > 40) times.shift();
    if (times.length >= 2) {
      const span = (times.at(-1) - times[0]) / 1000;
      $('mazeStats').textContent = `${(span > 0 ? (times.length - 1) / span : 0).toFixed(1)} predictions per second`;
    }
  }

  function clearPrediction() {
    $('mazeTop').textContent = 'Nothing yet'; $('mazeTop').style.color = '';
    $('mazeStats').textContent = '';
    cameraView.setPrediction(null); spectrogramView.setPrediction(null);
  }

  function stageMessage(iconName, title, body, buttons = []) {
    const msg = $('mazeMsg');
    msg.hidden = false; $('mazeCam').hidden = true; $('mazeSpec').hidden = true;
    msg.innerHTML = `${icon(iconName, 30)}<b></b><p></p><div class="row"></div>`;
    msg.querySelector('b').textContent = title; msg.querySelector('p').textContent = body;
    for (const [text, fn] of buttons) {
      const b = document.createElement('button');
      b.className = 'btn primary'; b.textContent = text; b.onclick = fn;
      msg.querySelector('.row').append(b);
    }
  }

  function sync() {
    maze.setActive(shown && !$('mazeBody').hidden, running);
    if (!state.project || $('mazeBody').hidden) return;
    const m = mode(), dev = m === 'image' ? 'camera' : 'microphone', st = source().state;
    $('startMazeButton').hidden = running; $('stopMazeButton').hidden = !running;
    if (error) { stageMessage('info', 'Stopped', error, [['Try again', () => { stop(); start(); }]]); setChip($('mazeInputChip'), 'Problem', 'accent'); return; }
    if (!running) { stageMessage(m === 'image' ? 'camera' : 'mic', 'Ready', `Click Start to turn on the ${dev} and steer the robot.`, [['Start', start]]); setChip($('mazeInputChip'), 'Off'); return; }
    if (st === 'error' && source().lastProblem) {
      const [kind, message] = source().lastProblem;
      stageMessage('info', PROBLEM_TITLES[kind] ?? 'Device problem', message, [['Try again', () => { stop(); start(); }]]);
      setChip($('mazeInputChip'), 'Problem', 'accent');
      return;
    }
    if (st !== 'live' || state.inference.state === 'loading') {
      stageMessage(m === 'image' ? 'camera' : 'mic', 'Starting', `Turning on the ${dev} and loading your model.`);
      setChip($('mazeInputChip'), 'Starting', 'warning');
      return;
    }
    $('mazeMsg').hidden = true;
    $('mazeCam').hidden = m !== 'image'; $('mazeSpec').hidden = m !== 'audio';
    (m === 'image' ? cameraView : spectrogramView).draw();
    setChip($('mazeInputChip'), 'Live', 'success');
  }

  return {
    onEnter() { shown = true; refresh(); sync(); },
    onLeave() { shown = false; stop(); sync(); },
    refresh,
  };
}
