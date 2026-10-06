// The saved training image, as SensDSv2 core/reference_image.py makes it:
//   reference_rgb:  plot_data = spectrogram.T, color limits from _jet_clim,
//                   Normalize(clip=True), jet with bytes=True, row 0 on top
//   training_image: PIL Image.fromarray(rgb).resize((400, 300), BILINEAR)

import { JET_LUT_BYTES, lutIndex } from '../viz/jet.js';
import { jetClim } from '../viz/image.js';
import { resizeBilinear } from '../io/resize.js';

export const TRAINING_SIZE = [400, 300];

// spectrogram: Float64Array (nFrame x bins). Returns RGB bytes (bins x nFrame x 3).
export function referenceRgb(spectrogram, nFrame, bins, jetVmin) {
  const plot = new Float64Array(bins * nFrame);
  for (let f = 0; f < nFrame; f++)
    for (let b = 0; b < bins; b++) plot[b * nFrame + f] = spectrogram[f * bins + b];
  const { vmin, vmax } = jetClim(plot, jetVmin);
  const rgb = new Uint8Array(bins * nFrame * 3);
  for (let i = 0; i < plot.length; i++) {
    let v;
    if (vmin === vmax) v = 0;
    else v = (Math.min(vmax, Math.max(vmin, plot[i])) - vmin) / (vmax - vmin);
    const k = lutIndex(v) * 3;
    rgb[i * 3] = JET_LUT_BYTES[k]; rgb[i * 3 + 1] = JET_LUT_BYTES[k + 1]; rgb[i * 3 + 2] = JET_LUT_BYTES[k + 2];
  }
  return rgb;
}

export function trainingImage(spectrogram, nFrame, bins, jetVmin) {
  const rgb = referenceRgb(spectrogram, nFrame, bins, jetVmin);
  const [w, h] = TRAINING_SIZE;
  return { rgb: resizeBilinear(rgb, nFrame, bins, w, h), width: w, height: h };
}
