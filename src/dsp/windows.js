// Window functions, ported from scipy 1.17 (scipy/signal/windows/_windows.py),
// symmetric (sym=True) forms, as the reference script calls them.

import { fft } from './fft.js';

// numpy.linspace(start, stop, num): i * step + start, last element forced to stop.
function linspace(start, stop, num) {
  const out = new Float64Array(num);
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) out[i] = i * step + start;
  if (num > 1) out[num - 1] = stop;
  return out;
}

// scipy.signal.windows.blackmanharris(M) = general_cosine(M, [0.35875, 0.48829, 0.14128, 0.01168])
export function blackmanharris(M) {
  if (M <= 1) return new Float64Array(M).fill(1);
  const a = [0.35875, 0.48829, 0.14128, 0.01168];
  const fac = linspace(-Math.PI, Math.PI, M);
  const w = new Float64Array(M);
  for (let k = 0; k < a.length; k++)
    for (let i = 0; i < M; i++) w[i] += a[k] * Math.cos(k * fac[i]);
  return w;
}

// scipy.signal.windows.chebwin(M, at)
export function chebwin(M, at) {
  if (M <= 1) return new Float64Array(M).fill(1);
  const order = M - 1.0;
  const beta = Math.cosh(1.0 / order * Math.acosh(10 ** (Math.abs(at) / 20.0)));
  const p = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    const x = beta * Math.cos(Math.PI * k / M);
    if (x > 1) p[k] = Math.cosh(order * Math.acosh(x));
    else if (x < -1) p[k] = (2 * (M % 2) - 1) * Math.cosh(order * Math.acosh(-x));
    else p[k] = Math.cos(order * Math.acos(x));
  }
  const re = new Float64Array(M), im = new Float64Array(M);
  let w;
  if (M % 2) {
    re.set(p);
    fft(re, im);
    const n = (M + 1) / 2;
    const half = re.slice(0, n);
    w = new Float64Array(2 * n - 1);
    for (let i = 1; i < n; i++) w[n - 1 - i] = half[i];   // flip(w[1:n])
    w.set(half, n - 1);
  } else {
    // p * exp(1j * pi / M * k)
    for (let k = 0; k < M; k++) {
      const a = Math.PI / M * k;
      re[k] = p[k] * Math.cos(a);
      im[k] = p[k] * Math.sin(a);
    }
    fft(re, im);
    const n = M / 2 + 1;
    w = new Float64Array(M);
    for (let i = 1; i < n; i++) { w[n - 1 - i] = re[i]; w[n - 2 + i] = re[i]; }
  }
  let max = -Infinity;
  for (const v of w) if (v > max) max = v;
  for (let i = 0; i < w.length; i++) w[i] /= max;
  return w;
}
