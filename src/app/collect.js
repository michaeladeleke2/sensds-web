// The Collect tab of SensDSv2 (ui/collect_tab.py CollectTab + CaptureWorker),
// Infineon SDK method. Per sample:
//   1. count down `delay` seconds, one per second,
//   2. take the next round(duration / 0.15) radar frames (frames that arrive
//      during the countdown are not kept); give up after duration * 3 s,
//   3. spectrogram = compute_recorded(frames, antenna 0) (reference_spectrogram),
//   4. save sample_NNN.npy (spectrogram, float64), sample_NNN_raw.npy (frames,
//      float32) and sample_NNN.png (training_image: reference drawing, 400x300),
//      write capture_info.json, and draw the capture on the right.
// Files go to <data folder>/<student name>/<gesture label>/, numbering on from
// the highest sample already there.

import { computeRecorded } from '../dsp/recorded.js';
import { trainingImage } from '../collect/training_image.js';
import {
  GESTURES, numFramesFor, captureTimeoutMs, isSampleFile, nextSampleNumber,
  sampleStem, captureInfoJson, captureMismatch,
} from '../collect/capture.js';
import { writeNpy } from '../io/npy.js';
import { encodePngRgb } from '../io/png.js';
import {
  canChooseFolder, rememberedFolder, chooseFolder, ensureWritable,
  subfolder, tryFolder, listNames, writeFile, readText, canRead, setCurrentFolder, onFolderChange,
} from '../io/folder.js';
import { RecordedSpectrogramPlot } from '../viz/recorded_plot.js';
import { subscribeFrames, isConnected } from './radar_session.js';
import { currentJetVmin, getReduceNoise, setReduceNoise, onReduceNoiseChange } from './settings.js';

const CAPTURE_INFO = 'capture_info.json';
const N_ANT = 3, N_CHIRP = 128, N_SAMPLE = 256, BINS = 512;
const HINTS = [
  'Type your name and pick a gesture, then hit Start. The radar will count down before each recording.',
  'Do the same move every time: same speed, same hand height, same distance from the sensor. Repetition = better data.',
  'Aim for at least 25 samples per gesture. More samples = smarter model!',
  'The delay timer between samples gives you a moment to reset before the next countdown.',
  'Each recording is automatically saved. Come back later and add more; it picks up where you left off.',
  'Have a few different people record data too. The model will work better for everyone, not just you.',
];

const $ = id => document.getElementById(id);
const preview = new RecordedSpectrogramPlot($('previewCanvas'));
let folder = null;                    // FileSystemDirectoryHandle of the data folder

const worker = { running: false, collecting: false, frames: [], wanted: 0 };
const batch = { saveDir: null, collected: 0, total: 0, label: '', name: '' };

// ---------- status line (the desktop's status_msg styles) ----------
const STYLES = {
  info: 'font-size: 11px; color: #888; font-weight: normal;',
  countdown: 'color: #e67e22; font-size: 22px; font-weight: bold;',
  capturing: 'color: #c0392b; font-size: 22px; font-weight: bold;',
  saved: 'color: #27ae60; font-size: 18px; font-weight: bold;',
  done: 'color: #27ae60; font-size: 13px; font-weight: bold;',
  stopped: 'color: #888; font-size: 13px; font-weight: normal;',
  error: 'color: #c0392b; font-size: 13px; font-weight: bold;',
};
function status(text, style = 'info') { const el = $('collectStatus'); el.textContent = text; el.style.cssText = STYLES[style]; }

// ---------- frames from the radar ----------
subscribeFrames(cube => { if (worker.collecting) worker.frames.push(cube); });   // feed_frame

const sleep = ms => new Promise(r => setTimeout(r, ms));

