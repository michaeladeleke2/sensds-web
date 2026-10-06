// compute_recorded and smooth_range_bins from SensDSv2
// core/doppler_spectrogram_live.py: the offline spectrogram of a finished
// capture, which the Collect tab saves and draws (core/reference_image.py
// reference_spectrogram).
//
// Python keeps every frame's full RDM in memory. Here each RDM is computed
// once and only the rows that can be chosen are kept: the smoothed range bin
// is the median of the raw bins in a 5-frame window (scipy's reflect mode), so
// it is always one of those raw bins, and a frame's row is taken once the
// frames two ahead are known. Same values, a few rows per frame of memory.

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
  const D = rdm.dopplerFftSize, R = rdm.nRangeBins, n = frames.length;
  const w = Math.max(1, SMOOTH_WINDOW | 1), h = Math.floor(w / 2);
  const raw = new Int32Array(n);
  const kept = new Array(n);                      // frame -> Map(bin -> row)
  const recent = new Map();                       // frame -> copy of its RDM, the last h + 1 frames
  const reflect = k => { while (k < 0 || k >= n) k = k < 0 ? -k - 1 : 2 * n - k - 1; return k; };
  const keepRows = k => {
    const db = recent.get(k), rows = new Map();
    for (let j = k - h; j <= k + h; j++) {
      const b = raw[reflect(j)];
      if (!rows.has(b)) rows.set(b, db.slice(b * D, (b + 1) * D));
    }
    kept[k] = rows;
    recent.delete(k);
  };
  for (let i = 0; i < n; i++) {
    const db = rdm.compute(frames[i]);
    raw[i] = selectRangeBinRaw(db, R, D);
    recent.set(i, db.slice());
    if (i - h >= 0) keepRows(i - h);
  }
  for (let k = Math.max(0, n - h); k < n; k++) keepRows(k);

  const rangeBins = smoothRangeBins(raw, R, SMOOTH_WINDOW);
  const spectrogram = new Float64Array(n * D);
  for (let i = 0; i < n; i++) {
    let row = kept[i].get(rangeBins[i]);
    if (!row) { const db = rdm.compute(frames[i]); row = db.subarray(rangeBins[i] * D, (rangeBins[i] + 1) * D); }   // not expected
    spectrogram.set(row, i * D);
  }
  return { spectrogram, rangeBins, dopplerBins: D };
}
