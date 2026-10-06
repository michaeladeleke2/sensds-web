// The training run of SensDSv2's TrainWorker (ui/train_tab.py), which uses the
// Hugging Face Trainer:
//   - subject-wise train/val split with np.random.default_rng(seed); a single
//     subject gets a random 80/20 split of its samples instead,
//   - classes = sorted gesture folders that hold PNGs,
//   - new classifier head on the pretrained ViT,
//   - per epoch: shuffled batches with the spectrogram-safe augmentation,
//     cross-entropy, gradient clipping 1.0, AdamW (weight decay 0.01), linear
//     learning-rate decay; then evaluation (loss, accuracy, macro F1),
//   - the best epoch by macro F1 is kept (load_best_model_at_end), evaluated
//     again and saved in Hugging Face format.
// tf and the image loader are passed in, so this runs in a Web Worker and in
// Node tests.

import { defaultRng } from './numpy_random.js';
import { AdamW } from './adamw.js';
import { configFromHf, loadParams, exportParams, newClassifier, forward, lossAndGrads, crossEntropy } from './vit.js';
import { trainTransform, valTransform, normalizeToNhwc } from './transforms.js';
import { writeSafetensors } from '../io/safetensors.js';
import { parseKeepNumbers, dumps, float, int } from '../io/pyjson.js';

// _fmt_dur
export function fmtDur(seconds) {
  let s = Math.round(Math.max(0, seconds));
  if (s < 60) return `${s}s`;
  let m = Math.floor(s / 60); s %= 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60); m %= 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

// Python str(list_of_str), for the log lines
export const pyList = items => `[${items.map(s => `'${s}'`).join(', ')}]`;

// Subject split, as TrainWorker.run: returns { train, val, randomSplit }
export function splitSubjects(subjects, valSubjects, seed) {
  if (subjects.length < 2) return { train: subjects, val: subjects, randomSplit: true };
  const arr = defaultRng(seed).shuffle([...subjects]);
  const nVal = Math.max(1, Math.min(valSubjects, arr.length - 1));
  return { train: arr.slice(nVal), val: arr.slice(0, nVal), randomSplit: false };
}

// The single-subject 80/20 split of GestureDataset
export function randomSplit(items, seed, isTrain) {
  const idx = defaultRng(seed).shuffle([...items.keys()]);
  const cut = Math.trunc(idx.length * 0.8);
  return (isTrain ? idx.slice(0, cut) : idx.slice(cut)).map(i => items[i]);
}

// compute_metrics
export function metrics(preds, labels, nClasses) {
  const n = labels.length;
  const acc = n ? preds.filter((p, i) => p === labels[i]).length / n : 0;
  let f1sum = 0;
  for (let c = 0; c < nClasses; c++) {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < n; i++) {
      if (preds[i] === c && labels[i] === c) tp++;
      else if (preds[i] === c) fp++;
      else if (labels[i] === c) fn++;
    }
    const denom = 2 * tp + fp + fn;
    f1sum += denom > 0 ? 2 * tp / denom : 0;
  }
  return { accuracy: acc, f1: f1sum / nClasses };
}

// Hugging Face files for the trained model. baseConfigText is the base
// model's config.json text, so every number keeps its original form.
export function hfFiles(baseConfigText, labelNames, params, preprocessor) {
  const id2label = Object.fromEntries(labelNames.map((n, i) => [String(i), n]));
  const label2id = Object.fromEntries(labelNames.map((n, i) => [n, int(i)]));
  const config = parseKeepNumbers(baseConfigText);
  delete config._name_or_path;
  Object.assign(config, { architectures: ['ViTForImageClassification'], id2label, label2id, problem_type: 'single_label_classification' });
  const size = preprocessor.size?.height ?? preprocessor.size ?? 224;
  const pre = {
    do_normalize: true, do_rescale: true, do_resize: true,
    image_mean: preprocessor.image_mean.map(float), image_processor_type: 'ViTImageProcessor', image_std: preprocessor.image_std.map(float),
    resample: int(2), rescale_factor: float(0.00392156862745098), size: { height: int(size), width: int(size) },
  };
  // labels.json is json.dump(..., indent=2) without sort_keys; id2label keys
  // are ints in Python, which JSON writes as strings
  return {
    'model/config.json': dumps(config) + '\n',
    'model/preprocessor_config.json': dumps(pre) + '\n',
    'model/model.safetensors': writeSafetensors(params),
    'labels.json': dumps({ id2label, label2id }, { sortKeys: false }),
  };
}

