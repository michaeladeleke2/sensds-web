// The Data tab (app/ui/tabs/data.py): totals, every class with its sample
// count and robot move, the CSV exports for CODAP, the research log and
// session ID, the project's details, moving trained models in and out as
// .sensavmodel files, and deleting the project.

import { $, setChip, showError, confirm, askText, friendlyDate, saveFile, openFile } from '../ui/ui.js';
import { BACKGROUND_CLASS_ID, MODE_LABELS, MODES, slugify } from '../storage/project.js';
import { actionLabel } from '../robot/actions.js';
import { exportModel, importModel, suggestedName, ModelError, TRANSFER_SUFFIX } from '../ml/model_store.js';
import { sampleRows, sampleColumns, readEvents, sessionRows, eventRows, csvBytes, SESSION_COLUMNS } from '../storage/export.js';
import { events } from '../logs/events.js';
import { rgbaToRgb } from '../ml/image_ops.js';

const MODEL_CHIPS = { none: ['Not trained', 'neutral'], current: ['Up to date', 'success'], samples_changed: ['New samples since training', 'warning'], classes_changed: ['Classes changed', 'warning'] };

// The pixels of a saved JPEG, decoded by the browser
async function decodeImage(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return rgbaToRgb(ctx.getImageData(0, 0, bmp.width, bmp.height).data);
}

