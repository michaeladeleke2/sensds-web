import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meta, arr, maxAbsDiff } from './sensav_fixtures.js';
import { TorchGenerator } from '../src/sensav/ml/torch_random.js';
import { ClassifierHead } from '../src/sensav/ml/head.js';
import { splitPerClass, buildDataset, trainClassifier, SHUFFLE_SEED } from '../src/sensav/ml/trainer.js';
import { defaultRng } from '../src/train/numpy_random.js';
import { halfArrayToFloat, floatArrayToHalf } from '../src/sensav/io/float16.js';

test('torch.Generator normal_ draws match PyTorch (both kernels, cached second value)', () => {
  const g = new TorchGenerator(1234), got = [];
  for (const n of meta.normal_sizes) got.push(...g.normal_(new Float32Array(n), 0.0, 0.5));
  const ref = arr('normal_draws');
  const d = maxAbsDiff(Float32Array.from(got), ref);
  console.log('normal_ max |diff|', d);
  assert.ok(d <= 1e-7);
});

test('head initialization matches ClassifierHead.initialize(1234)', () => {
  for (const c of [3, 5]) {
    const h = new ClassifierHead(1024, c).initialize(SHUFFLE_SEED);
    const d1 = maxAbsDiff(h.w1, arr(`head${c}_hidden_w`)), d2 = maxAbsDiff(h.w2, arr(`head${c}_output_w`));
    console.log(`head${c} init max |diff|`, d1, d2);
    assert.ok(d1 <= 1e-7 && d2 <= 1e-7);
  }
});

test('float16 round trip matches numpy', () => {
  const half = arr('train_embeddings');
  assert.deepEqual([...floatArrayToHalf(halfArrayToFloat(half))], [...half]);
});

test('per-class split and dataset order match numpy default_rng(1234)', () => {
  const rng = defaultRng(SHUFFLE_SEED);
  const splits = splitPerClass(meta.sample_ids, rng);
  assert.deepEqual(splits, meta.split);
  const all = meta.sample_ids.flat(), table = new Map(), half = halfArrayToFloat(arr('train_embeddings'));
  all.forEach((id, i) => table.set(id, half.subarray(i * 1024, (i + 1) * 1024)));
  const lookup = ids => { const out = new Float32Array(ids.length * 1024); ids.forEach((id, i) => out.set(table.get(id), i * 1024)); return out; };
  const ds = buildDataset(splits, lookup, rng, 1024);
  assert.deepEqual([...ds.trainY], meta.train_order_y);
  assert.deepEqual([...ds.valY], meta.val_order_y);
  assert.equal(maxAbsDiff(ds.trainX, arr('train_x')), 0);
  assert.equal(maxAbsDiff(ds.valX, arr('val_x')), 0);
});

test('training matches SensAV train_classifier (history, weights, confusion)', () => {
  const trainX = arr('train_x'), valX = arr('val_x');
  const r = trainClassifier(trainX, Int32Array.from(meta.train_order_y), valX, Int32Array.from(meta.val_order_y), 3, { epochs: 12, batchSize: 16, learningRate: 0.001 });
  const ref = meta.train_history;
  for (let i = 0; i < ref.length; i++) {
    const a = r.history[i], b = ref[i];
    assert.ok(Math.abs(a.loss - b.loss) <= 1e-4 * Math.max(1, b.loss), `epoch ${i + 1} loss ${a.loss} vs ${b.loss}`);
    assert.equal(a.accuracy, b.accuracy, `epoch ${i + 1} accuracy`);
    assert.ok(Math.abs(a.val_loss - b.val_loss) <= 1e-4 * Math.max(1, b.val_loss), `epoch ${i + 1} val_loss ${a.val_loss} vs ${b.val_loss}`);
    assert.equal(a.val_accuracy, b.val_accuracy, `epoch ${i + 1} val_accuracy`);
  }
  assert.deepEqual(r.confusion, meta.train_confusion);
  assert.deepEqual(r.trainCounts, meta.train_counts);
  assert.deepEqual(r.valCounts, meta.val_counts);
  const dw = maxAbsDiff(r.head.w1, arr('trained_hidden_w')), dw2 = maxAbsDiff(r.head.w2, arr('trained_output_w'));
  const dp = maxAbsDiff(r.head.predictProba(valX), arr('trained_val_proba'));
  console.log('after 12 epochs: max |diff| hidden', dw, 'output', dw2, 'val probabilities', dp);
  assert.ok(dw < 1e-4 && dw2 < 1e-4 && dp < 1e-4);
});
