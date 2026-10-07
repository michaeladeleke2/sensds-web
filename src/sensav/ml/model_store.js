// Trained models on disk (app/ml/model_store.py and model_transfer.py):
//   models/<mode>/model.pt       the head, as torch.save writes it
//   models/<mode>/labels.json    class ids and names, in output order
//   models/<mode>/training.json  settings, history, per-class accuracy, confusion
// and the .sensavmodel file that moves a model between computers (a ZIP of
// model_info.json plus those three files).

import * as fs from '../storage/fs.js';
import { MODES, ProjectError, nowIso, pyJson, slugify } from '../storage/project.js';
import { torchLoad, torchSave, OrderedDict, Tensor } from '../io/torch_file.js';
import { readZip, writeZip } from '../io/zip.js';
import { ClassifierHead } from './head.js';

export const MODEL_FILE = 'model.pt';
export const LABELS_FILE = 'labels.json';
export const REPORT_FILE = 'training.json';
export const MODEL_FORMAT = 1;
export const TRANSFER_SUFFIX = '.sensavmodel';
export const META_FILE = 'model_info.json';
export const TRANSFER_FORMAT = 1;
export const APP_VERSION = '0.1.0';

export class ModelError extends Error { constructor(m) { super(m); this.name = 'ModelError'; } }

const modelDir = (project, mode, create = false) => fs.tryDir(project.root, ['models', mode]).then(d => d ?? (create ? fs.dir(project.root, ['models', mode], true) : null));

export async function saveTrainedModel(project, mode, head, labels, report) {
  const folder = await modelDir(project, mode, true);
  const bytes = await torchSave({
    format: MODEL_FORMAT, mode, embed_dim: head.embedDim, num_classes: head.numClasses, dense_units: head.denseUnits,
    state_dict: new OrderedDict(head.stateDict().map(([k, t]) => [k, new Tensor(t.shape, t.data)]),
      [['', { version: 1 }], ['hidden', { version: 1 }], ['output', { version: 1 }]]),
  });
  await fs.writeFile(folder, MODEL_FILE, bytes);
  await fs.writeFile(folder, LABELS_FILE, pyJson(labels));
  await fs.writeFile(folder, REPORT_FILE, pyJson(report));
}

export async function loadReport(project, mode) {
  const folder = await modelDir(project, mode);
  if (!folder) return null;
  try { await folder.getFileHandle(MODEL_FILE); } catch { return null; }
  const text = await fs.tryReadText(folder, REPORT_FILE);
  if (text === null) return null;
  try { const r = JSON.parse(text); return r && typeof r === 'object' && !Array.isArray(r) ? r : null; } catch { return null; }
}

// { head: ClassifierHead, labels }
export async function loadHead(project, mode) {
  const folder = await modelDir(project, mode);
  let payload, labels;
  try {
    if (!folder) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    payload = await torchLoad(await fs.readBytes(folder, MODEL_FILE));
    labels = JSON.parse(await fs.readText(folder, LABELS_FILE));
  } catch (e) {
    if (e.name === 'NotFoundError') throw new ModelError('There is no trained model yet. Train one on the Train tab.');
    throw new ModelError(`The trained model could not be loaded: ${e.message}`);
  }
  if (payload.format !== MODEL_FORMAT || payload.num_classes !== labels.length) throw new ModelError('The trained model does not match its labels. Train the model again.');
  const head = ClassifierHead.fromState(payload.embed_dim, payload.num_classes, payload.dense_units, payload.state_dict);
  return { head, labels };
}

export async function deleteModel(project, mode) {
  const models = await fs.tryDir(project.root, ['models']);
  if (models) await fs.remove(models, mode, true);
}

// none | current | classes_changed | samples_changed
export function modelStatus(project, mode, report) {
  if (!report) return 'none';
  const trained = (report.classes ?? []).map(c => c.id), current = project.classes(mode).map(c => c.id);
  if (trained.length !== current.length || trained.some((id, i) => id !== current[i])) return 'classes_changed';
  const counts = report.sample_counts ?? {};
  for (const c of project.classes(mode)) if (counts[c.id] !== project.sampleCount(mode, c.id)) return 'samples_changed';
  return 'current';
}

export const suggestedName = (project, mode) => `${slugify(project.name, 'project')}_${mode}${TRANSFER_SUFFIX}`;

export async function exportModel(project, mode) {
  const folder = await modelDir(project, mode);
  let modelBytes;
  try { modelBytes = await fs.readBytes(folder, MODEL_FILE); } catch { throw new ModelError(`There is no trained ${mode} model to export yet.`); }
  const report = (await loadReport(project, mode)) ?? {};
  const meta = {
    format: TRANSFER_FORMAT, app_version: APP_VERSION, mode, project: project.name, exported_at: nowIso(),
    classes: (report.classes ?? []).map(c => ({ id: c.id ?? null, name: c.name ?? null, color: c.color ?? null })),
  };
  const entries = [[META_FILE, new TextEncoder().encode(pyJson(meta))], [MODEL_FILE, modelBytes]];
  for (const name of [LABELS_FILE, REPORT_FILE]) {
    try { entries.push([name, await fs.readBytes(folder, name)]); } catch { /* optional */ }
  }
  return writeZip(entries, { deflate: true });
}

export async function readModelInfo(bytes) {
  let files, meta;
  try { files = await readZip(bytes); meta = JSON.parse(new TextDecoder().decode(files.get(META_FILE))); } catch { throw new ModelError('That file is not a SensAV model file.'); }
  if (!meta || typeof meta !== 'object' || meta.format !== TRANSFER_FORMAT || !MODES.includes(meta.mode)) throw new ModelError('That model file was made by a different version of the app.');
  return { meta, files };
}

// Returns { mode, classes_created, class_count, project }
export async function importModel(project, bytes) {
  const { meta, files } = await readModelInfo(bytes);
  const mode = String(meta.mode);
  if (!files.has(MODEL_FILE) || !files.has(LABELS_FILE)) throw new ModelError('That model file is missing part of the model.');
  let labels;
  try { labels = JSON.parse(new TextDecoder().decode(files.get(LABELS_FILE))); } catch (e) { throw new ModelError(`The model file could not be read: ${e.message}`); }
  const folder = await modelDir(project, mode, true);
  for (const name of [MODEL_FILE, LABELS_FILE, REPORT_FILE]) if (files.has(name)) await fs.writeFile(folder, name, files.get(name));
  const colors = Object.fromEntries((meta.classes ?? []).map(c => [c.id, c.color]));
  const created = [];
  for (const label of labels) {
    const id = String(label.id), name = String(label.name ?? 'Class');
    if (!project.classes(mode).some(c => c.id === id)) created.push((await project.ensureClass(mode, id, name, colors[id])).name);
  }
  if (!files.has(REPORT_FILE)) {
    await fs.writeFile(folder, REPORT_FILE, pyJson({
      mode, project: meta.project ?? '', trained_at: meta.exported_at ?? '', imported: true,
      classes: labels.map(l => ({ id: l.id, name: l.name })), sample_counts: {}, history: [], confusion: [], val_accuracy: null,
    }));
  }
  return { mode, classes_created: created, class_count: labels.length, project: meta.project ?? '' };
}

export { ProjectError };
