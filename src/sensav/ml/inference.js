// Live predictions (app/ml/predictor.py InferenceController): loads the trained
// head, then repeatedly takes the newest camera frame (or the last second of
// sound), runs backbone and head in the live worker, and reports the
// probabilities, at the chosen rate. States: off, loading, running, error.
// Events: 'state', 'ready' (labels), 'prediction' ({ mode, probabilities,
// index, confidence, latencyMs, timestamp, labels, classId, className }),
// 'failed' (message).

import { Emitter } from '../app/emitter.js';
import { MlWorker } from './worker_client.js';
import { loadHead } from './model_store.js';
import { events } from '../logs/events.js';

export const IMAGE_RATES = [5, 10, 15];
export const AUDIO_HOPS_MS = [250, 500];

export class InferenceController extends Emitter {
  constructor() {
    super();
    this.worker = null;
    this.state = 'off';
    this.mode = '';
    this.purpose = '';
    this.labels = [];
    this.run = 0;
    this.count = 0;
    this.interval = 0.1;
  }

  get running() { return this.state === 'loading' || this.state === 'running'; }

  setState(s) { if (s !== this.state) { this.state = s; this.emit('state', s); } }

  // source(): newest ImageBitmap (image) or Float32Array of 16000 samples (audio), or null
  async start(project, mode, source, intervalS, purpose) {
    this.stop();
    const run = ++this.run;
    Object.assign(this, { mode, purpose, labels: [], count: 0, interval: intervalS, startedAt: performance.now() });
    this.setState('loading');
    events.log('inference_started', { mode, purpose, interval_s: Math.round(intervalS * 1000) / 1000 });
    try {
      if (!this.worker) this.worker = new MlWorker();
      await this.worker.ready;
      const { head, labels } = await loadHead(project, mode);
      if (run !== this.run) return;
      await this.worker.request({ type: 'setHead', mode, labels, head: { embedDim: head.embedDim, numClasses: head.numClasses, denseUnits: head.denseUnits, w1: head.w1, b1: head.b1, w2: head.w2 } });
      if (run !== this.run) return;
      this.labels = labels;
      this.setState('running');
      this.emit('ready', labels);
      while (run === this.run) {
        const t0 = performance.now();
        const data = await source();
        if (run !== this.run) { data?.close?.(); break; }
        if (!data) { await sleep(50); continue; }
        const r = mode === 'image'
          ? await this.worker.request({ type: 'predictImage', bitmap: data }, [data])
          : await this.worker.request({ type: 'predictAudio', samples: data }, [data.buffer]);
        if (run !== this.run) break;
        this.report(r);
        await sleep(Math.max(0, this.interval * 1000 - (performance.now() - t0)));
      }
    } catch (e) {
      if (run !== this.run) return;
      const message = e.name === 'ModelError' ? e.message : `Live prediction stopped because of an unexpected problem: ${e.message}`;
      events.log('error', { where: 'inference', message });
      this.stop();
      this.setState('error');
      this.emit('failed', message);
    }
  }

  report(r) {
    const p = r.probabilities;
    let index = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[index]) index = i;
    const label = this.labels[index] ?? { id: String(index), name: `Class ${index + 1}` };
    const prediction = {
      mode: r.mode, probabilities: p, index, confidence: p[index], latencyMs: r.latencyMs, timestamp: Date.now() / 1000,
      labels: this.labels, classId: label.id, className: label.name,
    };
    this.count++;
    events.log('prediction', { mode: r.mode, purpose: this.purpose, class_id: label.id, class_name: label.name, confidence: Math.round(p[index] * 1e4) / 1e4, latency_ms: Math.round(r.latencyMs * 10) / 10 });
    this.emit('prediction', prediction);
  }

  setInterval(s) { this.interval = s; }

  stop() {
    const wasRunning = this.running;
    this.run++;
    if (wasRunning) events.log('inference_stopped', { mode: this.mode, purpose: this.purpose, duration_s: Math.round((performance.now() - this.startedAt) / 10) / 100, predictions: this.count });
    if (this.state !== 'error') this.setState('off');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
