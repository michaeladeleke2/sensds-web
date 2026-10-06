// Port of SensDSv2 core/pca_analysis.py: the Doppler-domain and range-domain
// features of a raw radar cube, PCA by singular values, and the silhouette
// score.

import { fft, pairwiseSum } from '../dsp/fft.js';
import { RdmComputer, roundHalfEven } from '../dsp/doppler_live.js';
import { medianFilter1d } from '../dsp/recorded.js';
import { blackmanharris } from '../dsp/windows.js';

const RANGE_FFT_MULT = 4;
export const SMOOTH_WINDOW = 7;
export const FEATURE_SIZE = 32;

// numpy float32 pairwise sum (each addition rounded to float32)
function pairwiseSum32(a, start, n) {
  const f = Math.fround;
  if (n < 8) { let res = 0; for (let i = 0; i < n; i++) res = f(res + a[start + i]); return res; }
  if (n <= 128) {
    const r = new Float32Array(8);
    for (let j = 0; j < 8; j++) r[j] = a[start + j];
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] = f(r[j] + a[start + i + j]);
    let res = f(f(f(r[0] + r[1]) + f(r[2] + r[3])) + f(f(r[4] + r[5]) + f(r[6] + r[7])));
    for (; i < n; i++) res = f(res + a[start + i]);
    return res;
  }
  let n2 = Math.floor(n / 2); n2 -= n2 % 8;
  return f(pairwiseSum32(a, start, n2) + pairwiseSum32(a, start + n2, n - n2));
}

// spectrogram_features: doppler_db (float32 RDM per frame), extract_spectrogram
// (range bin of most total dB, median_filter size 7), _resize to 32x32.
export function spectrogramFeatures(cube, shape) {
  const [nFrame, nAnt, nChirp, nSample] = shape;
  const rdm = new RdmComputer(nSample, nChirp);
  const D = rdm.dopplerFftSize, R = rdm.nRangeBins;
  const frames = [], energy = new Float64Array(nFrame);
  for (let f = 0; f < nFrame; f++) {
    const base = f * nAnt * nChirp * nSample;                     // antenna 0
    const db32 = Float32Array.from(rdm.compute(cube.subarray(base, base + nChirp * nSample)));
    let best = -Infinity, idx = 0;
    for (let r = 0; r < R; r++) { const s = pairwiseSum32(db32, r * D, D); if (s > best) { best = s; idx = r; } }
    frames.push(db32); energy[f] = idx;
  }
  const smoothed = medianFilter1d(energy, Math.max(1, SMOOTH_WINDOW | 1));
  const spec = new Float64Array(nFrame * D);
  for (let f = 0; f < nFrame; f++) {
    const bin = Math.min(R - 1, Math.max(0, roundHalfEven(smoothed[f])));
    spec.set(frames[f].subarray(bin * D, (bin + 1) * D), f * D);
  }
  return resize(spec, nFrame, D);
}

// range_fft_features: chirp-averaged range profile (antenna 0), magnitude and
// phase, each resized to 32x32, concatenated (2048 values).
export function rangeFftFeatures(cube, shape) {
  const [nFrame, nAnt, nChirp, nSample] = shape;
  const fftSize = nSample * RANGE_FFT_MULT, nBins = fftSize / 2;
  const rw = blackmanharris(nSample);
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  const mag = new Float64Array(nFrame * nBins), phase = new Float64Array(nFrame * nBins);
  const aRe = new Float64Array(nBins), aIm = new Float64Array(nBins);
  for (let f = 0; f < nFrame; f++) {
    aRe.fill(0); aIm.fill(0);
    for (let c = 0; c < nChirp; c++) {
      const base = ((f * nAnt + 0) * nChirp + c) * nSample;
      const mean = pairwiseSum(cube, base, nSample) / nSample;
      re.fill(0); im.fill(0);
      for (let s = 0; s < nSample; s++) re[s] = (cube[base + s] - mean) * rw[s];
      fft(re, im);
      for (let b = 0; b < nBins; b++) { aRe[b] += re[b]; aIm[b] += im[b]; }
    }
    for (let b = 0; b < nBins; b++) {
      const r = aRe[b] / nChirp, i = aIm[b] / nChirp;
      mag[f * nBins + b] = Math.hypot(r, i);
      phase[f * nBins + b] = Math.atan2(i, r);
    }
  }
  const out = new Float64Array(2 * FEATURE_SIZE * FEATURE_SIZE);
  out.set(resize(mag, nFrame, nBins), 0);
  out.set(resize(phase, nFrame, nBins), FEATURE_SIZE * FEATURE_SIZE);
  return out;
}

