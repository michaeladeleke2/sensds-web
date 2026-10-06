import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extract, SUMMARY_KEYS } from '../src/analysis/physical_features.js';
import { spectrogramFeatures, rangeFftFeatures, resize, pca, silhouette } from '../src/analysis/pca_analysis.js';
import { summaryCsv, framesCsv, pyG } from '../src/analysis/csv.js';
import { parseNpy } from '../src/io/npy.js';
import { syntheticCube } from './synthetic.js';

const FIX = new URL('./fixtures/analysis/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', FIX)));
const f64 = name => { const b = readFileSync(new URL(name, FIX)); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); };
const realBuf = readFileSync(new URL('./fixtures/radar/python_frames.npy', import.meta.url));
const real = parseNpy(realBuf.buffer.slice(realBuf.byteOffset, realBuf.byteOffset + realBuf.byteLength));

const SAMPLES = [{ name: 'real', cube: real.data, shape: real.shape },
  ...Array.from({ length: 8 }, (_, v) => ({ name: `syn${v}`, cube: syntheticCube(v), shape: [7, 3, 128, 256] }))];

const maxRel = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]) / Math.max(1, Math.abs(b[i]))); return m; };

const results = SAMPLES.map(s => ({ ...s, ...extract(s.cube, s.shape) }));

test('physical features match physical_features.extract on real and synthetic samples', () => {
  results.forEach((r, i) => {
    const ref = meta.samples[i];
    assert.deepEqual([...r.series.range_m], ref.series.range_m, `${r.name} range_m (tracked bins identical)`);
    for (const k of Object.keys(ref.series)) assert.ok(maxRel(r.series[k], ref.series[k]) < 1e-9, `${r.name} series ${k}: ${maxRel(r.series[k], ref.series[k])}`);
    for (const k of Object.keys(ref.summary)) assert.ok(Math.abs(r.summary[k] - ref.summary[k]) <= 1e-9 * Math.max(1, Math.abs(ref.summary[k])), `${r.name} summary ${k}: ${r.summary[k]} vs ${ref.summary[k]}`);
  });
});

test('CSV text is identical to write_summary_csv / write_frames_csv', () => {
  const records = results.map((r, i) => ({ student: r.name === 'real' ? 'Alex, Jr.' : 'Sam', gesture: meta.samples[i].label, name: `${r.name}_raw.npy`, summary: r.summary, series: r.series }));
  assert.equal(summaryCsv(records), meta.summary_csv);
  assert.equal(framesCsv(records).text, meta.frames_csv);
});

test('Python .6g formatting', () => {
  for (const [v, s] of meta.g6) assert.equal(pyG(v), s, `format(${v}, '.6g')`);
});

test('zoom(order=1) resize matches PA._resize', () => {
  for (const p of meta.zoom_probes) {
    const out = resize(Float64Array.from(p.input), p.shape[0], p.shape[1]);
    assert.ok(maxRel(out, p.output) < 1e-12, `shape ${p.shape}: ${maxRel(out, p.output)}`);
  }
});

const spec = SAMPLES.map(s => spectrogramFeatures(s.cube, s.shape));
const rfft = SAMPLES.map(s => rangeFftFeatures(s.cube, s.shape));

test('Doppler-domain and range-domain features match pca_analysis', () => {
  SAMPLES.forEach((s, i) => {
    assert.ok(maxRel(spec[i], f64(`spec_feat_${s.name}.f64`)) < 1e-5, `${s.name} spectrogram features ${maxRel(spec[i], f64(`spec_feat_${s.name}.f64`))}`);
    assert.ok(maxRel(rfft[i], f64(`rfft_feat_${s.name}.f64`)) < 1e-9, `${s.name} range features ${maxRel(rfft[i], f64(`rfft_feat_${s.name}.f64`))}`);
  });
});

test('PCA variance, projections (up to sign) and silhouette match', () => {
  for (const [key, feats] of [['spec', spec], ['rfft', rfft]]) {
    const { proj, evr } = pca(feats, 2);
    for (let c = 0; c < 2; c++) {
      assert.ok(Math.abs(evr[c] - meta[`${key}_evr`][c]) < 1e-6, `${key} evr ${c}: ${evr[c]} vs ${meta[`${key}_evr`][c]}`);
      const ref = meta[`${key}_proj`].map(p => p[c]);
      const ours = proj.map(p => p[c]);
      const sign = Math.sign(ours.reduce((s, v, i) => s + v * ref[i], 0)) || 1;
      assert.ok(maxRel(ours.map(v => v * sign), ref) < 1e-4, `${key} PC${c + 1}`);
    }
    const sil = silhouette(proj, meta.labels);
    assert.ok(Math.abs(sil - meta[`${key}_sil`]) < 1e-6, `${key} silhouette ${sil} vs ${meta[`${key}_sil`]}`);
  }
});
