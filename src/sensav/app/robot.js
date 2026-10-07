// The Robot tab (app/ui/tabs/robot.py): connect to a VEX AIM robot, set the
// safety rules (confidence threshold, steady predictions, speed), map each
// class to a move, and drive with the image or audio model. Shows what is
// being sent and why. Emergency Stop is always here and on the space bar.

import { $, setChip, setIcon, segmented, showError, icon } from '../ui/ui.js';
import { CameraView, SpectrogramView } from '../ui/views.js';
import { listCameras } from '../capture/camera.js';
import { listMicrophones } from '../capture/microphone.js';
import { MODE_LABELS } from '../storage/project.js';
import { ACTIONS, ACTIONS_BY_KEY, DEFAULT_ACTION, actionLabel } from '../robot/actions.js';
import { SPEED_LABELS } from '../robot/protocol.js';

const ACTION_ICONS = { forward: 'arrow_up', backward: 'arrow_down', turn_left: 'rotate_left', turn_right: 'rotate_right', strafe_left: 'arrow_left', strafe_right: 'arrow_right', kick: 'bolt', stop: 'stop', no_action: 'minus' };
const REASONS = {
  not_sure: 'No class is sure enough, so the robot stops', no_predictions: 'Predictions stopped arriving, so the robot stops', emergency: 'Emergency stop',
  left_tab: 'You left the Robot tab', user: 'Driving stopped', connection_lost: 'The robot connection dropped', prediction_stopped: 'Predictions stopped',
  prediction_failed: 'Predictions stopped because of a problem', source_changed: 'The control source changed', app_closed: 'The page closed',
};
const LINK_CHIPS = { disconnected: ['Offline', 'neutral'], connecting: ['Connecting', 'warning'], connected: ['Connected', 'success'], lost: ['Connection lost', 'accent'] };

