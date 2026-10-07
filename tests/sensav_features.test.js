import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meta, arr, maxAbsDiff, countDiff } from './sensav_fixtures.js';
import { melFilterbank, logMel, toUnit, clipImageGray, StreamingMel, Resampler, encodeWav, decodeWav, fitClip } from '../src/sensav/ml/audio_features.js';
import { squareSample } from '../src/sensav/ml/image_ops.js';

const signal = arr('audio_signal');

test('mel filterbank matches SensAV', () => {
  assert.ok(maxAbsDiff(melFilterbank(), arr('mel_filterbank')) < 1e-7);
});

test('log mel spectrogram matches SensAV to 1e-3 dB', () => {
  const ref = arr('log_mel'), { data, rows, cols } = logMel(signal);
  assert.deepEqual([rows, cols], ref.shape);
  const d = maxAbsDiff(data, ref);
  console.log('log_mel max |diff| dB', d);
  assert.ok(d < 1e-3);
  assert.ok(maxAbsDiff(toUnit(data), arr('to_unit')) < 2e-5);
});

test('clip image (cv2 INTER_LINEAR, uint8) matches SensAV pixel for pixel', () => {
  for (const [name, sig] of [['clip_image', signal], ['clip_image_short', signal.subarray(0, 9000)]]) {
    const ref = arr(name), got = clipImageGray(sig);
    const off = countDiff(got, ref, 0), big = countDiff(got, ref, 1);
    assert.equal(big, 0);
    assert.equal(off, 0, `${name}: ${off} pixels differ`);
  }
});

test('streaming mel gives the same columns per push', () => {
  const s = new StreamingMel(), cols = [], parts = [];
  for (let i = 0; i < signal.length; i += 800) { const r = s.push(signal.subarray(i, i + 800)); cols.push(r.cols); parts.push(r); }
  assert.deepEqual(cols, meta.streaming_counts);
  const ref = arr('streaming_mel'), total = ref.shape[1];
  let c0 = 0, worst = 0;
  for (const p of parts) {
    for (let m = 0; m < 64; m++) for (let c = 0; c < p.cols; c++) worst = Math.max(worst, Math.abs(p.data[m * p.cols + c] - ref[m * total + c0 + c]));
    c0 += p.cols;
  }
  assert.ok(worst < 1e-3, `worst ${worst}`);
});

test('resampler matches SensAV (48 kHz and 44.1 kHz, chunked)', () => {
  const input = arr('resample_in');
  for (const [rate, chunk, end, name, counts] of [[48000, 2400, input.length, 'resample_out', meta.resample_counts], [44100, 2205, 22050, 'resample441_out', meta.resample441_counts]]) {
    const r = new Resampler(rate, 16000), outs = [];
    for (let i = 0; i < end; i += chunk) outs.push(r.process(input.subarray(i, i + chunk)));
    assert.deepEqual(outs.map(o => o.length), counts);
    const all = new Float32Array(outs.reduce((a, o) => a + o.length, 0));
    let o = 0; for (const x of outs) { all.set(x, o); o += x.length; }
    const d = maxAbsDiff(all, arr(name));
    console.log(name, 'max |diff|', d);
    assert.ok(d < 1e-6);
  }
});

test('WAV files: written byte for byte like SensAV, read back like read_wav', () => {
  const bytes = encodeWav(fitClip(signal));
  assert.deepEqual([...bytes], [...arr('wav_bytes')]);
  const stereo = decodeWav(arr('stereo_wav_bytes'));
  const d = maxAbsDiff(stereo, arr('stereo_read'));
  console.log('stereo 44.1 kHz read max |diff|', d);
  assert.ok(d < 1e-6);
});

const pattern = (h, w) => {
  const out = new Uint8Array(h * w * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = (x * 7 + y * 13 + c * 50 + (x * y) % 97) % 256;
  return out;
};

test('square sample (cv2 INTER_AREA) matches SensAV byte for byte', () => {
  for (const [h, w, name] of [[480, 640, 'square_sample_bgr'], [720, 1280, 'square_sample720_bgr'], [500, 300, 'square_sample_tall_bgr']]) {
    const got = squareSample(pattern(h, w), w, h), ref = arr(name);
    const off = countDiff(got, ref, 0);
    assert.equal(off, 0, `${name}: ${off} values differ`);
  }
});

import { audioFeatures, imageFeatures, pcaTwo, pyRound } from '../src/sensav/ml/stats.js';
import { decodeWav as readWav } from '../src/sensav/ml/audio_features.js';

test('CSV audio and image features match SensAV export.py', () => {
  assert.deepEqual(audioFeatures(readWav(arr('wav_bytes'))), meta.audio_features_clip);
  assert.deepEqual(audioFeatures(readWav(arr('stereo_wav_bytes'))), meta.audio_features_stereo);
  const bgr = arr('jpeg_decoded_bgr'), rgb = new Uint8Array(bgr.length);
  for (let i = 0; i < bgr.length; i += 3) { rgb[i] = bgr[i + 2]; rgb[i + 1] = bgr[i + 1]; rgb[i + 2] = bgr[i]; }
  assert.deepEqual(imageFeatures(rgb), meta.image_features);
  assert.equal(pyRound(0.25, 1), 0.2); assert.equal(pyRound(0.35, 1), 0.3); assert.equal(pyRound(2.5), 2);
});

test('PCA scores match numpy SVD up to the sign of each component', () => {
  const x = arr('pca_input'), ref = arr('pca_two'), n = x.shape[0];
  const got = pcaTwo(x, n, 1024);
  for (let c = 0; c < 2; c++) {
    let same = 0, flip = 0;
    for (let i = 0; i < n; i++) { same = Math.max(same, Math.abs(got[i * 2 + c] - ref[i * 2 + c])); flip = Math.max(flip, Math.abs(got[i * 2 + c] + ref[i * 2 + c])); }
    console.log(`pca component ${c + 1}: max |diff| ${Math.min(same, flip)}`);
    assert.ok(Math.min(same, flip) < 1e-3);
  }
});
