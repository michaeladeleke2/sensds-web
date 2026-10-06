// The image transforms of SensDSv2's TrainWorker (torchvision on PIL images):
//   val:   Resize((224, 224)), ToTensor, Normalize(mean, std)
//   train: Resize((256, 256)), RandomResizedCrop(224, scale=(0.85, 1.0)),
//          ColorJitter(brightness=0.15, contrast=0.15, saturation=0.05),
//          RandomAffine(degrees=3, translate=(0.02, 0.02), scale=(0.95, 1.05)),
//          ToTensor, Normalize(mean, std)
// Resizes use the Pillow BILINEAR port (byte-identical). The random draws use
// a seeded generator; they cannot reproduce torch's random stream, so each
// training run's augmentation differs from the desktop's (as it does between
// two desktop runs).

import { resizeBilinear } from '../io/resize.js';

// ToTensor then Normalize, in float32, laid out NHWC for TensorFlow.js.
export function normalizeToNhwc(rgb, w, h, mean, std, out = new Float32Array(w * h * 3), offset = 0) {
  const t = new Float32Array(1);
  for (let i = 0; i < w * h; i++)
    for (let c = 0; c < 3; c++) {
      t[0] = rgb[i * 3 + c] / 255;          // ToTensor: float32 / 255
      t[0] = t[0] - mean[c];
      t[0] = t[0] / std[c];
      out[offset + i * 3 + c] = t[0];
    }
  return out;
}

export function valTransform(rgb, w, h, size = 224) {
  return resizeBilinear(rgb, w, h, size, size);
}

// ---------- train augmentation ----------
const clip8 = v => (v < 0 ? 0 : v > 255 ? 255 : v);

function crop(rgb, w, top, left, ch, cw) {
  const out = new Uint8Array(ch * cw * 3);
  for (let y = 0; y < ch; y++) out.set(rgb.subarray(((top + y) * w + left) * 3, ((top + y) * w + left + cw) * 3), y * cw * 3);
  return out;
}

// torchvision RandomResizedCrop.get_params, then resize the crop with PIL BILINEAR
function randomResizedCrop(rgb, w, h, size, rng, scale = [0.85, 1.0], ratio = [3 / 4, 4 / 3]) {
  const area = w * h, logR = [Math.log(ratio[0]), Math.log(ratio[1])];
  const randint = (lo, hi) => lo + Math.floor(rng() * (hi - lo));       // [lo, hi)
  for (let k = 0; k < 10; k++) {
    const target = area * (scale[0] + rng() * (scale[1] - scale[0]));
    const aspect = Math.exp(logR[0] + rng() * (logR[1] - logR[0]));
    const cw = Math.round(Math.sqrt(target * aspect)), ch = Math.round(Math.sqrt(target / aspect));
    if (cw > 0 && cw <= w && ch > 0 && ch <= h) {
      const top = randint(0, h - ch + 1), left = randint(0, w - cw + 1);
      return resizeBilinear(crop(rgb, w, top, left, ch, cw), cw, ch, size, size);
    }
  }
  // Fallback: central crop
  const inRatio = w / h;
  let cw, ch;
  if (inRatio < ratio[0]) { cw = w; ch = Math.round(cw / ratio[0]); }
  else if (inRatio > ratio[1]) { ch = h; cw = Math.round(ch * ratio[1]); }
  else { cw = w; ch = h; }
  return resizeBilinear(crop(rgb, w, Math.floor((h - ch) / 2), Math.floor((w - cw) / 2), ch, cw), cw, ch, size, size);
}

// PIL Image.blend(degenerate, img, factor) as ImageEnhance does
function blend(img, degenerate, factor) {
  const out = new Uint8Array(img.length);
  for (let i = 0; i < img.length; i++) out[i] = clip8(Math.trunc(degenerate[i] + factor * (img[i] - degenerate[i])));
  return out;
}
// PIL "L" conversion: L = R*299/1000 + G*587/1000 + B*114/1000
const luma = (r, g, b) => ((r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16);

function adjustBrightness(img, f) { return blend(img, new Uint8Array(img.length), f); }
function adjustContrast(img, f) {
  let sum = 0;
  for (let i = 0; i < img.length; i += 3) sum += luma(img[i], img[i + 1], img[i + 2]);
  const mean = Math.trunc(sum / (img.length / 3) + 0.5);
  return blend(img, new Uint8Array(img.length).fill(mean), f);
}
function adjustSaturation(img, f) {
  const gray = new Uint8Array(img.length);
  for (let i = 0; i < img.length; i += 3) gray[i] = gray[i + 1] = gray[i + 2] = luma(img[i], img[i + 1], img[i + 2]);
  return blend(img, gray, f);
}

// ColorJitter: factors uniform in [1 - x, 1 + x], applied in a random order
function colorJitter(img, rng, b = 0.15, c = 0.15, s = 0.05) {
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const fb = 1 - b + rng() * 2 * b, fc = 1 - c + rng() * 2 * c, fs = 1 - s + rng() * 2 * s;
  for (const k of order) {
    if (k === 0) img = adjustBrightness(img, fb);
    else if (k === 1) img = adjustContrast(img, fc);
    else if (k === 2) img = adjustSaturation(img, fs);
    // k === 3 is hue, 0 here
  }
  return img;
}

// RandomAffine (rotation, translation, scale; NEAREST, fill 0), about the image centre
function randomAffine(img, w, h, rng, degrees = 3, translate = [0.02, 0.02], scaleRange = [0.95, 1.05]) {
  const angle = (-degrees + rng() * 2 * degrees) * Math.PI / 180;
  const tx = Math.round((-translate[0] + rng() * 2 * translate[0]) * w);
  const ty = Math.round((-translate[1] + rng() * 2 * translate[1]) * h);
  const sc = scaleRange[0] + rng() * (scaleRange[1] - scaleRange[0]);
  const cx = w * 0.5, cy = h * 0.5, cos = Math.cos(angle), sin = Math.sin(angle);
  const out = new Uint8Array(img.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // inverse map: output pixel centre -> input
      const dx = x + 0.5 - cx - tx, dy = y + 0.5 - cy - ty;
      const sx = (cos * dx + sin * dy) / sc + cx, sy = (-sin * dx + cos * dy) / sc + cy;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      const o = (y * w + x) * 3, i = (iy * w + ix) * 3;
      out[o] = img[i]; out[o + 1] = img[i + 1]; out[o + 2] = img[i + 2];
    }
  return out;
}

export function trainTransform(rgb, w, h, rng, size = 224) {
  let img = resizeBilinear(rgb, w, h, 256, 256);
  img = randomResizedCrop(img, 256, 256, size, rng);
  img = colorJitter(img, rng);
  img = randomAffine(img, size, size, rng);
  return img;
}
