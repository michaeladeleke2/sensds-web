// Port of the DSP in SensDSv2 core/doppler_spectrogram_live.py (the reference
// script that draws the desktop Visualize tab): compute_rdm_db,
// select_range_bin_raw and LiveDopplerProcessor.
//
// Agreement with the Python reference is to floating point rounding (the FFTs
// sum in a different order than numpy's pocketfft), checked in tests/viz.test.js.

import { fft, pairwiseSum } from './fft.js';
import { blackmanharris, chebwin } from './windows.js';

export const CLIPPING_VALUE = 1e-6;
export const SPECT_THRESHOLD = 1e-6;
export const SMOOTH_WINDOW = 5;
export const CLIP_DB = 20.0 * Math.log10(CLIPPING_VALUE);   // -120 dB

// _range_doppler_windows
export function rangeDopplerWindows(nSample, nChirp) {
  const rangeWindow = blackmanharris(nSample);
  const dopplerWindow = chebwin(nChirp, 100.0);
  const s = pairwiseSum(dopplerWindow, 0, dopplerWindow.length);   // np.sum
  for (let i = 0; i < dopplerWindow.length; i++) dopplerWindow[i] /= s;
  return { rangeWindow, dopplerWindow };
}

// compute_rdm_db: one frame (nChirp x nSample, row major) to an RDM in dB,
// returned as a Float64Array laid out (nRangeBins x dopplerFftSize), row major.
export class RdmComputer {
  constructor(nSample, nChirp, rangeFftSize = nSample * 4, dopplerFftSize = nChirp * 4) {
    Object.assign(this, { nSample, nChirp, rangeFftSize, dopplerFftSize });
    this.nRangeBins = rangeFftSize / 2;
    Object.assign(this, rangeDopplerWindows(nSample, nChirp));
    this.rRe = new Float64Array(rangeFftSize);
    this.rIm = new Float64Array(rangeFftSize);
    this.dRe = new Float64Array(dopplerFftSize);
    this.dIm = new Float64Array(dopplerFftSize);
    this.row = new Float64Array(nSample);
    // rdm_complex, (nRangeBins x nChirp)
    this.cRe = new Float64Array(this.nRangeBins * nChirp);
    this.cIm = new Float64Array(this.nRangeBins * nChirp);
    this.rdmDb = new Float64Array(this.nRangeBins * dopplerFftSize);
  }

  compute(frame) {
    const { nSample, nChirp, rangeFftSize, dopplerFftSize, nRangeBins, rangeWindow, dopplerWindow } = this;
    const { rRe, rIm, dRe, dIm, row, cRe, cIm, rdmDb } = this;

    // Range FFT across chirps: subtract each chirp's mean, window, zero pad.
    for (let c = 0; c < nChirp; c++) {
      const base = c * nSample;
      for (let s = 0; s < nSample; s++) row[s] = frame[base + s];
      const mean = pairwiseSum(row, 0, nSample) / nSample;
      rRe.fill(0); rIm.fill(0);
      for (let s = 0; s < nSample; s++) rRe[s] = (row[s] - mean) * rangeWindow[s];
      fft(rRe, rIm);
      for (let r = 0; r < nRangeBins; r++) { cRe[r * nChirp + c] = rRe[r]; cIm[r * nChirp + c] = rIm[r]; }
    }

    // Doppler FFT across slow time: subtract the mean, window, zero pad, fftshift.
    const half = dopplerFftSize / 2;
    const thr = SPECT_THRESHOLD ** 2;
    for (let r = 0; r < nRangeBins; r++) {
      const base = r * nChirp;
      let mr = 0, mi = 0;
      for (let c = 0; c < nChirp; c++) { mr += cRe[base + c]; mi += cIm[base + c]; }
      mr /= nChirp; mi /= nChirp;
      dRe.fill(0); dIm.fill(0);
      for (let c = 0; c < nChirp; c++) {
        dRe[c] = (cRe[base + c] - mr) * dopplerWindow[c];
        dIm[c] = (cIm[base + c] - mi) * dopplerWindow[c];
      }
      fft(dRe, dIm);
      const out = r * dopplerFftSize;
      for (let k = 0; k < dopplerFftSize; k++) {
        const src = (k + half) % dopplerFftSize;           // np.fft.fftshift
        const mag = Math.hypot(dRe[src], dIm[src]);        // np.abs
        const power = mag ** 2;
        rdmDb[out + k] = power >= thr ? 10.0 * Math.log10(power) : CLIP_DB;
      }
    }
    return rdmDb;
  }
}

