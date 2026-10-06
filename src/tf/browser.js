// TensorFlow.js for the Web Workers (training and testing), from the jsDelivr
// CDN at a pinned version, with the GPU backends. tfjs-core's module build
// leaves out the gradient definitions; they register into the same global
// registry when loaded separately.

import * as tf from 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core@4.22.0/+esm';
import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core@4.22.0/dist/register_all_gradients/+esm';
import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-cpu@4.22.0/+esm';
import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl@4.22.0/+esm';
import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/+esm';

export { tf };

// Returns { name, label }: WebGPU, then WebGL, then CPU
export async function pickBackend() {
  for (const [name, label] of [['webgpu', 'GPU (WebGPU)'], ['webgl', 'GPU (WebGL)'], ['cpu', 'CPU (slow)']]) {
    try { if (await tf.setBackend(name)) { await tf.ready(); return { name, label }; } } catch { /* try the next one */ }
  }
  throw new Error('No TensorFlow.js backend is available in this browser.');
}
