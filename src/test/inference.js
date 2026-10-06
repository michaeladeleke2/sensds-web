// The Test tab's inference path (SensDSv2 ui/test_tab.py InferenceWorker and
// _frames_to_pil, Infineon SDK method):
//   frames -> last 30 (at least 10) -> reference_spectrogram (compute_recorded,
//   antenna 0) -> training_image (the reference drawing, 400 x 300) ->
//   the model's image processor -> ViTForImageClassification -> softmax.
//
// The image processor is the one in the model folder's preprocessor_config.json
// (ViTImageProcessor): resize with Pillow BILINEAR (resample 2), rescale
// (x * rescale_factor), normalise ((x - mean) / std), in float32 as
// transformers does. transformers 5 resizes with torchvision instead, which can
// differ from Pillow by 1/255 on some pixels (and between machines); Pillow is
// what the training images went through.

import { computeRecorded } from '../dsp/recorded.js';
import { trainingImage } from '../collect/training_image.js';
import { resizeBilinear } from '../io/resize.js';
import { readSafetensors } from '../io/safetensors.js';
import { configFromHf, loadParams, forward } from '../train/vit.js';

export const EPOCH_FRAMES = 30;          // core.processing.EPOCH_FRAMES
export const MIN_FRAMES = 10;

// _frames_to_pil: frames are antenna-0 arrays (nChirp x nSample). Returns the
// training image { rgb, width, height } or null when there are too few frames.
export function framesToImage(frames, nChirp, nSample, jetVmin) {
  if (frames.length < MIN_FRAMES) return null;
  const epoch = frames.slice(-EPOCH_FRAMES);
  const { spectrogram, dopplerBins } = computeRecorded(epoch, nChirp, nSample);
  return trainingImage(spectrogram, epoch.length, dopplerBins, jetVmin);
}

// files: { configText, preprocessorText, weights (ArrayBuffer) }
export function loadModel(tf, files) {
  const config = JSON.parse(files.configText);
  if ((config.architectures || [])[0] && config.architectures[0] !== 'ViTForImageClassification')
    throw new Error(`Unsupported model type ${config.architectures[0]}; this app runs ViTForImageClassification models`);
  const pre = JSON.parse(files.preprocessorText);
  const id2label = Object.fromEntries(Object.entries(config.id2label).map(([k, v]) => [Number(k), v]));
  const classes = Object.keys(id2label).map(Number).sort((a, b) => a - b).map(i => id2label[i]);
  const size = typeof pre.size === 'number' ? { height: pre.size, width: pre.size }
    : pre.size?.height ? pre.size : { height: pre.size?.shortest_edge ?? 224, width: pre.size?.shortest_edge ?? 224 };
  const preprocessor = {
    doResize: pre.do_resize !== false, size,
    doRescale: pre.do_rescale !== false, rescaleFactor: pre.rescale_factor ?? 1 / 255,
    doNormalize: pre.do_normalize !== false, mean: pre.image_mean ?? [0.5, 0.5, 0.5], std: pre.image_std ?? [0.5, 0.5, 0.5],
  };
  const params = loadParams(tf, readSafetensors(files.weights).tensors);
  return { params, cfg: configFromHf(config), id2label, classes, preprocessor };
}

// ViTImageProcessor on an RGB image -> NHWC float32 pixels
export function preprocess(img, p) {
  let { rgb, width: w, height: h } = img;
  if (p.doResize && (w !== p.size.width || h !== p.size.height)) { rgb = resizeBilinear(rgb, w, h, p.size.width, p.size.height); w = p.size.width; h = p.size.height; }
  const out = new Float32Array(w * h * 3), t = new Float32Array(1);
  const mean = Float32Array.from(p.mean), std = Float32Array.from(p.std);
  for (let i = 0; i < w * h; i++)
    for (let c = 0; c < 3; c++) {
      t[0] = p.doRescale ? rgb[i * 3 + c] * p.rescaleFactor : rgb[i * 3 + c];   // rescale: float64 multiply, cast to float32
      if (p.doNormalize) { t[0] = t[0] - mean[c]; t[0] = t[0] / std[c]; }
      out[i * 3 + c] = t[0];
    }
  return { pixels: out, width: w, height: h };
}

// Returns { label: probability } in class order, as InferenceWorker
export async function predict(tf, model, img) {
  const { pixels, width, height } = preprocess(img, model.preprocessor);
  const probs = tf.tidy(() => tf.reshape(tf.softmax(forward(tf, model.params, model.cfg, tf.tensor4d(pixels, [1, height, width, 3]))), [-1]));
  const p = await probs.data();
  probs.dispose();
  return Object.fromEntries(model.classes.map((c, i) => [c, p[i]]));
}

export function disposeModel(model) { if (model) for (const v of model.params.values()) v.dispose(); }
