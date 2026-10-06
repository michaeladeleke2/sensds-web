// The browser workers load tfjs-core (plus the gradients and backends) from the
// CDN, which, unlike the full @tensorflow/tfjs package, has no chained tensor
// methods (tensor.reshape(...)). Node cannot import tfjs-core's module build
// directly, so this removes the chained methods from the full package and runs
// training and inference under the same conditions as the browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as tf from '@tensorflow/tfjs';

import { readSafetensors } from '../src/io/safetensors.js';
import { loadModel, predict, framesToImage } from '../src/test/inference.js';
import { train } from '../src/train/trainer.js';
import { syntheticRaw, sdkScale } from './synthetic.js';

await tf.setBackend('cpu');
// Methods Tensor has in tfjs-core itself; every other op-named method is a chained op
const CORE = new Set(['buffer', 'bufferSync', 'array', 'arraySync', 'data', 'dataToGPU', 'dataSync', 'bytes', 'dispose', 'isDisposed', 'throwIfDisposed', 'print', 'clone', 'toString', 'cast', 'variable', 'assign', 'constructor']);
for (const proto of [tf.Tensor.prototype, Object.getPrototypeOf(tf.Tensor.prototype)])
  for (const name of Object.getOwnPropertyNames(proto))
    if (!CORE.has(name) && typeof tf[name] === 'function' && typeof Object.getOwnPropertyDescriptor(proto, name).value === 'function') delete proto[name];
const rd = p => { const b = readFileSync(new URL(p, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

test('chained tensor methods are absent in tfjs-core (the browser build)', () => {
  assert.equal(typeof tf.zeros([1]).reshape, 'undefined');
});

test('inference works with tfjs-core only', async () => {
  const F = './fixtures/test_tab/tiny_model/';
  const model = loadModel(tf, { configText: readFileSync(new URL(F + 'config.json', import.meta.url), 'utf8'), preprocessorText: readFileSync(new URL(F + 'preprocessor_config.json', import.meta.url), 'utf8'), weights: rd(F + 'model.safetensors') });
  const img = framesToImage(Array.from({ length: 12 }, (_, f) => sdkScale(syntheticRaw(f))), 128, 256, -20);
  const probs = await predict(tf, model, img);
  assert.equal(Object.keys(probs).length, 3);
});

test('training works with tfjs-core only', async () => {
  const meta = JSON.parse(readFileSync(new URL('./fixtures/train/meta.json', import.meta.url)));
  const { tensors } = readSafetensors(rd('./fixtures/train/tiny_init.safetensors'));
  const img = (c, k) => { const rgb = new Uint8Array(40 * 30 * 3).map((_, i) => (i * (c + 3) + k * 11) % 256); return { load: async () => ({ rgb, width: 40, height: 30 }), label: c }; };
  const tr = [], va = [];
  for (let k = 0; k < 2; k++) for (let c = 0; c < 3; c++) tr.push(img(c, k));
  for (let c = 0; c < 3; c++) va.push(img(c, 9));
  const r = await train({ tf, baseTensors: tensors, baseConfigText: JSON.stringify({ ...meta.tiny.config, image_size: 32, patch_size: 8 }),
    preprocessor: { image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5], size: 32 }, train: tr, val: va, labelNames: ['a', 'b', 'c'],
    epochs: 1, batchSize: 3, lr: 1e-3, seed: 42, log: () => {}, onEpoch: () => {}, shouldStop: () => false });
  assert.ok(r.files['model/model.safetensors'].byteLength > 0);
});
