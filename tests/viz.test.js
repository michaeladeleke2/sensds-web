import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { blackmanharris, chebwin } from '../src/dsp/windows.js';
import { RdmComputer, LiveDopplerProcessor, medianFilterLast, roundHalfEven } from '../src/dsp/doppler_live.js';
import { JET_LUT, JET_LUT_BYTES, lutIndex } from '../src/viz/jet.js';
import { axisTicks, yTickSpace, xTickSpace } from '../src/viz/ticks.js';
import { makeImage, jetClim, historyToPlotData } from '../src/viz/image.js';
import { syntheticRaw, sdkScale } from './synthetic.js';

const FIX = new URL('./fixtures/viz/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', FIX)));
const f64 = name => { const b = readFileSync(new URL(name, FIX)); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); };
const frames = Array.from({ length: meta.n_frames }, (_, f) => sdkScale(syntheticRaw(f, meta.cos_tab)));

const maxAbsDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

test('synthetic input matches the Python generator', () => {
  assert.deepEqual([...frames[0].subarray(0, 8)], meta.frame0_scaled_first8);
});

test('windows match scipy blackmanharris(256) and chebwin(128, 100) / sum', () => {
  assert.ok(maxAbsDiff(blackmanharris(256), meta.range_window) < 1e-15);
  const rdm = new RdmComputer(256, 128);
  assert.ok(maxAbsDiff(rdm.dopplerWindow, meta.doppler_window) < 1e-15, 'doppler window');
  assert.equal(chebwin(128, 100).length, 128);
});

test('compute_rdm_db on frame 0 matches the reference to rounding', () => {
  const rdm = new RdmComputer(256, 128).compute(frames[0]);
  const ref = f64('rdm_frame0_512x512.f64');
  const d = maxAbsDiff(rdm, ref);
  assert.ok(d < 1e-8, `max |dB difference| ${d}`);
});

test('LiveDopplerProcessor: same range bins and history as the reference', () => {
  const proc = new LiveDopplerProcessor({ nSample: 256, nChirp: 128, historyLength: meta.history_length });
  const bins = [];
  let history;
  for (const fr of frames) { const out = proc.processFrame(fr); bins.push(out.rangeBin); history = out.history; }
  assert.deepEqual(bins, meta.range_bins);
  const d = maxAbsDiff(history, f64('history_10x512.f64'));
  assert.ok(d < 1e-8, `max |dB difference| ${d}`);
});

test('range bin smoothing reproduces median_filter(mode=reflect)[-1] and numpy round', () => {
  assert.equal(medianFilterLast([1, 2, 30, 4, 5], 5), 5);     // window [30, 4, 5, 5, 4]
  assert.equal(medianFilterLast([9, 9, 1, 1, 2], 5), 1);      // window [1, 1, 2, 2, 1]
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
});

test('jet colormap matches matplotlib (float LUT, byte LUT, value-to-index)', () => {
  const flat = meta.jet_lut_float.flat();
  assert.ok(maxAbsDiff(JET_LUT, flat) < 1e-15);
  assert.deepEqual([...JET_LUT_BYTES], meta.jet_lut_bytes.flat());
  const probe = Array.from({ length: 1001 }, (_, i) => {
    const step = 1 / 1000; const v = i === 1000 ? 1 : i * step;
    const k = lutIndex(v) * 3; return [JET_LUT_BYTES[k], JET_LUT_BYTES[k + 1], JET_LUT_BYTES[k + 2]];
  });
  assert.deepEqual(probe, meta.jet_probe_bytes);
});

test('tick positions and labels match matplotlib for each figure size and frame range', () => {
  for (const t of meta.ticks) {
    const [x0, y0, w, h] = t.axes_bbox_px;
    void x0; void y0;
    const y = axisTicks(-6.19405905, 6.19405905, yTickSpace(h, 100));
    assert.deepEqual(y.map(v => v.label), t.yticklabels, `y labels ${t.figsize}`);
    const x = axisTicks(t.xlim[0], t.xlim[1], xTickSpace(w, 100));
    assert.deepEqual(x.map(v => v.label), t.xticklabels, `x labels ${t.figsize} frame ${t.frame_end}`);
  }
});

test('image pixels match a real matplotlib render (640x480, grid off)', () => {
  const W = 640, H = 480;
  const ref = readFileSync(new URL('render_640x480_nogrid.rgba', FIX));
  const [bx, by, bw, bh] = meta.render_nogrid.axes_bbox_px;
  const history = f64('history_10x512.f64');
  const plot = historyToPlotData(history, meta.history_length, 512);
  const { vmin, vmax } = jetClim(plot, -20);
  const img = makeImage(plot, 512, meta.history_length, bw, bh, vmin, vmax);
  assert.equal(img.stage, 'rgba');
  assert.equal(img.interpolation, 'hanning');
  const left = Math.round(bx), top = Math.round(H - (by + img.outH));
  // Compare the interior, keeping 3 px clear of the spines.
  let sum = 0, n = 0, max = 0, over2 = 0;
  for (let y = 3; y < img.outH - 3; y++) {
    for (let x = 3; x < img.outW - 3; x++) {
      for (let ch = 0; ch < 3; ch++) {
        const a = img.rgba[(y * img.outW + x) * 4 + ch];
        const b = ref[((top + y) * W + (left + x)) * 4 + ch];
        const d = Math.abs(a - b);
        sum += d; n++; max = Math.max(max, d); if (d > 2) over2++;
      }
    }
  }
  const mean = sum / n;
  console.log(`  image vs matplotlib: mean |diff| ${mean.toFixed(3)}, max ${max}, values off by >2: ${(100 * over2 / n).toFixed(2)}%`);
  assert.ok(mean < 1.0, `mean |diff| ${mean}`);
  assert.ok(over2 / n < 0.01, `share off by more than 2: ${over2 / n}`);
});

test('JS cosine table equals the Python one', async () => {
  const { COS_TAB } = await import('./synthetic.js');
  assert.deepEqual(COS_TAB, meta.cos_tab);
});
