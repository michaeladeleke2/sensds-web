// In-place complex FFT (forward, unnormalised, same sign convention as numpy.fft.fft).
// Iterative radix-2 for power-of-two lengths; a direct DFT for any other length
// (only used for short window construction).
// Results agree with numpy's pocketfft to floating point rounding, not bit for bit.

const plans = new Map();

function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  // Twiddles computed directly (no recurrence) for accuracy.
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos(2 * Math.PI * k / n);
    sin[k] = -Math.sin(2 * Math.PI * k / n);
  }
  p = { rev, cos, sin };
  plans.set(n, p);
  return p;
}

export const isPow2 = n => n > 0 && (n & (n - 1)) === 0;

export function fft(re, im) {
  const n = re.length;
  if (!isPow2(n)) return dft(re, im);
  const { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >>> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k, b = a + half;
        const wr = cos[t], wi = sin[t];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

function dft(re, im) {
  const n = re.length;
  const or = new Float64Array(n), oi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = -2 * Math.PI * ((k * t) % n) / n;
      const c = Math.cos(a), s = Math.sin(a);
      sr += re[t] * c - im[t] * s;
      si += re[t] * s + im[t] * c;
    }
    or[k] = sr; oi[k] = si;
  }
  re.set(or); im.set(oi);
}

// numpy's pairwise summation (numpy/_core/src/umath/loops_utils.h.src,
// PW_BLOCKSIZE 128), used where numpy reduces along a contiguous axis.
export function pairwiseSum(a, start, n, stride = 1) {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[start + i * stride];
    return res;
  }
  if (n <= 128) {
    const r = new Float64Array(8);
    for (let j = 0; j < 8; j++) r[j] = a[start + j * stride];
    let i = 8;
    for (; i < n - (n % 8); i += 8)
      for (let j = 0; j < 8; j++) r[j] += a[start + (i + j) * stride];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[start + i * stride];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, start, n2, stride) + pairwiseSum(a, start + n2 * stride, n - n2, stride);
}
