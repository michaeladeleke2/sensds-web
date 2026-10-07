// The OpenCV resizes SensAV relies on, ported from imgproc/src/resize.cpp:
//   - INTER_AREA downscaling of 8-bit 3-channel images (square_sample: the
//     centre square of a camera frame shrunk to 224x224), with OpenCV's
//     area-weight tables, float accumulation and round-half-even at the end;
//   - INTER_LINEAR of a one-channel float image (the clip spectrogram stretched
//     to 224x224), with OpenCV's pixel-centre mapping and edge clamping.

const f32 = Math.fround;
export const SAMPLE_SIZE = 224;

// cvRound / saturate_cast<uchar>(float): round half to even, clamp to 0..255
function toU8(v) {
  let r = Math.round(v);
  if (r - v === 0.5 && r % 2 !== 0) r -= 1;
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

// computeResizeAreaTab: [{ d, s, alpha }]
function areaTab(ssize, dsize, scale) {
  const tab = [];
  for (let dx = 0; dx < dsize; dx++) {
    const fsx1 = dx * scale, fsx2 = fsx1 + scale;
    const cellWidth = Math.min(scale, ssize - fsx1);
    let sx1 = Math.ceil(fsx1), sx2 = Math.floor(fsx2);
    sx2 = Math.min(sx2, ssize - 1);
    sx1 = Math.min(sx1, sx2);
    if (sx1 - fsx1 > 1e-3) tab.push({ d: dx, s: sx1 - 1, alpha: f32((sx1 - fsx1) / cellWidth) });
    for (let sx = sx1; sx < sx2; sx++) tab.push({ d: dx, s: sx, alpha: f32(1.0 / cellWidth) });
    if (fsx2 - sx2 > 1e-3) tab.push({ d: dx, s: sx2, alpha: f32(Math.min(Math.min(fsx2 - sx2, 1.0), cellWidth) / cellWidth) });
  }
  return tab;
}

// cv2.resize(src, (dw, dh), interpolation=cv2.INTER_AREA) for a downscale.
// src: Uint8Array (sh x sw x cn), row stride `stride` elements (default sw*cn),
// starting at `offset`.
export function resizeAreaU8(src, sw, sh, dw, dh, cn = 3, { offset = 0, stride = sw * cn } = {}) {
  const scaleX = 1 / (dw / sw), scaleY = 1 / (dh / sh);
  if (scaleX < 1 || scaleY < 1) throw new Error('INTER_AREA is only ported for shrinking');
  const xtab = areaTab(sw, dw, scaleX), ytab = areaTab(sh, dh, scaleY);
  const W = dw * cn, out = new Uint8Array(dh * W);
  const buf = new Float32Array(W), sum = new Float32Array(W);
  let prevDy = ytab[0].d;
  for (const { d: dy, s: sy, alpha: beta } of ytab) {
    buf.fill(0);
    const row = offset + sy * stride;
    for (const { d, s, alpha } of xtab) {
      const di = d * cn, si = row + s * cn;
      for (let c = 0; c < cn; c++) buf[di + c] = f32(buf[di + c] + f32(src[si + c] * alpha));
    }
    if (dy !== prevDy) {
      const o = prevDy * W;
      for (let x = 0; x < W; x++) { out[o + x] = toU8(sum[x]); sum[x] = f32(beta * buf[x]); }
      prevDy = dy;
    } else {
      for (let x = 0; x < W; x++) sum[x] = f32(sum[x] + f32(beta * buf[x]));
    }
  }
  const o = prevDy * W;
  for (let x = 0; x < W; x++) out[o + x] = toU8(sum[x]);
  return out;
}

// square_sample: the centre square of an RGB (or BGR) frame, INTER_AREA to 224
export function squareSample(rgb, width, height, size = SAMPLE_SIZE) {
  const side = Math.min(width, height);
  const top = Math.floor((height - side) / 2), left = Math.floor((width - side) / 2);
  return resizeAreaU8(rgb, side, side, size, size, 3, { offset: (top * width + left) * 3, stride: width * 3 });
}

// square_sample on RGBA pixels (canvas ImageData): RGB 224x224
export function squareSampleRgbaToRgb(rgba, width, height, size = SAMPLE_SIZE) {
  const side = Math.min(width, height);
  const top = Math.floor((height - side) / 2), left = Math.floor((width - side) / 2);
  const out = resizeAreaU8(rgba, side, side, size, size, 4, { offset: (top * width + left) * 4, stride: width * 4 });
  return rgbaToRgb(out);
}

// RGBA (canvas ImageData) -> RGB
export function rgbaToRgb(rgba) {
  const n = rgba.length / 4, out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { out[3 * i] = rgba[4 * i]; out[3 * i + 1] = rgba[4 * i + 1]; out[3 * i + 2] = rgba[4 * i + 2]; }
  return out;
}

function linearCoeffs(ssize, dsize) {
  const scale = 1 / (dsize / ssize);
  const idx = new Int32Array(dsize), a = new Float32Array(dsize);
  for (let d = 0; d < dsize; d++) {
    let fx = f32((d + 0.5) * scale - 0.5);
    let sx = Math.floor(fx);
    fx = f32(fx - sx);
    if (sx < 0) { fx = 0; sx = 0; }
    if (sx >= ssize - 1) { fx = 0; sx = ssize - 1; }
    idx[d] = sx; a[d] = fx;
  }
  return { idx, a };
}

// cv2.resize(src, (dw, dh), interpolation=cv2.INTER_LINEAR), one float channel
export function resizeLinearF32(src, sw, sh, dw, dh) {
  const X = linearCoeffs(sw, dw), Y = linearCoeffs(sh, dh);
  const rows = new Map();
  const hrow = sy => {
    let r = rows.get(sy);
    if (r) return r;
    r = new Float32Array(dw);
    const o = sy * sw;
    for (let d = 0; d < dw; d++) {
      const sx = X.idx[d], fx = X.a[d];
      const s1 = sx + 1 < sw ? sx + 1 : sx;
      r[d] = f32(f32(src[o + sx] * f32(1 - fx)) + f32(src[o + s1] * fx));
    }
    rows.set(sy, r);
    return r;
  };
  const out = new Float32Array(dw * dh);
  for (let d = 0; d < dh; d++) {
    const sy = Y.idx[d], fy = Y.a[d];
    const r0 = hrow(sy), r1 = hrow(sy + 1 < sh ? sy + 1 : sy);
    const b0 = f32(1 - fy), b1 = fy;
    for (let x = 0; x < dw; x++) out[d * dw + x] = f32(f32(r0[x] * b0) + f32(r1[x] * b1));
  }
  return out;
}
