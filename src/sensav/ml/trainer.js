// SensAV's training (app/ml/trainer.py), the Teachable Machine recipe on the
// cached embeddings:
//   - per class, 15 % of the samples (rounded up) are held back for
//     validation, picked by numpy default_rng(1234).permutation; the training
//     and validation rows are then put in one more permuted order each;
//   - the head trains with Adam (lr 0.001, eps 1e-7) on cross entropy, in
//     batches of 16 in that fixed order (no reshuffling between epochs);
//   - after every epoch: mean training loss and accuracy, then loss and
//     accuracy on the held-back samples;
//   - at the end: the confusion matrix and accuracy per class on the
//     held-back samples. The model from the last epoch is kept.
// Plain JavaScript in float32, with torch's Adam update step by step.

import { defaultRng } from '../../train/numpy_random.js';
import { ClassifierHead, argmax, softmaxRows } from './head.js';

export const VALIDATION_FRACTION = 0.15;
export const SHUFFLE_SEED = 1234;
export const DEFAULT_EPOCHS = 50;
export const DEFAULT_BATCH_SIZE = 16;
export const DEFAULT_LEARNING_RATE = 0.001;

const f32 = Math.fround;

export class TrainingCancelled extends Error { constructor() { super('Training stopped'); this.name = 'TrainingCancelled'; } }
export class TrainingDataError extends Error { constructor(m) { super(m); this.name = 'TrainingDataError'; } }

const permutation = (rng, n) => rng.shuffle([...Array(n).keys()]);

// split_per_class(sample_ids, rng): [[train ids, validation ids], ...]
export function splitPerClass(sampleIds, rng, fraction = VALIDATION_FRACTION) {
  return sampleIds.map(ids => {
    const shuffled = permutation(rng, ids.length).map(i => ids[i]);
    const validation = Math.ceil(fraction * shuffled.length);
    const train = shuffled.length - validation;
    return [shuffled.slice(0, train), shuffled.slice(train)];
  });
}

// build_dataset(splits, lookup, rng). lookup(ids) -> Float32Array (n x dim)
export function buildDataset(splits, lookup, rng, dim) {
  const trainIds = [], trainLabels = [], valIds = [], valLabels = [];
  splits.forEach(([train, validation], label) => {
    for (const id of train) { trainIds.push(id); trainLabels.push(label); }
    for (const id of validation) { valIds.push(id); valLabels.push(label); }
  });
  if (!trainIds.length) throw new TrainingDataError('There are no samples to train on.');
  const trainOrder = permutation(rng, trainIds.length);
  const valOrder = permutation(rng, valIds.length);
  return {
    trainX: lookup(trainOrder.map(i => trainIds[i])),
    trainY: Int32Array.from(trainOrder, i => trainLabels[i]),
    valX: valIds.length ? lookup(valOrder.map(i => valIds[i])) : new Float32Array(0),
    valY: Int32Array.from(valOrder, i => valLabels[i]),
    dim,
  };
}

// Mean cross entropy and number correct for rows [start, start + n)
function lossAndCorrect(logits, y, start, n, C) {
  let loss = 0, correct = 0;
  for (let i = 0; i < n; i++) {
    const o = i * C;
    let m = -Infinity;
    for (let c = 0; c < C; c++) m = Math.max(m, logits[o + c]);
    let s = 0;
    for (let c = 0; c < C; c++) s += Math.exp(logits[o + c] - m);
    loss += Math.log(s) + m - logits[o + y[start + i]];
    if (argmax(logits, o, C) === y[start + i]) correct++;
  }
  return { loss: f32(loss / n), correct };
}

class Adam {
  constructor(params, lr, beta1 = 0.9, beta2 = 0.999, eps = 1e-7) {
    this.params = params; this.lr = lr; this.beta1 = beta1; this.beta2 = beta2; this.eps = f32(eps);
    this.m = params.map(p => new Float32Array(p.length));
    this.v = params.map(p => new Float32Array(p.length));
    this.step = 0;
  }

  // torch.optim.Adam, single-tensor path (the CPU default)
  update(grads) {
    this.step += 1;
    const w = f32(1 - this.beta1), b2 = f32(this.beta2), g2w = f32(1 - this.beta2);
    const bc1 = 1 - this.beta1 ** this.step, bc2 = 1 - this.beta2 ** this.step;
    const stepSize = f32(-(this.lr / bc1)), bc2Sqrt = f32(Math.sqrt(bc2));
    this.params.forEach((p, k) => {
      const g = grads[k], m = this.m[k], v = this.v[k];
      for (let i = 0; i < p.length; i++) {
        m[i] = f32(m[i] + f32(w * f32(g[i] - m[i])));                         // lerp_(grad, 1 - beta1)
        v[i] = f32(f32(v[i] * b2) + f32(f32(g2w * g[i]) * g[i]));             // mul_(beta2).addcmul_(g, g, 1 - beta2)
        const denom = f32(f32(f32(Math.sqrt(v[i])) / bc2Sqrt) + this.eps);
        p[i] = f32(p[i] + f32(f32(stepSize * m[i]) / denom));                 // addcdiv_(m, denom, -step_size)
      }
    });
  }
}

