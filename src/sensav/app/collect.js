// The Collect tab (app/ui/tabs/collect.py): the class list with sample counts,
// progress toward the minimum and the newest thumbnails, and the capture
// panel: camera or microphone on/off, the live view, and recording into the
// selected class in Hold, Toggle or Timed (count down, then a set number)
// mode. Audio projects record Background Noise as 20 one-second clips.

import { $, setChip, setIcon, segmented, confirm, showError, fillDevices, fillIcons, icon } from '../ui/ui.js';
import { CameraView, SpectrogramView, spectrogramThumb } from '../ui/views.js';
import { listCameras } from '../capture/camera.js';
import { listMicrophones } from '../capture/microphone.js';
import { BACKGROUND_CLASS_ID, MODE_LABELS, ProjectError } from '../storage/project.js';
import { clipImageGray, decodeWav } from '../ml/audio_features.js';
import { events } from '../logs/events.js';
import * as fs from '../storage/fs.js';

export const MIN_CLASSES = 2;
export const MIN_SAMPLES = { image: 20, audio: 8 };
export const MIN_BACKGROUND_CLIPS = 20;
const BACKGROUND_SECONDS = 20;
const THUMB_LIMIT = 17;

const SOURCE_TEXT = {
  image: { device: 'camera', title: 'Camera', icon: 'camera', unit: 'samples', offTitle: 'Camera is off', offBody: 'Turn on the camera to record examples. Only the square in the middle of the picture is saved.', turnOn: 'Turn on camera', starting: 'Starting camera' },
  audio: { device: 'microphone', title: 'Microphone', icon: 'mic', unit: 'clips', offTitle: 'Microphone is off', offBody: 'Turn on the microphone to record sounds. Every clip is 1 second long.', turnOn: 'Turn on microphone', starting: 'Starting microphone' },
};
const PROBLEM_TITLES = {
  'image:permission_denied': 'Camera permission needed', 'image:no_camera': 'No camera found', 'image:lost': 'Camera disconnected', 'image:open_failed': 'Camera problem',
  'audio:permission_denied': 'Microphone permission needed', 'audio:no_microphone': 'No microphone found', 'audio:open_failed': 'Microphone problem', 'audio:lost': 'Microphone disconnected',
};

