// Settings shared by the Visualize and Collect tabs, as in SensDSv2 where
// core/reference_image.py holds one app-wide Reduce noise setting: it changes
// the live view, the saved training images and what the model is shown.

import { rangeMapMode } from '../config.js';

export const REF_JET_VMIN = -50.0;
export const REDUCED_NOISE_JET_VMIN = -50.0;

const listeners = new Set();
let reduceNoise = false;

export const getReduceNoise = () => reduceNoise;
export const currentJetVmin = () => (reduceNoise ? REDUCED_NOISE_JET_VMIN : REF_JET_VMIN);
export function setReduceNoise(on) {
  on = Boolean(on);
  if (on === reduceNoise) return;
  reduceNoise = on;
  for (const fn of listeners) fn(on);
}
export const onReduceNoiseChange = fn => listeners.add(fn);

// The range map's settings, shared by the Visualize and Curve Fit tabs:
//   MTI on or off (the starting value comes from src/config.js or
//   ?range_mode=), and the distance shown on the Y axis. Both are remembered
//   in this browser.

export const RANGE_MAX_M = 3.48;               // 512 bins of range_map_v1.py's axis
const RANGE_KEY = 'sensds-range-settings';
const rangeListeners = new Set();
let rangeSettings = (() => {
  const s = { mti: rangeMapMode() === 'mti', min: 0, max: RANGE_MAX_M };
  try {
    const url = new URLSearchParams(location.search).get('range_mode');
    const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      if (!url && typeof saved.mti === 'boolean') s.mti = saved.mti;     // a flag in the address wins
      if (Number.isFinite(saved.min) && Number.isFinite(saved.max) && saved.max > saved.min) Object.assign(s, { min: saved.min, max: saved.max });
    }
  } catch { /* defaults */ }
  return s;
})();

export const getRangeSettings = () => ({ ...rangeSettings });
export const rangeMode = () => (rangeSettings.mti ? 'mti' : 'raw');
// patch: { mti?, min?, max? }; distances are kept within 0 .. RANGE_MAX_M, at least 0.1 m apart
export function setRangeSettings(patch) {
  const next = { ...rangeSettings, ...patch };
  next.min = Math.max(0, Math.min(RANGE_MAX_M - 0.1, Number(next.min) || 0));
  next.max = Math.min(RANGE_MAX_M, Math.max(next.min + 0.1, Number(next.max) || RANGE_MAX_M));
  next.mti = Boolean(next.mti);
  const changed = { mti: next.mti !== rangeSettings.mti, distance: next.min !== rangeSettings.min || next.max !== rangeSettings.max };
  if (!changed.mti && !changed.distance) return;
  rangeSettings = next;
  try { localStorage.setItem(RANGE_KEY, JSON.stringify(next)); } catch { /* this visit only */ }
  for (const fn of rangeListeners) fn(getRangeSettings(), changed);
}
export const onRangeSettingsChange = fn => rangeListeners.add(fn);

// The radar's chirp, for testing the starter model (team feedback): 'current'
// (0.3 ms, 1 MHz, high-pass 20 kHz, the change note) or 'previous' (0.2 ms,
// 2 MHz, high-pass 80 kHz, what the starter model's recordings were made
// with). Chosen on the Test tab; it reprograms the radar
// (src/avian/registers_tr13c_previous.js), so every tab gets the previous
// chirp's frames while it is on. Not remembered: each visit starts on the
// current chirp.
export const CHIRP_CURRENT_S = 0.0003, CHIRP_PREVIOUS_S = 0.0002;
// The speed axis is the span of the chirp at 60.75 GHz: +/-4.112380411522634
// m/s for 0.3 ms (the change note), 1.5 times that for 0.2 ms. (The app
// labelled the 0.2 ms axis +/-6.19405905 before the change note, the span at
// 60.5 GHz; this is the same bins at the change note's centre frequency.)
export const MAX_SPEED_CURRENT = 4.112380411522634;
export const maxSpeedFor = chirpS => MAX_SPEED_CURRENT * CHIRP_CURRENT_S / (Number(chirpS) || CHIRP_CURRENT_S);   // shorter chirp, faster speeds

const chirpListeners = new Set();
let radarChirp = 'current';
export const getRadarChirp = () => radarChirp;
export const radarChirpS = () => (radarChirp === 'previous' ? CHIRP_PREVIOUS_S : CHIRP_CURRENT_S);
export const currentMaxSpeed = () => maxSpeedFor(radarChirpS());
export function setRadarChirp(mode) {
  mode = mode === 'previous' ? 'previous' : 'current';
  if (mode === radarChirp) return;
  radarChirp = mode;
  for (const fn of chirpListeners) fn(mode);
}
export const onRadarChirpChange = fn => chirpListeners.add(fn);
