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

// ── team feedback: maze moves for any class, float16 model weights ──

import { MAZE_ACTIONS, defaultMazeAction } from '../src/test/maze.js';
import { readSafetensors, writeSafetensors } from '../src/io/safetensors.js';

test('maze: every class can be given a move; the defaults keep the desktop gestures', () => {
  assert.deepEqual(MAZE_ACTIONS.map(([k]) => k), ['forward', 'left', 'right', 'around', 'none']);
  assert.deepEqual(['idle', 'push', 'swipe_down', 'swipe_left', 'swipe_right', 'swipe_up', 'wave'].map(defaultMazeAction),
    ['none', 'forward', 'around', 'left', 'right', 'forward', 'none']);
  const m = new Maze(3, 3, () => 0.5);
  m.walls = m.walls.map(row => row.map(() => 0));          // no inner walls
  assert.match(m.applyAction('around', 'swipe_down'), /^Turned around! Now facing West/);
  assert.match(m.applyAction('around'), /Now facing East/);
  assert.match(m.applyAction('forward', 'swipe_up'), /^Moved East/);
  assert.match(m.applyAction('none', 'wave'), /^Wave does nothing in the maze/);
  assert.equal(m.moves, 3);
  assert.match(m.applyGesture('swipe_down'), /Turned around/);
});

test('safetensors: float16 and bfloat16 tensors are read as float32', () => {
  const vals = [0, 1, -2, 0.5, 65504, 2 ** -14, 2 ** -24, -0];          // smallest normal, smallest subnormal
  const half = Uint16Array.from([0x0000, 0x3c00, 0xc000, 0x3800, 0x7bff, 0x0400, 0x0001, 0x8000]);
  const bf = Uint16Array.from([0x0000, 0x3f80, 0xc000, 0x3f00]);
  const json = JSON.stringify({ a: { dtype: 'F16', shape: [8], data_offsets: [0, 16] }, b: { dtype: 'BF16', shape: [4], data_offsets: [16, 24] } });
  const head = new TextEncoder().encode(json + ' '.repeat((8 - (json.length % 8)) % 8));
  const buf = new Uint8Array(8 + head.length + 24);
  new DataView(buf.buffer).setBigUint64(0, BigInt(head.length), true);
  buf.set(head, 8);
  buf.set(new Uint8Array(half.buffer), 8 + head.length);
  buf.set(new Uint8Array(bf.buffer), 8 + head.length + 16);
  const { tensors } = readSafetensors(buf.buffer);
  [...tensors.get('a').data].forEach((v, i) => assert.ok(Object.is(v, vals[i]) || Math.abs(v - vals[i]) <= 1e-12 * Math.abs(vals[i]), `${v} vs ${vals[i]}`));
  assert.deepEqual([...tensors.get('b').data], [0, 1, -2, 0.5]);
  const f32 = readSafetensors(writeSafetensors([['w', { shape: [2], data: Float32Array.from([1.5, -3]) }]]).buffer);
  assert.deepEqual([...f32.tensors.get('w').data], [1.5, -3]);
});

test('the starter model shipped with the site is complete and matches its manifest', async () => {
  const { readFileSync, statSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const dir = new URL('../assets/models/six_class/', import.meta.url);
  const man = JSON.parse(readFileSync(new URL('manifest.json', dir)));
  const config = JSON.parse(readFileSync(new URL('config.json', dir)));
  assert.deepEqual(Object.values(config.id2label), man.classes);
  let total = 0;
  const whole = createHash('sha256');
  for (const p of man.weights.parts) {
    const b = readFileSync(new URL(p.file, dir));
    assert.ok(statSync(new URL(p.file, dir)).size < 50 * 1024 * 1024, `${p.file} under GitHub's 50 MB warning`);
    assert.equal(b.length, p.bytes);
    assert.equal(createHash('sha256').update(b).digest('hex'), p.sha256);
    whole.update(b); total += b.length;
  }
  assert.equal(total, man.weights.bytes);
  assert.equal(whole.digest('hex'), man.weights.sha256);
});

// ── previous spectrogram (starter model) ──
import { previousImage, toPreviousSpeedRange, speedRatio } from '../src/test/previous_picture.js';
import { computeRecorded } from '../src/dsp/recorded.js';
import { selectRangeBinRawPrevious } from '../src/dsp/doppler_live.js';

const prevFix = name => readFileSync(new URL(`previous/${name}`, FIX));

test('previous spectrogram: same range bins and colours as SensDS before the change note', () => {
  // Fixtures made by SensDSv2 before the change note (commit 6642a2e^), from the same synthetic capture
  const frames = Array.from({ length: 20 }, (_, f) => sdkScale(syntheticRaw(f)));
  const b = prevFix('spectrogram_20x512.f64'), ref = new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
  const { spectrogram } = computeRecorded(frames, 128, 256, selectRangeBinRawPrevious);
  let d = 0;
  for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs(spectrogram[i] - ref[i]));
  assert.ok(d < 1e-8, `max |dB difference| ${d}`);
  // With the previous chirp (no stretch) the picture is byte for byte the previous training image
  const img = previousImage(frames, 128, 256, 1);
  assert.deepEqual(img.rgb, new Uint8Array(prevFix('training_20.u8')));
});

test('previous spectrogram: the 0.3 ms chirp is stretched onto the 0.2 ms speed range', () => {
  assert.equal(speedRatio(0.0003), 1.5);
  assert.equal(speedRatio(0.0002), 1);
  const D = 8, row = Float64Array.of(-80, -70, -60, -50, 0, -50, -60, -70);   // zero speed at bin 4
  const out = toPreviousSpeedRange(row, 1, D, 1.5);
  // bin k reads current bin 4 + (k - 4) * 1.5 (bin 3 -> 2.5, between -60 and -50);
  // past the ends (bins 0, 1 and 7), the column's median (-60)
  assert.deepEqual([...out], [-60, -60, -70, -55, 0, -55, -70, -60]);
});

test('framesToImage draws the previous way only when asked', () => {
  const frames = Array.from({ length: 20 }, (_, f) => sdkScale(syntheticRaw(f)));
  const cur = framesToImage(frames, 128, 256, -50), prev = framesToImage(frames, 128, 256, -50, 'previous');
  assert.deepEqual(prev.rgb, previousImage(frames, 128, 256).rgb);
  assert.notDeepEqual(prev.rgb, cur.rgb);
});
