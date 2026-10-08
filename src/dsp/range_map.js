// The range map's processing, ported unchanged from range_map_v1.py and
// range_map_live.py's LiveRangeProcessor (kept in reference/python/):
//   range FFT: per chirp mean removal, Blackman-Harris window, 4x zero
//   padding, positive half kept;
//   raw: mean |range FFT| across chirps, 20 log10, floor 1e-6;
//   mti: slow-time mean removal per range bin, Chebyshev window (100 dB,
//   normalised to sum 1), 4x Doppler FFT, fftshift, linear power summed over
//   every Doppler bin except the centre (zero velocity), 10 log10, floor 1e-12;
//   range axis: bin k -> k * Fs / Nfft beat frequency -> range by the chirp slope.

import { fft } from './fft.js';
import { blackmanharris, chebwin } from './windows.js';
import { pairwiseSum } from './fft.js';

export const C_MPS = 299_792_458.0;
export const CLIPPING_VALUE = 1e-6;
export const SPECT_THRESHOLD = 1e-6;
export const START_FREQUENCY_HZ = 58.0e9;
export const END_FREQUENCY_HZ = 63.5e9;
export const SAMPLE_RATE_HZ = 2.0e6;
export const FRAME_REPETITION_TIME_S = 0.1;

// _windows(n_sample, n_chirp)
export function windows(nSample, nChirp) {
  const rangeWindow = blackmanharris(nSample);
  const dw = chebwin(nChirp, 100.0);
  const s = pairwiseSum(dw, 0, dw.length);
  return { rangeWindow, dopplerWindow: dw.map(v => v / s) };
}

// range_axis_m(...)
export function rangeAxisM(nRangeBins, rangeFftSize, { sampleRateHz = SAMPLE_RATE_HZ, startFrequencyHz = START_FREQUENCY_HZ, endFrequencyHz = END_FREQUENCY_HZ, nSample }) {
  const bandwidthHz = endFrequencyHz - startFrequencyHz;
  if (bandwidthHz <= 0) throw new Error('end frequency must be above start frequency');
  const chirpTimeS = nSample / sampleRateHz;
  const slopeHzS = bandwidthHz / chirpTimeS;
  const out = new Float64Array(nRangeBins);
  for (let k = 0; k < nRangeBins; k++) out[k] = (k * sampleRateHz / rangeFftSize) * C_MPS / (2.0 * slopeHzS);
  return out;
}

// _to_db(linear, power)
function toDb(linear, power) {
  const floor = power ? SPECT_THRESHOLD ** 2 : CLIPPING_VALUE, scale = power ? 10.0 : 20.0;
  const floorDb = scale * Math.log10(floor);
  return linear.map(v => (v >= floor ? scale * Math.log10(v) : floorDb));
}

// _range_spectrum: frame (nChirp x nSample) -> { re, im } (nChirp x nRangeBins),
// i.e. the transpose of the script's (n_range_bins, n_chirp) array
function rangeSpectrum(frame, nChirp, nSample, rangeWindow, rangeFftSize) {
  const nBins = rangeFftSize / 2;
  const re = new Float64Array(nChirp * nBins), im = new Float64Array(nChirp * nBins);
  const bufRe = new Float64Array(rangeFftSize), bufIm = new Float64Array(rangeFftSize);
  const row = new Float64Array(nSample);
  for (let c = 0; c < nChirp; c++) {
    for (let s = 0; s < nSample; s++) row[s] = frame[c * nSample + s];
    const mean = pairwiseSum(row, 0, nSample) / nSample;
    bufRe.fill(0); bufIm.fill(0);
    for (let s = 0; s < nSample; s++) bufRe[s] = (row[s] - mean) * rangeWindow[s];
    fft(bufRe, bufIm);
    re.set(bufRe.subarray(0, nBins), c * nBins);
    im.set(bufIm.subarray(0, nBins), c * nBins);
  }
  return { re, im, nBins };
}

function profileRaw({ re, im, nBins }, nChirp) {
  const mag = new Float64Array(nBins), col = new Float64Array(nChirp);
  for (let b = 0; b < nBins; b++) {
    for (let c = 0; c < nChirp; c++) col[c] = Math.hypot(re[c * nBins + b], im[c * nBins + b]);
    mag[b] = pairwiseSum(col, 0, nChirp) / nChirp;
  }
  return toDb(mag, false);
}

