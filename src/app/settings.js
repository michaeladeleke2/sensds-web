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