// _resize: scipy.ndimage.zoom(arr, (size/h, size/w), order=1), then forced to
// (size, size). Output shape round(h * size/h); coordinates i * (in-1)/(out-1);
// linear interpolation.
export function resize(arr, h, w, size = FEATURE_SIZE) {
  if (h === size && w === size) return Float64Array.from(arr);
  const oh = Math.round(h * (size / h)), ow = Math.round(w * (size / w));
  const zh = oh > 1 ? (h - 1) / (oh - 1) : 0, zw = ow > 1 ? (w - 1) / (ow - 1) : 0;
  const sample = (y, x) => (y >= 0 && y < h && x >= 0 && x < w ? arr[y * w + x] : 0);
  const out = new Float64Array(size * size);
  for (let i = 0; i < Math.min(oh, size); i++) {
    const cy = i * zh, y0 = Math.floor(cy), ty = cy - y0;
    for (let j = 0; j < Math.min(ow, size); j++) {
      const cx = j * zw, x0 = Math.floor(cx), tx = cx - x0;
      let v = (1 - ty) * ((1 - tx) * sample(y0, x0) + (tx ? tx * sample(y0, x0 + 1) : 0));
      if (ty) v += ty * ((1 - tx) * sample(y0 + 1, x0) + (tx ? tx * sample(y0 + 1, x0 + 1) : 0));
      out[i * size + j] = v;
    }
  }
  return out;
}

// Symmetric eigen-decomposition by cyclic Jacobi rotations. A is n x n, row major.
function jacobiEigen(A, n) {
  const a = Float64Array.from(A), v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0, diag = 0;
    for (let p = 0; p < n; p++) { diag += a[p * n + p] ** 2; for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2; }
    if (off <= 1e-30 * diag || off === 0) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k * n + p], akq = a[k * n + q];
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p * n + k], aqk = a[q * n + k];
        a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k * n + p], vkq = v[k * n + q];
        v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors: v };
}

// pca(X, k=2): projection onto the top k singular directions of the centred
// data, and the explained variance ratio S**2 / sum(S**2).
// numpy uses an SVD; here the same U and S come from the eigenvectors of
// Xc Xc^T (n x n, n = number of samples). Each component's sign is arbitrary in
// both, so it is fixed here by making the largest-magnitude score positive;
// the desktop plot can be the mirror image of this one.
export function pca(rows, k = 2) {
  const n = rows.length, d = rows[0].length;
  const mean = new Float64Array(d);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const xc = rows.map(r => Float64Array.from(r, (v, j) => v - mean[j]));
  const G = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
    let s = 0; const a = xc[i], b = xc[j];
    for (let t = 0; t < d; t++) s += a[t] * b[t];
    G[i * n + j] = G[j * n + i] = s;
  }
  const { values, vectors } = jacobiEigen(G, n);
  const order = values.map((v, i) => [Math.max(0, v), i]).sort((p, q) => q[0] - p[0]);
  const total = order.reduce((s, [v]) => s + v, 0);
  const proj = Array.from({ length: n }, () => new Float64Array(k));
  const evr = new Float64Array(k);
  const kEff = Math.min(k, Math.min(n, d));
  for (let c = 0; c < kEff; c++) {
    const [lambda, idx] = order[c];
    const s = Math.sqrt(lambda);
    let big = 0;
    for (let i = 0; i < n; i++) if (Math.abs(vectors[i * n + idx]) > Math.abs(big)) big = vectors[i * n + idx];
    const sign = big < 0 ? -1 : 1;
    for (let i = 0; i < n; i++) proj[i][c] = sign * vectors[i * n + idx] * s;
    evr[c] = total > 0 ? lambda / total : 0;
  }
  return { proj, evr };
}

// silhouette(proj, labels)
export function silhouette(proj, labels) {
  const n = proj.length, classes = [...new Set(labels)].sort();
  if (classes.length < 2 || n < 2) return 0;
  const dist = (i, j) => Math.sqrt(proj[i].reduce((s, v, t) => s + (v - proj[j][t]) ** 2, 0));
  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = [];
    for (let j = 0; j < n; j++) if (labels[j] === labels[i]) own.push(j);
    if (own.length <= 1) continue;
    const a = own.reduce((s, j) => s + dist(i, j), 0) / (own.length - 1);
    let b = Infinity;
    for (const c of classes) {
      if (c === labels[i]) continue;
      const members = [];
      for (let j = 0; j < n; j++) if (labels[j] === c) members.push(j);
      if (!members.length) continue;
      b = Math.min(b, members.reduce((s, j) => s + dist(i, j), 0) / members.length);
    }
    if (!Number.isFinite(b)) continue;
    const denom = Math.max(a, b);
    total += denom === 0 ? 0 : (b - a) / denom;
  }
  return total / n;
}
