// Inference for the Test tab, off the page (the desktop's InferenceWorker
// thread), on the GPU when available.
//
// in:  { type: 'load', files: { configText, preprocessorText, weights } }
//      { type: 'predict', id, frames: [Float32Array antenna 0], nChirp, nSample, jetVmin }
// out: { type: 'loaded', classes, backend } | { type: 'result', id, probs, image }
//      { type: 'error', id?, message }

import { tf, pickBackend } from '../tf/browser.js';
import { loadModel, disposeModel, framesToImage, predict } from './inference.js';

let model = null, backend = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      backend = backend || await pickBackend();
      disposeModel(model); model = null;
      model = loadModel(tf, data.files);
      // Warm up once so the first real prediction is not slowed by GPU setup
      await predict(tf, model, { rgb: new Uint8Array(400 * 300 * 3), width: 400, height: 300 });
      self.postMessage({ type: 'loaded', classes: model.classes, backend: backend.name });
    } else if (data.type === 'predict') {
      if (!model) throw new Error('No model loaded! Please load a model first.');
      const image = framesToImage(data.frames, data.nChirp, data.nSample, data.jetVmin);
      if (!image) throw new Error('Not enough frames for inference.');
      const probs = await predict(tf, model, image);
      self.postMessage({ type: 'result', id: data.id, probs, image }, [image.rgb.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: data.id, message: e.message });
  }
};
