// The numbers SensAV's CSV export puts next to each sample
// (app/storage/export.py): mean brightness and colour of an image; loudness,
// peak frequency and spectral centroid of a clip; and two PCA components of
// the embeddings. Rounded like Python's round().

import { fft, isPow2 } from '../../dsp/fft.js';
import { SAMPLE_RATE } from './audio_features.js';

// Python round(x, digits): rounds the exact binary value, ties to even
export function pyRound(x, digits = 0) {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const [ip, fp = ''] = Math.abs(x).toFixed(Math.min(100, digits + 30)).split('.');
  let base = BigInt(ip + fp.slice(0, digits));
  const rest = fp.slice(digits), tail = /[1-9]/.test(rest.slice(1));
  if (rest[0] > '5' || (rest[0] === '5' && (tail || base % 2n === 1n))) base += 1n;
  const v = parseFloat(`${base}e-${digits}`);
  return x < 0 ? -v : v;
}

// Complex FFT of any length (Bluestein's algorithm through power-of-two FFTs)
export function fftAny(re, im) {
  const n = re.length;
  if (isPow2(n)) { fft(re, im); return; }
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const wr = new Float64Array(n), wi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.PI * ((k * k) % (2 * n)) / n;
    wr[k] = Math.cos(a); wi[k] = -Math.sin(a);
  }
  const ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
  for (let k = 0; k < n; k++) { ar[k] = re[k] * wr[k] - im[k] * wi[k]; ai[k] = re[k] * wi[k] + im[k] * wr[k]; }
  br[0] = wr[0]; bi[0] = -wi[0];
  for (let k = 1; k < n; k++) { br[k] = br[m - k] = wr[k]; bi[k] = bi[m - k] = -wi[k]; }
  fft(ar, ai); fft(br, bi);
  for (let k = 0; k < m; k++) { const r = ar[k] * br[k] - ai[k] * bi[k], i = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r; ai[k] = -i; }
  fft(ar, ai);
  for (let k = 0; k < n; k++) { const r = ar[k] / m, i = -ai[k] / m; re[k] = r * wr[k] - i * wi[k]; im[k] = r * wi[k] + i * wr[k]; }
}

// image_features: mean of each channel over the decoded picture (RGB bytes)
export function imageFeatures(rgb) {
  const n = rgb.length / 3, sum = [0, 0, 0];
  for (let i = 0; i < n; i++) { sum[0] += rgb[3 * i]; sum[1] += rgb[3 * i + 1]; sum[2] += rgb[3 * i + 2]; }
  const [red, green, blue] = sum.map(s => s / n);
  const brightness = 0.299 * red + 0.587 * green + 0.114 * blue;
  return { brightness: pyRound(brightness, 1), red: pyRound(red, 1), green: pyRound(green, 1), blue: pyRound(blue, 1) };
}

// audio_features on 16 kHz samples (read_wav output)
export function audioFeatures(signal) {
  const n = signal.length;
  let sq = 0;
  for (let i = 0; i < n; i++) sq += signal[i] * signal[i];
  const rms = n ? Math.sqrt(sq / n) : 0;
  const re = Float64Array.from(signal), im = new Float64Array(n);
  if (n) fftAny(re, im);
  const bins = n ? Math.floor(n / 2) + 1 : 1, len = n || 1;
  let total = 0, weighted = 0, peak = 0;
  const mag = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    mag[k] = n ? Math.fround(Math.hypot(re[k], im[k])) : 0;
    total += mag[k];
    weighted += (k * SAMPLE_RATE / len) * mag[k];
    if (mag[k] > mag[peak]) peak = k;
  }
  return {
    loudness_db: rms > 1e-9 ? pyRound(20 * Math.log10(rms), 1) : -120.0,
    loudness_rms: pyRound(rms, 5),
    peak_frequency_hz: pyRound(peak * SAMPLE_RATE / len, 1),
    spectral_centroid_hz: pyRound(total > 0 ? weighted / total : 0, 1),
  };
}

function orthonormalize(V, d, k) {
  for (let j = 0; j < k; j++) {
    const vj = V.subarray(j * d, (j + 1) * d);
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < j; i++) {
      const vi = V.subarray(i * d, (i + 1) * d);
      let dot = 0; for (let t = 0; t < d; t++) dot += vi[t] * vj[t];
      for (let t = 0; t < d; t++) vj[t] -= dot * vi[t];
    }
    let norm = 0; for (let t = 0; t < d; t++) norm += vj[t] * vj[t];
    norm = Math.sqrt(norm) || 1;
    for (let t = 0; t < d; t++) vj[t] /= norm;
  }
}

