// Training runs (app/ml/training.py TrainingController): checks every sample
// has its embedding, makes the per-class split and dataset order with numpy's
// default_rng(1234), trains in a worker, then saves model.pt, labels.json and
// training.json (settings, history, per-class accuracy, confusion matrix).
// Events: 'started' (mode), 'stage' (preparing | training | saving),
// 'epoch' (metrics), 'finished' (report), 'failed' (message), 'cancelled',
// 'busy' (bool).

import { Emitter } from '../app/emitter.js';
import { defaultRng } from '../../train/numpy_random.js';
import { splitPerClass, buildDataset, SHUFFLE_SEED, TrainingDataError } from './trainer.js';
import { ClassifierHead } from './head.js';
import { saveTrainedModel } from './model_store.js';
import { nowIso, PyFloat } from '../storage/project.js';
import { EMBED_DIM } from './backbone.js';

const F = v => (v === null || v === undefined ? null : new PyFloat(v));

export class TrainingController extends Emitter {
  constructor(embeddings) {
    super();
    this.embeddings = embeddings;
    this.worker = null;
    this.job = null;
    this.busy = false;
  }

  // job: { project, mode, classes: [{ id, name, color, sampleIds }], epochs, batchSize, learningRate }
  start(job) {
    if (this.busy) return false;
    this.job = job;
    this.busy = true;
    this.emit('started', job.mode);
    this.emit('busy', true);
    this.run(job);
    return true;
  }

  cancel() {
    if (!this.busy) return;
    this.worker?.terminate();
    this.worker = null;
    this.release();
    this.emit('cancelled');
  }

  release() { this.busy = false; this.emit('busy', false); }

  async run(job) {
    const started = performance.now();
    try {
      this.emit('stage', 'preparing');
      const available = this.embeddings.availableIds(job.mode);
      const missing = job.classes.reduce((a, c) => a + c.sampleIds.filter(id => !available.has(id)).length, 0);
      if (missing) throw new TrainingDataError(`${missing} samples are still being prepared. Wait a moment, then train again.`);
      const rng = defaultRng(SHUFFLE_SEED);
      const splits = splitPerClass(job.classes.map(c => c.sampleIds), rng);
      const ds = buildDataset(splits, ids => this.embeddings.embeddings(job.mode, ids), rng, EMBED_DIM);
      this.emit('stage', 'training');
      const result = await new Promise((resolve, reject) => {
        const w = this.worker = new Worker(new URL('./train_worker.js', import.meta.url), { type: 'module' });
        w.onmessage = ({ data }) => {
          if (w !== this.worker) return;
          if (data.type === 'epoch') this.emit('epoch', data.metrics);
          else if (data.type === 'done') resolve(data);
          else if (data.type === 'failed') reject(new Error(data.message));
        };
        w.onerror = e => reject(new Error(e.message || 'The training worker stopped'));
        w.postMessage({ type: 'train', trainX: ds.trainX, trainY: ds.trainY, valX: ds.valX, valY: ds.valY, numClasses: job.classes.length,
          epochs: job.epochs, batchSize: job.batchSize, learningRate: job.learningRate, embedDim: EMBED_DIM },
        [ds.trainX.buffer, ds.trainY.buffer, ds.valX.buffer, ds.valY.buffer]);
      });
      this.worker?.terminate(); this.worker = null;
      if (!this.busy || this.job !== job) return;
      const duration = (performance.now() - started) / 1000;
      const h = result.head;
      const head = ClassifierHead.fromState(h.embedDim, h.numClasses, h.denseUnits, new Map([['hidden.weight', { data: h.w1 }], ['hidden.bias', { data: h.b1 }], ['output.weight', { data: h.w2 }]]));
      const report = this.report(job, result, duration);
      this.emit('stage', 'saving');
      await saveTrainedModel(job.project, job.mode, head, job.classes.map(c => ({ id: c.id, name: c.name })), report);
      this.release();
      this.emit('finished', report);
    } catch (e) {
      this.worker?.terminate(); this.worker = null;
      if (!this.busy || this.job !== job) return;
      this.release();
      this.emit('failed', e instanceof TrainingDataError ? e.message : `Training stopped because of an unexpected problem: ${e.message}`);
    }
  }

  report(job, r, duration) {
    const last = r.history.at(-1);
    return {
      mode: job.mode,
      project: job.project.name,
      trained_at: nowIso(),
      duration_s: F(Math.round(duration * 100) / 100),
      settings: { epochs: job.epochs, batch_size: job.batchSize, learning_rate: F(job.learningRate) },
      classes: job.classes.map((c, i) => ({ id: c.id, name: c.name, color: c.color, train_count: r.trainCounts[i], val_count: r.valCounts[i], val_accuracy: F(r.classAccuracy[i]) })),
      sample_counts: Object.fromEntries(job.classes.map(c => [c.id, c.sampleIds.length])),
      history: r.history.map(m => ({ epoch: m.epoch, loss: F(m.loss), accuracy: F(m.accuracy), val_loss: F(m.val_loss), val_accuracy: F(m.val_accuracy) })),
      confusion: r.confusion,
      val_accuracy: F(r.valAccuracy),
      final_loss: F(last?.loss ?? null),
      final_accuracy: F(last?.accuracy ?? null),
    };
  }
}

// training.json values as plain numbers (for the page)
export const plainReport = report => JSON.parse(JSON.stringify(report, (k, v) => (v instanceof PyFloat ? v.value : v)));
