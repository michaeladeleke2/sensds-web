// Training runs here, off the page, on the GPU when the browser offers it.
// TensorFlow.js comes from src/tf/browser.js (jsDelivr CDN, pinned version).
//
// in:  { type: 'train', base: { configText, preprocessor, weights }, train: [{ file, label }],
//        val: [...], labelNames, epochs, batchSize, lr, seed }
//      { type: 'stop' }
// out: { type: 'log', msg } | { type: 'epoch', epoch, loss, acc, f1 } | { type: 'progress', phase, ... }
//      { type: 'done', files, final, stopped } | { type: 'error', message }

import { tf, pickBackend as pick } from '../tf/browser.js';
import { train } from './trainer.js';
import { readSafetensors } from '../io/safetensors.js';

let stop = false;
const log = msg => self.postMessage({ type: 'log', msg });

async function pickBackend() { return (await pick()).label; }

// PNG -> RGB bytes, with no colour management (the PNGs carry no colour profile)
async function decodePng(file) {
  const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const rgb = new Uint8Array(bmp.width * bmp.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  return { rgb, width: bmp.width, height: bmp.height };
}

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { stop = true; return; }
  if (data.type !== 'train') return;
  stop = false;
  try {
    log(`Device: ${await pickBackend()}`);
    const baseTensors = readSafetensors(data.base.weights).tensors;
    const result = await train({
      tf, baseTensors, baseConfigText: data.base.configText, preprocessor: data.base.preprocessor,
      train: data.train.map(t => ({ label: t.label, load: () => decodePng(t.file) })),
      val: data.val.map(t => ({ label: t.label, load: () => decodePng(t.file) })),
      labelNames: data.labelNames, epochs: data.epochs, batchSize: data.batchSize, lr: data.lr, seed: data.seed,
      log, onEpoch: e => self.postMessage({ type: 'epoch', ...e }), shouldStop: () => stop,
      onProgress: p => self.postMessage({ type: 'progress', ...p }),
    });
    self.postMessage({ type: 'done', files: result.files, final: result.final, stopped: result.stopped });
  } catch (e) {
    self.postMessage({ type: 'error', message: `${e.message}\n${e.stack || ''}` });
  }
};