// One step on rows [start, start + B): gradients of the mean cross entropy
function gradients(head, x, y, start, B) {
  const { embedDim: E, denseUnits: U, numClasses: C, w2 } = head;
  const xb = x.subarray(start * E, (start + B) * E);
  const { hidden, logits } = head.forward(xb, B);
  const p = softmaxRows(logits, B, C);
  const dLogits = new Float64Array(B * C);
  for (let i = 0; i < B; i++) for (let c = 0; c < C; c++) dLogits[i * C + c] = (p[i * C + c] - (y[start + i] === c ? 1 : 0)) / B;
  const gW2 = new Float32Array(C * U), gW1 = new Float32Array(U * E), gB1 = new Float32Array(U);
  for (let c = 0; c < C; c++) for (let u = 0; u < U; u++) {
    let s = 0;
    for (let i = 0; i < B; i++) s += dLogits[i * C + c] * hidden[i * U + u];
    gW2[c * U + u] = s;
  }
  const dH = new Float64Array(B * U);
  for (let i = 0; i < B; i++) for (let u = 0; u < U; u++) {
    if (hidden[i * U + u] <= 0) continue;
    let s = 0;
    for (let c = 0; c < C; c++) s += dLogits[i * C + c] * w2[c * U + u];
    dH[i * U + u] = s;
  }
  const acc = new Float64Array(E);
  for (let u = 0; u < U; u++) {
    acc.fill(0);
    let sb = 0;
    for (let i = 0; i < B; i++) {
      const d = dH[i * U + u];
      if (d === 0) continue;
      sb += d;
      const xo = i * E;
      for (let k = 0; k < E; k++) acc[k] += d * xb[xo + k];
    }
    gB1[u] = sb;
    gW1.set(acc, u * E);
  }
  return { grads: [gW1, gB1, gW2], logits };
}

// train_classifier(...). onEpoch({ epoch, epochs, loss, accuracy, val_loss,
// val_accuracy }); shouldStop() -> true cancels (throws TrainingCancelled).
export function trainClassifier(trainX, trainY, valX, valY, numClasses, {
  epochs = DEFAULT_EPOCHS, batchSize = DEFAULT_BATCH_SIZE, learningRate = DEFAULT_LEARNING_RATE,
  onEpoch = null, shouldStop = null, seed = SHUFFLE_SEED, embedDim = trainX.length / trainY.length,
} = {}) {
  const head = new ClassifierHead(embedDim, numClasses).initialize(seed);
  const adam = new Adam([head.w1, head.b1, head.w2], learningRate);
  const n = trainY.length, nVal = valY.length, history = [];
  for (let epoch = 1; epoch <= epochs; epoch++) {
    if (shouldStop?.()) throw new TrainingCancelled();
    let totalLoss = 0, totalCorrect = 0;
    for (let start = 0; start < n; start += batchSize) {
      const B = Math.min(batchSize, n - start);
      const { grads, logits } = gradients(head, trainX, trainY, start, B);
      const { loss, correct } = lossAndCorrect(logits, trainY, start, B, numClasses);
      adam.update(grads);
      totalLoss += loss * B;
      totalCorrect += correct;
    }
    let valLoss = null, valAccuracy = null;
    if (nVal) {
      const { logits } = head.forward(valX, nVal);
      const r = lossAndCorrect(logits, valY, 0, nVal, numClasses);
      valLoss = r.loss;
      valAccuracy = f32(r.correct / nVal);
    }
    const metrics = { epoch, loss: totalLoss / n, accuracy: totalCorrect / n, val_loss: valLoss, val_accuracy: valAccuracy };
    history.push(metrics);
    onEpoch?.({ ...metrics, epochs });
  }
  const confusion = Array.from({ length: numClasses }, () => new Array(numClasses).fill(0));
  if (nVal) {
    const proba = head.predictProba(valX, nVal);
    for (let i = 0; i < nVal; i++) confusion[valY[i]][argmax(proba, i * numClasses, numClasses)] += 1;
  }
  const classAccuracy = confusion.map((row, i) => { const t = row.reduce((a, b) => a + b, 0); return t ? row[i] / t : null; });
  const counts = y => { const c = new Array(numClasses).fill(0); for (const v of y) c[v]++; return c; };
  return {
    head, history, confusion, classAccuracy,
    trainCounts: counts(trainY),
    valCounts: nVal ? counts(valY) : new Array(numClasses).fill(0),
    valAccuracy: history.length ? history[history.length - 1].val_accuracy : null,
  };
}
