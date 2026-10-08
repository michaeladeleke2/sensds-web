// The range map views against range_map_v1.py and range_map_live.py, run
// unchanged on 20 real radar frames (reference/python/make_range_map_fixtures.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNpy, framesFromNpy } from '../src/io/npy.js';
import { windows, computeRangeMap, LiveRangeProcessor } from '../src/dsp/range_map.js';
import { jetClim } from '../src/viz/image.js';

const FIX = new URL('./fixtures/range_map/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', FIX)));
const bin = readFileSync(new URL('arrays.f64', FIX));
const arr = name => { const { shape, offset } = meta.arrays[name]; const n = shape.reduce((a, b) => a * b, 1); return new Float64Array(bin.buffer.slice(bin.byteOffset + offset, bin.byteOffset + offset + n * 8)); };
const npy = readFileSync(new URL('./fixtures/radar/python_frames.npy', import.meta.url));
const rec = framesFromNpy(parseNpy(npy.buffer.slice(npy.byteOffset, npy.byteOffset + npy.byteLength)));
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

test('windows match scipy (Blackman-Harris, normalised Chebyshev 100 dB)', () => {
  const { rangeWindow, dopplerWindow } = windows(256, 128);
  assert.ok(maxDiff(rangeWindow, arr('range_window')) < 1e-15);
  assert.ok(maxDiff(dopplerWindow, arr('doppler_window')) < 1e-15);
});

for (const mode of ['raw', 'mti']) {
  test(`compute_range_map (${mode}) matches range_map_v1.py`, () => {
    const { map, rangeM } = computeRangeMap(i => rec.antenna0(i), rec.nFrame, rec.nChirp, rec.nSample, mode);
    const d = maxDiff(map, arr(`map_${mode}`));
    console.log(`${mode}: max |diff| ${d} dB`);
    assert.ok(d < 1e-9);
    assert.ok(maxDiff(rangeM, arr('range_m')) < 1e-15);
    const { vmin, vmax } = jetClim(map, -20);
    assert.ok(Math.abs(vmin - meta[`map_${mode}_clim`][0]) < 1e-9 && Math.abs(vmax - meta[`map_${mode}_clim`][1]) < 1e-9);
  });

  test(`LiveRangeProcessor (${mode}) history matches range_map_live.py`, () => {
    const p = new LiveRangeProcessor({ nSample: 256, nChirp: 128, mode, historyLength: 12 });
    let r;
    for (let i = 0; i < rec.nFrame; i++) {
      r = p.processFrame(rec.antenna0(i));
      if (i === 6) assert.ok(maxDiff(r.history, arr(`live_${mode}_history_7`)) < 1e-9);
    }
    assert.equal(r.nFilled, 12);
    assert.ok(maxDiff(r.history, arr(`live_${mode}_history_20`)) < 1e-9);
    assert.deepEqual([p.rangeM[0], p.rangeM.at(-1)], meta[`live_${mode}_range`]);
  });
}
