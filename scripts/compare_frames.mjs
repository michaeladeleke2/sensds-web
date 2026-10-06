// Compares radar frames captured by the browser with frames captured by the
// Python SDK (the Step 2 validation). Both are (n, 3, 128, 256) float32 .npy.
// With the radar facing the same still scene, the static picture should match:
// per-antenna level and spread, and the average chirp shape.
//
//   node scripts/compare_frames.mjs ~/Downloads/browser_frames_20.npy tests/fixtures/radar/python_frames.npy

import { readFileSync } from 'node:fs';
import { parseNpy } from '../src/io/npy.js';

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('usage: node scripts/compare_frames.mjs <browser.npy> <python.npy>'); process.exit(1); }

function load(path) {
  const buf = readFileSync(path);
  const arr = parseNpy(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const [n, ant, chirp, sample] = arr.shape;
  return { ...arr, n, ant, chirp, sample };
}

function stats(x) {
  const per = x.chirp * x.sample, out = [];
  for (let r = 0; r < x.ant; r++) {
    let sum = 0, sq = 0, cnt = 0, min = Infinity, max = -Infinity;
    const avgChirp = new Float64Array(x.sample);
    for (let f = 0; f < x.n; f++) {
      const base = (f * x.ant + r) * per;
      for (let i = 0; i < per; i++) {
        const v = x.data[base + i];
        sum += v; sq += v * v; cnt++; if (v < min) min = v; if (v > max) max = v;
        avgChirp[i % x.sample] += v;
      }
    }
    const mean = sum / cnt;
    for (let s = 0; s < x.sample; s++) avgChirp[s] /= x.n * x.chirp;
    out.push({ mean, std: Math.sqrt(sq / cnt - mean * mean), min, max, avgChirp });
  }
  return out;
}

function corr(p, q) {
  const n = p.length, mp = p.reduce((s, v) => s + v, 0) / n, mq = q.reduce((s, v) => s + v, 0) / n;
  let num = 0, dp = 0, dq = 0;
  for (let i = 0; i < n; i++) { num += (p[i] - mp) * (q[i] - mq); dp += (p[i] - mp) ** 2; dq += (q[i] - mq) ** 2; }
  return num / Math.sqrt(dp * dq);
}

const A = load(a), B = load(b);
console.log(`browser: ${A.n} frames, shape (${A.shape.join(', ')})`);
console.log(`python:  ${B.n} frames, shape (${B.shape.join(', ')})`);
if (A.ant !== B.ant || A.chirp !== B.chirp || A.sample !== B.sample) { console.error('Shapes differ.'); process.exit(1); }
const sa = stats(A), sb = stats(B);
const f = v => v.toFixed(4).padStart(8);
console.log('\nantenna   mean (browser / python)    std (browser / python)    average chirp correlation');
for (let r = 0; r < A.ant; r++) {
  console.log(`   ${r}      ${f(sa[r].mean)} / ${f(sb[r].mean)}       ${f(sa[r].std)} / ${f(sb[r].std)}            ${corr(sa[r].avgChirp, sb[r].avgChirp).toFixed(4)}`);
}
const inRange = sa.every(s => s.min >= -1 && s.max <= 1);
console.log(`\nall browser values within [-1, 1]: ${inRange ? 'yes' : 'NO'}`);
console.log('A still scene should give means within a few thousandths, similar std, and correlation near 1.');