function profileMti({ re, im, nBins }, nChirp, dopplerWindow, dopplerFftSize) {
  const moving = new Float64Array(nBins);
  const bufRe = new Float64Array(dopplerFftSize), bufIm = new Float64Array(dopplerFftSize);
  const colRe = new Float64Array(nChirp), colIm = new Float64Array(nChirp);
  const power = new Float64Array(dopplerFftSize);
  const dc = dopplerFftSize / 2;
  for (let b = 0; b < nBins; b++) {
    for (let c = 0; c < nChirp; c++) { colRe[c] = re[c * nBins + b]; colIm[c] = im[c * nBins + b]; }
    const mRe = pairwiseSum(colRe, 0, nChirp) / nChirp, mIm = pairwiseSum(colIm, 0, nChirp) / nChirp;
    bufRe.fill(0); bufIm.fill(0);
    for (let c = 0; c < nChirp; c++) { bufRe[c] = (colRe[c] - mRe) * dopplerWindow[c]; bufIm[c] = (colIm[c] - mIm) * dopplerWindow[c]; }
    fft(bufRe, bufIm);
    // fftshift: shifted[k] = unshifted[(k + n/2) % n]
    for (let k = 0; k < dopplerFftSize; k++) {
      const u = (k + dc) % dopplerFftSize;
      power[k] = bufRe[u] * bufRe[u] + bufIm[u] * bufIm[u];
    }
    moving[b] = pairwiseSum(power, 0, dopplerFftSize) - power[dc];
  }
  return toDb(moving, true);
}

// frame_profile: one frame (nChirp x nSample) -> range profile in dB
export function frameProfile(frame, { mode, nChirp, nSample, rangeWindow, dopplerWindow, rangeFftSize, dopplerFftSize }) {
  if (mode !== 'mti' && mode !== 'raw') throw new Error(`mode must be 'mti' or 'raw', got '${mode}'`);
  const spectrum = rangeSpectrum(frame, nChirp, nSample, rangeWindow, rangeFftSize);
  return mode === 'raw' ? profileRaw(spectrum, nChirp) : profileMti(spectrum, nChirp, dopplerWindow, dopplerFftSize);
}

// compute_range_map: frameAt(i) -> antenna 0 of frame i. Returns { map (nFrame x nBins), rangeM }
export function computeRangeMap(frameAt, nFrame, nChirp, nSample, mode = 'mti') {
  if (mode !== 'mti' && mode !== 'raw') throw new Error(`mode must be 'mti' or 'raw', got '${mode}'`);
  const rangeFftSize = nSample * 4, dopplerFftSize = nChirp * 4, nBins = rangeFftSize / 2;
  const { rangeWindow, dopplerWindow } = windows(nSample, nChirp);
  const map = new Float64Array(nFrame * nBins);
  for (let i = 0; i < nFrame; i++) map.set(frameProfile(frameAt(i), { mode, nChirp, nSample, rangeWindow, dopplerWindow, rangeFftSize, dopplerFftSize }), i * nBins);
  return { map, nBins, rangeM: rangeAxisM(nBins, rangeFftSize, { nSample }) };
}

// LiveRangeProcessor (range_map_live.py): rolling history, newest row last
export class LiveRangeProcessor {
  constructor({ nSample, nChirp, mode = 'mti', historyLength = 100 }) {
    if (mode !== 'mti' && mode !== 'raw') throw new Error(`mode must be 'mti' or 'raw', got '${mode}'`);
    Object.assign(this, { nSample, nChirp, mode, historyLength });
    this.rangeFftSize = nSample * 4;
    this.dopplerFftSize = nChirp * 4;
    this.nRangeBins = this.rangeFftSize / 2;
    Object.assign(this, windows(nSample, nChirp));
    this.rangeM = rangeAxisM(this.nRangeBins, this.rangeFftSize, { nSample });
    this.history = new Float64Array(historyLength * this.nRangeBins).fill(20.0 * Math.log10(CLIPPING_VALUE));
    this.nFilled = 0;
  }

  processFrame(frame) {
    if (frame.length !== this.nChirp * this.nSample) throw new Error(`Expected (${this.nChirp}, ${this.nSample}) frame`);
    const profile = frameProfile(frame, this);
    const n = this.nRangeBins;
    this.history.copyWithin(0, n);
    this.history.set(profile, (this.historyLength - 1) * n);
    this.nFilled = Math.min(this.nFilled + 1, this.historyLength);
    return { history: this.history, nFilled: this.nFilled };
  }
}
