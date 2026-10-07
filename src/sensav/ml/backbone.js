// SensAV's frozen backbone (app/ml/backbone.py): torchvision's MobileNetV3
// Small with its ImageNet weights, cut after classifier[1] (Linear 576 -> 1024
// then Hardswish), so every 224x224 RGB picture becomes 1024 numbers. Pixels
// are scaled to 0..1 and normalised with the ImageNet mean and std.
//
// The network is rebuilt here in TensorFlow.js from the same weights
// (assets/sensav/mobilenet_v3_small.safetensors, made by
// reference/python/sensav_convert_mobilenet.py), following torchvision's
// mobilenet_v3_small layer table. BatchNorm (eps 0.001, inference mode) is
// folded into the convolution before it. Convolutions pad (k - 1) / 2 on every
// side as PyTorch does (TensorFlow's 'same' would pad stride-2 layers
// differently). tf is passed in, so the same code runs in a browser worker and
// in Node tests.

export const EMBED_DIM = 1024;
export const INPUT_SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const BN_EPS = 0.001;

// torchvision _mobilenet_v3_conf("mobilenet_v3_small"):
// [kernel, expanded, out, use_se, activation, stride]
const BLOCKS = [
  [3, 16, 16, true, 'RE', 2],
  [3, 72, 24, false, 'RE', 2],
  [3, 88, 24, false, 'RE', 1],
  [5, 96, 40, true, 'HS', 2],
  [5, 240, 40, true, 'HS', 1],
  [5, 240, 40, true, 'HS', 1],
  [5, 120, 48, true, 'HS', 1],
  [5, 144, 48, true, 'HS', 1],
  [5, 288, 96, true, 'HS', 2],
  [5, 576, 96, true, 'HS', 1],
  [5, 576, 96, true, 'HS', 1],
];

const hardswish = (tf, x) => tf.mul(x, tf.div(tf.relu6(tf.add(x, 3)), 6));
const hardsigmoid = (tf, x) => tf.div(tf.relu6(tf.add(x, 3)), 6);
const act = (tf, x, kind) => (kind === 'HS' ? hardswish(tf, x) : kind === 'RE' ? tf.relu(x) : x);