// opts: { tf, baseTensors (Map), baseConfigText, preprocessor, train: [{ load(), label }],
//         val: [...], labelNames, epochs, batchSize, lr, seed, log(msg), onEpoch({epoch, loss, acc, f1}),
//         shouldStop(), onProgress({ phase: 'loading' | 'train' | 'eval', ... }) }
// load() resolves to { rgb, width, height }.
export async function train(opts) {
  const { tf, baseConfigText, preprocessor, labelNames, epochs, batchSize, lr, seed, log, onEpoch, shouldStop } = opts;
  const cfg = configFromHf(JSON.parse(baseConfigText));
  const mean = preprocessor.image_mean, std = preprocessor.image_std, size = cfg.imageSize;
  const rng = defaultRng(seed);
  const random = () => rng.random();

  // Model: pretrained weights with a new classifier head (ignore_mismatched_sizes)
  const tensors = new Map([...opts.baseTensors].filter(([k]) => !k.startsWith('classifier.')));
  const head = newClassifier(cfg.hidden, labelNames.length, random);
  tensors.set('classifier.weight', head.weight);
  tensors.set('classifier.bias', head.bias);
  const params = loadParams(tf, tensors);

  const progress = opts.onProgress || (() => {});
  const nImages = opts.train.length + opts.val.length;
  let loaded = 0;
  const decode = async items => {
    const out = [];
    for (const it of items) {
      out.push({ ...(await it.load()), label: it.label });
      if (++loaded % 10 === 0 || loaded === nImages) progress({ phase: 'loading', done: loaded, total: nImages });
    }
    return out;
  };
  const trainSet = await decode(opts.train), valSet = await decode(opts.val);

  const batchPixels = (batch, isTrain) => {
    const data = new Float32Array(batch.length * size * size * 3);
    batch.forEach((s, i) => {
      const rgb = isTrain ? trainTransform(s.rgb, s.width, s.height, random, size) : valTransform(s.rgb, s.width, s.height, size);
      normalizeToNhwc(rgb, size, size, mean, std, data, i * size * size * 3);
    });
    return tf.tensor4d(data, [batch.length, size, size, 3]);
  };

  const evaluate = async () => {
    let lossSum = 0;
    const preds = [], labels = [];
    for (let i = 0; i < valSet.length; i += batchSize) {
      const batch = valSet.slice(i, i + batchSize);
      const y = batch.map(s => s.label);
      // tidy: release every intermediate (attention maps, layer outputs) of the
      // forward pass, or GPU memory grows each epoch until the browser stalls
      const [loss, am] = tf.tidy(() => {
        const logits = forward(tf, params, cfg, batchPixels(batch, false));
        return [crossEntropy(tf, logits, y), tf.argMax(logits, 1)];
      });
      lossSum += (await loss.data())[0] * batch.length;
      preds.push(...(await am.data())); labels.push(...y);
      tf.dispose([loss, am]);
    }
    return { loss: lossSum / Math.max(1, valSet.length), ...metrics(preds, labels, labelNames.length) };
  };

  const stepsPerEpoch = Math.ceil(trainSet.length / batchSize);
  const opt = new AdamW(tf, params, { lr, totalSteps: stepsPerEpoch * epochs });
  let best = null, bestF1 = -Infinity, stopped = false;
  const t0 = performance.now();
  let lastEpoch = t0;

  for (let epoch = 1; epoch <= epochs && !stopped; epoch++) {
    const order = rng.shuffle([...trainSet.keys()]);
    for (let s = 0; s < stepsPerEpoch; s++) {
      if (shouldStop()) { stopped = true; break; }
      const batch = order.slice(s * batchSize, (s + 1) * batchSize).map(i => trainSet[i]);
      const x = batchPixels(batch, true);
      const { loss, grads } = lossAndGrads(tf, params, cfg, x, batch.map(b => b.label));
      opt.apply(grads);
      await loss.data();                                            // let the GPU finish, keep the page responsive
      tf.dispose([x, loss, ...Object.values(grads)]);
      progress({ phase: 'train', epoch, step: s + 1, steps: stepsPerEpoch });
      await new Promise(r => setTimeout(r, 0));
    }
    if (stopped) break;
    progress({ phase: 'eval', epoch });
    const m = await evaluate();
    const now = performance.now();
    log(`Epoch ${epoch}/${epochs}  ·  val_loss: ${m.loss.toFixed(4)}  acc: ${(m.accuracy * 100).toFixed(2)}%  f1: ${m.f1.toFixed(3)}  [${fmtDur((now - lastEpoch) / 1000)}]`);
    lastEpoch = now;
    onEpoch({ epoch, loss: m.loss, acc: m.accuracy, f1: m.f1 });
    if (m.f1 > bestF1) { bestF1 = m.f1; best = await exportParams(params); }   // np.greater: ties keep the earlier epoch
  }

  const trainS = (performance.now() - t0) / 1000;
  log(`Training finished in ${fmtDur(trainS)} (${fmtDur(trainS / Math.max(1, epochs))}/epoch avg).`);
  if (best) for (const [k, t] of best) { const v = tf.tensor(t.data, t.shape); params.get(k).assign(v); v.dispose(); }
  log('Evaluating best model...');
  const final = await evaluate();
  log(`Final acc: ${(final.accuracy * 100).toFixed(2)}%  f1: ${final.f1.toFixed(3)}`);
  const files = hfFiles(baseConfigText, labelNames, await exportParams(params), preprocessor);
  opt.dispose();
  for (const p of params.values()) p.dispose();
  return { files, final, stopped };
}
