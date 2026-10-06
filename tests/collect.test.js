import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeRecorded, medianFilter1d } from '../src/dsp/recorded.js';
import { referenceRgb, trainingImage } from '../src/collect/training_image.js';
import { resizeBilinear } from '../src/io/resize.js';
import { encodePngRgb } from '../src/io/png.js';
import { writeNpy, parseNpy } from '../src/io/npy.js';
import { numFramesFor, nextSampleNumber, isSampleFile, sampleStem, captureInfoJson, captureMismatch } from '../src/collect/capture.js';
import { syntheticRaw, sdkScale } from './synthetic.js';

const FIX = new URL('./fixtures/collect/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', FIX)));
const bytes = name => new Uint8Array(readFileSync(new URL(name, FIX)));
const f64 = name => { const b = readFileSync(new URL(name, FIX)); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); };
const ref = f64('spectrogram_20x512.f64');

test('frame count per duration matches round(duration / 0.15) as SensDSv2 computes it', () => {
  for (const [d, n] of Object.entries(meta.num_frames)) assert.equal(numFramesFor(Number(d)), n, `duration ${d}`);
});

test('compute_recorded on a 20-frame capture matches the reference', () => {
  const frames = Array.from({ length: meta.n }, (_, f) => sdkScale(syntheticRaw(f)));
  const { spectrogram } = computeRecorded(frames, 128, 256);
  let d = 0;
  for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs(spectrogram[i] - ref[i]));
  assert.ok(d < 1e-8, `max |dB difference| ${d}`);
});

test('median_filter mode=reflect over a whole sequence', () => {
  assert.deepEqual([...medianFilter1d(Float64Array.of(1, 9, 2, 8, 3, 7), 5)], [2, 2, 3, 7, 7, 7]);
});

test('reference_rgb is byte-identical for both colour floors', () => {
  for (const floor of [20, 50]) assert.deepEqual(referenceRgb(ref, meta.n, 512, -floor), bytes(`reference_rgb_${floor}.u8`), `jet_vmin -${floor}`);
});

test('Pillow BILINEAR resize is byte-identical on a probe image', () => {
  const src = Uint8Array.from(meta.resize_probe_in.flat(2));
  assert.deepEqual([...resizeBilinear(src, 5, 7, 11, 4)], meta.resize_probe_out.flat(2));
});

test('training image (400x300) is byte-identical to SensDSv2 training_image()', () => {
  for (const floor of [20, 50]) {
    const img = trainingImage(ref, meta.n, 512, -floor);
    assert.equal(img.width, 400); assert.equal(img.height, 300);
    assert.deepEqual(img.rgb, bytes(`training_${floor}.u8`), `jet_vmin -${floor}`);
  }
});

test('PNG writer produces an RGB PNG whose pixels decode back exactly', async () => {
  const rgb = bytes('training_20.u8');
  const png = await encodePngRgb(rgb, 400, 300);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(png[25], 2);                      // colour type RGB
  // Inflate the IDAT and strip the filter bytes.
  const dv = new DataView(png.buffer, png.byteOffset);
  let o = 8, idat = [];
  while (o < png.length) {
    const len = dv.getUint32(o), type = new TextDecoder().decode(png.subarray(o + 4, o + 8));
    if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const px = new Uint8Array(400 * 300 * 3);
  for (let y = 0; y < 300; y++) px.set(raw.subarray(y * 1201 + 1, (y + 1) * 1201), y * 1200);
  assert.deepEqual(px, rgb);
});

test('npy writer round-trips float64 and float32', () => {
  const a = Float64Array.of(1.5, -2.25, 3e-9), b = Float32Array.of(0.5, -1);
  const pa = parseNpy(writeNpy(a, [3]).buffer), pb = parseNpy(writeNpy(b, [2, 1]).buffer);
  assert.equal(pa.descr, '<f8'); assert.deepEqual([...pa.data], [...a]); assert.deepEqual(pa.shape, [3]);
  assert.equal(pb.descr, '<f4'); assert.deepEqual(pb.shape, [2, 1]);
});

test('sample numbering, counting and file names follow the desktop', () => {
  const files = ['sample_001.npy', 'sample_001_raw.npy', 'sample_001.png', 'sample_012.npy', 'capture_info.json', 'notes.txt'];
  assert.equal(nextSampleNumber(files), 12);
  assert.equal(files.filter(isSampleFile).length, 2);
  assert.equal(sampleStem(13), 'sample_013');
  assert.equal(sampleStem(1234), 'sample_1234');
});

test('capture_info.json matches json.dump(indent=2) and mismatch messages', () => {
  const json = captureInfoJson(-20, new Date(2026, 9, 5, 9, 4, 7));
  assert.equal(json, '{\n  "spectrogram_method": "infineon",\n  "renderer": "reference",\n  "velocity_flipped": true,\n  "updated": "2026-10-05 09:04:07",\n  "jet_vmin": -20.0\n}');
  const info = JSON.parse(json);
  assert.equal(captureMismatch(true, info, -20), '');
  assert.match(captureMismatch(true, info, -50), /Reduce noise setting was different/);
  assert.match(captureMismatch(true, { spectrogram_method: 'stft', renderer: 'sensds' }, -20), /method was stft/);
  assert.match(captureMismatch(true, null, -20), /before SensDS recorded/);
  assert.equal(captureMismatch(false, null, -20), '');
});
