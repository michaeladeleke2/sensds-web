// ViTForImageClassification (Hugging Face transformers) in TensorFlow.js:
// patch embedding (16x16 conv), CLS token, position embeddings, pre-norm
// transformer layers (LayerNorm eps from config, multi-head self-attention,
// exact erf GELU), final LayerNorm, linear classifier on the CLS token.
// Weights use the transformers names and PyTorch layouts, so a model loads
// from and saves to the same model.safetensors the desktop uses.
//
// tf is passed in, so the same code runs in the browser and in Node tests.

export function configFromHf(c) {
  return {
    imageSize: c.image_size ?? 224, patchSize: c.patch_size ?? 16, channels: c.num_channels ?? 3,
    hidden: c.hidden_size, layers: c.num_hidden_layers, heads: c.num_attention_heads,
    intermediate: c.intermediate_size, eps: c.layer_norm_eps ?? 1e-12,
  };
}

// tensors: Map(name -> { shape, data }) from readSafetensors. Converts to tf
// variables (trainable). Linear weights stay (out, in) as in PyTorch.
export function loadParams(tf, tensors) {
  const params = new Map();
  // Unnamed variables: tf gives each a unique name, so two models (the one
  // training and the best one kept) can live side by side.
  for (const [name, t] of tensors) params.set(name, tf.tidy(() => tf.variable(tf.tensor(t.data, t.shape, 'float32'), true)));
  return params;
}

// Back to plain arrays for writeSafetensors
export async function exportParams(params) {
  const out = new Map();
  for (const [name, p] of params) out.set(name, { shape: p.shape, data: new Float32Array(await p.data()) });
  return out;
}

// A new classifier head, as transformers' _init_weights does after
// ignore_mismatched_sizes: weight ~ truncated normal(0, 0.02) cut at +/-2,
// bias = 0. rng() returns uniform [0, 1).
export function newClassifier(hidden, numLabels, rng, std = 0.02) {
  const w = new Float32Array(numLabels * hidden);
  for (let i = 0; i < w.length; i++) {
    let z;
    do {                                                       // Box-Muller, rejected outside [-2, 2]
      const u = 1 - rng(), v = rng();
      z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * std;
    } while (z < -2 || z > 2);
    w[i] = z;
  }
  return { weight: { shape: [numLabels, hidden], data: w }, bias: { shape: [numLabels], data: new Float32Array(numLabels) } };
}

// x @ W^T + b. Inputs of rank 3 are flattened to 2-D first: TensorFlow.js
// cannot take the gradient of a matMul that broadcasts a 3-D input against a
// 2-D weight.
function linear(tf, x, w, b) {
  if (x.rank === 2) return tf.add(tf.matMul(x, w, false, true), b);
  const [B, T, I] = x.shape;
  const y = tf.add(tf.matMul(tf.reshape(x, [B * T, I]), w, false, true), b);
  return tf.reshape(y, [B, T, w.shape[0]]);
}

function layerNorm(tf, x, w, b, eps) {
  const { mean, variance } = tf.moments(x, -1, true);
  return tf.add(tf.mul(tf.div(tf.sub(x, mean), tf.sqrt(tf.add(variance, eps))), w), b);
}

const gelu = (tf, x) => tf.mul(tf.mul(x, 0.5), tf.add(1, tf.erf(tf.div(x, Math.SQRT2))));

// pixels: [B, H, W, 3] (NHWC, already normalised). Returns logits [B, numLabels].
export function forward(tf, params, cfg, pixels) {
  const P = name => params.get(name);
  const B = pixels.shape[0], D = cfg.hidden, H = cfg.heads, hd = D / H;
  // Conv2d weight (out, in, kh, kw) -> tf filter (kh, kw, in, out)
  const filter = tf.transpose(P('vit.embeddings.patch_embeddings.projection.weight'), [2, 3, 1, 0]);
  let x = tf.conv2d(pixels, filter, cfg.patchSize, 'valid');
  x = tf.add(x, P('vit.embeddings.patch_embeddings.projection.bias'));
  const nPatch = x.shape[1] * x.shape[2];
  x = tf.reshape(x, [B, nPatch, D]);                                         // row-major patches, as flatten(2).transpose(1, 2)
  const cls = tf.tile(P('vit.embeddings.cls_token'), [B, 1, 1]);
  x = tf.concat([cls, x], 1);
  x = tf.add(x, P('vit.embeddings.position_embeddings'));
  const T = nPatch + 1;

  for (let i = 0; i < cfg.layers; i++) {
    const pre = `vit.encoder.layer.${i}.`;
    const h = layerNorm(tf, x, P(pre + 'layernorm_before.weight'), P(pre + 'layernorm_before.bias'), cfg.eps);
    const heads = t => tf.transpose(tf.reshape(t, [B, T, H, hd]), [0, 2, 1, 3]);
    const q = heads(linear(tf, h, P(pre + 'attention.attention.query.weight'), P(pre + 'attention.attention.query.bias')));
    const k = heads(linear(tf, h, P(pre + 'attention.attention.key.weight'), P(pre + 'attention.attention.key.bias')));
    const v = heads(linear(tf, h, P(pre + 'attention.attention.value.weight'), P(pre + 'attention.attention.value.bias')));
    const scores = tf.mul(tf.matMul(q, k, false, true), 1 / Math.sqrt(hd));
    const ctx = tf.reshape(tf.transpose(tf.matMul(tf.softmax(scores, -1), v), [0, 2, 1, 3]), [B, T, D]);
    x = tf.add(x, linear(tf, ctx, P(pre + 'attention.output.dense.weight'), P(pre + 'attention.output.dense.bias')));
    const h2 = layerNorm(tf, x, P(pre + 'layernorm_after.weight'), P(pre + 'layernorm_after.bias'), cfg.eps);
    const mid = gelu(tf, linear(tf, h2, P(pre + 'intermediate.dense.weight'), P(pre + 'intermediate.dense.bias')));
    x = tf.add(x, linear(tf, mid, P(pre + 'output.dense.weight'), P(pre + 'output.dense.bias')));
  }
  x = layerNorm(tf, x, P('vit.layernorm.weight'), P('vit.layernorm.bias'), cfg.eps);
  const pooled = tf.reshape(tf.slice(x, [0, 0, 0], [B, 1, D]), [B, D]);      // sequence_output[:, 0, :]
  return linear(tf, pooled, P('classifier.weight'), P('classifier.bias'));
}

// Mean cross-entropy, as torch.nn.CrossEntropyLoss
export function crossEntropy(tf, logits, labels) {
  const oneHot = tf.oneHot(tf.tensor1d(labels, 'int32'), logits.shape[1]);
  return tf.neg(tf.mean(tf.sum(tf.mul(oneHot, tf.logSoftmax(logits)), -1)));
}

// One training step: loss, gradients of every parameter. Returns { loss, grads }.
export function lossAndGrads(tf, params, cfg, pixels, labels) {
  const names = [...params.keys()];
  const vars = names.map(n => params.get(n));
  const { value, grads } = tf.variableGrads(() => crossEntropy(tf, forward(tf, params, cfg, pixels), labels), vars);
  const byName = {};
  vars.forEach((v, i) => { byName[names[i]] = grads[v.name]; });
  return { loss: value, grads: byName };
}
