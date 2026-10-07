// The Train tab (app/ui/tabs/train.py): the checklist (2 classes, 20 image
// samples or 8 clips per class, 20 Background Noise clips), the advanced
// settings (epochs, batch size, learning rate), live accuracy and loss charts
// while training, then the result: validation accuracy, accuracy per class,
// the confusion matrix, and a confetti burst.

import { $, setChip, setIcon, showError, friendlyDate, icon } from '../ui/ui.js';
import { MetricChart, celebrate, TRAIN_COLOR } from '../ui/views.js';
import { BACKGROUND_CLASS_ID, MODE_LABELS, trainingDefaults } from '../storage/project.js';
import { MIN_CLASSES, MIN_SAMPLES, MIN_BACKGROUND_CLIPS } from './collect.js';

const STATUS_CHIPS = {
  none: ['Not trained', 'neutral'], current: ['Up to date', 'success'],
  samples_changed: ['New samples since training', 'warning'], classes_changed: ['Classes changed, train again', 'warning'],
};

// training_requirements(project, mode)
export function trainingRequirements(project, mode) {
  const classes = project.classes(mode), reqs = [];
  if (mode === 'audio') {
    const others = classes.filter(c => c.id !== BACKGROUND_CLASS_ID);
    reqs.push({ label: 'Background Noise plus at least 1 more class', met: others.length >= 1 });
  } else reqs.push({ label: `At least ${MIN_CLASSES} classes`, met: classes.length >= MIN_CLASSES });
  const unit = mode === 'audio' ? 'clips' : 'samples';
  for (const c of classes) {
    const needed = c.id === BACKGROUND_CLASS_ID ? MIN_BACKGROUND_CLIPS : MIN_SAMPLES[mode], count = project.sampleCount(mode, c.id);
    const label = count >= needed ? `${c.name}: ${count} ${count === 1 ? unit.replace(/s$/, '') : unit}, ${needed} needed` : `${c.name}: ${count} of ${needed} ${unit}`;
    reqs.push({ label, met: count >= needed });
  }
  return reqs;
}
export const isReady = reqs => reqs.every(r => r.met);

