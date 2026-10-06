// Port of SensDSv2 core/physical_features.py: interpretable quantities
// (distance, speed, Doppler velocity and spread) from a raw radar cube
// (n_frame, n_ant, n_chirp, n_sample), with the same constants and steps.

import { fft, pairwiseSum } from '../dsp/fft.js';
import { blackmanharris, chebwin } from '../dsp/windows.js';

// ── Radar constants (core/radar.py build_config) ──
export const C = 3e8;
export const F_START = 58.0e9, F_END = 63.5e9;
export const BANDWIDTH = F_END - F_START;
export const F_CENTER = (F_START + F_END) / 2;
export const WAVELENGTH = C / F_CENTER;
export const CHIRP_REP_S = 0.0002;
export const PRF = 1.0 / CHIRP_REP_S;
export const FRAME_S = 0.10;
export const MAX_VELOCITY = PRF * WAVELENGTH / 4;
export const RANGE_RES_M = C / (2 * BANDWIDTH);
export const N_SAMPLES_CFG = 256;
export const MAX_RANGE_M = N_SAMPLES_CFG * C / (4 * BANDWIDTH);
const RANGE_FFT_MULT = 4, DOPPLER_FFT_MULT = 4, CLIP_VALUE = 1e-6;
export const MOTION_SPEED_MS = 0.25;

export const ALL_SUMMARY_FEATURES = [
  ['range_mean_m', 'Distance from radar', 'm'],
  ['range_travel_m', 'Distance traveled', 'm'],
  ['range_net_m', 'Net displacement', 'm'],
  ['range_toward_m', 'Movement toward radar', 'm'],
  ['radial_speed_max_ms', 'Peak speed (toward/away)', 'm/s'],
  ['radial_speed_mean_ms', 'Mean speed (toward/away)', 'm/s'],
  ['vel_peak_ms', 'Peak Doppler velocity', 'm/s'],
  ['vel_mean_ms', 'Mean Doppler velocity', 'm/s'],
  ['vel_std_ms', 'Velocity variability', 'm/s'],
  ['accel_peak_ms2', 'Peak acceleration', 'm/s²'],
  ['accel_mean_ms2', 'Mean |acceleration|', 'm/s²'],
  ['doppler_spread_ms', 'Doppler spread', 'm/s'],
  ['doppler_spread_max_ms', 'Peak Doppler spread', 'm/s'],
  ['direction_changes', 'Direction changes', 'count'],
  ['motion_duration_s', 'Motion duration', 's'],
  ['energy_peak', 'Peak return energy', 'a.u.'],
  ['energy_mean', 'Mean return energy', 'a.u.'],
  ['n_frames', 'Frames captured', 'count'],
];
export const ALL_FRAME_FEATURES = [
  ['time_s', 'Time', 's'],
  ['range_m', 'Distance', 'm'],
  ['radial_speed_ms', 'Speed (toward/away)', 'm/s'],
  ['velocity_ms', 'Doppler velocity', 'm/s'],
  ['speed_ms', 'Doppler speed', 'm/s'],
  ['accel_ms2', 'Acceleration', 'm/s²'],
  ['doppler_spread_ms', 'Doppler spread', 'm/s'],
  ['energy', 'Return energy', 'a.u.'],
];
// The exposed set: distance and speed only, as in SensDSv2.
export const SUMMARY_FEATURES = [
  ['range_mean_m', 'Distance from radar', 'm'],
  ['range_travel_m', 'Distance traveled', 'm'],
  ['radial_speed_max_ms', 'Peak speed (toward/away)', 'm/s'],
  ['radial_speed_mean_ms', 'Mean speed (toward/away)', 'm/s'],
];
export const FRAME_FEATURES = [
  ['time_s', 'Time', 's'],
  ['range_m', 'Distance', 'm'],
  ['radial_speed_ms', 'Speed (toward/away)', 'm/s'],
];
export const SUMMARY_KEYS = SUMMARY_FEATURES.map(f => f[0]);
export const FRAME_KEYS = FRAME_FEATURES.map(f => f[0]);

export function featureLabel(key) {
  for (const [k, label, unit] of [...ALL_SUMMARY_FEATURES, ...ALL_FRAME_FEATURES])
    if (k === key) return unit ? `${label} (${unit})` : label;
  return key;
}
export function featureUnit(key) {
  for (const [k, , unit] of [...ALL_SUMMARY_FEATURES, ...ALL_FRAME_FEATURES]) if (k === key) return unit;
  return '';
}

