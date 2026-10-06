// Predictions made in the Test tab, for the Results tab: SensDSv2's
// TestTab.prediction_made(gesture, confidence, threshold, actual, source).
// actual is the confirmed gesture, or null when unconfirmed.

const records = [];
const listeners = new Set();

export function recordPrediction(gesture, confidence, threshold, actual, source) {
  const r = { gesture, confidence, threshold, actual, source, time: new Date() };
  records.push(r);
  for (const fn of listeners) fn(r);
}
export const allPredictions = () => records.slice();
export const onPrediction = fn => listeners.add(fn);