export function initData(state, shell) {
  let exporting = false;

  $('dataSave').onclick = async () => { try { await state.saveProject(); } catch (e) { showError('Could not save project', e.message); } refresh(); };
  $('dataRename').onclick = () => shell.renameProject();
  $('dataOpen').onclick = () => shell.showProjectDialog();
  $('deleteProjectButton').onclick = deleteProject;
  $('exportImages').onclick = () => exportSamples('image');
  $('exportAudio').onclick = () => exportSamples('audio');
  $('exportSessions').onclick = exportSessions;
  $('exportEvents').onclick = exportEvents;
  $('changeParticipant').onclick = changeParticipant;
  $('askParticipant').checked = state.settings.ask_participant;
  $('askParticipant').onchange = () => { state.settings.ask_participant = $('askParticipant').checked; state.saveSettings(); };
  for (const ev of ['project', 'projectRenamed', 'classes', 'model']) state.on(ev, () => refresh());
  state.on('samples', () => { if (shell.isTab('data')) refresh(); });

  function refresh() {
    const p = state.project;
    if (!p) return;
    const s = p.summary();
    $('dataSubtitle').textContent = `Everything in “${p.name}” is stored in your SensAV data folder.`;
    $('tileImageClasses').textContent = String(s.image_classes);
    $('tileImages').textContent = String(s.image_samples);
    $('tileAudioClasses').textContent = String(p.classes('audio').filter(c => c.id !== BACKGROUND_CLASS_ID).length);
    $('tileClips').textContent = String(s.audio_samples);
    $('infoName').textContent = p.name;
    $('infoCreated').textContent = friendlyDate(p.created);
    $('infoUpdated').textContent = friendlyDate(p.modified);
    $('infoLocation').textContent = `${state.dataRoot?.name ?? ''}/projects/${p.folder}`;
    const rows = MODES.flatMap(m => p.classes(m).map(c => [m, c]));
    setChip($('allClassesChip'), String(rows.length));
    const tbody = $('classTable');
    tbody.innerHTML = '';
    for (const [m, c] of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><span class="swatch" style="width:10px;height:10px;background:${c.color}"></span><span></span></td><td>${MODE_LABELS[m]}</td><td>${p.sampleCount(m, c.id)} ${m === 'image' ? 'images' : 'clips'}</td><td>${actionLabel(c.robot_action)}</td>`;
      tr.querySelector('td span:last-child').textContent = c.name;
      tbody.append(tr);
    }
    $('exportImages').disabled = s.image_samples === 0 || exporting;
    $('exportAudio').disabled = s.audio_samples === 0 || exporting;
    $('exportSessions').disabled = exporting; $('exportEvents').disabled = exporting;
    $('participantValue').textContent = events.participantId || 'Not set';
    $('logValue').textContent = events.path ? `${state.dataRoot?.name ?? ''}/${events.path}` : 'Not started';
    const host = $('modelRows');
    host.innerHTML = '';
    for (const m of MODES) {
      const report = state.modelReport(m), [ct, ck] = MODEL_CHIPS[state.modelStatus(m)] ?? MODEL_CHIPS.none;
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML = `<div class="top"><span class="heading">${MODE_LABELS[m]} model</span><span class="chip"></span></div><span class="caption"></span>
        <div class="btn-row"><button class="btn small" data-act="export">Export</button><button class="btn small" data-act="import">Import</button></div>`;
      setChip(row.querySelector('.chip'), ct, ck);
      let detail = 'No model yet. Train one on the Train tab.';
      if (report) {
        const parts = [`${report.imported ? 'Imported' : 'Trained'} ${friendlyDate(String(report.trained_at ?? ''))}`];
        if (report.val_accuracy !== null && report.val_accuracy !== undefined) parts.push(`${Math.round(report.val_accuracy * 100)}% validation accuracy`);
        parts.push(`${(report.classes ?? []).length} classes`);
        detail = parts.join('  ·  ');
      }
      row.querySelector('.caption').textContent = detail;
      const exp = row.querySelector('[data-act="export"]');
      exp.disabled = !report;
      exp.onclick = () => exportModelFile(m);
      row.querySelector('[data-act="import"]').onclick = importModelFile;
      host.append(row);
    }
  }

  function setBusy(busy) {
    exporting = busy;
    $('exportProgress').hidden = !busy;
    if (busy) $('exportProgress').firstElementChild.style.width = '0%';
    refresh();
  }

  async function finishExport(kind, name, bytes, rows) {
    const saved = await saveFile(name, bytes, 'CSV file', '.csv', 'text/csv');
    if (!saved) return;
    events.log('export_finished', { kind, path: saved, rows });
    $('exportNote').textContent = `Saved ${rows} ${rows === 1 ? 'row' : 'rows'} to ${saved}`;
    state.status(`Exported ${rows} ${rows === 1 ? 'row' : 'rows'}`, 6000);
  }

  async function exportSamples(mode) {
    const p = state.project;
    if (!p || exporting) return;
    const missing = state.missingEmbeddings(mode);
    if (missing) state.status(`Waiting for ${missing} samples to finish preparing. The PCA columns may be empty.`);
    setBusy(true);
    try {
      const available = state.embeddings.availableIds(mode);
      const rows = await sampleRows(p, mode, {
        decodeImage,
        embeddings: ids => { if (ids.some(id => !available.has(id))) throw new Error('missing embeddings'); return state.embeddings.embeddings(mode, ids); },
        progress: (done, total) => { $('exportProgress').firstElementChild.style.width = `${(100 * done) / total}%`; },
      });
      setBusy(false);
      await finishExport(`${mode}_samples`, `${slugify(p.name, 'project')}_${mode}_samples.csv`, csvBytes(rows, sampleColumns(mode)), rows.length);
    } catch (e) {
      setBusy(false);
      showError('Export did not finish', e.message);
    }
  }

  async function exportSessions() {
    if (!state.dataRoot) return;
    await events.flush();
    setBusy(true);
    try {
      const rows = sessionRows(await readEvents(state.dataRoot));
      setBusy(false);
      await finishExport('sessions', 'test_and_robot_sessions.csv', csvBytes(rows, SESSION_COLUMNS), rows.length);
    } catch (e) { setBusy(false); showError('Export did not finish', e.message); }
  }

  async function exportEvents() {
    if (!state.dataRoot) return;
    await events.flush();
    setBusy(true);
    try {
      const { rows, columns } = eventRows(await readEvents(state.dataRoot));
      setBusy(false);
      await finishExport('event_log', 'event_log.csv', csvBytes(rows, columns), rows.length);
    } catch (e) { setBusy(false); showError('Export did not finish', e.message); }
  }

  async function changeParticipant() {
    const v = await askText('Session ID', 'This is for research notes only. Never use a name. Leave it empty to clear it.', events.participantId || '', 'Save', 'For example: P07');
    if (v === null) return;
    events.setParticipant(v || null);
    refresh();
  }

  async function exportModelFile(mode) {
    const p = state.project;
    if (!p) return;
    try {
      const bytes = await exportModel(p, mode);
      const saved = await saveFile(suggestedName(p, mode), bytes, 'SensAV model', TRANSFER_SUFFIX);
      if (!saved) return;
      events.log('export_finished', { kind: `${mode}_model`, path: saved, rows: 1 });
      state.status(`Exported the ${MODE_LABELS[mode].toLowerCase()} model`, 6000);
    } catch (e) { showError('Could not export the model', e.message); }
  }

  async function importModelFile() {
    const p = state.project;
    if (!p) return;
    const file = await openFile('SensAV model', TRANSFER_SUFFIX);
    if (!file) return;
    let result;
    try { result = await importModel(p, new Uint8Array(await file.arrayBuffer())); } catch (e) { showError('Could not import the model', e instanceof ModelError ? e.message : e.message); return; }
    events.log('model_imported', { mode: result.mode, path: file.name, classes_created: result.classes_created });
    let note = `Imported a ${MODE_LABELS[result.mode].toLowerCase()} model with ${result.class_count} classes`;
    if (result.classes_created.length) note += `. Added the missing classes: ${result.classes_created.join(', ')}`;
    state.status(note, 8000);
    await state.refreshReport(result.mode);
    state.emit('classes', result.mode);
    state.emit('model', result.mode);
    refresh();
  }

  async function deleteProject() {
    const p = state.project;
    if (!p) return;
    const ok = await confirm('Delete project?', `This permanently deletes “${p.name}”, including every image, sound, and trained model in it. This cannot be undone.`, 'Delete project', true);
    if (!ok) return;
    try { await state.deleteProject(p.folder); } catch (e) { showError('Could not delete project', e.message); return; }
    shell.showProjectDialog();
  }

  return { onEnter: refresh, onLeave() {}, refresh };
}