// select_range_bin_raw: argmax over range of the dB sum over Doppler (first max wins).
export function selectRangeBinRaw(rdmDb, nRangeBins, dopplerFftSize) {
  let best = -Infinity, bestIdx = 0;
  for (let r = 0; r < nRangeBins; r++) {
    const s = pairwiseSum(rdmDb, r * dopplerFftSize, dopplerFftSize);
    if (s > best) { best = s; bestIdx = r; }
  }
  return bestIdx;
}

// numpy.round: round half to even.
export function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Last element of scipy.ndimage.median_filter(buf, size=w), default
// mode='reflect' (d c b a | a b c d | d c b a). For the last sample the window
// runs past the end and is filled by reflection.
export function medianFilterLast(buf, w) {
  const n = buf.length, h = w >> 1, idx = n - 1;
  const win = [];
  for (let j = idx - h; j <= idx + h; j++) {
    let k = j;
    while (k < 0 || k >= n) k = k < 0 ? -k - 1 : 2 * n - k - 1;
    win.push(buf[k]);
  }
  return median(win);
}

// LiveDopplerProcessor: frame-by-frame RDM plus a rolling spectrogram with a
// median-smoothed range bin.
export class LiveDopplerProcessor {
  constructor({ nSample, nChirp, historyLength = 100, smoothWindow = SMOOTH_WINDOW }) {
    this.nSample = nSample;
    this.nChirp = nChirp;
    this.historyLength = historyLength;
    this.smoothWindow = smoothWindow;
    this.rdm = new RdmComputer(nSample, nChirp);
    this.dopplerFftSize = this.rdm.dopplerFftSize;
    this.nRangeBins = this.rdm.nRangeBins;
    // history (historyLength x dopplerFftSize), oldest row first
    this.history = new Float64Array(historyLength * this.dopplerFftSize).fill(CLIP_DB);
    this.rawBinBuf = [];
    this.maxBins = Math.max(1, smoothWindow | 1);
    this.lastRangeBin = null;
  }

  // frame: (nChirp x nSample) row major, antenna already selected.
  processFrame(frame) {
    if (frame.length !== this.nChirp * this.nSample)
      throw new Error(`Expected (${this.nChirp}, ${this.nSample}), got ${frame.length} samples`);
    const rdmDb = this.rdm.compute(frame);
    const rawBin = selectRangeBinRaw(rdmDb, this.nRangeBins, this.dopplerFftSize);
    this.rawBinBuf.push(rawBin);
    if (this.rawBinBuf.length > this.maxBins) this.rawBinBuf.shift();   // deque(maxlen)

    const w = this.maxBins;
    const clip = v => Math.min(this.nRangeBins - 1, Math.max(0, v));
    const rangeBin = this.rawBinBuf.length >= w
      ? clip(roundHalfEven(medianFilterLast(this.rawBinBuf, w)))
      : clip(roundHalfEven(median(this.rawBinBuf)));
    this.lastRangeBin = rangeBin;

    // Oldest left, newest right.
    const D = this.dopplerFftSize;
    this.history.copyWithin(0, D);
    this.history.set(rdmDb.subarray(rangeBin * D, (rangeBin + 1) * D), (this.historyLength - 1) * D);
    return { history: this.history.slice(), rangeBin };
  }
}