function jacobiSmall(A, k) {
  const V = new Float64Array(k * k);
  for (let i = 0; i < k; i++) V[i * k + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) off += A[p * k + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) {
      const apq = A[p * k + q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (A[q * k + q] - A[p * k + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let r = 0; r < k; r++) {
        const arp = A[r * k + p], arq = A[r * k + q];
        A[r * k + p] = c * arp - s * arq; A[r * k + q] = s * arp + c * arq;
      }
      for (let r = 0; r < k; r++) {
        const apr = A[p * k + r], aqr = A[q * k + r];
        A[p * k + r] = c * apr - s * aqr; A[q * k + r] = s * apr + c * aqr;
      }
      for (let r = 0; r < k; r++) {
        const vrp = V[r * k + p], vrq = V[r * k + q];
        V[r * k + p] = c * vrp - s * vrq; V[r * k + q] = s * vrp + c * vrq;
      }
    }
  }
  return { values: Array.from({ length: k }, (_, i) => A[i * k + i]), V };
}

// pca_two(vectors): scores on the first two principal components (fewer than
// three rows give zeros, as the desktop does). The sign of each component is
// arbitrary (LAPACK picks one on the desktop); here the largest score is
// made positive.
export function pcaTwo(x, n, d) {
  const out = new Float32Array(n * 2);
  if (n < 3) return out;
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) for (let t = 0; t < d; t++) mean[t] += x[i * d + t];
  for (let t = 0; t < d; t++) mean[t] /= n;
  const xc = new Float64Array(n * d);
  for (let i = 0; i < n; i++) for (let t = 0; t < d; t++) xc[i * d + t] = x[i * d + t] - mean[t];
  const k = Math.min(8, n, d);
  const V = new Float64Array(k * d);
  let seed = 12345;
  for (let i = 0; i < V.length; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; V[i] = seed / 2 ** 32 - 0.5; }
  orthonormalize(V, d, k);
  const XV = new Float64Array(n * k);
  let prev = [Infinity, Infinity], ritz = null;
  for (let iter = 0; iter < 2000; iter++) {
    // XV = Xc V^T, then V = (Xc^T XV)^T
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) { let s = 0; for (let t = 0; t < d; t++) s += xc[i * d + t] * V[j * d + t]; XV[i * k + j] = s; }
    V.fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) { const a = XV[i * k + j]; if (a) for (let t = 0; t < d; t++) V[j * d + t] += a * xc[i * d + t]; }
    orthonormalize(V, d, k);
    // Rayleigh-Ritz in the subspace
    for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) { let s = 0; for (let t = 0; t < d; t++) s += xc[i * d + t] * V[j * d + t]; XV[i * k + j] = s; }
    const A = new Float64Array(k * k);
    for (let p = 0; p < k; p++) for (let q = 0; q < k; q++) { let s = 0; for (let i = 0; i < n; i++) s += XV[i * k + p] * XV[i * k + q]; A[p * k + q] = s; }
    ritz = jacobiSmall(A, k);
    const order = ritz.values.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    const R = new Float64Array(k * d);
    order.forEach(([, idx], j) => { for (let q = 0; q < k; q++) { const c = ritz.V[q * k + idx]; if (c) for (let t = 0; t < d; t++) R[j * d + t] += c * V[q * d + t]; } });
    V.set(R);
    const top = [order[0][0], order[1][0]];
    if (Math.abs(top[0] - prev[0]) <= 1e-13 * top[0] && Math.abs(top[1] - prev[1]) <= 1e-13 * Math.max(top[0], 1e-300)) break;
    prev = top;
  }
  for (let c = 0; c < 2; c++) {
    let big = 0;
    for (let i = 0; i < n; i++) {
      let s = 0; for (let t = 0; t < d; t++) s += xc[i * d + t] * V[c * d + t];
      out[i * 2 + c] = s;
      if (Math.abs(s) > Math.abs(big)) big = s;
    }
    if (big < 0) for (let i = 0; i < n; i++) out[i * 2 + c] = -out[i * 2 + c];
  }
  return out;
}
