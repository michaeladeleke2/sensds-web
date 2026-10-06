// Pillow's Image.resize(size, Image.BILINEAR) for 8-bit RGB images, ported
// from Pillow's libImaging/Resample.c: separable triangle filter whose support
// widens when downsampling, coefficients in 22-bit fixed point, horizontal pass
// first (into an 8-bit intermediate), then vertical.

const PRECISION_BITS = 32 - 8 - 2;
const bilinear = x => { x = Math.abs(x); return x < 1 ? 1 - x : 0; };
const SUPPORT = 1.0;

function precomputeCoeffs(inSize, in0, in1, outSize) {
  const scale = (in1 - in0) / outSize;
  const filterscale = Math.max(1, scale);
  const support = SUPPORT * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Int32Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  const k = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = in0 + (xx + 0.5) * scale;
    const ss = 1.0 / filterscale;
    let xmin = Math.trunc(center - support + 0.5); if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5); if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) { const w = bilinear((x + xmin - center + 0.5) * ss); k[x] = w; ww += w; }
    for (let x = 0; x < xmax; x++) if (ww !== 0) k[x] /= ww;
    for (let x = 0; x < ksize; x++) {
      const v = x < xmax ? k[x] : 0;
      // normalize_coeffs_8bpc
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin; bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, kk, bounds };
}

function clip8(v) {
  if (v >= (1 << PRECISION_BITS) * 256) return 255;
  if (v <= 0) return 0;
  return Math.floor(v / (1 << PRECISION_BITS));
}

// rgb: Uint8Array (h x w x 3). Returns Uint8Array (outH x outW x 3).
export function resizeBilinear(rgb, w, h, outW, outH) {
  const horiz = precomputeCoeffs(w, 0, w, outW);
  const vert = precomputeCoeffs(h, 0, h, outH);
  const needH = outW !== w, needV = outH !== h;
  const half = 1 << (PRECISION_BITS - 1);

  let src = rgb, srcW = w, srcH = h;
  let yFirst = 0;
  if (needH) {
    yFirst = vert.bounds[0];
    const yLast = vert.bounds[outH * 2 - 2] + vert.bounds[outH * 2 - 1];
    const rows = yLast - yFirst;
    const tmp = new Uint8Array(rows * outW * 3);
    for (let y = 0; y < rows; y++) {
      for (let xx = 0; xx < outW; xx++) {
        const xmin = horiz.bounds[xx * 2], xmax = horiz.bounds[xx * 2 + 1], kb = xx * horiz.ksize;
        for (let c = 0; c < 3; c++) {
          let ss = half;
          for (let x = 0; x < xmax; x++) ss += src[((y + yFirst) * srcW + x + xmin) * 3 + c] * horiz.kk[kb + x];
          tmp[(y * outW + xx) * 3 + c] = clip8(ss);
        }
      }
    }
    src = tmp; srcW = outW; srcH = rows;
  }
  if (!needV) return src;
  const out = new Uint8Array(outH * outW * 3);
  for (let yy = 0; yy < outH; yy++) {
    const ymin = vert.bounds[yy * 2] - (needH ? yFirst : 0), ymax = vert.bounds[yy * 2 + 1], kb = yy * vert.ksize;
    for (let x = 0; x < srcW; x++) {
      for (let c = 0; c < 3; c++) {
        let ss = half;
        for (let y = 0; y < ymax; y++) ss += src[((y + ymin) * srcW + x) * 3 + c] * vert.kk[kb + y];
        out[(yy * outW + x) * 3 + c] = clip8(ss);
      }
    }
  }
  void srcH;
  return out;
}
