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

// null in the fixture is NaN (a frame with no micro-Doppler signature): both sides must have it
const maxRel = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    if (b[i] === null) { if (!Number.isNaN(a[i])) return Infinity; continue; }
    m = Math.max(m, Math.abs(a[i] - b[i]) / Math.max(1, Math.abs(b[i])));
  }
  return m;
};

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

// ── team feedback: velocity span, chirp spacing, the Visualize-style preview ──

import { CHIRP_REP_S, FRAME_KEYS, featureLabel } from '../src/analysis/physical_features.js';
import { samplePreview } from '../src/analysis/preview.js';
import { LiveDopplerProcessor } from '../src/dsp/doppler_live.js';
import { computeRangeMap } from '../src/dsp/range_map.js';

// A target 0.8 m away swinging toward and away from the radar
function swing(amp = 0.15, f = 0.7, chirpS = 0.0003, nF = 12) {
  const C = 299792458, slope = 5.5e9 / 256e-6, lam = C / 60.75e9;
  const a = new Float32Array(nF * 3 * 128 * 256);
  let r = 7;
  const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
  for (let i = 0; i < nF; i++) for (let c = 0; c < 128; c++) {
    const t = i * 0.1 + c * chirpS, R = 0.8 + amp * Math.sin(2 * Math.PI * f * t), fb = 2 * slope * R / C;
    for (let s = 0; s < 256; s++) {
      const v = 0.5 + 0.02 * Math.cos(2 * Math.PI * fb * s / 1e6 + 4 * Math.PI * R / lam) + 0.004 * rnd();
      for (let an = 0; an < 3; an++) a[((i * 3 + an) * 128 + c) * 256 + s] = v;
    }
  }
  return { cube: a, shape: [nF, 3, 128, 256] };
}

test('velocity span: exposed, follows the swing, none for a still target', () => {
  assert.ok(SUMMARY_KEYS.includes('vel_span_ms') && FRAME_KEYS.includes('vel_upper_ms'));
  assert.equal(featureLabel('vel_span_ms'), 'Velocity span (m/s)');
  const push = swing(), wave = swing(0.04, 1.5), still = swing(0);
  const span = s => extract(s.cube, s.shape).summary.vel_span_ms;
  const truePush = 2 * 0.15 * 2 * Math.PI * 0.7;
  assert.ok(Math.abs(span(push) - truePush) < 0.3, `push ${span(push)}`);
  assert.ok(span(push) > span(wave) && span(wave) > span(still));
  assert.ok(span(still) < 0.2, `still ${span(still)}`);
});

test('Doppler velocities use the chirp spacing the sample was recorded with', () => {
  assert.equal(CHIRP_REP_S, 0.0003);
  const old = swing(0.15, 0.7, 0.0002);
  const right = extract(old.cube, old.shape, { chirpRepS: 0.0002 }).summary.vel_span_ms;
  const wrong = extract(old.cube, old.shape).summary.vel_span_ms;
  assert.ok(Math.abs(wrong / right - 2 / 3) < 0.05, `${wrong} / ${right}`);
});

test('the sample preview is the Visualize processing over every frame', () => {
  const { cube, shape } = swing();
  const p = samplePreview(cube, shape, 'mti');
  const per = 128 * 256, frameAt = i => cube.subarray((i * 3) * per, (i * 3 + 1) * per);
  const proc = new LiveDopplerProcessor({ nSample: 256, nChirp: 128, historyLength: 12 });
  let hist;
  for (let i = 0; i < 12; i++) hist = proc.processFrame(frameAt(i)).history;
  assert.deepEqual([...p.doppler], [...hist]);
  assert.deepEqual([...p.rangeMap], [...computeRangeMap(frameAt, 12, 128, 256, 'mti').map]);
  assert.equal(p.mode, 'mti');
  assert.equal(p.nFrame, 12);
});
