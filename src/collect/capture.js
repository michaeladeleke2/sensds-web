// Capture rules from SensDSv2 ui/collect_tab.py (CollectTab, CaptureWorker),
// the Infineon SDK method.

import { roundHalfEven } from '../dsp/doppler_live.js';

export const GESTURES = ['push', 'swipe_left', 'swipe_right', 'swipe_up', 'swipe_down', 'idle'];
export const DEFAULTS = { numSamples: 10, duration: 3.0, delay: 3 };
export const LIMITS = { numSamples: [1, 100], duration: [1.0, 10.0], delay: [1, 10] };

// num_frames = max(1, round(duration_s / 0.15)), Python's round (half to even).
// The 0.15 is SensDSv2's own constant: with 0.1 s frames a "3 s" sample is
// 20 frames, about 2 s of radar. Kept as is so web and desktop samples match.
export const numFramesFor = durationS => Math.max(1, roundHalfEven(durationS / 0.15));

// CaptureWorker gives up on a sample after duration_s * 3 seconds.
export const captureTimeoutMs = durationS => durationS * 3 * 1000;

// _is_sample_file: sample_NNN.npy counts as a sample, sample_NNN_raw.npy does not.
export const isSampleFile = name => name.endsWith('.npy') && !name.endsWith('_raw.npy');

// re.match(r'sample_(\d+)\.npy', fname): numbering continues from the highest.
export function nextSampleNumber(fileNames) {
  let max = 0;
  for (const f of fileNames) {
    const m = /^sample_(\d+)\.npy/.exec(f);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

export const sampleStem = n => `sample_${String(n).padStart(3, '0')}`;

// time.strftime("%Y-%m-%d %H:%M:%S")
const pad = v => String(v).padStart(2, '0');
export const timestamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// write_capture_info for the Infineon method: json.dump(info, f, indent=2).
// Python writes floats with a decimal point (-20.0), so jet_vmin is formatted by hand.
export function captureInfoJson(jetVmin, when = new Date()) {
  const f = v => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  return '{\n' +
    '  "spectrogram_method": "infineon",\n' +
    '  "renderer": "reference",\n' +
    '  "velocity_flipped": true,\n' +
    `  "updated": "${timestamp(when)}",\n` +
    `  "jet_vmin": ${f(jetVmin)}\n` +
    '}';
}

// capture_mismatch for the Infineon method: "" when the folder agrees.
export function captureMismatch(hasSamples, info, jetVmin) {
  if (!hasSamples) return '';
  if (!info) return 'This folder has samples from before SensDS recorded these settings. If they were collected differently, the mix will confuse the model.';
  const oldRenderer = info.renderer ?? 'sensds';
  const sameMethod = info.spectrogram_method === 'infineon';
  const diffs = [];
  if (!sameMethod) diffs.push(`method was ${info.spectrogram_method}`);
  else if (oldRenderer !== 'reference') diffs.push("they were drawn with the app's own coloring");
  else if (Number(info.jet_vmin ?? -20.0) !== jetVmin) diffs.push('the Reduce noise setting was different');
  if (!diffs.length) return '';
  const fix = sameMethod && oldRenderer !== 'reference' ? 'Delete them first' : 'Delete them or switch back';
  return `Existing samples here do not match: ${diffs.join(', ')}. ${fix}, or the model will be trained on two different kinds of picture.`;
}