// CaptureWorker.run
async function runWorker(numSamples, durationS, delayS, numFrames) {
  worker.running = true;
  for (let i = 0; i < numSamples; i++) {
    if (!worker.running) return onStopped();
    for (let c = Math.trunc(delayS); c > 0; c--) {
      if (!worker.running) return onStopped();
      status(`Get ready... ${c}`, 'countdown');
      await sleep(1000);
    }
    worker.frames = [];
    worker.collecting = true;
    status('⬤  Perform your gesture NOW!', 'capturing');
    const deadline = performance.now() + captureTimeoutMs(durationS);
    while (worker.frames.length < numFrames && worker.running && performance.now() < deadline) await sleep(10);
    worker.collecting = false;
    if (!worker.running) return onStopped();

    if (worker.frames.length >= numFrames) {
      const frames = worker.frames.slice(0, numFrames);
      const per = N_CHIRP * N_SAMPLE;
      const { spectrogram } = computeRecorded(frames.map(f => f.subarray(0, per)), N_CHIRP, N_SAMPLE);
      try {
        await onSampleDone(spectrogram, frames);
      } catch (e) {
        worker.running = false;
        status(`Could not save the sample: ${e.message}`, 'error');
        return finish();
      }
      $('collectProgress').value = i + 1;
    }
  }
  onBatchDone();
}

// CollectTab._on_sample_done, Infineon SDK branch
async function onSampleDone(spectrogram, frames) {
  const n = frames.length;
  batch.collected += 1;
  const stem = sampleStem(batch.collected);
  const raw = new Float32Array(n * N_ANT * N_CHIRP * N_SAMPLE);
  frames.forEach((f, i) => raw.set(f, i * f.length));
  const jetVmin = currentJetVmin();
  const img = trainingImage(spectrogram, n, BINS, jetVmin);

  await writeFile(batch.saveDir, `${stem}.npy`, writeNpy(spectrogram, [n, BINS]));
  await writeFile(batch.saveDir, `${stem}_raw.npy`, writeNpy(raw, [n, N_ANT, N_CHIRP, N_SAMPLE]));
  await writeFile(batch.saveDir, `${stem}.png`, await encodePngRgb(img.rgb, img.width, img.height));
  try { await writeFile(batch.saveDir, CAPTURE_INFO, captureInfoJson(jetVmin)); } catch { /* never let bookkeeping lose a capture */ }

  $('previewPlaceholder').hidden = true;
  preview.draw(spectrogram, n, BINS, jetVmin);
  await refreshCounts();
  const { files } = await listNames(batch.saveDir);
  const total = files.filter(isSampleFile).length;
  $('sampleCount').textContent = `#${batch.collected} saved  ·  ${total} total for '${batch.label}'  ·  raw ${n}x${N_ANT}x${N_CHIRP}x${N_SAMPLE} float32`;
  status(`✓ Sample ${batch.collected} saved.`, 'saved');
}

function onBatchDone() { finish(); status(`✓ All ${batch.total} samples collected and saved!`, 'done'); }
function onStopped() { finish(); status(`Stopped. ${batch.collected} samples saved.`, 'stopped'); }
function finish() {
  worker.running = false;
  worker.collecting = false;
  $('collectProgress').hidden = true;
  $('startBtn').hidden = false;
  $('stopBtn').hidden = true;
}

// CollectTab._start_collection
async function startCollection() {
  const name = $('studentName').value.trim();
  const label = $('gestureLabel').value.trim();
  if (!name) return alert('Please enter a student name.');
  if (!label) return alert('Please enter a gesture label.');
  if (!isConnected()) return status('Connect the radar first (Connect Radar, top left).', 'error');
  if (!folder) { await pickFolder(); if (!folder) return; }
  if (!(await ensureWritable(folder))) return status('Allow access to the data folder to save samples.', 'error');

  const existing = await tryFolder(folder, [name, label]);
  const mismatch = await mismatchFor(existing);
  if (mismatch && !confirm(`${mismatch}\n\nCollect anyway?`)) return;

  const saveDir = await subfolder(folder, [name, label], true);
  const { files } = await listNames(saveDir);
  Object.assign(batch, { saveDir, collected: nextSampleNumber(files), total: Number($('numSamples').value), label, name });

  $('collectProgress').max = batch.total;
  $('collectProgress').value = 0;
  $('collectProgress').hidden = false;
  $('startBtn').hidden = true;
  $('stopBtn').hidden = false;
  const offset = batch.collected > 0 ? `  (continuing from ${batch.collected})` : '';
  status(`Saving to ${folder.name}/${name}/${label}/${offset}`, 'info');

  const duration = Number($('duration').value);
  runWorker(batch.total, duration, Number($('delay').value), numFramesFor(duration));
}

async function mismatchFor(dir) {
  if (!dir) return '';
  const { files } = await listNames(dir);
  const text = await readText(dir, CAPTURE_INFO);
  let info = null;
  try { info = text ? JSON.parse(text) : null; } catch { info = null; }
  return captureMismatch(files.some(isSampleFile), info, currentJetVmin());
}

