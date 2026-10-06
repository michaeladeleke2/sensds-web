// The Train tab of SensDSv2 (ui/train_tab.py TrainTab + TrainWorker): pick
// students, check the dataset (3 gestures and 20 samples needed), set epochs,
// batch size, learning rate and validation students, download the base ViT
// once, then train in a Web Worker with live per-epoch charts. The model is
// saved to <data folder>/models/<students>_vN/ in Hugging Face format, the
// same layout the desktop writes.

import { discoverSubjects, classCounts } from '../train/dataset.js';
import { splitSubjects, randomSplit, pyList, fmtDur } from '../train/trainer.js';
import { MODEL_OPTIONS, DEFAULT_MODEL_KEY, isCached, download, load } from '../train/model_store.js';
import { LineChart } from '../viz/line_chart.js';
import { currentFolder, setCurrentFolder, onFolderChange, chooseFolder, ensureWritable, canRead, canChooseFolder, subfolder, writeFile, listNames } from '../io/folder.js';

const MIN_SAMPLES = 20, MIN_CLASSES = 3, SEED = 42;
const HINTS = [
  "Epochs: one full run through all your samples. More = more practice for the model. Watch the chart: if the orange line stops climbing, it's done learning.",
  'Batch size: how many samples the model sees at once before updating. 8 is great for small datasets. Think of it like studying in groups of 8.',
  "Learning rate: how big a step the model takes when it makes a mistake. 0.00002 is the sweet spot. Don't change it unless things go wrong.",
  'Val subjects: classmates kept secret from the model during training. Their data is used only to check if the model actually learned, not to cheat.',
  'Green accuracy line rising = model is getting smarter. Orange F1 line is more trustworthy when you have unequal numbers of each gesture.',
  'Training can take several minutes, so let it run! The chart updates after each epoch so you can watch progress live.',
  "The model learns from spectrogram images. it's basically learning to read radar pictures of your hand movements.",
];

const $ = id => document.getElementById(id);
const state = { subjects: [], worker: null, start: null, epochsTotal: 0, acc: [], f1: [], loss: [], timer: null, phase: '' };
let scoreChart, lossChart;

const log = msg => { const el = $('trainLog'); el.textContent += (el.textContent ? '\n' : '') + msg; el.scrollTop = el.scrollHeight; };
const statusLine = (id, cls, text) => { const el = $(id); el.className = cls; el.textContent = text; };
const modelId = () => MODEL_OPTIONS[$('modelSize').value] || MODEL_OPTIONS[DEFAULT_MODEL_KEY];
const selectedStudents = () => ($('allStudents').checked ? null : [...document.querySelectorAll('#studentList input:checked')].map(c => c.value));

// ---------- base model ----------
async function refreshModelStatus() {
  const id = modelId();
  if (await isCached(id)) {
    statusLine('modelStatus', 'status-ok', `✓  browser cache (${id.split('/').pop()})`);
    $('downloadBtn').disabled = true; $('downloadBtn').textContent = '✓  Model ready';
  } else {
    statusLine('modelStatus', 'status-warn', '⚠  Not downloaded. Training requires internet without this');
    $('downloadBtn').disabled = false; $('downloadBtn').textContent = '⬇  Download Model (once)';
  }
}

async function startDownload() {
  $('downloadBtn').disabled = true; $('downloadBtn').textContent = 'Downloading…';
  statusLine('modelStatus', 'status-warn', 'Downloading model weights, please wait…');
  try { await download(modelId(), t => { $('modelStatus').textContent = t; }); }
  catch (e) { statusLine('modelStatus', 'status-err', `✗  Download failed: ${e.message}`); $('downloadBtn').disabled = false; $('downloadBtn').textContent = '⬇  Download Model (once)'; return; }
  refreshModelStatus();
}

