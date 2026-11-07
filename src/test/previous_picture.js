// The spectrogram as SensDS drew it before the change note of 2026-10-19, for
// the starter model: its training pictures were drawn that way, and a model
// does best on pictures like the ones it learned from.
//
// What the change note changed, and how this undoes it for the model only:
//   range bin     back to the previous rule (the bin with the largest dB sum
//                 over Doppler, from bin 0), then the same 5-frame median.
//   colour scale  back to a floor of -20 dB, or 40 dB below the loudest cell
//                 when nothing reaches it (Reduce noise off).
//   chirp         the radar now sends a chirp every 0.3 ms instead of 0.2 ms,
//                 so the same 512 Doppler bins cover 1/1.5 of the speeds they
//                 used to. That is set on the radar and is not changed here;
//                 instead each column is stretched back onto the previous
//                 speed range: previous bin k shows speed (k - 256) x 1.5 of a
//                 current bin, read from the current bins by linear
//                 interpolation. Speeds the current chirp cannot see (above
//                 4.1 m/s, the outer sixth at each end) are filled with that
//                 column's median, its background level.
// Nothing else in the app changes: Visualize, Collect, Analysis and a
// student's own models keep the current drawing.

import { SENSDS_CONFIG } from '../config.js';
import { computeRecorded } from '../dsp/recorded.js';
import { selectRangeBinRawPrevious } from '../dsp/doppler_live.js';
import { jetClimPrevious } from '../viz/image.js';
import { trainingImage } from '../collect/training_image.js';

export const PREVIOUS_CHIRP_S = 0.0002;
export const PREVIOUS_JET_VMIN = -20.0;

// How many times more speed a Doppler bin covered with the previous chirp
export const speedRatio = (chirpS = SENSDS_CONFIG.chirp_repetition_time_s) => Math.round(chirpS / PREVIOUS_CHIRP_S * 1e9) / 1e9;

function median(a) {
  const s = Float64Array.from(a).sort(), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// spectrogram (nFrame x D, zero speed at bin D/2) onto the previous speed range
export function toPreviousSpeedRange(spectrogram, nFrame, D, ratio = speedRatio()) {
  if (ratio === 1) return Float64Array.from(spectrogram);
  const out = new Float64Array(nFrame * D), half = D / 2;
  for (let f = 0; f < nFrame; f++) {
    const row = spectrogram.subarray(f * D, (f + 1) * D);
    const fill = median(row);
    for (let k = 0; k < D; k++) {
      const x = half + (k - half) * ratio;
      let v;
      if (x < 0 || x > D - 1) v = fill;
      else { const i = Math.floor(x), t = x - i; v = t === 0 ? row[i] : row[i] * (1 - t) + row[i + 1] * t; }
      out[f * D + k] = v;
    }
  }
  return out;
}

// The model's picture from antenna-0 frames, as framesToImage makes it but
// drawn the previous way
export function previousImage(epoch, nChirp, nSample, ratio = speedRatio()) {
  const { spectrogram, dopplerBins } = computeRecorded(epoch, nChirp, nSample, selectRangeBinRawPrevious);
  const spec = toPreviousSpeedRange(spectrogram, epoch.length, dopplerBins, ratio);
  return trainingImage(spec, epoch.length, dopplerBins, PREVIOUS_JET_VMIN, jetClimPrevious);
}
