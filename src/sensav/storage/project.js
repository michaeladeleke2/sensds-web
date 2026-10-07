// SensAV projects (app/storage/project.py), stored exactly as the desktop
// stores them, so a project folder opens in either app:
//
//   <data folder>/projects/<Project_Name>/
//     project.json        classes, colors, robot mappings, settings
//     images/<Class>/     224x224 JPEG samples
//     audio/<Class>/      16 kHz 16-bit mono WAV clips
//     embeddings.npz      cached backbone embeddings
//     models/<mode>/      model.pt, labels.json, training.json
//
// Every audio project has the locked Background Noise class first.

import * as fs from './fs.js';
import { pyRepr } from '../logs/pyrepr.js';

export const SCHEMA_VERSION = 2;
export const PROJECT_FILE = 'project.json';
export const MODES = ['image', 'audio'];
export const MODE_DIRS = { image: 'images', audio: 'audio' };
export const SAMPLE_SUFFIX = { image: '.jpg', audio: '.wav' };
export const MODE_LABELS = { image: 'Image', audio: 'Audio' };
export const BACKGROUND_CLASS_ID = 'background_noise';
export const BACKGROUND_CLASS_NAME = 'Background Noise';
export const BACKGROUND_COLOR = '#8E8E93';
export const CLASS_COLORS = ['#2F6FED', '#1FA37A', '#E8A317', '#8B5CF6', '#E0569B', '#F07F2A', '#0EA5C6', '#6D8A16', '#B5651D', '#4B5BD6'];
export const CAPTURE_MODES = ['hold', 'toggle', 'burst'];
export const MAX_NAME_LENGTH = 40;
const WINDOWS_RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(i => [`com${i}`, `lpt${i}`])]);

export class ProjectError extends Error { constructor(m) { super(m); this.name = 'ProjectError'; } }

