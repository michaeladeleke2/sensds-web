// Predictions made in the Test tab, for the Results tab: SensDSv2's
// TestTab.prediction_made(gesture, confidence, threshold, actual, source) and
// TestTab.model_loaded(name, classes). actual is the confirmed gesture, or null
// when unconfirmed.

const listeners = new Set();
const modelListeners = new Set();

export function recordPrediction(gesture, confidence, threshold, actual, source) {
  const r = { gesture, confidence, threshold, actual, source, time: new Date() };
  for (const fn of listeners) fn(r);
}
export const onPrediction = fn => listeners.add(fn);

export function announceModel(name, classes) { for (const fn of modelListeners) fn(name, classes); }
export const onModelLoaded = fn => modelListeners.add(fn);