// ---------- dataset ----------
async function refresh(ask = false) {
  refreshModelStatus();
  const folder = currentFolder();
  $('trainFolderBtn').textContent = folder ? `📂  ${folder.name}` : '📂  Choose Data Folder';
  let readable = folder && (await canRead(folder));
  if (folder && !readable && ask) readable = await ensureWritable(folder);
  state.subjects = readable ? await discoverSubjects(folder) : [];
  const list = $('studentList');
  list.replaceChildren(...state.subjects.map(s => {
    const label = document.createElement('label'); label.className = 'check';
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', value: s.name, checked: true });
    cb.onchange = updateStatus;
    label.append(cb, ` ${s.name}`);
    return label;
  }));
  if (!folder) $('trainMsg').textContent = 'Choose the folder your samples are saved in (the same one the Collect tab uses).';
  else if (!readable) $('trainMsg').textContent = 'Click Refresh to allow this page to read the data folder.';
  else $('trainMsg').textContent = '';
  updateStatus();
}

function updateStatus() {
  const counts = classCounts(state.subjects, selectedStudents());
  const nClasses = Object.keys(counts).length, nSamples = Object.values(counts).reduce((a, b) => a + b, 0);
  const ready = nClasses >= MIN_CLASSES && nSamples >= MIN_SAMPLES;
  statusLine('trainClasses', nClasses >= MIN_CLASSES ? 'status-ok' : 'status-err',
    nClasses >= MIN_CLASSES ? `✓  ${nClasses} gesture classes: ${Object.keys(counts).sort().join(', ')}` : `✗  ${nClasses} gesture classes (need ${MIN_CLASSES})`);
  statusLine('trainSamples', nSamples >= MIN_SAMPLES ? 'status-ok' : 'status-err',
    nSamples >= MIN_SAMPLES ? `✓  ${nSamples} total samples` : `✗  ${nSamples} samples (need ${MIN_SAMPLES})`);
  statusLine('trainReady', ready ? 'status-ok' : 'status-warn', ready ? '✓  Ready to train' : 'Collect more data to unlock training');
  $('trainBtn').disabled = !ready || Boolean(state.worker);
}

