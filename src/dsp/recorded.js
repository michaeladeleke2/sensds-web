// compute_recorded and smooth_range_bins from SensDSv2
// core/doppler_spectrogram_live.py: the offline spectrogram of a finished
// capture, which the Collect tab saves and draws (core/reference_image.py
// reference_spectrogram).
//
// Python keeps every frame's full RDM in memory; here each frame's RDM is
// computed twice instead (once to pick the range bin, once to take the chosen
// row), which gives the same values without holding ~2 MB per frame.

import { RdmComputer, selectRangeBinRaw, roundHalfEven, SMOOTH_WINDOW } from './doppler_live.js';

// scipy.ndimage.median_filter(x, size), default mode='reflect'
// (d c b a | a b c d | d c b a), 1-D.
export function medianFilter1d(x, size) {
  const n = x.length, h = Math.floor(size / 2), out = new Float64Array(n);
  const win = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    for (let j = -h; j < size - h; j++) {
      let k = i + j;
      while (k < 0 || k >= n) k = k < 0 ? -k - 1 : 2 * n - k - 1;
      win[j + h] = x[k];
    }
    const s = Array.from(win).sort((a, b) => a - b);
    out[i] = size % 2 ? s[h] : (s[size / 2 - 1] + s[size / 2]) / 2;
  }
  return out;
}

// smooth_range_bins(raw_bins, n_range_bins, window)
export function smoothRangeBins(rawBins, nRangeBins, window = SMOOTH_WINDOW) {
  const w = Math.max(1, window | 1);
  const smoothed = medianFilter1d(Float64Array.from(rawBins), w);
  return Int32Array.from(smoothed, v => Math.min(nRangeBins - 1, Math.max(0, roundHalfEven(v))));
}

// frames: array of antenna-0 frames, each (nChirp x nSample) row major.
// Returns { spectrogram: Float64Array (nFrame x dopplerBins), rangeBins, dopplerBins }.
export function computeRecorded(frames, nChirp, nSample) {
  const rdm = new RdmComputer(nSample, nChirp);
  const D = rdm.dopplerFftSize, R = rdm.nRangeBins;
  const raw = frames.map(f => selectRangeBinRaw(rdm.compute(f), R, D));
  const rangeBins = smoothRangeBins(raw, R, SMOOTH_WINDOW);
  const spectrogram = new Float64Array(frames.length * D);
  frames.forEach((f, i) => {
    const db = rdm.compute(f);
    spectrogram.set(db.subarray(rangeBins[i] * D, (rangeBins[i] + 1) * D), i * D);
  });
  return { spectrogram, rangeBins, dopplerBins: D };
}