const winCache = new Map();
function windows(nSample, nChirp) {
  const key = `${nSample}x${nChirp}`;
  if (!winCache.has(key)) {
    const r = blackmanharris(nSample), d = chebwin(nChirp, 100.0);
    const s = pairwiseSum(d, 0, d.length);
    winCache.set(key, { rwin: r, dwin: d.map(v => v / s) });
  }
  return winCache.get(key);
}

// numpy.linspace(start, stop, num)
function linspace(start, stop, num) {
  const out = new Float64Array(num), step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) out[i] = i * step + start;
  out[num - 1] = stop;
  return out;
}

// One chirp's range spectrum (first nBins of a 4x zero-padded FFT), mean
// removed and Blackman-Harris windowed. cube is flat (fr, ant, chirp, sample).
function chirpSpectrum(cube, base, nSample, fftSize, rwin, re, im) {
  const mean = pairwiseSum(cube, base, nSample) / nSample;
  re.fill(0); im.fill(0);
  for (let s = 0; s < nSample; s++) re[s] = (cube[base + s] - mean) * rwin[s];
  fft(re, im);
}

// frame_series(cube): per-frame physical quantities.
export function frameSeries(cube, shape) {
  const [nFrame, nAnt, nChirp, nSample] = shape;
  const fftSize = nSample * RANGE_FFT_MULT, nBins = fftSize / 2, dfft = nChirp * DOPPLER_FFT_MULT;
  const { rwin, dwin } = windows(nSample, nChirp);
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);

  // _range_profile: chirp-averaged range spectrum, (ant, fr, bin)
  const pRe = new Float64Array(nAnt * nFrame * nBins), pIm = new Float64Array(nAnt * nFrame * nBins);
  for (let f = 0; f < nFrame; f++)
    for (let a = 0; a < nAnt; a++) {
      const o = (a * nFrame + f) * nBins;
      for (let c = 0; c < nChirp; c++) {
        chirpSpectrum(cube, ((f * nAnt + a) * nChirp + c) * nSample, nSample, fftSize, rwin, re, im);
        for (let b = 0; b < nBins; b++) { pRe[o + b] += re[b]; pIm[o + b] += im[b]; }
      }
      for (let b = 0; b < nBins; b++) { pRe[o + b] /= nChirp; pIm[o + b] /= nChirp; }
    }

  // Static clutter removal, then magnitude averaged over antennas: (fr, bin)
  const mag = new Float64Array(nFrame * nBins);
  for (let a = 0; a < nAnt; a++)
    for (let b = 0; b < nBins; b++) {
      let mr = 0, mi = 0;
      for (let f = 0; f < nFrame; f++) { mr += pRe[(a * nFrame + f) * nBins + b]; mi += pIm[(a * nFrame + f) * nBins + b]; }
      mr /= nFrame; mi /= nFrame;
      for (let f = 0; f < nFrame; f++) {
        const k = (a * nFrame + f) * nBins + b;
        mag[f * nBins + b] += Math.hypot(pRe[k] - mr, pIm[k] - mi);
      }
    }
  for (let i = 0; i < mag.length; i++) mag[i] /= nAnt;

  const peakBin = new Int32Array(nFrame), rangeM = new Float64Array(nFrame), energy = new Float64Array(nFrame);
  for (let f = 0; f < nFrame; f++) {
    let best = -Infinity, idx = 0;
    for (let b = 0; b < nBins; b++) if (mag[f * nBins + b] > best) { best = mag[f * nBins + b]; idx = b; }
    peakBin[f] = idx; rangeM[f] = idx * (MAX_RANGE_M / nBins); energy[f] = best;
  }

  // _doppler_at_bins: Doppler spectrum of the tracked bin, antenna 0
  const velAxis = linspace(-MAX_VELOCITY, MAX_VELOCITY, dfft);
  const floor = 20.0 * Math.log10(CLIP_VALUE);
  const velocity = new Float64Array(nFrame), spread = new Float64Array(nFrame);
  const sRe = new Float64Array(nChirp), sIm = new Float64Array(nChirp);
  const dRe = new Float64Array(dfft), dIm = new Float64Array(dfft), w = new Float64Array(dfft), tmp = new Float64Array(dfft);
  for (let f = 0; f < nFrame; f++) {
    const bin = Math.min(nBins - 1, Math.max(0, peakBin[f]));
    for (let c = 0; c < nChirp; c++) {
      chirpSpectrum(cube, ((f * nAnt + 0) * nChirp + c) * nSample, nSample, fftSize, rwin, re, im);
      sRe[c] = re[bin]; sIm[c] = im[bin];
    }
    const mr = pairwiseSum(sRe, 0, nChirp) / nChirp, mi = pairwiseSum(sIm, 0, nChirp) / nChirp;
    dRe.fill(0); dIm.fill(0);
    for (let c = 0; c < nChirp; c++) { dRe[c] = (sRe[c] - mr) * dwin[c]; dIm[c] = (sIm[c] - mi) * dwin[c]; }
    fft(dRe, dIm);
    let wmin = Infinity;
    for (let k = 0; k < dfft; k++) {
      const src = (k + dfft / 2) % dfft;
      const power = Math.hypot(dRe[src], dIm[src]) ** 2;
      const db = power >= CLIP_VALUE ** 2 ? 10.0 * Math.log10(power) : floor;
      w[k] = 10.0 ** (db / 10.0);
      if (w[k] < wmin) wmin = w[k];
    }
    for (let k = 0; k < dfft; k++) w[k] -= wmin;
    let total = pairwiseSum(w, 0, dfft);
    if (total <= 0) total = 1.0;
    for (let k = 0; k < dfft; k++) w[k] /= total;
    for (let k = 0; k < dfft; k++) tmp[k] = velAxis[k] * w[k];
    velocity[f] = pairwiseSum(tmp, 0, dfft);
    for (let k = 0; k < dfft; k++) tmp[k] = (velAxis[k] - velocity[f]) ** 2 * w[k];
    spread[f] = Math.sqrt(pairwiseSum(tmp, 0, dfft));
  }

  const radial = new Float64Array(nFrame), accel = new Float64Array(nFrame);
  for (let f = 1; f < nFrame; f++) { radial[f] = (rangeM[f] - rangeM[f - 1]) / FRAME_S; accel[f] = (velocity[f] - velocity[f - 1]) / FRAME_S; }
  return {
    time_s: Float64Array.from({ length: nFrame }, (_, i) => i * FRAME_S),
    range_m: rangeM,
    velocity_ms: velocity,
    speed_ms: velocity.map(Math.abs),
    radial_speed_ms: radial,
    accel_ms2: accel,
    doppler_spread_ms: spread,
    energy,
  };
}