// Thumbnails: object URLs for JPEGs, spectrogram canvases for clips, cached
const thumbCache = new Map();
async function thumbFor(state, mode, cls, name, size, blob = null) {
  const key = `${state.project?.folder}/${mode}/${cls.folder}/${name}@${size}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const p = (async () => {
    const file = blob ?? await fs.readFile(await state.project.classDir(mode, cls, false), name);
    if (mode === 'image') return { url: URL.createObjectURL(file) };
    const canvas = document.createElement('canvas');
    spectrogramThumb(clipImageGray(decodeWav(new Uint8Array(await file.arrayBuffer())), size), size, canvas);
    return { url: canvas.toDataURL() };
  })();
  thumbCache.set(key, p);
  return p;
}

export function thumbTile(state, mode, cls, name, size, onDelete, blob = null) {
  const b = document.createElement('button');
  b.className = 'thumb';
  b.title = 'Click to delete this sample';
  b.innerHTML = `<span class="del">${icon('trash', Math.max(16, size / 2 - 4), 2.2)}</span>`;
  thumbFor(state, mode, cls, name, size * 2, blob).then(({ url }) => { const img = new Image(); img.src = url; img.alt = ''; b.prepend(img); }).catch(() => {});
  b.onclick = e => { e.stopPropagation(); onDelete(name); };
  return b;
}

export function initCollect(state, shell) {
  const cameraView = new CameraView($('collectCam'));
  const spectrogramView = new SpectrogramView($('collectSpec'));
  const sources = { image: state.camera, audio: state.microphone };
  const wanted = { image: false, audio: false };
  let cards = new Map(), selectedId = null, active = false, recording = false;
  let session = { count: 0, started: 0, classId: null, mode: 'hold', color: '#999999' };
  let countdownValue = 0, countdownTimer = null, pressed = false;
  const mode = () => state.mode, source = () => sources[mode()];
  const view = () => (mode() === 'image' ? cameraView : spectrogramView);

  const captureMode = segmented($('captureMode'), value => onCaptureMode(value));
  $('countdownInput').value = state.settings.capture_countdown;
  $('burstInput').value = state.settings.capture_burst_count;
  for (const id of ['countdownInput', 'burstInput']) $(id).addEventListener('change', () => {
    state.settings.capture_countdown = clampInt($('countdownInput').value, 0, 10, 3);
    state.settings.capture_burst_count = clampInt($('burstInput').value, 5, 300, 30);
    $('countdownInput').value = state.settings.capture_countdown; $('burstInput').value = state.settings.capture_burst_count;
    state.saveSettings(); sync();
  });

  state.camera.on('frame', v => { if (active && mode() === 'image') cameraView.setFrame(v); });
  state.microphone.on('columns', c => { if (active && mode() === 'audio') spectrogramView.appendDb(c); });
  state.microphone.on('level', v => { $('micLevel').firstElementChild.style.width = `${Math.round(v * 100)}%`; });
  state.microphone.on('clipProgress', v => { if (recording && mode() === 'audio') { spectrogramView.setProgress(v); spectrogramView.requestDraw(); } });
  for (const [m, src] of Object.entries(sources)) {
    src.on('state', () => {
      if (m !== mode()) return;
      if (src.state !== 'live') { cancelCountdown(); stopRecording('source_stopped'); $('micLevel').firstElementChild.style.width = '0%'; }
      sync();
    });
    src.on('problem', (kind, message) => {
      if (m !== mode()) return;
      if (kind === 'save_failed') showError('Could not save a sample', message);
      else if (kind === 'silent') { $('collectNotice').textContent = message; $('collectNotice').hidden = false; }
      sync();
    });
    src.on('sampleSaved', (classId, name, blob) => onSampleSaved(m, classId, name, blob));
    src.on('recordingFinished', (classId, count) => { if (m === mode()) stopRecording('finished', count); });
  }
  state.on('sampleAdded', (m, classId, name, blob) => {
    if (m !== mode() || !state.project) return;
    const card = cards.get(classId);
    if (card) { card.addThumb(name, blob); card.setCount(state.project.sampleCount(m, classId)); }
    updateHeader();
  });
  state.on('sampleRemoved', (m, classId) => {
    if (m !== mode() || !state.project) return;
    cards.get(classId)?.rebuildThumbs(); cards.get(classId)?.setCount(state.project.sampleCount(m, classId));
    updateHeader();
  });
  state.on('project', () => { cancelCountdown(); stopRecording('project_changed'); selectedId = null; refresh(); });
  state.on('projectRenamed', () => refresh());
  state.on('classes', () => refresh());
  state.on('mode', () => onModeChanged());

  $('addClassButton').onclick = addClass;
  $('powerButton').onclick = toggleSource;
  $('collectDevice').onchange = onDeviceChosen;
  const rec = $('recordButton');
  const holdStart = () => { if (!isBackground() && captureMode.value === 'hold' && !pressed) { pressed = true; startRecording(); } };
  const holdEnd = () => { if (pressed) { pressed = false; stopRecording('released'); } };
  rec.addEventListener('pointerdown', e => { if (e.button === 0 && !rec.disabled) { rec.setPointerCapture(e.pointerId); holdStart(); } });
  rec.addEventListener('pointerup', holdEnd);
  rec.addEventListener('pointercancel', holdEnd);
  rec.addEventListener('click', onRecordClicked);
  rec.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && captureMode.value === 'hold' && !isBackground()) { e.preventDefault(); holdStart(); } });
  rec.addEventListener('keyup', e => { if ((e.key === ' ' || e.key === 'Enter') && captureMode.value === 'hold' && !isBackground()) { e.preventDefault(); holdEnd(); } });

  function clampInt(v, lo, hi, dflt) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
  const isBackground = () => mode() === 'audio' && selectedId === BACKGROUND_CLASS_ID;

  function updateHeader() {
    const p = state.project;
    if (!p) return;
    const m = mode(), n = p.classes(m).length;
    $('collectSubtitle').textContent = `${MODE_LABELS[m]} model  ·  ${n} ${n === 1 ? 'class' : 'classes'}  ·  ${p.totalSamples(m)} ${SOURCE_TEXT[m].unit}`;
  }

  function refresh() {
    const p = state.project;
    if (!p) return;
    const m = mode(), classes = p.classes(m), unit = SOURCE_TEXT[m].unit;
    updateHeader();
    setChip($('classCount'), String(classes.length));
    const list = $('classList');
    list.innerHTML = '';
    cards = new Map();
    for (const cls of classes) {
      const minimum = cls.id === BACKGROUND_CLASS_ID ? MIN_BACKGROUND_CLIPS : MIN_SAMPLES[m];
      const card = classCard(cls, unit, minimum);
      list.append(card.el);
      cards.set(cls.id, card);
    }
    if (!cards.has(selectedId)) selectedId = classes[0]?.id ?? null;
    select(selectedId);
  }

  function classCard(cls, unit, minimum) {
    const m = mode();
    const el = document.createElement('div');
    el.className = 'class-card';
    el.innerHTML = `<div class="top"><span class="swatch" style="background:${cls.color}"></span><span class="name"></span><span class="chip"></span>${cls.locked
      ? `<span class="lock" title="Every audio project needs Background Noise so the model can tell your sounds apart from a quiet room.">${icon('lock', 16)}</span>`
      : `<button class="menu-button" title="Class options">${icon('more', 18)}</button>`}</div>
      <div class="progress"><span class="bar"><i style="background:${cls.color}"></i></span><span class="caption"></span></div><div class="thumbs"></div>`;
    el.querySelector('.name').textContent = cls.name;
    el.addEventListener('click', e => { if (!e.target.closest('.menu-button, input, .thumb')) select(cls.id); });
    const nameEl = el.querySelector('.name');
    const startRename = () => {
      if (cls.locked) return;
      const input = Object.assign(document.createElement('input'), { className: 'name', value: cls.name, maxLength: 40 });
      nameEl.replaceWith(input);
      input.focus(); input.select();
      let done = false;
      const finish = async commit => {
        if (done) return; done = true;
        input.replaceWith(nameEl);
        const name = input.value.trim();
        if (commit && name && name !== cls.name) await renameClass(cls.id, name);
      };
      input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
      input.onblur = () => finish(true);
    };
    nameEl.ondblclick = startRename;
    el.querySelector('.menu-button')?.addEventListener('click', e => {
      e.stopPropagation();
      shell.popupMenu(e.currentTarget, [
        ['pencil', 'Rename', startRename],
        null,
        ['trash', 'Delete class', () => deleteClass(cls.id)],
      ]);
    });
    const thumbs = el.querySelector('.thumbs');
    const rebuildThumbs = () => {
      thumbs.innerHTML = '';
      const names = [...state.project.sampleNames(m, cls.id)].reverse();
      for (const name of names.slice(0, THUMB_LIMIT)) thumbs.append(thumbTile(state, m, cls, name, 48, n => deleteSample(cls.id, n)));
      if (names.length > THUMB_LIMIT) {
        const more = Object.assign(document.createElement('button'), { className: 'thumb more', textContent: `+${names.length - THUMB_LIMIT}`, title: 'See all samples' });
        more.onclick = e => { e.stopPropagation(); shell.showSamples(m, cls, n => deleteSample(cls.id, n)); };
        thumbs.append(more);
      }
      thumbs.hidden = !names.length;
    };
    const setCount = count => {
      const ready = count >= minimum;
      setChip(el.querySelector('.chip'), `${count} ${count === 1 ? unit.replace(/s$/, '') : unit}`, ready ? 'success' : 'neutral');
      el.querySelector('.bar i').style.width = `${Math.min(100, (count / minimum) * 100)}%`;
      el.querySelector('.progress .caption').textContent = ready ? 'Ready to train' : `${minimum - count} more needed`;
    };
    const addThumb = (name, blob) => {
      const names = state.project.sampleNames(m, cls.id);
      if (names.length > THUMB_LIMIT) { rebuildThumbs(); return; }
      thumbs.prepend(thumbTile(state, m, cls, name, 48, n => deleteSample(cls.id, n), blob));
      thumbs.hidden = false;
    };
    rebuildThumbs();
    setCount(state.project.sampleCount(m, cls.id));
    return { el, setCount, addThumb, rebuildThumbs, startRename, setSelected: on => el.classList.toggle('selected', on) };
  }

  function select(id) {
    if (id !== selectedId && (recording || countdownTimer)) { cancelCountdown(); stopRecording('class_changed'); }
    selectedId = id;
    for (const [cid, card] of cards) card.setSelected(cid === id);
    const p = state.project;
    const cls = p && id ? p.classes(mode()).find(c => c.id === id) : null;
    if (!cls) { $('targetName').textContent = 'Add a class to begin'; $('targetSwatch').hidden = true; }
    else { $('targetName').textContent = cls.name; $('targetSwatch').style.background = cls.color; $('targetSwatch').hidden = false; captureMode.set(cls.capture_mode); }
    sync();
  }

  async function populateDevices() {
    const m = mode();
    const devices = m === 'image' ? await listCameras() : await listMicrophones();
    fillDevices($('collectDevice'), devices, m === 'image' ? state.settings.camera_id : state.settings.microphone_id);
    $('collectDevice').title = m === 'image' ? 'Choose a camera' : 'Choose a microphone';
  }
  const device = () => $('collectDevice').value || null;

  function rememberDevice() {
    if (mode() === 'image') state.settings.camera_id = $('collectDevice').value; else state.settings.microphone_id = $('collectDevice').value;
    state.saveSettings();
  }

  function onDeviceChosen() {
    rememberDevice();
    const m = mode(), sel = $('collectDevice');
    events.log(`${SOURCE_TEXT[m].device}_selected`, { device_id: sel.value, name: sel.selectedOptions[0]?.textContent ?? '' });
    if (wanted[m] || source().state !== 'off') {
      cancelCountdown(); stopRecording('device_changed');
      wanted[m] = true; $('collectNotice').hidden = true;
      source().start(device());
    }
  }

  async function turnOnSource() {
    wanted[mode()] = true;
    $('collectNotice').hidden = true;
    await source().start(device());
    await populateDevices();      // names appear once permission is given
  }

  function toggleSource() {
    if (source().state === 'live' || source().state === 'starting') {
      wanted[mode()] = false;
      cancelCountdown(); stopRecording('source_off');
      source().stop();
      cameraView.clear(); spectrogramView.clear();
      $('collectNotice').hidden = true;
    } else turnOnSource();
  }

  function sync() {
    const m = mode(), text = SOURCE_TEXT[m], src = source(), st = src.state, background = isBackground();
    setIcon($('captureIcon'), text.icon); $('captureTitle').textContent = text.title;
    setIcon($('powerIcon'), text.icon, 16);
    $('burstUnit').textContent = text.unit;
    $('micLevel').hidden = !(m === 'audio' && st === 'live');
    const msg = $('collectMsg');
    $('collectCam').hidden = !(st === 'live' && m === 'image');
    $('collectSpec').hidden = !(st === 'live' && m === 'audio');
    if (st === 'live') {
      msg.hidden = true;
      view().draw();
    } else {
      msg.hidden = false;
      if (st === 'starting') msg.innerHTML = `${icon(text.icon, 30)}<b>${text.starting}</b><p>This can take a few seconds.</p>`;
      else if (st === 'error' && src.lastProblem) {
        const [kind, message] = src.lastProblem;
        msg.innerHTML = `${icon('info', 30)}<b></b><p></p><div class="row"><button class="btn primary">Try again</button></div>`;
        msg.querySelector('b').textContent = PROBLEM_TITLES[`${m}:${kind}`] ?? `${text.title} problem`;
        msg.querySelector('p').textContent = message;
        msg.querySelector('button').onclick = turnOnSource;
      } else {
        msg.innerHTML = `${icon(text.icon, 30)}<b>${text.offTitle}</b><p>${text.offBody}</p><div class="row"><button class="btn primary">${icon(text.icon, 18)}${text.turnOn}</button></div>`;
        msg.querySelector('button').onclick = turnOnSource;
      }
    }
    let [chipText, chipKind] = { live: ['Live', 'success'], starting: ['Starting', 'warning'], error: ['Problem', 'accent'] }[st] ?? ['Off', 'neutral'];
    if (recording) [chipText, chipKind] = [`Recording ${session.count}`, 'accent'];
    setChip($('captureChip'), chipText, chipKind);
    $('powerText').textContent = st === 'live' || st === 'starting' ? 'Turn off' : 'Turn on';

    const busy = recording || countdownTimer !== null, cm = captureMode.value;
    $('captureModeCaption').hidden = background; $('captureMode').hidden = background;
    captureMode.setEnabled(selectedId !== null && !busy);
    $('timedRow').hidden = background || cm !== 'burst';
    const canRecord = st === 'live' && selectedId !== null;
    $('recordButton').disabled = !canRecord;
    let label, hint;
    if (background) {
      label = busy ? 'Stop' : `Record ${BACKGROUND_SECONDS} seconds`;
      hint = 'Record the normal sound of the room without making any of your other sounds. It is saved as 1 second clips.';
    } else if (cm === 'hold') {
      label = recording ? 'Recording' : 'Hold to record';
      hint = m === 'image' ? 'Press and hold to record. Let go to stop.' : 'Press and hold to record. Every full second you hold becomes one clip.';
    } else if (cm === 'toggle') {
      label = recording ? 'Stop recording' : 'Start recording';
      hint = m === 'image' ? 'Click once to start and again to stop.' : 'Click once to start and again to stop. Every full second becomes one clip.';
    } else {
      label = busy ? 'Cancel' : `Record ${state.settings.capture_burst_count}`;
      hint = m === 'image' ? 'Counts down, then records a set number of samples.' : 'Counts down, then records a set number of 1 second clips.';
    }
    if (!canRecord) hint = `Turn on the ${text.device} and pick a class first.`;
    $('recordText').textContent = label;
    $('captureHint').textContent = hint;
  }

  async function onCaptureMode(value) {
    if (selectedId !== null) {
      try { await state.updateClass(selectedId, { capture_mode: value }); } catch (e) { showError('Could not change capture mode', e.message); }
    }
    sync();
  }

  function onRecordClicked() {
    if (isBackground()) { if (recording) stopRecording('user'); else startRecording(BACKGROUND_SECONDS); return; }
    const cm = captureMode.value;
    if (cm === 'toggle') { if (recording) stopRecording('user'); else startRecording(); }
    else if (cm === 'burst') {
      if (recording) stopRecording('cancelled');
      else if (countdownTimer) cancelCountdown();
      else beginCountdown();
    }
  }

  function beginCountdown() {
    countdownValue = state.settings.capture_countdown;
    if (countdownValue <= 0) { startRecording(state.settings.capture_burst_count); return; }
    view().setCountdown(countdownValue); view().draw();
    countdownTimer = setInterval(() => {
      countdownValue -= 1;
      if (countdownValue > 0) { view().setCountdown(countdownValue); view().draw(); return; }
      clearInterval(countdownTimer); countdownTimer = null;
      view().setCountdown(null);
      startRecording(state.settings.capture_burst_count);
    }, 1000);
    sync();
  }

  function cancelCountdown() {
    if (!countdownTimer) return;
    clearInterval(countdownTimer); countdownTimer = null;
    cameraView.setCountdown(null); spectrogramView.setCountdown(null); view().draw();
    sync();
  }

  async function startRecording(limit = null) {
    if (recording) return;
    const p = state.project;
    const cls = p && selectedId ? p.classes(mode()).find(c => c.id === selectedId) : null;
    if (!cls) return;
    const m = mode(), folder = () => {
      if (!p.classes(m).includes(cls)) throw new Error(`“${cls.name}” was deleted while recording.`);
      return p.classDir(m, cls);
    };
    await folder();
    if (limit === null && captureMode.value === 'hold' && !isBackground() && !pressed) return;     // let go already
    if (recording || !source().startRecording(cls.id, folder, limit)) return;
    recording = true;
    session = { count: 0, started: performance.now(), classId: cls.id, color: cls.color, mode: isBackground() ? 'background' : captureMode.value };
    showRecordingBadge();
    events.log('recording_started', { mode: mode(), class_id: cls.id, class_name: cls.name, capture_mode: session.mode, limit });
    sync();
  }

  function showRecordingBadge() {
    const v = view();
    v.setRecording(`REC  ${session.count}`, session.color);
    v.draw();
  }

  function stopRecording(reason, finishedCount = null) {
    if (!recording) return;
    const m = mode();
    const workerCount = source().stopRecording();
    session.count = Math.max(session.count, workerCount, finishedCount ?? 0);
    recording = false;
    const p = state.project, cls = p?.classes(m).find(c => c.id === session.classId);
    events.log('samples_captured', { mode: m, class_id: session.classId, class_name: cls?.name ?? '', count: session.count, capture_mode: session.mode, duration_s: Math.round((performance.now() - session.started) / 10) / 100, reason });
    const unit = SOURCE_TEXT[m].unit;
    if (session.count) state.status(`Saved ${session.count} ${session.count === 1 ? unit.replace(/s$/, '') : unit} to “${cls?.name ?? ''}”`);
    else if (m === 'audio' && reason === 'released') state.status('Hold the button for at least 1 second to save a clip');
    cameraView.setRecording(null); spectrogramView.setRecording(null); view().draw();
    sync();
  }

  function onSampleSaved(m, classId, name, blob) {
    if (!state.project) return;
    state.sampleCaptured(m, classId, name, blob);
    if (m !== mode() || !recording || classId !== session.classId) return;
    session.count += 1;
    if (m === 'audio') spectrogramView.markClip(session.color);
    showRecordingBadge();
    setChip($('captureChip'), `Recording ${session.count}`, 'accent');
  }

  async function deleteSample(classId, name) {
    try { await state.deleteSample(mode(), classId, name); } catch (e) { showError('Could not delete sample', e.message); }
  }

  async function addClass() {
    let cls;
    try { cls = await state.addClass(); } catch (e) { showError('Could not add class', e.message); return; }
    select(cls.id);
    setTimeout(() => cards.get(cls.id)?.startRename(), 0);
  }

  async function renameClass(id, name) {
    if (session.classId === id) { cancelCountdown(); stopRecording('class_renamed'); }
    try { await state.renameClass(id, name); } catch (e) { showError('Could not rename class', e.message); refresh(); }
  }

  async function deleteClass(id) {
    const p = state.project;
    const cls = p?.classes(mode()).find(c => c.id === id);
    if (!cls) return;
    const count = p.sampleCount(mode(), id), unit = SOURCE_TEXT[mode()].unit;
    const ok = await confirm('Delete class?', `This permanently deletes “${cls.name}” and its ${count} ${count === 1 ? unit.replace(/s$/, '') : unit} from your data folder. This cannot be undone.`, 'Delete class', true);
    if (!ok) return;
    if (session.classId === id || selectedId === id) { cancelCountdown(); stopRecording('class_deleted'); }
    try { await state.deleteClass(id); } catch (e) { showError('Could not delete class', e.message); }
  }

  function onModeChanged() {
    cancelCountdown(); stopRecording('mode_changed');
    for (const [m, src] of Object.entries(sources)) if (m !== mode()) src.stop();
    cameraView.clear(); spectrogramView.clear();
    $('collectNotice').hidden = true;
    populateDevices();
    if (active && wanted[mode()] && state.project) source().start(device());
    selectedId = null;
    refresh();
  }

  return {
    onEnter() {
      active = true;
      populateDevices();
      if (wanted[mode()] && state.project) source().start(device());
      sync();
    },
    onLeave() {
      active = false;
      cancelCountdown(); stopRecording('left_tab');
      for (const src of Object.values(sources)) src.stop();
      cameraView.clear(); spectrogramView.clear();
    },
    refresh,
  };
}
