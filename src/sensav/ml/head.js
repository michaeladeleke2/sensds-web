// SensAV's classifier head (app/ml/head.py): the part that is trained. A dense
// layer of 100 ReLU units on the 1024-value embedding, then a dense layer to
// one score per class (no bias), softmax for probabilities. Weights start from
// Teachable Machine's variance scaling (normal, std sqrt(1/fan_in)/0.8796,
// values beyond 2 std drawn again), drawn from torch.Generator(seed) exactly
// as the desktop does.

import { TorchGenerator } from './torch_random.js';

export const DENSE_UNITS = 100;
const f32 = Math.fround;

function varianceScaling(w, fanIn, gen) {
  const std = Math.sqrt(1.0 / fanIn) / 0.87962566103423978;
  gen.normal_(w, 0.0, std);
  const limit = f32(2.0 * std);
  for (;;) {
    const outside = [];
    for (let i = 0; i < w.length; i++) if (Math.abs(w[i]) > limit) outside.push(i);
    if (!outside.length) break;
    const fresh = gen.normal_(new Float32Array(outside.length), 0.0, std);
    outside.forEach((idx, k) => { w[idx] = fresh[k]; });
  }
}

export class ClassifierHead {
  constructor(embedDim, numClasses, denseUnits = DENSE_UNITS) {
    Object.assign(this, { embedDim, numClasses, denseUnits });
    this.w1 = new Float32Array(denseUnits * embedDim);     // hidden.weight (units x embed)
    this.b1 = new Float32Array(denseUnits);                 // hidden.bias
    this.w2 = new Float32Array(numClasses * denseUnits);    // output.weight (classes x units)
  }

  initialize(seed) {
    const gen = new TorchGenerator(seed);
    varianceScaling(this.w1, this.embedDim, gen);
    this.b1.fill(0);
    varianceScaling(this.w2, this.denseUnits, gen);
    return this;
  }

  // x: Float32Array (n x embed). Returns { hidden (n x units, after ReLU),
  // logits (n x classes) } as float32.
  forward(x, n) {
    const { embedDim: E, denseUnits: U, numClasses: C, w1, b1, w2 } = this;
    const hidden = new Float32Array(n * U), logits = new Float32Array(n * C);
    for (let i = 0; i < n; i++) {
      const xo = i * E;
      for (let u = 0; u < U; u++) {
        let s = 0;
        const wo = u * E;
        for (let k = 0; k < E; k++) s += x[xo + k] * w1[wo + k];
        const v = f32(s + b1[u]);
        hidden[i * U + u] = v > 0 ? v : 0;
      }
      for (let c = 0; c < C; c++) {
        let s = 0;
        for (let u = 0; u < U; u++) s += hidden[i * U + u] * w2[c * U + u];
        logits[i * C + c] = s;
      }
    }
    return { hidden, logits };
  }

  // softmax(forward(x)) as float32 (n x classes)
  predictProba(x, n = x.length / this.embedDim) {
    const { logits } = this.forward(x, n);
    return softmaxRows(logits, n, this.numClasses);
  }

  // state_dict order and shapes, for model.pt
  stateDict() {
    return [
      ['hidden.weight', { shape: [this.denseUnits, this.embedDim], data: this.w1 }],
      ['hidden.bias', { shape: [this.denseUnits], data: this.b1 }],
      ['output.weight', { shape: [this.numClasses, this.denseUnits], data: this.w2 }],
    ];
  }

  static fromState(embedDim, numClasses, denseUnits, tensors) {
    const h = new ClassifierHead(embedDim, numClasses, denseUnits);
    const get = name => {
      const t = tensors.get(name);
      if (!t) throw new Error(`The model file has no ${name}`);
      return t.data;
    };
    h.w1.set(get('hidden.weight')); h.b1.set(get('hidden.bias')); h.w2.set(get('output.weight'));
    return h;
  }
}

export function softmaxRows(logits, n, C) {
  const out = new Float32Array(n * C);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let c = 0; c < C; c++) m = Math.max(m, logits[i * C + c]);
    let s = 0;
    for (let c = 0; c < C; c++) s += Math.exp(logits[i * C + c] - m);
    for (let c = 0; c < C; c++) out[i * C + c] = Math.exp(logits[i * C + c] - m) / s;
  }
  return out;
}

// First index of the largest value (torch.argmax)
export function argmax(a, o = 0, n = a.length - o) {
  let best = o;
  for (let i = o + 1; i < o + n; i++) if (a[i] > a[best]) best = i;
  return best - o;
}
