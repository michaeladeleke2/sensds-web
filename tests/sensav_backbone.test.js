import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as tf from '@tensorflow/tfjs';
import { arr } from './sensav_fixtures.js';
import { readSafetensors } from '../src/io/safetensors.js';
import { buildBackbone } from '../src/sensav/ml/backbone.js';

await tf.setBackend('cpu');

test('MobileNetV3 Small embeddings match torchvision (SensAV backbone)', async () => {
  const b = readFileSync(new URL('../assets/sensav/mobilenet_v3_small.safetensors', import.meta.url));
  const { tensors } = readSafetensors(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const net = buildBackbone(tf, tensors);
  const images = arr('backbone_images'), ref = arr('backbone_embeddings');
  const got = await net.embed(images, 3);
  let worst = 0, scale = 0;
  for (let i = 0; i < ref.length; i++) { worst = Math.max(worst, Math.abs(got[i] - ref[i])); scale = Math.max(scale, Math.abs(ref[i])); }
  console.log('embedding max |diff|', worst, 'largest value', scale);
  assert.ok(worst < 1e-4 * Math.max(1, scale));
  net.dispose();
});
