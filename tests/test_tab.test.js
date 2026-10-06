import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as tf from '@tensorflow/tfjs';

import { loadModel, preprocess, predict, framesToImage, disposeModel } from '../src/test/inference.js';
import { Maze, generateMaze, N, E, S, W } from '../src/test/maze.js';
import { syntheticRaw, sdkScale } from './synthetic.js';

const FIX = new URL('./fixtures/test_tab/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', FIX)));
const file = p => readFileSync(new URL(p, FIX));
await tf.setBackend('cpu');

const loadTiny = () => {
  const w = file('tiny_model/model.safetensors');
  return loadModel(tf, { configText: file('tiny_model/config.json').toString(), preprocessorText: file('tiny_model/preprocessor_config.json').toString(), weights: w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) });
};
const png = name => new Uint8Array(readFileSync(new URL(`./fixtures/collect/${name.replace('.png', '.u8')}`, import.meta.url)));

test('a model folder saved by transformers loads: classes from config.json', () => {
  const m = loadTiny();
  assert.deepEqual(m.classes, meta.classes);
  assert.deepEqual(m.preprocessor.size, { height: 32, width: 32 });
  disposeModel(m);
});

test('preprocessing is the Pillow path, within 1/255 of transformers\' own processor', () => {
  const m = loadTiny();
  for (const c of meta.cases) {
    const { pixels } = preprocess({ rgb: png(c.image), width: 400, height: 300 }, m.preprocessor);
    const ref = tf.transpose(tf.tensor(c.pixel_values, [3, 32, 32]), [1, 2, 0]).dataSync();
    let d = 0;
    for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs(pixels[i] - ref[i]));
    assert.ok(d <= c.max_diff_vs_pil_path + 1e-6, `${c.image}: ${d}`);
  }
  disposeModel(m);
});

test('probabilities match transformers (AutoImageProcessor -> model -> softmax)', async () => {
  const m = loadTiny();
  for (const c of meta.cases) {
    const probs = await predict(tf, m, { rgb: png(c.image), width: 400, height: 300 });
    assert.deepEqual(Object.keys(probs), meta.classes);
    for (const k of meta.classes) assert.ok(Math.abs(probs[k] - c.probs[k]) < 2e-3, `${c.image} ${k}: ${probs[k]} vs ${c.probs[k]}`);
    assert.ok(Math.abs(Object.values(probs).reduce((a, b) => a + b, 0) - 1) < 1e-5);
  }
  disposeModel(m);
});

test('frames -> image: needs 10 frames, uses the last 30, same image as Collect', async () => {
  const { computeRecorded } = await import('../src/dsp/recorded.js');
  const { trainingImage } = await import('../src/collect/training_image.js');
  const frames = Array.from({ length: 34 }, (_, f) => sdkScale(syntheticRaw(f)));
  assert.equal(framesToImage(frames.slice(0, 9), 128, 256, -20), null);
  const img = framesToImage(frames, 128, 256, -20);
  const { spectrogram } = computeRecorded(frames.slice(-30), 128, 256);
  assert.deepEqual(img.rgb, trainingImage(spectrogram, 30, 512, -20).rgb);
  assert.equal(img.width, 400); assert.equal(img.height, 300);
});

test('maze: every cell reachable, walls consistent, moves, bumps, win and stars', () => {
  let seed = 1;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const [rows, cols] of [[3, 4], [4, 5], [5, 7]]) {
    const w = generateMaze(rows, cols, rng);
    const seen = new Set(['0,0']), stack = [[0, 0]];
    while (stack.length) {
      const [r, c] = stack.pop();
      for (const [d, dr, dc] of [[N, -1, 0], [S, 1, 0], [E, 0, 1], [W, 0, -1]]) {
        if (w[r][c] & d) continue;
        const k = `${r + dr},${c + dc}`;
        if (!seen.has(k)) { seen.add(k); stack.push([r + dr, c + dc]); }
      }
    }
    assert.equal(seen.size, rows * cols, 'perfect maze: all cells reachable');
    assert.ok(w.every((row, r) => (row[0] & W) && (row[cols - 1] & E) && (r > 0 || row.every(x => x & N))));
  }
  // A corridor maze: walk it with gestures
  const m = new Maze(1, 3, rng);
  m.walls = [[N | S | W, N | S, N | S | E]];
  assert.match(m.applyGesture('idle'), /^Idle/);
  assert.match(m.applyGesture('push'), /^Moved East/);
  assert.match(m.applyGesture('swipe_left'), /^Turned left! Now facing North/);
  assert.match(m.applyGesture('push'), /^Oops! There's a wall to the North/);
  assert.ok(m.bump);
  m.applyGesture('swipe_right');
  assert.match(m.applyGesture('push'), /You reached the goal in 4 moves/);
  assert.ok(m.won);
  assert.equal(m.starRating, 3);                       // min path 1 + 3 - 2 = 2; 4 <= int(2 * 2.5)
  assert.match(m.applyGesture('push'), /already won/);
});