// tensors: Map(name -> { shape, data }) from the safetensors file
export function buildBackbone(tf, tensors) {
  const get = name => {
    const t = tensors.get(name);
    if (!t) throw new Error(`The image model file is missing ${name}`);
    return t;
  };
  const vars = [];
  const keep = t => { vars.push(t); return t; };

  // Conv2d (no bias) + BatchNorm2d folded: returns { w, b, k, stride, depthwise }
  function convBn(prefix, stride, depthwise = false) {
    const w = get(`${prefix}.0.weight`);
    const [O, I, kh] = w.shape;
    const gamma = get(`${prefix}.1.weight`).data, beta = get(`${prefix}.1.bias`).data;
    const mean = get(`${prefix}.1.running_mean`).data, variance = get(`${prefix}.1.running_var`).data;
    const scale = Float32Array.from(gamma, (g, o) => g / Math.sqrt(variance[o] + BN_EPS));
    const bias = Float32Array.from(beta, (b, o) => b - mean[o] * scale[o]);
    // PyTorch [O, I, kh, kw] -> TensorFlow [kh, kw, I, O] (depthwise: [kh, kw, O, 1])
    const out = new Float32Array(w.data.length);
    const per = I * kh * kh;
    for (let o = 0; o < O; o++) for (let i = 0; i < I; i++) for (let y = 0; y < kh; y++) for (let x = 0; x < kh; x++) {
      const v = w.data[o * per + (i * kh + y) * kh + x] * scale[o];
      if (depthwise) out[((y * kh + x) * O + o)] = v;
      else out[(((y * kh + x) * I + i) * O + o)] = v;
    }
    const wt = keep(tf.tensor4d(out, depthwise ? [kh, kh, O, 1] : [kh, kh, I, O]));
    return { w: wt, b: keep(tf.tensor1d(bias)), k: kh, stride, depthwise };
  }
  function conv1x1Bias(prefix) {
    const w = get(`${prefix}.weight`), [O, I] = w.shape;
    const out = new Float32Array(I * O);
    for (let o = 0; o < O; o++) for (let i = 0; i < I; i++) out[i * O + o] = w.data[o * I + i];
    return { w: keep(tf.tensor2d(out, [I, O])), b: keep(tf.tensor1d(get(`${prefix}.bias`).data)) };
  }

  const stem = convBn('features.0', 2);
  const blocks = BLOCKS.map(([k, exp, out, se, kind, stride], n) => {
    const p = `features.${n + 1}.block`;
    const inC = n === 0 ? 16 : BLOCKS[n - 1][2];
    let i = 0;
    const b = { kind, residual: stride === 1 && inC === out };
    if (exp !== inC) b.expand = convBn(`${p}.${i++}`, 1);
    b.dw = convBn(`${p}.${i++}`, stride, true);
    if (se) { b.se = { fc1: conv1x1Bias(`${p}.${i}.fc1`), fc2: conv1x1Bias(`${p}.${i}.fc2`) }; i++; }
    b.project = convBn(`${p}.${i}`, 1);
    if (b.dw.k !== k) throw new Error(`features.${n + 1}: kernel ${b.dw.k}, expected ${k}`);
    return b;
  });
  const last = convBn('features.12', 1);
  const fc = (() => {
    const w = get('classifier.0.weight'), [O, I] = w.shape, out = new Float32Array(I * O);
    for (let o = 0; o < O; o++) for (let i = 0; i < I; i++) out[i * O + o] = w.data[o * I + i];
    return { w: keep(tf.tensor2d(out, [I, O])), b: keep(tf.tensor1d(get('classifier.0.bias').data)) };
  })();
  const mean = keep(tf.tensor1d(MEAN)), std = keep(tf.tensor1d(STD));

  function conv(x, c) {
    const pad = (c.k - 1) / 2;
    const xp = pad ? tf.pad(x, [[0, 0], [pad, pad], [pad, pad], [0, 0]]) : x;
    const y = c.depthwise ? tf.depthwiseConv2d(xp, c.w, c.stride, 'valid') : tf.conv2d(xp, c.w, c.stride, 'valid');
    return tf.add(y, c.b);
  }

  // x: [N, 224, 224, 3] float32 0..255 -> [N, 1024]
  function forward(pixels) {
    let x = tf.div(tf.sub(tf.div(pixels, 255), mean), std);
    x = hardswish(tf, conv(x, stem));
    for (const b of blocks) {
      const input = x;
      let y = b.expand ? act(tf, conv(x, b.expand), b.kind) : x;
      y = act(tf, conv(y, b.dw), b.kind);
      if (b.se) {
        const [N, , , C] = y.shape;
        const s = tf.reshape(tf.mean(y, [1, 2]), [N, C]);
        const h = tf.relu(tf.add(tf.matMul(s, b.se.fc1.w), b.se.fc1.b));
        const g = hardsigmoid(tf, tf.add(tf.matMul(h, b.se.fc2.w), b.se.fc2.b));
        y = tf.mul(y, tf.reshape(g, [N, 1, 1, C]));
      }
      y = conv(y, b.project);
      x = b.residual ? tf.add(y, input) : y;
    }
    x = hardswish(tf, conv(x, last));
    const pooled = tf.mean(x, [1, 2]);
    return hardswish(tf, tf.add(tf.matMul(pooled, fc.w), fc.b));
  }

  return {
    // images: Uint8Array (n x 224 x 224 x 3, RGB). Returns Float32Array (n x 1024).
    async embed(images, n) {
      const out = tf.tidy(() => forward(tf.tensor4d(Float32Array.from(images), [n, INPUT_SIZE, INPUT_SIZE, 3])));
      const data = await out.data();
      out.dispose();
      return new Float32Array(data);
    },
    dispose() { for (const v of vars) v.dispose(); },
  };
}
