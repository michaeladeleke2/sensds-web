// SensAV's model work, off the page's main thread (the desktop's embedding,
// prediction and camera threads):
//   init                 load the backbone weights, pick WebGPU / WebGL / CPU
//   embed                saved samples (JPEG or WAV files) -> 1024 numbers each,
//                        decoded the way the desktop reads them from disk
//   setHead              the trained head and its labels, for predictions
//   predictImage         a camera frame: mirror, centre square (INTER_AREA to
//                        224), backbone, head
//   predictAudio         the last second of sound: clip picture, backbone, head
// Two of these run: one embeds new samples, one serves live predictions.

import { tf, pickBackend } from '../../tf/browser.js';
import { readSafetensors } from '../../io/safetensors.js';
import { buildBackbone } from './backbone.js';
import { ClassifierHead } from './head.js';
import { resizeAreaU8, squareSampleRgbaToRgb, rgbaToRgb, SAMPLE_SIZE } from './image_ops.js';
import { clipImageRgb, decodeWav, fitClip } from './audio_features.js';

let net = null, head = null, labels = null, mode = null;

function frameRgba(bitmap, mirror) {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = c.getContext('2d', { willReadFrequently: true });
  if (mirror) { ctx.translate(bitmap.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
}

// Centre square of a frame, RGB 224x224 (square_sample on the flipped frame)
function frameSample(bitmap, mirror = true) {
  const { data, width, height } = frameRgba(bitmap, mirror);
  if (Math.min(width, height) >= SAMPLE_SIZE) return squareSampleRgbaToRgb(data, width, height);
  // Smaller than 224 (no real camera is): let the canvas scale it up
  const side = Math.min(width, height), top = Math.floor((height - side) / 2), left = Math.floor((width - side) / 2);
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  const c = new OffscreenCanvas(SAMPLE_SIZE, SAMPLE_SIZE), ctx = c.getContext('2d');
  ctx.drawImage(src, left, top, side, side, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  return rgbaToRgb(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
}

// load_image_variants: decode, INTER_AREA to 224 if needed, RGB
async function decodeImage(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { data, width, height } = frameRgba(bmp, false);
  if (width === SAMPLE_SIZE && height === SAMPLE_SIZE) {
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2]; }
    return rgb;
  }
  const rgba = width >= SAMPLE_SIZE && height >= SAMPLE_SIZE ? resizeAreaU8(data, width, height, SAMPLE_SIZE, SAMPLE_SIZE, 4) : null;
  if (rgba) {
    const rgb = new Uint8Array(SAMPLE_SIZE * SAMPLE_SIZE * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
    return rgb;
  }
  const c = new OffscreenCanvas(SAMPLE_SIZE, SAMPLE_SIZE), ctx = c.getContext('2d');
  ctx.drawImage(await createImageBitmap(blob), 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const d = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data, rgb = new Uint8Array(SAMPLE_SIZE * SAMPLE_SIZE * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return rgb;
}

async function predict(rgb, started) {
  const vec = await net.embed(rgb, 1);
  const probabilities = head.predictProba(vec, 1);
  return { probabilities, latencyMs: performance.now() - started };
}

self.onmessage = async ({ data: msg }) => {
  const reply = (m, transfer = []) => self.postMessage({ id: msg.id, ...m }, transfer);
  try {
    switch (msg.type) {
      case 'init': {
        const backend = await pickBackend();
        const res = await fetch(msg.weightsUrl);
        if (!res.ok) throw new Error(`The image model could not be downloaded (HTTP ${res.status}).`);
        const { tensors } = readSafetensors(await res.arrayBuffer());
        net = buildBackbone(tf, tensors);
        await net.embed(new Uint8Array(SAMPLE_SIZE * SAMPLE_SIZE * 3), 1);     // warm up
        reply({ type: 'ready', backend: backend.label });
        break;
      }
      case 'embed': {
        const images = [], ok = [];
        for (const item of msg.items) {
          try {
            images.push(item.kind === 'image' ? await decodeImage(item.blob) : clipImageRgb(fitClip(decodeWav(new Uint8Array(await item.blob.arrayBuffer())))));
            ok.push(true);
          } catch (e) { ok.push(false); console.warn(`Skipping sample: ${e.message}`); }
        }
        const n = images.length, all = new Uint8Array(n * SAMPLE_SIZE * SAMPLE_SIZE * 3);
        images.forEach((im, i) => all.set(im, i * im.length));
        const vectors = n ? await net.embed(all, n) : new Float32Array(0);
        reply({ type: 'embedded', vectors, ok }, [vectors.buffer]);
        break;
      }
      case 'setHead': {
        mode = msg.mode; labels = msg.labels;
        head = msg.head ? ClassifierHead.fromState(msg.head.embedDim, msg.head.numClasses, msg.head.denseUnits,
          new Map([['hidden.weight', { data: msg.head.w1 }], ['hidden.bias', { data: msg.head.b1 }], ['output.weight', { data: msg.head.w2 }]])) : null;
        reply({ type: 'headSet' });
        break;
      }
      case 'predictImage': {
        const started = performance.now();
        const r = await predict(frameSample(msg.bitmap, true), started);
        reply({ type: 'prediction', mode: 'image', ...r });
        break;
      }
      case 'predictAudio': {
        const started = performance.now();
        const r = await predict(clipImageRgb(fitClip(msg.samples)), started);
        reply({ type: 'prediction', mode: 'audio', ...r });
        break;
      }
      default: throw new Error(`Unknown message ${msg.type}`);
    }
  } catch (e) {
    reply({ type: 'error', message: e.message || String(e) });
  }
};