const sum = a => pairwiseSum(a, 0, a.length);
const mean = a => sum(a) / a.length;
const maxOf = a => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const minOf = a => a.reduce((m, v) => (v < m ? v : m), Infinity);

// summarize(series)
export function summarize(s) {
  const rng = s.range_m, vel = s.velocity_ms, n = rng.length;
  const absVel = vel.map(Math.abs), absRad = s.radial_speed_ms.map(Math.abs), absAcc = s.accel_ms2.map(Math.abs);
  const movingIdx = [];
  for (let i = 0; i < n; i++) if (absVel[i] > MOTION_SPEED_MS) movingIdx.push(i);
  let directionChanges = 0;
  if (movingIdx.length > 1) {
    const signs = movingIdx.map(i => Math.sign(vel[i]));
    for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) directionChanges++;
  }
  let toward = 0;
  if (n > 1) {
    const neg = [];
    for (let i = 1; i < n; i++) { const d = rng[i] - rng[i - 1]; if (d < 0) neg.push(d); }
    toward = neg.length ? -sum(Float64Array.from(neg)) : 0;
  }
  const vm = mean(vel);
  return {
    range_mean_m: mean(rng),
    range_travel_m: maxOf(rng) - minOf(rng),
    range_net_m: n > 1 ? rng[n - 1] - rng[0] : 0,
    range_toward_m: toward,
    radial_speed_max_ms: maxOf(absRad),
    radial_speed_mean_ms: mean(absRad),
    vel_peak_ms: maxOf(absVel),
    vel_mean_ms: vm,
    vel_std_ms: Math.sqrt(mean(vel.map(v => (v - vm) ** 2))),
    accel_peak_ms2: maxOf(absAcc),
    accel_mean_ms2: mean(absAcc),
    doppler_spread_ms: mean(s.doppler_spread_ms),
    doppler_spread_max_ms: maxOf(s.doppler_spread_ms),
    direction_changes: directionChanges,
    motion_duration_s: movingIdx.length * FRAME_S,
    energy_peak: maxOf(s.energy),
    energy_mean: mean(s.energy),
    n_frames: n,
  };
}

export function extract(cube, shape) {
  const series = frameSeries(cube, shape);
  return { summary: summarize(series), series };
}