// ---------- training ----------
async function startTraining() {
  const folder = currentFolder();
  if (!folder || !(await ensureWritable(folder))) { log('✗ Allow access to the data folder first.'); return; }
  const filter = selectedStudents();
  const subjectsAll = state.subjects.filter(s => !filter || filter.includes(s.name));
  const names = subjectsAll.map(s => s.name).sort();
  let baseName = names.length ? names.join('_') : 'all_students';
  if (baseName.length > 60) baseName = baseName.slice(0, 60);
  const models = await subfolder(folder, ['models'], true);
  const existing = new Set((await listNames(models)).dirs);
  let version = 1;
  while (existing.has(`${baseName}_v${version}`)) version++;
  const outName = `${baseName}_v${version}`;

  state.acc = []; state.f1 = []; state.loss = []; state.phase = '';
  scoreChart.clear(); lossChart.clear();
  scoreChart.setTitle('Accuracy & F1'); lossChart.setTitle('Val Loss');
  $('trainLog').textContent = '';
  log('Starting training...');
  state.start = performance.now(); state.epochsTotal = Number($('epochs').value);
  $('trainTimer').textContent = '⏱  0s elapsed   ·   starting…';
  state.timer = setInterval(tickElapsed, 1000);
  $('trainBtn').hidden = true; $('stopTrainBtn').hidden = false;

  try {
    const id = modelId();
    if (!(await isCached(id))) {
      log(`⚠  No local copy of ${id} found. attempting HuggingFace download.\n   Connect to the internet or click 'Download Model' first.`);
      await download(id, t => { $('modelStatus').textContent = t; });
      refreshModelStatus();
    } else log(`Model: browser cache (${id.split('/').pop()})  (${id})`);
    const base = await load(id);

    if (!subjectsAll.length) throw new Error('None of the selected students have any samples.');
    const split = splitSubjects(names, Number($('valSubjects').value), SEED);
    if (split.randomSplit) log('Single subject. Using random 80/20 split.');
    log(`Train subjects: ${pyList(split.train)}`);
    log(`Val subjects:   ${pyList(split.val)}`);

    const labelNames = [...new Set(subjectsAll.flatMap(s => s.gestures.map(g => g.gesture)))].sort();
    const label2id = Object.fromEntries(labelNames.map((n, i) => [n, i]));
    log(`Classes (${labelNames.length}): ${pyList(labelNames)}`);

    const itemsFor = async subjNames => {
      const items = [];
      for (const s of subjectsAll.filter(x => subjNames.includes(x.name)))
        for (const g of s.gestures) for (const p of g.pngs) items.push({ handle: await g.dir.getFileHandle(p), label: label2id[g.gesture] });
      return items;
    };
    let trainItems = await itemsFor(split.train), valItems = await itemsFor(split.val);
    if (split.randomSplit) { trainItems = randomSplit(trainItems, SEED, true); valItems = randomSplit(valItems, SEED, false); }
    log(`Train samples: ${trainItems.length}  |  Val samples: ${valItems.length}`);
    if (!trainItems.length || !valItems.length) {
      const which = !trainItems.length ? 'Training' : 'Validation', subj = !trainItems.length ? split.train : split.val;
      const counts = subjectsAll.map(s => `${s.name}: ${s.gestures.reduce((n, g) => n + g.pngs.length, 0)} samples`).join(', ');
      throw new Error(`${which} set is empty.\n\n${which} subjects: ${pyList(subj)}\nSamples per student: ${counts}\n\nEach student folder needs gesture sub-folders with PNGs:\n    ${folder.name}/<student>/<gesture>/*.png\nIf a student has no samples, untick them under 'Select students' or collect data for them first.`);
    }
    const valClasses = new Set(subjectsAll.filter(s => split.val.includes(s.name)).flatMap(s => s.gestures.map(g => g.gesture)));
    const missing = labelNames.filter(n => !valClasses.has(n));
    if (missing.length) log(`⚠  Validation subject(s) ${pyList(split.val)} have no samples for: ${pyList(missing)}. Accuracy/F1 only reflect the classes they do have.`);
    log('Loading ViT model...');

    const toFiles = async items => Promise.all(items.map(async it => ({ file: await it.handle.getFile(), label: it.label })));
    const message = {
      type: 'train', base, train: await toFiles(trainItems), val: await toFiles(valItems), labelNames,
      epochs: state.epochsTotal, batchSize: Number($('batchSize').value), lr: Number($('lr').value), seed: SEED,
    };
    log(`Setup took ${fmtDur((performance.now() - state.start) / 1000)}. Training...`);
    const worker = new Worker(new URL('../train/worker.js', import.meta.url), { type: 'module' });
    state.worker = worker;
    worker.onmessage = async ({ data }) => {
      if (data.type === 'log') log(data.msg);
      else if (data.type === 'progress') {
        state.phase = data.phase === 'loading' ? `loading images ${data.done}/${data.total}`
          : data.phase === 'train' ? `epoch ${data.epoch}: step ${data.step}/${data.steps}`
            : `epoch ${data.epoch}: checking validation samples`;
        tickElapsed();
      }
      else if (data.type === 'epoch') onEpoch(data);
      else if (data.type === 'error') finish(`\n✗ Error: ${explainError(data.message.split('\n')[0])}`, '✗  Failed after ');
      else if (data.type === 'done') {
        try {
          const out = await subfolder(models, [outName], true);
          const modelDir = await subfolder(out, ['model'], true);
          for (const [path, content] of Object.entries(data.files)) await writeFile(path.startsWith('model/') ? modelDir : out, path.split('/').pop(), content);
          const where = `${folder.name}/models/${outName}/model`;
          log(`Model saved to: ${where}`);
          log(`Total time (setup + training + save): ${fmtDur((performance.now() - state.start) / 1000)}`);
          finish(`\n✓ Training complete. Model saved to:\n${where}`, '✓  Trained in ');
        } catch (e) { finish(`\n✗ Error: could not save the model: ${e.message}`, '✗  Failed after '); }
      }
    };
    worker.onerror = e => finish(`\n✗ Error: ${e.message || 'the training worker failed to start'}`, '✗  Failed after ');
    worker.postMessage(message, [base.weights]);
  } catch (e) {
    finish(`\n✗ Error: ${e.message}`, '✗  Failed after ');
  }
}