export function initRobot(state, shell) {
  const link = state.robot, driver = state.driver;
  const cameraView = new CameraView($('robotCam')), spectrogramView = new SpectrogramView($('robotSpec'));
  const sources = { image: state.camera, audio: state.microphone };
  let rows = new Map(), active = false;

  const speedSeg = segmented($('speedSeg'), v => { if (state.project) state.updateRobotSettings({ speed: v }); });
  const sourceSeg = segmented($('sourceSwitch'), onSourceChanged);
  $('hostInput').value = state.settings.robot_host;
  $('hostInput').addEventListener('change', () => state.setRobotHost($('hostInput').value));
  $('hostInput').addEventListener('keydown', e => { if (e.key === 'Enter') toggleConnection(); });
  $('connectButton').onclick = toggleConnection;
  $('reconnectRobot').onclick = () => link.connectTo(link.host || $('hostInput').value.trim() || '192.168.4.1');
  $('driveButton').onclick = startDriving;
  $('stopDriveButton').onclick = () => driver.stop('user');
  $('estopButton').onclick = emergencyStop;
  $('thresholdInput').addEventListener('input', () => { $('thresholdValue').textContent = `${$('thresholdInput').value}%`; });
  $('thresholdInput').addEventListener('change', saveSafety);
  $('smoothingInput').addEventListener('change', saveSafety);
  document.addEventListener('keydown', e => {
    if (!active || e.code !== 'Space' || e.repeat) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea, dialog')) return;
    e.preventDefault();
    emergencyStop();
  });

  link.on('state', () => sync());
  link.on('battery', () => sync());
  link.on('problem', (kind, message) => { state.status(message, 8000); sync(); });
  driver.on('active', on => {
    if (!on) { stopSources(); $('liveText').textContent = 'Nothing yet'; for (const r of rows.values()) r.classList.remove('selected'); }
    sync();
  });
  driver.on('decision', onDecision);
  state.inference.on('prediction', onPrediction);
  state.inference.on('state', () => sync());
  for (const src of Object.values(sources)) src.on('state', () => sync());
  state.camera.on('frame', v => { if (driver.active && driver.mode === 'image') cameraView.setFrame(v); });
  state.microphone.on('columns', c => { if (driver.active && driver.mode === 'audio') spectrogramView.appendDb(c); });
  state.on('project', () => { driver.stop('source_changed'); refresh(); });
  state.on('classes', () => refresh());
  state.on('model', () => refresh());
  state.on('mode', () => driver.stop('source_changed'));
  addEventListener('pagehide', () => { driver.stop('app_closed'); link.shutdown(); });

  function refresh() {
    const p = state.project;
    if (!p) return;
    const r = p.robot;
    $('thresholdInput').value = String(Math.round(r.confidence_threshold * 100));
    $('thresholdValue').textContent = `${$('thresholdInput').value}%`;
    $('smoothingInput').value = r.smoothing_count;
    speedSeg.set(r.speed in SPEED_LABELS ? r.speed : 'medium');
    sourceSeg.set(r.source);
    rebuildRows();
    sync();
  }

  function rebuildRows() {
    const p = state.project;
    if (!p) return;
    const src = p.robot.source, classes = p.classes(src), noun = MODE_LABELS[src].toLowerCase();
    $('mappingHint').textContent = `Choose what the robot does when the ${noun} model recognizes each class. No Action keeps doing the last move.`;
    const host = $('actionRows');
    host.innerHTML = ''; rows = new Map();
    if (!classes.length) { const s = document.createElement('span'); s.className = 'secondary'; s.textContent = `This project has no ${noun} classes yet.`; host.append(s); }
    for (const cls of classes) {
      const row = document.createElement('div');
      row.className = 'action-row';
      row.innerHTML = `<span class="swatch" style="background:${cls.color}"></span><span class="heading"></span><span class="caption">drives</span><select class="field"></select>`;
      row.querySelector('.heading').textContent = cls.name;
      const sel = row.querySelector('select');
      for (const a of ACTIONS) { const o = new Option(a.label, a.key); o.title = a.description; sel.add(o); }
      sel.value = ACTIONS_BY_KEY[cls.robot_action] ? cls.robot_action : DEFAULT_ACTION;
      sel.onchange = async () => { try { await state.setClassAction(src, cls.id, sel.value); } catch (e) { showError('Could not save the robot action', e.message); } };
      host.append(row); rows.set(cls.id, row);
    }
    const status = state.modelStatus(src);
    const notes = { none: `Train the ${noun} model before driving.`, samples_changed: `The ${noun} model is out of date because samples changed. Train again for the best results.`, classes_changed: `The ${noun} model was trained on different classes. Train again before driving.` };
    $('modelNote').textContent = notes[status] ?? ''; $('modelNote').hidden = !(status in notes);
  }

  function stageMessage(iconName, title, body) {
    const msg = $('robotMsg');
    msg.hidden = false; $('robotCam').hidden = true; $('robotSpec').hidden = true;
    msg.innerHTML = `${icon(iconName, 30)}<b></b><p></p>`;
    msg.querySelector('b').textContent = title; msg.querySelector('p').textContent = body;
  }

  function sync() {
    if (!state.project) return;
    const ls = link.state, [ct, ck] = LINK_CHIPS[ls] ?? LINK_CHIPS.disconnected;
    setChip($('linkChip'), ct, ck);
    const connected = ls === 'connected' || ls === 'connecting';
    $('connectText').textContent = connected ? 'Disconnect' : 'Connect';
    $('connectButton').className = connected ? 'btn danger' : 'btn primary';
    $('hostInput').disabled = connected;
    const showReconnect = ls === 'lost' || (ls === 'disconnected' && link.lastProblem !== null);
    $('reconnectRobot').hidden = !showReconnect;
    const battery = link.battery;
    $('batteryIcon').hidden = !(ls === 'connected' && battery !== null);
    $('batteryText').textContent = ls === 'connected' ? (battery !== null ? `Battery ${battery}%` : 'Connected') : ls === 'connecting' ? `Connecting to ${link.host}` : '';
    $('batteryRow').hidden = !($('batteryText').textContent || showReconnect);
    $('connectionNote').textContent = link.lastProblem && (ls === 'disconnected' || ls === 'lost') ? link.lastProblem[1]
      : ls === 'connected' ? 'Commands go to the robot while you drive.'
        : "Join the robot's WiFi network first. In access point mode the address is 192.168.4.1. Without a robot you can still drive in practice mode and watch the commands. The address simulated tries everything with a pretend robot.";

    const on = driver.active, m = on ? driver.mode : state.project.robot.source;
    const ready = state.modelStatus(m) !== 'none';
    $('driveButton').hidden = on; $('driveButton').disabled = !ready;
    $('driveButton').title = ready ? '' : `Train the ${MODE_LABELS[m].toLowerCase()} model first.`;
    $('stopDriveButton').hidden = !on;
    sourceSeg.setEnabled(!on);
    const src = sources[m];
    if (!on) {
      setChip($('driveChip'), 'Stopped');
      stageMessage('robot', 'Not driving', `Click Start driving to turn on the ${m === 'image' ? 'camera' : 'microphone'} and let the model steer.`);
    } else if (src.state === 'error' && src.lastProblem) {
      setChip($('driveChip'), 'Problem', 'accent');
      stageMessage('info', 'Input problem', src.lastProblem[1]);
    } else if (src.state !== 'live' || state.inference.state === 'loading') {
      setChip($('driveChip'), 'Starting', 'warning');
      stageMessage('robot', 'Starting', 'Loading the model and turning on the input.');
    } else {
      setChip($('driveChip'), link.isConnected ? 'Driving' : 'Practice', link.isConnected ? 'success' : 'warning');
      $('robotMsg').hidden = true;
      $('robotCam').hidden = m !== 'image'; $('robotSpec').hidden = m !== 'audio';
      (m === 'image' ? cameraView : spectrogramView).draw();
    }
  }

  function toggleConnection() {
    if (link.state === 'connected' || link.state === 'connecting') {
      if (driver.active) driver.stop('user');
      link.disconnect();
    } else {
      state.setRobotHost($('hostInput').value);
      link.connectTo($('hostInput').value.trim() || '192.168.4.1');
    }
    sync();
  }

  async function startDriving() {
    const p = state.project;
    if (!p) return;
    const m = p.robot.source;
    if (state.modelStatus(m) === 'none') { showError('Train a model first', `Train the ${MODE_LABELS[m].toLowerCase()} model before driving the robot.`); return; }
    try {
      const devices = m === 'image' ? await listCameras() : await listMicrophones();
      const saved = m === 'image' ? state.settings.camera_id : state.settings.microphone_id;
      const id = devices.some(d => d.id === saved) ? saved : null;
      sources[m].start(id);
      driver.start(mode => state.startInference('robot', mode));
    } catch (e) { showError('Could not start driving', e.message); }
  }

  function stopSources() {
    for (const s of Object.values(sources)) s.stop();
    cameraView.clear(); spectrogramView.clear();
  }

  function onPrediction(p) {
    if (!driver.active || state.inference.purpose !== 'robot') return;
    const cls = state.project?.classes(p.mode).find(c => c.id === p.classId);
    const name = cls?.name ?? p.className, color = cls?.color ?? '#8E8E93', percent = Math.round(p.confidence * 100);
    $('liveText').textContent = `${name}  ${percent}%`;
    (p.mode === 'image' ? cameraView : spectrogramView).setPrediction(`${name}  ${percent}%`, color);
    if (p.mode === 'audio') spectrogramView.requestDraw();
  }

  function onDecision(ev) {
    $('commandText').textContent = actionLabel(ev.action);
    const badge = $('commandBadge');
    setIcon(badge, ACTION_ICONS[ev.action] ?? 'minus', 28);
    badge.classList.toggle('moving', ev.action !== 'stop' && ev.action !== 'no_action');
    if (ev.reason === 'prediction' && ev.className) $('becauseText').textContent = `${ev.className} was ${Math.round((ev.confidence ?? 0) * 100)}% sure`;
    else if (ev.reason === 'not_sure' && ev.confidence !== null) $('becauseText').textContent = `${REASONS.not_sure} (best guess ${Math.round(ev.confidence * 100)}%)`;
    else $('becauseText').textContent = REASONS[ev.reason] ?? ev.reason.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
    $('sentNote').textContent = ev.sent ? 'Sent to the robot' : link.isConnected ? 'Not sent' : 'Practice mode: not sent because no robot is connected';
    for (const [id, row] of rows) row.classList.toggle('selected', ev.reason === 'prediction' && id === ev.classId);
  }

  function emergencyStop() {
    driver.emergencyStop();
    state.status(`Emergency stop${link.isConnected ? '' : '. No robot is connected right now.'}`);
  }

  async function onSourceChanged(src) {
    try { await state.updateRobotSettings({ source: src }); } catch (e) { showError('Could not change the control source', e.message); }
    rebuildRows(); sync();
  }

  async function saveSafety() {
    if (!state.project) return;
    const threshold = Math.round(Number($('thresholdInput').value)) / 100;
    const smoothing = Math.min(10, Math.max(1, Math.round(Number($('smoothingInput').value) || 3)));
    $('smoothingInput').value = smoothing;
    await state.updateRobotSettings({ confidence_threshold: threshold, smoothing_count: smoothing });
    driver.updateSettings(threshold, smoothing);
  }

  return {
    onEnter() { active = true; refresh(); },
    onLeave() {
      active = false;
      if (driver.active) driver.stop('left_tab');
      else if (link.isConnected) link.send('stop', speedSeg.value);
      stopSources();
    },
    refresh,
  };
}
