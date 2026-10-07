// The embedding cache (app/ml/embeddings.py EmbeddingService): every saved
// sample is run through the backbone once, in the background, in batches of 8,
// and its 1024 numbers kept (as float16, like the desktop) in the project's
// embeddings.npz, saved at most every 5 seconds. Training and the PCA export
// read from here. Opening a project loads the cache and embeds any sample
// files that are not in it yet; files that are gone are dropped.
// Events: 'pending' (count), 'error' (message).

import { Emitter } from '../app/emitter.js';
import * as fs from '../storage/fs.js';
import { MODES, SAMPLE_SUFFIX } from '../storage/project.js';
import { readNpz, writeNpz, npyStrings, npyFloat16 } from '../io/npz.js';
import { floatArrayToHalf, halfArrayToFloat } from '../io/float16.js';
import { MlWorker } from './worker_client.js';
import { EMBED_DIM } from './backbone.js';

export const EMBEDDINGS_FILE = 'embeddings.npz';
const BATCH_SIZE = 8;
const SAVE_INTERVAL_MS = 5000;

export class EmbeddingService extends Emitter {
  constructor() {
    super();
    this.worker = null;
    this.project = null;
    this.store = { image: new Map(), audio: new Map() };   // sample id -> Uint16Array(1024) float16 bits
    this.queue = [];
    this.pending = 0;
    this.dirty = false;
    this.running = false;
    this.lastSave = 0;
    this.saveTimer = setInterval(() => this.maybeSave(), 1000);
    this.generation = 0;
  }

  ensureWorker() {
    if (!this.worker) {
      this.worker = new MlWorker();
      this.worker.ready.catch(e => this.emit('error', `The image model could not start: ${e.message}`));
    }
    return this.worker;
  }

  setPending(n) { this.pending = Math.max(0, n); this.emit('pending', this.pending); }

  async setProject(project) {
    await this.flush();
    this.generation++;
    this.queue = [];
    this.setPending(0);
    this.project = project;
    this.store = { image: new Map(), audio: new Map() };
    this.dirty = false;
    if (!project) return;
    try {
      const npz = await readNpz(await fs.readBytes(project.root, EMBEDDINGS_FILE));
      for (const mode of MODES) {
        const ids = npz.get(`${mode}__ids`), vecs = npz.get(`${mode}__vectors`);
        if (!ids || !vecs || vecs.shape.length !== 3 || vecs.shape[0] !== ids.data.length || vecs.shape[1] !== 1) continue;
        const dim = vecs.shape[2];
        ids.data.forEach((id, i) => this.store[mode].set(id, vecs.data.slice(i * dim, (i + 1) * dim)));
      }
    } catch (e) {
      if (e.name !== 'NotFoundError') console.warn('Could not read embeddings, they will be rebuilt', e);
    }
    await this.sync();
  }

  // Drops vectors whose files are gone, queues files that have none
  async sync() {
    const project = this.project;
    if (!project) return;
    await project.rescan();
    for (const mode of MODES) {
      const onDisk = new Map();
      for (const cls of project.classes(mode)) for (const name of project.sampleNames(mode, cls.id)) onDisk.set(name.slice(0, -SAMPLE_SUFFIX[mode].length), [cls, name]);
      for (const id of [...this.store[mode].keys()]) if (!onDisk.has(id)) { this.store[mode].delete(id); this.dirty = true; }
      const queued = new Set(this.queue.filter(j => j.mode === mode).map(j => j.id));
      for (const [id, [cls, name]] of [...onDisk].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!this.store[mode].has(id) && !queued.has(id)) this.queue.push({ mode, id, cls, name, blob: null });
      }
    }
    this.setPending(this.queue.length);
    this.run();
  }

  // A sample was just saved (blob: its file's bytes, saves reading it back)
  add(mode, cls, fileName, blob = null) {
    const id = fileName.slice(0, -SAMPLE_SUFFIX[mode].length);
    this.queue.push({ mode, id, cls, name: fileName, blob });
    this.setPending(this.pending + 1);
    this.run();
  }

  remove(mode, ids) {
    for (const id of ids) if (this.store[mode].delete(id)) this.dirty = true;
    const before = this.queue.length;
    this.queue = this.queue.filter(j => !(j.mode === mode && ids.includes(j.id)));
    if (this.queue.length !== before) this.setPending(this.pending - (before - this.queue.length));
  }

  async run() {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;
    try {
      const worker = this.ensureWorker();
      await worker.ready;
      while (this.queue.length && gen === this.generation) {
        const batch = this.queue.splice(0, BATCH_SIZE);
        const items = [], jobs = [];
        for (const j of batch) {
          if (this.store[j.mode].has(j.id)) continue;
          try {
            const blob = j.blob ?? await fs.readFile(await this.project.classDir(j.mode, j.cls, false), j.name);
            items.push({ kind: j.mode, blob }); jobs.push(j);
          } catch { /* the file is gone */ }
        }
        if (items.length) {
          try {
            const { vectors, ok } = await worker.request({ type: 'embed', items });
            if (gen !== this.generation) break;
            let k = 0;
            jobs.forEach((j, i) => {
              if (!ok[i]) return;
              this.store[j.mode].set(j.id, floatArrayToHalf(vectors.subarray(k * EMBED_DIM, (k + 1) * EMBED_DIM)));
              k++;
            });
            this.dirty = true;
          } catch (e) {
            console.warn('Embedding batch failed', e);
            this.emit('error', `Samples could not be prepared: ${e.message}`);
          }
        }
        this.setPending(this.pending - batch.length);
      }
    } catch (e) {
      this.emit('error', `The image model could not start: ${e.message}`);
    } finally {
      this.running = false;
      if (gen === this.generation) this.setPending(this.queue.length);
      this.maybeSave(true);
    }
  }

  availableIds(mode) { return new Set(this.store[mode].keys()); }

  // Float32Array (n x 1024) in the order given
  embeddings(mode, ids) {
    const out = new Float32Array(ids.length * EMBED_DIM);
    ids.forEach((id, i) => {
      const v = this.store[mode].get(id);
      if (!v) throw new Error(`No embedding for ${id}`);
      out.set(halfArrayToFloat(v), i * EMBED_DIM);
    });
    return out;
  }

  async maybeSave(force = false) {
    if (!this.project || !this.dirty) return;
    if (!force && performance.now() - this.lastSave < SAVE_INTERVAL_MS) return;
    this.dirty = false;
    this.lastSave = performance.now();
    const project = this.project, arrays = [];
    for (const mode of MODES) {
      const ids = [...this.store[mode].keys()].sort();
      arrays.push([`${mode}__ids`, npyStrings(ids)]);
      if (ids.length) {
        const bits = new Uint16Array(ids.length * EMBED_DIM);
        ids.forEach((id, i) => bits.set(this.store[mode].get(id), i * EMBED_DIM));
        arrays.push([`${mode}__vectors`, npyFloat16(bits, [ids.length, 1, EMBED_DIM])]);
      } else arrays.push([`${mode}__vectors`, npyFloat16(new Uint16Array(0), [0, 1, 0])]);
    }
    try { await fs.writeFile(project.root, EMBEDDINGS_FILE, await writeNpz(arrays)); } catch (e) { console.warn('Could not save embeddings', e); this.dirty = true; }
  }

  async flush() { await this.maybeSave(true); }
}
