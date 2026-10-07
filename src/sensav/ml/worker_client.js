// Talks to a SensAV model worker (worker.js): one request at a time per
// message id, replies matched by id.

const WEIGHTS_URL = new URL('../../../assets/sensav/mobilenet_v3_small.safetensors', import.meta.url).href;

export class MlWorker {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.next = 1;
    this.waiting = new Map();
    this.worker.onmessage = ({ data }) => {
      const w = this.waiting.get(data.id);
      if (!w) return;
      this.waiting.delete(data.id);
      if (data.type === 'error') w.reject(new Error(data.message)); else w.resolve(data);
    };
    this.worker.onerror = e => {
      const err = new Error(e.message || 'The model worker stopped');
      for (const w of this.waiting.values()) w.reject(err);
      this.waiting.clear();
      this.failed = err;
    };
    this.ready = this.request({ type: 'init', weightsUrl: WEIGHTS_URL });
  }

  request(msg, transfer = []) {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  terminate() { this.worker.terminate(); }
}