// ---------- samples on disk, and the settings warning ----------
async function refreshCounts() {
  await refreshWarning();
  const name = $('studentName').value.trim();
  const grid = $('countsGrid');
  grid.replaceChildren();
  const empty = $('countsEmpty');
  if (!name) { $('countsTitle').textContent = 'Samples on disk'; empty.textContent = 'Enter a name above to see counts.'; empty.hidden = false; return; }
  $('countsTitle').textContent = `Samples on disk:  ${name}`;
  if (!folder) { empty.textContent = 'Choose a data folder to see counts.'; empty.hidden = false; return; }
  if (!(await canRead(folder))) { empty.textContent = `Click Start, or the data folder button, to allow access to ${folder.name}.`; empty.hidden = false; return; }
  const gestures = [];
  const student = await tryFolder(folder, [name]);
  if (student) {
    try {
      const { dirs } = await listNames(student);
      for (const g of dirs.sort()) {
        const { files } = await listNames(await student.getDirectoryHandle(g));
        const count = files.filter(isSampleFile).length;
        if (count > 0) gestures.push([g, count]);
      }
    } catch { /* folder changed underneath; show what we have */ }
  }
  if (!gestures.length) { empty.textContent = 'No samples collected yet.'; empty.hidden = false; return; }
  empty.hidden = true;
  for (const [g, count] of gestures) {
    const a = document.createElement('span'); a.className = 'count-name'; a.textContent = g;
    const b = document.createElement('span'); b.className = 'count-value'; b.textContent = count;
    grid.append(a, b);
  }
}

async function refreshWarning() {
  const name = $('studentName').value.trim(), label = $('gestureLabel').value.trim();
  let msg = '';
  if (folder && name && label && await canRead(folder)) {
    try { msg = await mismatchFor(await tryFolder(folder, [name, label])); } catch { msg = ''; }
  }
  $('captureWarn').textContent = msg ? `⚠  ${msg}` : '';
  $('captureWarn').hidden = !msg;
}

// ---------- data folder ----------
async function pickFolder() {
  if (!canChooseFolder()) { status('This browser cannot save to a folder. Use Chrome or Edge on a computer.', 'error'); return; }
  let picked;
  try { picked = await chooseFolder(); } catch { return; }       // closed the picker
  setCurrentFolder(picked);                                        // shared with the Analysis tab
}

function showFolder() { $('folderBtn').textContent = folder ? `📂  Data folder: ${folder.name}` : '📂  Choose Data Folder'; }

// ---------- wiring ----------
function updateCaptureNote() {
  $('captureNote').textContent = 'Saved exactly as the reference script draws it, the picture shown on the right, and the Test tab reads live gestures the same way.';
}

export async function initCollect() {
  $('gestureList').replaceChildren(...GESTURES.map(g => Object.assign(document.createElement('option'), { value: g })));
  $('gestureLabel').value = GESTURES[0];
  $('collectNoise').checked = getReduceNoise();
  $('collectNoise').onchange = e => setReduceNoise(e.target.checked);
  onReduceNoiseChange(on => { $('collectNoise').checked = on; preview.redraw(currentJetVmin()); refreshCounts(); });
  $('studentName').oninput = () => refreshCounts();
  $('gestureLabel').oninput = () => refreshWarning();
  $('startBtn').onclick = () => startCollection();
  $('stopBtn').onclick = () => { worker.running = false; worker.collecting = false; };
  $('folderBtn').onclick = () => pickFolder();
  updateCaptureNote();

  // Rotating hint card (HintCard, 6 s)
  let hint = 0;
  $('hintText').textContent = HINTS[0];
  setInterval(() => { hint = (hint + 1) % HINTS.length; $('hintText').textContent = HINTS[hint]; }, 6000);

  new ResizeObserver(() => preview.redraw()).observe($('previewCanvas'));

  if (!canChooseFolder()) $('folderBtn').title = 'Saving to a folder needs Chrome or Edge on a computer.';
  onFolderChange(h => { folder = h; showFolder(); refreshCounts().catch(() => {}); });
  setCurrentFolder(await rememberedFolder());
}

export function showCollect() { preview.redraw(); refreshCounts().catch(() => {}); }