// datetime.now().astimezone().isoformat(timespec="seconds")
export function nowIso(ms = false) {
  const d = new Date(), pad = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  const frac = ms ? `.${pad(d.getMilliseconds(), 3)}` : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${frac}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export const cleanName = name => name.split(/\s+/).filter(Boolean).join(' ');

export function validateName(name, kind = 'Name') {
  const cleaned = cleanName(name);
  if (!cleaned) throw new ProjectError(`${kind} cannot be empty.`);
  if ([...cleaned].length > MAX_NAME_LENGTH) throw new ProjectError(`${kind} must be ${MAX_NAME_LENGTH} characters or fewer.`);
  return cleaned;
}

export function slugify(name, fallback = 'item') {
  let slug = cleanName(name).replace(/[^\p{L}\p{N}_\s]/gu, '');
  slug = slug.replace(/\s+/g, '_').replace(/^[_.]+|[_.]+$/g, '');
  if (!slug) slug = fallback;
  if (WINDOWS_RESERVED.has(slug.toLowerCase())) slug = `${slug}_${fallback}`;
  return [...slug].slice(0, MAX_NAME_LENGTH).join('');
}

export async function uniqueFolder(parent, base, keep = null) {
  let candidate = base, index = 2;
  while ((await fs.exists(parent, candidate)) && (keep === null || candidate.toLowerCase() !== keep.toLowerCase())) candidate = `${base}_${index++}`;
  return candidate;
}

const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2))), b => b.toString(16).padStart(2, '0')).join('').slice(0, n);
let lastMicro = 0;
// new_sample_id(): 20261007_154512_123456_a1b2
export function newSampleId() {
  const d = new Date(), pad = (n, w = 2) => String(n).padStart(w, '0');
  let micro = d.getMilliseconds() * 1000 + Math.floor((performance.now() % 1) * 1000);
  const key = d.getTime() * 1000 + micro;
  if (key <= lastMicro) micro = (micro + 1) % 1000000;
  lastMicro = key;
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(micro, 6)}_${hex(4)}`;
}

const pick = (raw, defaults) => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, raw && k in raw ? raw[k] : v]));

export const classDefaults = () => ({ id: '', name: '', color: '#999999', folder: '', capture_mode: 'hold', robot_action: 'no_action', locked: false });
export const trainingDefaults = () => ({ epochs: 50, batch_size: 16, learning_rate: 0.001 });
export const robotDefaults = () => ({ source: 'image', confidence_threshold: 0.5, smoothing_count: 3, speed: 'medium' });

export class Project {
  // root: directory handle of the project folder; parent: the projects folder
  constructor({ root, parent, folder, name, id, created, modified, lastMode = 'image', modes = null, robot = null }) {
    Object.assign(this, { root, parent, folder, name, id, created, modified });
    this.last_mode = MODES.includes(lastMode) ? lastMode : 'image';
    this.modes = modes ?? { image: { classes: [], training: trainingDefaults() }, audio: { classes: [], training: trainingDefaults() } };
    this.robot = robot ?? robotDefaults();
    this.counts = { image: new Map(), audio: new Map() };     // class id -> sorted sample file names
  }

  static async create(parent, name) {
    name = validateName(name, 'Project name');
    const folder = await uniqueFolder(parent, slugify(name, 'project'));
    const root = await parent.getDirectoryHandle(folder, { create: true });
    const stamp = nowIso();
    const p = new Project({ root, parent, folder, name, id: hex(32), created: stamp, modified: stamp });
    await p.ensureInvariants();
    await p.save();
    return p;
  }

  static async load(parent, folder) {
    const root = await fs.tryDir(parent, [folder]);
    const text = root && await fs.tryReadText(root, PROJECT_FILE);
    if (text === null || text === undefined) throw new ProjectError(`No project found in ${folder}.`);
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw new ProjectError(`The project file in ${folder} could not be read: ${e.message}`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProjectError(`The project file in ${folder} is not valid.`);
    const version = Number(raw.schema_version ?? 0);
    if (version > SCHEMA_VERSION) throw new ProjectError('This project was made with a newer version of the app.');
    const modesRaw = raw.modes ?? {};
    const modes = {};
    for (const m of MODES) {
      const mr = modesRaw[m] ?? {};
      modes[m] = {
        classes: (mr.classes ?? []).map(c => pick(c, classDefaults())),
        training: version < 2 ? trainingDefaults() : pick(mr.training ?? {}, trainingDefaults()),
      };
    }
    const p = new Project({
      root, parent, folder, name: String(raw.name || folder), id: String(raw.id || hex(32)),
      created: String(raw.created || nowIso()), modified: String(raw.modified || nowIso()),
      lastMode: String(raw.last_mode ?? 'image'), modes, robot: pick(raw.robot ?? {}, robotDefaults()),
    });
    await p.ensureInvariants();
    await p.rescan();
    return p;
  }

  toJSON() {
    return {
      schema_version: SCHEMA_VERSION, id: this.id, name: this.name, created: this.created, modified: this.modified, last_mode: this.last_mode,
      modes: Object.fromEntries(MODES.map(m => [m, { classes: this.modes[m].classes.map(c => ({ ...c })), training: { ...this.modes[m].training } }])),
      robot: { ...this.robot },
    };
  }

  async save() {
    this.modified = nowIso();
    await fs.writeFile(this.root, PROJECT_FILE, pyJson(this.toJSON()));
  }

  async ensureInvariants() {
    const audio = this.modes.audio.classes;
    let bg = audio.find(c => c.id === BACKGROUND_CLASS_ID);
    if (!bg) bg = { ...classDefaults(), id: BACKGROUND_CLASS_ID, name: BACKGROUND_CLASS_NAME, color: BACKGROUND_COLOR, folder: slugify(BACKGROUND_CLASS_NAME), capture_mode: 'toggle', robot_action: 'stop' };
    else audio.splice(audio.indexOf(bg), 1);
    bg.locked = true;
    bg.name = BACKGROUND_CLASS_NAME;
    audio.unshift(bg);
    for (const m of MODES) for (const c of this.modes[m].classes) if (!CAPTURE_MODES.includes(c.capture_mode)) c.capture_mode = 'hold';
    if (!MODES.includes(this.robot.source)) this.robot.source = 'image';
    for (const m of MODES) {
      const md = await this.root.getDirectoryHandle(MODE_DIRS[m], { create: true });
      for (const c of this.modes[m].classes) await md.getDirectoryHandle(c.folder, { create: true });
    }
  }

  modeDir(mode, create = true) { return this.root.getDirectoryHandle(MODE_DIRS[mode], { create }); }
  classes(mode) { return this.modes[mode].classes; }

  getClass(mode, id) {
    const c = this.modes[mode].classes.find(x => x.id === id);
    if (!c) throw new ProjectError('That class no longer exists.');
    return c;
  }

  async classDir(mode, cls, create = true) { return (await this.modeDir(mode, create)).getDirectoryHandle(cls.folder, { create }); }

  // Re-reads the sample file names of every class from disk
  async rescan() {
    for (const m of MODES) {
      this.counts[m] = new Map();
      for (const c of this.modes[m].classes) this.counts[m].set(c.id, await this.listSamples(m, c));
    }
  }

  async listSamples(mode, cls) {
    try {
      const d = await this.classDir(mode, cls, false);
      return (await fs.entries(d)).filter(e => e.kind === 'file' && e.name.endsWith(SAMPLE_SUFFIX[mode])).map(e => e.name).sort();
    } catch { return []; }
  }

  sampleNames(mode, classId) { return this.counts[mode].get(classId) ?? []; }
  sampleCount(mode, classId) { return this.sampleNames(mode, classId).length; }
  totalSamples(mode) { return this.classes(mode).reduce((a, c) => a + this.sampleCount(mode, c.id), 0); }
  stem = name => name.replace(/\.[^.]+$/, '');

  noteSampleAdded(mode, classId, fileName) {
    const list = this.counts[mode].get(classId) ?? [];
    list.push(fileName); list.sort();
    this.counts[mode].set(classId, list);
  }

  noteSampleRemoved(mode, classId, fileName) {
    const list = this.counts[mode].get(classId) ?? [];
    const i = list.indexOf(fileName);
    if (i >= 0) list.splice(i, 1);
  }

  checkUnique(mode, name, ignoreId = null) {
    const lowered = name.toLowerCase();
    for (const c of this.classes(mode)) if (c.id !== ignoreId && c.name.toLowerCase() === lowered) throw new ProjectError(`There is already a class called “${c.name}”.`);
  }

  nextColor(mode) {
    const used = new Set(this.classes(mode).map(c => c.color));
    return CLASS_COLORS.find(c => !used.has(c)) ?? CLASS_COLORS[this.classes(mode).length % CLASS_COLORS.length];
  }

  suggestClassName(mode) {
    const existing = new Set(this.classes(mode).map(c => c.name.toLowerCase()));
    let i = 1;
    while (existing.has(`class ${i}`)) i++;
    return `Class ${i}`;
  }

  async addClass(mode, name) {
    name = validateName(name, 'Class name');
    this.checkUnique(mode, name);
    const md = await this.modeDir(mode);
    const folder = await uniqueFolder(md, slugify(name, 'class'));
    const cls = { ...classDefaults(), id: hex(12), name, color: this.nextColor(mode), folder };
    await md.getDirectoryHandle(folder, { create: true });
    this.modes[mode].classes.push(cls);
    this.counts[mode].set(cls.id, []);
    await this.save();
    return cls;
  }

  async ensureClass(mode, id, name, color = null) {
    const found = this.classes(mode).find(c => c.id === id);
    if (found) return found;
    name = cleanName(name) || 'Class';
    const taken = new Set(this.classes(mode).map(c => c.name.toLowerCase()));
    let candidate = name, i = 2;
    while (taken.has(candidate.toLowerCase())) candidate = `${name} ${i++}`;
    const md = await this.modeDir(mode);
    const folder = await uniqueFolder(md, slugify(candidate, 'class'));
    const cls = { ...classDefaults(), id, name: candidate, color: color || this.nextColor(mode), folder };
    await md.getDirectoryHandle(folder, { create: true });
    this.modes[mode].classes.push(cls);
    this.counts[mode].set(cls.id, []);
    await this.save();
    return cls;
  }

  async renameClass(mode, id, newName) {
    const cls = this.getClass(mode, id);
    if (cls.locked) throw new ProjectError(`“${cls.name}” cannot be renamed.`);
    newName = validateName(newName, 'Class name');
    this.checkUnique(mode, newName, id);
    const md = await this.modeDir(mode);
    const folder = await uniqueFolder(md, slugify(newName, 'class'), cls.folder);
    try { await fs.renameDir(md, cls.folder, folder); } catch (e) { throw new ProjectError(`Could not rename the class folder: ${e.message}`); }
    cls.name = newName; cls.folder = folder;
    await this.save();
    return cls;
  }

  async deleteClass(mode, id) {
    const cls = this.getClass(mode, id);
    if (cls.locked) throw new ProjectError(`“${cls.name}” is required and cannot be deleted.`);
    try { await fs.remove(await this.modeDir(mode), cls.folder, true); } catch (e) { throw new ProjectError(`Could not delete the class folder: ${e.message}`); }
    this.modes[mode].classes.splice(this.modes[mode].classes.indexOf(cls), 1);
    this.counts[mode].delete(id);
    await this.save();
    return cls;
  }

  async updateClass(mode, id, changes) {
    const cls = this.getClass(mode, id);
    for (const [k, v] of Object.entries(changes)) {
      if (!['color', 'capture_mode', 'robot_action'].includes(k)) throw new ProjectError(`Cannot change ${k}.`);
      cls[k] = v;
    }
    await this.save();
    return cls;
  }

  async rename(newName) {
    newName = validateName(newName, 'Project name');
    const folder = await uniqueFolder(this.parent, slugify(newName, 'project'), this.folder);
    try { await fs.renameDir(this.parent, this.folder, folder); } catch (e) { throw new ProjectError(`Could not rename the project folder: ${e.message}`); }
    this.folder = folder;
    this.root = await this.parent.getDirectoryHandle(folder);
    this.name = newName;
    await this.save();
  }

  summary() {
    return {
      name: this.name, folder: this.folder, modified: this.modified,
      image_classes: this.classes('image').length, audio_classes: this.classes('audio').length,
      image_samples: this.totalSamples('image'), audio_samples: this.totalSamples('audio'),
    };
  }
}

// list_projects(parent): summaries, most recently changed first
export async function listProjects(parent) {
  const out = [];
  for (const e of await fs.entries(parent)) {
    if (e.kind !== 'directory') continue;
    try {
      const raw = JSON.parse(await fs.readText(e.handle, PROJECT_FILE));
      const count = async mode => {
        let n = 0;
        const md = await fs.tryDir(e.handle, [MODE_DIRS[mode]]);
        if (!md) return 0;
        for (const c of raw.modes?.[mode]?.classes ?? []) {
          const cd = await fs.tryDir(md, [c.folder]);
          if (cd) n += (await fs.entries(cd)).filter(x => x.kind === 'file' && x.name.endsWith(SAMPLE_SUFFIX[mode])).length;
        }
        return n;
      };
      const audioClasses = raw.modes?.audio?.classes ?? [];
      out.push({
        name: String(raw.name || e.name), folder: e.name, modified: String(raw.modified || ''),
        image_classes: (raw.modes?.image?.classes ?? []).length,
        audio_classes: audioClasses.length + (audioClasses.some(c => c.id === BACKGROUND_CLASS_ID) ? 0 : 1),
        image_samples: await count('image'), audio_samples: await count('audio'),
      });
    } catch { /* not a project */ }
  }
  out.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return out;
}

export async function deleteProject(parent, folder) {
  const d = await fs.tryDir(parent, [folder]);
  if (!d || (await fs.tryReadText(d, PROJECT_FILE)) === null) throw new ProjectError('That folder is not a project, so it was not deleted.');
  try { await fs.remove(parent, folder, true); } catch (e) { throw new ProjectError(`Could not delete the project: ${e.message}`); }
}

// json.dump(data, indent=2, ensure_ascii=False): floats keep a decimal point
export function pyJson(value, indent = 2) {
  const fmt = (v, level) => {
    const pad = ' '.repeat(indent * (level + 1)), end = ' '.repeat(indent * level);
    if (v === null || v === undefined) return 'null';
    if (v instanceof PyFloat) return v.text;
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity');
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return v.length ? `[\n${v.map(x => pad + fmt(x, level + 1)).join(',\n')}\n${end}]` : '[]';
    const keys = Object.keys(v);
    return keys.length ? `{\n${keys.map(k => `${pad}${JSON.stringify(k)}: ${fmt(v[k], level + 1)}`).join(',\n')}\n${end}}` : '{}';
  };
  return fmt(value, 0);
}

// A number that Python wrote as a float (keeps "1.0")
export class PyFloat {
  constructor(v) { this.value = v; this.text = pyRepr(v); }
}
