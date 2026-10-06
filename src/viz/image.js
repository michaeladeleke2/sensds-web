// The image step of matplotlib's imshow as LiveSpectrogramPlot uses it:
// Normalize(vmin, vmax, clip=True), the jet colormap, and AxesImage._make_image
// resampling onto the screen pixels (matplotlib 3.10, rcParams defaults
// image.interpolation = 'auto', image.interpolation_stage = 'auto',
// image.resample = True).
//
// matplotlib resamples with Agg in fixed point; this does the same filter in
// floating point, so a few pixels can differ by a byte or two. Measured
// against a real matplotlib render in tests/viz.test.js.

import { JET_LUT, JET_LUT_BYTES, lutIndex } from './jet.js';

// _jet_clim
export function jetClim(data, jetVmin) {
  let vmax = -Infinity;
  for (let i = 0; i < data.length; i++) if (data[i] > vmax) vmax = data[i];   // nanmax (no NaNs here)
  const vmin = jetVmin < vmax ? jetVmin : vmax - 40.0;
  return { vmin, vmax };
}

function normalise(v, vmin, vmax) {
  if (vmin === vmax) return 0;
  const c = Math.min(vmax, Math.max(vmin, v));
  return (c - vmin) / (vmax - vmin);
}

// Agg's image_filter_hanning, radius 1
const hanning = x => 0.5 + 0.5 * Math.cos(Math.PI * x);

// Weights for one axis of span_image_resample: output pixel d (centre d + 0.5)
// maps to source position u = (d + 0.5) * nSrc / nOut. The filter is
// stretched by the scale when downsampling (scale = max(1, nSrc / nOut)).
function axisWeights(nSrc, nOut, kind) {
  const scale = Math.max(1, nSrc / nOut);
  const taps = [];
  for (let d = 0; d < nOut; d++) {
    const u = (d + 0.5) * nSrc / nOut;
    if (kind === 'nearest') { taps.push([[Math.min(nSrc - 1, Math.floor(u)), 1]]); continue; }
    const radius = scale;
    const lo = Math.floor(u - radius - 0.5), hi = Math.ceil(u + radius - 0.5);
    const list = [];
    let total = 0;
    for (let j = lo; j <= hi; j++) {
      const x = (j + 0.5 - u) / scale;
      if (Math.abs(x) >= 1) continue;
      const w = hanning(x);
      list.push([Math.min(nSrc - 1, Math.max(0, j)), w]);   // edge pixels repeat
      total += w;
    }
    for (const t of list) t[1] /= total;
    taps.push(list);
  }
  return taps;
}

// plotData: Float64Array (rows x cols), row 0 drawn at the top (origin='upper').
// Returns { rgba: Uint8ClampedArray(outW * outH * 4), outW, outH, stage, interpolation }.
export function makeImage(plotData, rows, cols, outWBase, outHBase, vmin, vmax) {
  // round_to_pixel_border: the output size is rounded up to whole pixels
  const outW = Math.ceil(outWBase), outH = Math.ceil(outHBase);

  const dispx = outW / cols, dispy = outH / rows;
  const stage = (dispx < 3 || dispy < 3) ? 'rgba' : 'data';
  // _resample: 'auto' interpolation picks nearest only when upsampling
  // by more than 3x (or exactly 1x / 2x) on both axes
  const okx = outW > 3 * cols || outW === cols || outW === 2 * cols;
  const oky = outH > 3 * rows || outH === rows || outH === 2 * rows;
  const interpolation = okx && oky ? 'nearest' : 'hanning';

  const wx = axisWeights(cols, outW, interpolation);
  const wy = axisWeights(rows, outH, interpolation);
  const rgba = new Uint8ClampedArray(outW * outH * 4);

  if (stage === 'rgba') {
    // Colormap first (float LUT), then resample the colours.
    const src = new Float64Array(rows * cols * 3);
    for (let i = 0; i < rows * cols; i++) {
      const k = lutIndex(normalise(plotData[i], vmin, vmax)) * 3;
      src[i * 3] = JET_LUT[k]; src[i * 3 + 1] = JET_LUT[k + 1]; src[i * 3 + 2] = JET_LUT[k + 2];
    }
    // Vertical pass: (outH x cols x 3)
    const mid = new Float64Array(outH * cols * 3);
    for (let y = 0; y < outH; y++) {
      for (const [r, w] of wy[y]) {
        const sb = r * cols * 3, mb = y * cols * 3;
        for (let i = 0; i < cols * 3; i++) mid[mb + i] += src[sb + i] * w;
      }
    }
    // Horizontal pass, then (x * 255).astype(uint8)
    for (let y = 0; y < outH; y++) {
      const mb = y * cols * 3;
      for (let x = 0; x < outW; x++) {
        let r = 0, g = 0, b = 0;
        for (const [c, w] of wx[x]) { const k = mb + c * 3; r += mid[k] * w; g += mid[k + 1] * w; b += mid[k + 2] * w; }
        const o = (y * outW + x) * 4;
        rgba[o] = Math.trunc(Math.min(1, Math.max(0, r)) * 255);
        rgba[o + 1] = Math.trunc(Math.min(1, Math.max(0, g)) * 255);
        rgba[o + 2] = Math.trunc(Math.min(1, Math.max(0, b)) * 255);
        rgba[o + 3] = 255;
      }
    }
  } else {
    // Resample the data, then normalise and colormap with the byte LUT.
    const mid = new Float64Array(outH * cols);
    for (let y = 0; y < outH; y++)
      for (const [r, w] of wy[y])
        for (let c = 0; c < cols; c++) mid[y * cols + c] += plotData[r * cols + c] * w;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        let v = 0;
        for (const [c, w] of wx[x]) v += mid[y * cols + c] * w;
        const k = lutIndex(normalise(v, vmin, vmax)) * 3;
        const o = (y * outW + x) * 4;
        rgba[o] = JET_LUT_BYTES[k]; rgba[o + 1] = JET_LUT_BYTES[k + 1]; rgba[o + 2] = JET_LUT_BYTES[k + 2]; rgba[o + 3] = 255;
      }
    }
  }
  return { rgba, outW, outH, stage, interpolation };
}

// LiveSpectrogramPlot.draw, frame_x orientation: plot_data = history.T
export function historyToPlotData(history, historyLength, dopplerBins) {
  const out = new Float64Array(dopplerBins * historyLength);
  for (let t = 0; t < historyLength; t++)
    for (let d = 0; d < dopplerBins; d++) out[d * historyLength + t] = history[t * dopplerBins + d];
  return out;
}
