// IEEE half precision <-> float32, for the float16 embeddings SensAV caches
// (embeddings.npz). toHalf rounds to nearest even, as numpy's astype(float16).

const f32buf = new Float32Array(1), u32buf = new Uint32Array(f32buf.buffer);

export function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1F, m = h & 0x3FF;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export function floatToHalf(v) {
  f32buf[0] = v;
  const x = u32buf[0], sign = (x >>> 16) & 0x8000;
  let e = (x >>> 23) & 0xFF, m = x & 0x7FFFFF;
  if (e === 0xFF) return sign | 0x7C00 | (m ? 0x200 : 0);
  e = e - 127 + 15;
  if (e >= 31) return sign | 0x7C00;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const shift = 14 - e;
    let half = m >>> shift;
    const rem = m & ((1 << shift) - 1), mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = (e << 10) | (m >>> 13);
  const rem = m & 0x1FFF;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;
  return sign | half;
}

export const halfArrayToFloat = a => Float32Array.from(a, halfToFloat);
export const floatArrayToHalf = a => Uint16Array.from(a, floatToHalf);