export function initTrain(state, shell) {
  const accChart = new MetricChart($('accChart'), true), lossChart = new MetricChart($('lossChart'), false);
  let liveHistory = [], liveEpochs = 0, stage = '';
  const t = state.training;

  $('trainButton').onclick = startTraining;
  $('stopTrainButton').onclick = () => t.cancel();
  $('tryTestButton').onclick = () => shell.setTab('test');
  $('advancedToggle').onclick = () => toggleAdvanced($('advanced').hidden);
  $('resetAdvanced').onclick = async () => { const p = state.project; if (!p) return; p.modes[state.mode].training = trainingDefaults(); await p.save(); refresh(); };
  for (const id of ['epochsInput', 'lrInput', 'batchInput']) $(id).addEventListener('change', saveAdvanced);

  t.on('started', () => { const job = t.job; liveHistory = []; liveEpochs = job?.epochs ?? 0; stage = 'preparing'; accChart.reset(liveEpochs); lossChart.reset(liveEpochs); refresh(); });
  t.on('stage', s => { stage = s; if (thisView()) showLive(); });
  t.on('epoch', m => { liveHistory.push(m); if (thisView()) showLive(); });
  t.on('busy', () => updateTrainButton());
  t.on('cancelled', () => { liveHistory = []; refresh(); state.status('Training stopped'); });
  t.on('failed', message => { liveHistory = []; refresh(); showError('Training did not finish', message); });
  state.on('model', mode => {
    liveHistory = [];
    refresh();
    const report = state.modelReport(mode);
    if (!report || mode !== state.mode || !shell.isTab('train')) return;
    const acc = report.val_accuracy;
    state.status(`Model trained${acc !== null && acc !== undefined ? ` with ${Math.round(acc * 100)}% validation accuracy` : ''}`, 6000);
    celebrate($('confetti'), (report.classes ?? []).map(c => c.color ?? '#999999'));
    const badge = $('statusBadge');
    badge.animate([{ transform: 'scale(0.6)' }, { transform: 'scale(1.15)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.3,1)' });
  });
  for (const ev of ['project', 'mode', 'classes']) state.on(ev, () => refresh());
  state.on('samples', () => { if (shell.isTab('train')) refresh(); });
  state.embeddings.on('pending', () => { if (shell.isTab('train')) updateTrainButton(); });

  const thisView = () => t.busy && t.job && state.project && t.job.project === state.project && t.job.mode === state.mode;

  function toggleAdvanced(open) {
    $('advanced').hidden = !open;
    $('advancedText').textContent = open ? 'Hide' : 'Show';
    setIcon($('advancedIcon'), open ? 'chevron_down' : 'chevron_right', 14);
  }

  async function saveAdvanced() {
    const p = state.project;
    if (!p) return;
    const s = p.modes[state.mode].training;
    const epochs = Math.min(1000, Math.max(1, Math.round(Number($('epochsInput').value) || s.epochs)));
    const batch = Number($('batchInput').value) || s.batch_size;
    const lr = Math.min(1, Math.max(0.00001, Math.round((Number($('lrInput').value) || s.learning_rate) * 1e6) / 1e6));
    $('epochsInput').value = epochs; $('lrInput').value = lr;
    if (epochs === s.epochs && batch === s.batch_size && lr === s.learning_rate) return;
    Object.assign(s, { epochs, batch_size: batch, learning_rate: lr });
    await p.save();
  }

  function refresh() {
    const p = state.project;
    if (!p) return;
    const mode = state.mode;
    $('trainTitle').textContent = `Train your ${MODE_LABELS[mode].toLowerCase()} model`;
    const reqs = trainingRequirements(p, mode), done = reqs.filter(r => r.met).length, ready = isReady(reqs);
    $('checklist').innerHTML = '';
    for (const r of reqs) {
      const row = document.createElement('div');
      row.className = `req${r.met ? ' met' : ''}`;
      row.innerHTML = `${icon(r.met ? 'check_circle' : 'circle', 18)}<span></span>`;
      row.querySelector('span').textContent = r.label;
      $('checklist').append(row);
    }
    setChip($('checklistChip'), ready ? 'Ready' : `${done} of ${reqs.length} done`, ready ? 'success' : 'neutral');
    $('checklistBar').style.width = `${reqs.length ? (done / reqs.length) * 100 : 0}%`;
    const classes = p.classes(mode);
    $('tileClasses').textContent = `${reqs.slice(1).filter(r => r.met).length} of ${classes.length}`;
    $('tileSamples').textContent = String(p.totalSamples(mode));
    setIcon($('tileSamplesIcon'), mode === 'image' ? 'image' : 'wave', 20);
    const s = p.modes[mode].training;
    $('epochsInput').value = s.epochs; $('lrInput').value = s.learning_rate;
    if (![...$('batchInput').options].some(o => Number(o.value) === s.batch_size)) $('batchInput').add(new Option(String(s.batch_size)));
    $('batchInput').value = String(s.batch_size);
    if (thisView()) showLive(); else showReport(state.modelReport(mode));
    updateTrainButton();
  }

  function updateTrainButton() {
    const p = state.project;
    if (!p) return;
    const mode = state.mode, busy = t.busy, mine = thisView();
    $('stopTrainButton').hidden = !(busy && mine);
    $('trainButton').hidden = busy && mine;
    const ready = isReady(trainingRequirements(p, mode));
    const missing = ready ? state.missingEmbeddings(mode) : 0;
    const hasModel = state.modelReport(mode) !== null;
    const btn = $('trainButton');
    if (busy) { btn.disabled = true; $('trainButtonText').textContent = 'Train model'; btn.title = 'Another model is training right now.'; }
    else if (!ready) { btn.disabled = true; $('trainButtonText').textContent = 'Train model'; btn.title = 'Finish the checklist to unlock training.'; }
    else if (missing) { btn.disabled = true; $('trainButtonText').textContent = `Preparing ${missing} ${missing === 1 ? 'sample' : 'samples'}`; btn.title = 'New samples are being prepared for training. This only takes a moment.'; }
    else { btn.disabled = false; $('trainButtonText').textContent = hasModel ? 'Train again' : 'Train model'; btn.title = ''; }
  }

  function setStatus(iconName, kind, title, subtitle) {
    const b = $('statusBadge');
    setIcon(b, iconName, 24);
    b.style.background = kind === 'success' ? 'var(--success-soft)' : 'var(--accent-soft)';
    b.style.color = kind === 'success' ? 'var(--success)' : 'var(--accent)';
    $('statusTitle').textContent = title; $('statusSubtitle').textContent = subtitle;
  }

  function showLive() {
    $('resultsEmpty').hidden = true; $('results').hidden = false;
    $('trainProgress').hidden = false; $('tryTestButton').hidden = true; $('details').hidden = true;
    setChip($('modelChip'), 'Training', 'accent');
    const epochs = liveEpochs || 1, done = liveHistory.length;
    if (stage === 'preparing' || !done) { setStatus('train', 'accent', 'Preparing training data', 'Getting your samples ready.'); $('trainProgress').firstElementChild.style.width = '0%'; }
    else { setStatus('train', 'accent', 'Training', `Epoch ${done} of ${epochs}`); $('trainProgress').firstElementChild.style.width = `${(100 * done) / epochs}%`; }
    accChart.setHistory(liveHistory, epochs); lossChart.setHistory(liveHistory, epochs);
  }

  function showReport(report) {
    const mode = state.mode, status = state.modelStatus(mode);
    const [ct, ck] = STATUS_CHIPS[status] ?? STATUS_CHIPS.none;
    setChip($('modelChip'), ct, ck);
    if (!report) {
      $('resultsEmpty').hidden = false; $('results').hidden = true;
      $('tileAccuracy').textContent = 'Not yet'; $('tileTime').textContent = 'Not yet';
      return;
    }
    $('resultsEmpty').hidden = true; $('results').hidden = false;
    $('trainProgress').hidden = true; $('details').hidden = false; $('tryTestButton').hidden = false;
    const acc = report.val_accuracy, duration = Number(report.duration_s || 0);
    const accText = acc !== null && acc !== undefined ? `${Math.round(acc * 100)}%` : 'Not measured';
    $('tileAccuracy').textContent = accText;
    $('tileTime').textContent = `${duration.toFixed(1)} s`;
    const epochs = Number(report.settings?.epochs ?? (report.history ?? []).length);
    let sub = `Trained ${friendlyDate(String(report.trained_at ?? ''))} in ${duration.toFixed(1)} seconds`;
    if (acc !== null && acc !== undefined) sub += `. It got ${accText} of the samples it never saw right.`;
    if (status === 'samples_changed') sub += ' You added or removed samples since then, so train again to include them.';
    else if (status === 'classes_changed') sub += ' Your classes changed since then, so train again before testing.';
    setStatus('check_circle', 'success', 'Model trained', sub);
    const history = report.history ?? [];
    accChart.setHistory(history, epochs); lossChart.setHistory(history, epochs);
    const byId = new Map(state.project.classes(mode).map(c => [c.id, c]));
    const classes = (report.classes ?? []).map(c => ({ ...c, name: byId.get(c.id)?.name ?? c.name ?? '', color: byId.get(c.id)?.color ?? c.color ?? '#999999' }));
    renderClassAccuracy(classes);
    renderMatrix(classes, report.confusion ?? []);
    const tested = classes.reduce((a, c) => a + Number(c.val_count ?? 0), 0), trained = classes.reduce((a, c) => a + Number(c.train_count ?? 0), 0);
    $('detailsNote').textContent = `The model learned from ${trained} samples. These results use the other ${tested} samples, which it never saw during training.`;
  }

  function renderClassAccuracy(classes) {
    const host = $('classAccuracy');
    host.innerHTML = '';
    for (const c of classes) {
      const acc = c.val_accuracy;
      const row = document.createElement('div');
      row.className = 'acc-row';
      row.innerHTML = `<div class="top"><span class="swatch" style="width:10px;height:10px;background:${c.color}"></span><span class="n"></span><span class="heading">${acc !== null && acc !== undefined ? `${Math.round(acc * 100)}%` : 'No samples'}</span></div>
        <div class="bottom"><span class="bar"><i style="width:${(acc ?? 0) * 100}%;background:${c.color}"></i></span><span class="caption">${Number(c.train_count ?? 0)} trained  ·  ${Number(c.val_count ?? 0)} tested</span></div>`;
      row.querySelector('.n').textContent = c.name;
      host.append(row);
    }
  }

  function renderMatrix(classes, matrix) {
    const host = $('matrix'), n = classes.length;
    host.innerHTML = '';
    if (!n) return;
    const grid = document.createElement('div');
    grid.className = 'matrix';
    grid.style.gridTemplateColumns = `minmax(60px, 170px) repeat(${n}, minmax(18px, 44px))`;
    const cell = (cls, text = '') => { const d = document.createElement('div'); d.className = cls; d.textContent = text; grid.append(d); return d; };
    cell('');
    const head = cell('caption', 'Predicted as');
    head.style.gridColumn = `2 / span ${n}`; head.style.textAlign = 'center';
    classes.forEach((c, i) => {
      const row = matrix[i] ?? new Array(n).fill(0), total = row.reduce((a, b) => a + b, 0);
      const name = cell('rowname');
      name.innerHTML = `<span class="swatch" style="width:8px;height:8px;background:${c.color}"></span><span></span>`;
      name.lastChild.textContent = c.name; name.title = c.name;
      for (let j = 0; j < n; j++) {
        const v = row[j] ?? 0, share = total ? v / total : 0;
        const d = cell('cell', String(v));
        if (v) { d.style.background = hexAlpha(TRAIN_COLOR, 0.08 + 0.85 * share); if (share > 0.55) d.style.color = '#FFFFFF'; }
        else d.style.background = 'var(--bg)';
      }
    });
    cell('');
    for (const c of classes) { const d = cell('colname', c.name); d.title = c.name; }
    host.append(grid);
  }

  const hexAlpha = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;

  function startTraining() {
    if (!state.project) return;
    try {
      if (!state.startTraining()) showError('Training is already running', 'Wait for the current training to finish, then try again.');
    } catch (e) { showError('Could not start training', e.message); }
  }

  toggleAdvanced(false);
  return { onEnter: refresh, onLeave() {}, refresh };
}