function onEpoch({ loss, acc, f1 }) {
  state.loss.push(loss); state.acc.push(acc); state.f1.push(f1);
  scoreChart.set(0, state.acc); scoreChart.set(1, state.f1); lossChart.set(0, state.loss);
  scoreChart.setTitle(`Accuracy & F1   ·   ${(acc * 100).toFixed(1)}%  /  ${f1.toFixed(3)}`);
  lossChart.setTitle(`Val Loss   ·   ${loss.toFixed(4)}`);
}

function tickElapsed() {
  if (state.start === null) return;
  const elapsed = (performance.now() - state.start) / 1000, done = state.acc.length;
  if (done > 0 && state.epochsTotal > 0) {
    const remaining = Math.max(0, elapsed / done * (state.epochsTotal - done));
    $('trainTimer').textContent = `⏱  ${fmtDur(elapsed)} elapsed   ·   ~${fmtDur(remaining)} left   ·   epoch ${done}/${state.epochsTotal}${state.phase ? `   ·   ${state.phase}` : ''}`;
  } else $('trainTimer').textContent = `⏱  ${fmtDur(elapsed)} elapsed   ·   ${state.phase || 'starting…'}`;
}

// A lost GPU (out of graphics memory, or the GPU process restarted) shows up
// as a WebGPU error that means nothing to a student; say what happened.
function explainError(msg) {
  if (/mapAsync|Instance reference|device (was |is )?lost|Device lost|out of memory|OOM/i.test(msg)) {
    const base = $('modelSize').value === 'Base';
    return `The graphics processor ran out of memory and stopped (${msg}).\n` +
      (base ? 'The Base model is too large to train on this computer. Choose Small under Model Size and try again.'
        : `Try a smaller Batch size (for example ${Math.max(1, Math.floor(Number($('batchSize').value) / 2))}), close other tabs, and try again.`);
  }
  return msg;
}

function finish(message, timerNote) {
  clearInterval(state.timer);
  if (state.start !== null) $('trainTimer').textContent = `${timerNote}${fmtDur((performance.now() - state.start) / 1000)}`;
  state.start = null;
  state.worker?.terminate(); state.worker = null;
  log(message);
  $('trainBtn').hidden = false; $('stopTrainBtn').hidden = true;
  updateStatus();
}

// ---------- wiring ----------
export function initTrain() {
  for (const [key, id] of Object.entries(MODEL_OPTIONS)) {
    const label = key === 'Small' ? `Small (${id.split('/').pop()}, faster)` : `Base (${id.split('/').pop()}, more accurate)`;
    $('modelSize').append(new Option(label, key));
  }
  $('modelSize').value = DEFAULT_MODEL_KEY;
  $('modelSize').onchange = refreshModelStatus;
  $('downloadBtn').onclick = startDownload;
  $('allStudents').onchange = $('selectStudents').onchange = () => { $('studentList').hidden = $('allStudents').checked; updateStatus(); };
  $('trainRefreshBtn').onclick = () => refresh(true);
  $('trainFolderBtn').onclick = async () => { if (!canChooseFolder()) return; try { setCurrentFolder(await chooseFolder()); } catch { /* closed */ } };
  $('trainBtn').onclick = startTraining;
  $('stopTrainBtn').onclick = () => { state.worker?.postMessage({ type: 'stop' }); log('Stopping after the current batch...'); };
  scoreChart = new LineChart($('scoreChart'), { title: 'Accuracy & F1', yRange: [0, 1.05], legend: true, series: [
    { name: 'Accuracy', color: '#2ecc71', marker: 'circle' }, { name: 'F1 (macro)', color: '#f39c12', dash: true, marker: 'triangle' }] });
  lossChart = new LineChart($('lossChart'), { title: 'Val Loss', series: [{ name: 'Val Loss', color: '#e74c3c', marker: 'circle' }] });
  let hint = 0;
  $('trainHint').textContent = HINTS[0];
  setInterval(() => { hint = (hint + 1) % HINTS.length; $('trainHint').textContent = HINTS[hint]; }, 6000);
  onFolderChange(() => refresh().catch(() => {}));
}

export function showTrain() { refresh().catch(() => {}); scoreChart.draw(); lossChart.draw(); }
