// Settings shared by the Visualize and Collect tabs, as in SensDSv2 where
// core/reference_image.py holds one app-wide Reduce noise setting: it changes
// the live view, the saved training images and what the model is shown.

export const REF_JET_VMIN = -20.0;
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
