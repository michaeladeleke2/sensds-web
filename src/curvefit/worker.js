// The Curve Fit tab's Freeze drawing (compute_recorded over the frozen window)
// off the page, so the radar keeps being read while it runs: about a second
// per 50 frames, which on the page itself stalls the serial reader.
//
// in:  { id, frames: [Float32Array antenna 0], nChirp, nSample }
// out: { id, spectrogram: Float64Array (n x bins) } | { id, error }

import { computeRecorded } from '../dsp/recorded.js';

self.onmessage = ({ data }) => {
  try {
    const { spectrogram } = computeRecorded(data.frames, data.nChirp, data.nSample);
    self.postMessage({ id: data.id, spectrogram }, [spectrogram.buffer]);
  } catch (e) {
    self.postMessage({ id: data.id, error: e.message });
  }
};
