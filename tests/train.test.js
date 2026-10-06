import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as tf from '@tensorflow/tfjs';

import { readSafetensors, writeSafetensors } from '../src/io/safetensors.js';
import { defaultRng } from '../src/train/numpy_random.js';
import { AdamW, usesWeightDecay, linearLr } from '../src/train/adamw.js';
import { configFromHf, loadParams, forward, lossAndGrads, exportParams } from '../src/train/vit.js';
import { resizeBilinear } from '../src/io/resize.js';
import { normalizeToNhwc } from '../src/train/transforms.js';

const FIX = new URL('./fixtures/train/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', FIX)));
const buf = name => { const b = readFileSync(new URL(name, FIX)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const f32 = name => new Float32Array(buf(name));
const nchwToNhwc = (a, B, C, H, W) => tf.transpose(tf.tensor(a, [B, C, H, W]), [0, 2, 3, 1]);
const maxAbs = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

await tf.setBackend('cpu');

test('numpy default_rng(seed).shuffle matches numpy exactly', () => {
  for (const s of meta.shuffles) assert.deepEqual(defaultRng(s.seed).shuffle([...Array(s.n).keys()]), s.out, `seed ${s.seed}, n ${s.n}`);
  assert.deepEqual(defaultRng(42).shuffle(['Alex', 'Bea', 'Cy', 'Dee']), meta.subject_shuffle);
});

test('safetensors round trip', () => {
  const { tensors } = readSafetensors(buf('tiny_init.safetensors'));
  const back = readSafetensors(writeSafetensors(tensors).buffer).tensors;
  assert.deepEqual([...back.keys()].sort(), [...tensors.keys()].sort());
  for (const [k, t] of tensors) { assert.deepEqual(back.get(k).shape, t.shape); assert.deepEqual(back.get(k).data, t.data); }
});

test('weight-decay groups match Trainer.get_decay_parameter_names', () => {
  const names = [...readSafetensors(buf('tiny_init.safetensors')).tensors.keys()];
  assert.deepEqual(names.filter(usesWeightDecay).sort(), meta.tiny.decay_names);
  assert.equal(linearLr(1e-3, 0, 10), 1e-3);
  assert.ok(Math.abs(linearLr(1e-3, 1, 10) - 9e-4) < 1e-18);
});

test('tiny ViT: forward, two training steps (clip + AdamW + linear lr) match PyTorch', async () => {
  const cfg = configFromHf(meta.tiny.config);
  const params = loadParams(tf, readSafetensors(buf('tiny_init.safetensors')).tensors);
  const x = nchwToNhwc(f32('tiny_x_nchw.f32'), 4, 3, 32, 32);
  const opt = new AdamW(tf, params, { lr: meta.tiny.lr, totalSteps: meta.tiny.total_steps });
  for (let step = 0; step < 2; step++) {
    const ref = meta.tiny.steps[step];
    const logits = forward(tf, params, cfg, x);
    assert.ok(maxAbs(logits.dataSync(), ref.logits.flat()) < 1e-5, `step ${step} logits ${maxAbs(logits.dataSync(), ref.logits.flat())}`);
    const { loss, grads } = lossAndGrads(tf, params, cfg, x, meta.tiny.labels);
    assert.ok(Math.abs(loss.dataSync()[0] - ref.loss) < 1e-5, `step ${step} loss ${loss.dataSync()[0]} vs ${ref.loss}`);
    const norm = opt.apply(grads);
    assert.ok(Math.abs(norm - ref.grad_norm) < 1e-4, `step ${step} grad norm ${norm} vs ${ref.grad_norm}`);
  }
  const after = readSafetensors(buf('tiny_after2.safetensors')).tensors;
  const ours = await exportParams(params);
  // The attention key bias has an exactly-zero true gradient (softmax ignores a
  // constant added to every key), so both frameworks update it from rounding
  // noise; Adam scales that noise up to about lr. Bound it, and hold every
  // other weight to a hundredth of lr.
  let worst = 0, worstName = '';
  for (const [k, t] of after) {
    const d = maxAbs(ours.get(k).data, t.data);
    if (k.endsWith('attention.attention.key.bias')) { assert.ok(d < meta.tiny.lr, `${k}: ${d}`); continue; }
    if (d > worst) { worst = d; worstName = k; }
  }
  assert.ok(worst < meta.tiny.lr * 1e-2, `weights after 2 steps: max diff ${worst} (${worstName}), lr ${meta.tiny.lr}`);
  const evalLogits = forward(tf, params, cfg, x).dataSync();
  assert.ok(maxAbs(evalLogits, meta.tiny.eval_logits.flat()) < 1e-4, 'eval logits after training');
});

test('val transform: Resize((224, 224)) + ToTensor + Normalize(0.5, 0.5) is exact', () => {
  const src = new Uint8Array(readFileSync(new URL('./fixtures/collect/training_20.u8', import.meta.url)));
  const rgb = resizeBilinear(src, 400, 300, 224, 224);
  const ours = normalizeToNhwc(rgb, 224, 224, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const ref = tf.transpose(tf.tensor(f32('small_px_nchw.f32'), [1, 3, 224, 224]), [0, 2, 3, 1]).dataSync();
  assert.equal(maxAbs(ours, ref), 0);
  const r256 = resizeBilinear(src, 400, 300, 256, 256);
  assert.deepEqual(r256, new Uint8Array(buf('resize256.u8')));
});

// Opt-in (FULL=1): the real vit-small-patch16-224 from Hugging Face (88 MB, cached in tests/.cache).
test('vit-small-patch16-224 forward on a real training image matches PyTorch', { skip: !process.env.FULL }, async () => {
  const dir = new URL('./.cache/', import.meta.url);
  const path = new URL('vit-small.safetensors', dir);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const res = await fetch('https://huggingface.co/WinKawaks/vit-small-patch16-224/resolve/main/model.safetensors');
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const b = readFileSync(path);
  const tensors = readSafetensors(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).tensors;
  for (const [k, t] of readSafetensors(buf('small_head.safetensors')).tensors) tensors.set(k, t);
  const params = loadParams(tf, tensors);
  const cfg = configFromHf({ image_size: 224, patch_size: 16, num_channels: 3, hidden_size: 384, num_hidden_layers: 12, num_attention_heads: 6, intermediate_size: 1536, layer_norm_eps: 1e-12 });
  const x = tf.transpose(tf.tensor(f32('small_px_nchw.f32'), [1, 3, 224, 224]), [0, 2, 3, 1]);
  const logits = forward(tf, params, cfg, x).dataSync();
  assert.ok(maxAbs(logits, meta.small_logits.flat()) < 1e-3, `logits ${[...logits]} vs ${meta.small_logits}`);
});

test('a full (tiny) training run: epochs, metrics, best model, Hugging Face files', async () => {
  const { train, splitSubjects, randomSplit, metrics, fmtDur, pyList } = await import('../src/train/trainer.js');
  assert.equal(fmtDur(42), '42s'); assert.equal(fmtDur(187), '3m 07s'); assert.equal(fmtDur(4350), '1h 12m 30s');
  assert.equal(pyList(['Alex', 'Bea']), "['Alex', 'Bea']");
  assert.deepEqual(splitSubjects(['Alex', 'Bea', 'Cy', 'Dee'], 1, 42), { train: ['Cy', 'Bea', 'Alex'], val: ['Dee'], randomSplit: false });
  assert.equal(randomSplit([...Array(10).keys()], 42, true).length, 8);
  assert.deepEqual(metrics([0, 1, 1, 2], [0, 1, 2, 2], 3), { accuracy: 0.75, f1: (1 + 2 / 3 + 2 / 3) / 3 });

  const { tensors } = readSafetensors(buf('tiny_init.safetensors'));
  const baseConfigText = JSON.stringify({ ...meta.tiny.config, image_size: 32, patch_size: 8, hidden_dropout_prob: 0.5 }).replace('"hidden_dropout_prob":0.5', '"hidden_dropout_prob":0.0');
  // Synthetic 40x30 images: class = which third of the picture is bright
  const make = (cls, k) => {
    const w = 40, h = 30, rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const bright = Math.floor(y / 10) === cls;
      const v = bright ? 200 + ((x * 7 + k * 13) % 50) : 20 + ((x + y + k) % 30);
      rgb.set([v, bright ? 60 : v, 255 - v], (y * w + x) * 3);
    }
    return { load: async () => ({ rgb, width: w, height: h }), label: cls };
  };
  const trainItems = [], valItems = [];
  for (let k = 0; k < 8; k++) for (let c = 0; c < 3; c++) trainItems.push(make(c, k));
  for (let k = 8; k < 11; k++) for (let c = 0; c < 3; c++) valItems.push(make(c, k));
  const epochsSeen = [], logs = [];
  const result = await train({
    tf, baseTensors: tensors, baseConfigText, preprocessor: { image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5], size: 32 },
    train: trainItems, val: valItems, labelNames: ['a', 'b', 'c'], epochs: 4, batchSize: 8, lr: 1e-3, seed: 42,
    log: m => logs.push(m), onEpoch: e => epochsSeen.push(e), shouldStop: () => false,
  });
  assert.equal(epochsSeen.length, 4);
  assert.match(logs[0], /^Epoch 1\/4  · {2}val_loss: \d+\.\d{4} {2}acc: \d+\.\d{2}% {2}f1: \d\.\d{3} {2}\[\d+s\]$/);
  assert.ok(logs.some(l => l.startsWith('Final acc: ')));
  const bestF1 = Math.max(...epochsSeen.map(e => e.f1));
  assert.ok(Math.abs(result.final.f1 - bestF1) < 1e-9, 'the saved model is the best epoch');
  assert.ok(result.final.accuracy > 0.5, `learned something: ${result.final.accuracy}`);
  const cfg = JSON.parse(result.files['model/config.json']);
  assert.deepEqual(cfg.id2label, { 0: 'a', 1: 'b', 2: 'c' });
  assert.deepEqual(cfg.architectures, ['ViTForImageClassification']);
  assert.match(result.files['model/config.json'], /"hidden_dropout_prob": 0\.0,/, 'floats keep their decimal point');
  assert.match(result.files['model/config.json'], /"layer_norm_eps": 1e-12,/);
  const saved = readSafetensors(result.files['model/model.safetensors'].buffer).tensors;
  assert.deepEqual(saved.get('classifier.weight').shape, [3, 32]);
  assert.deepEqual(JSON.parse(result.files['labels.json']), { id2label: { 0: 'a', 1: 'b', 2: 'c' }, label2id: { a: 0, b: 1, c: 2 } });
});

test('training does not leak tensors between epochs', async () => {
  const { train } = await import('../src/train/trainer.js');
  const { tensors } = readSafetensors(buf('tiny_init.safetensors'));
  const img = (c, k) => { const rgb = new Uint8Array(40 * 30 * 3).map((_, i) => (i * (c + 3) + k * 11) % 256); return { load: async () => ({ rgb, width: 40, height: 30 }), label: c }; };
  const tr = [], va = [];
  for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) tr.push(img(c, k));
  for (let c = 0; c < 3; c++) va.push(img(c, 9));
  const counts = [], phases = new Set();
  const start = tf.memory().numTensors;
  await train({ tf, baseTensors: tensors, baseConfigText: JSON.stringify({ ...meta.tiny.config, image_size: 32, patch_size: 8 }),
    preprocessor: { image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5], size: 32 }, train: tr, val: va, labelNames: ['a', 'b', 'c'],
    epochs: 3, batchSize: 4, lr: 1e-3, seed: 42, log: () => {}, onEpoch: () => counts.push(tf.memory().numTensors),
    shouldStop: () => false, onProgress: p => phases.add(p.phase) });
  assert.equal(counts[1], counts[0], `tensors after epochs: ${counts}`);
  assert.equal(counts[2], counts[0], `tensors after epochs: ${counts}`);
  assert.equal(tf.memory().numTensors, start, 'everything released at the end');
  assert.deepEqual([...phases].sort(), ['eval', 'loading', 'train']);
});
