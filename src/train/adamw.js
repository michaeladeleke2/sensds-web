// torch.optim.AdamW as the Hugging Face Trainer configures it: betas
// (0.9, 0.999), eps 1e-8, decoupled weight decay 0.01 on every parameter
// except biases and LayerNorm weights (Trainer.get_decay_parameter_names),
// gradient clipping to a total norm of 1.0 (clip_grad_norm_), and a linear
// learning-rate decay to 0 over all steps with no warmup.
//
// tf is passed in (TensorFlow.js), so the same code runs in the browser and
// in Node tests.

const FORBIDDEN = [/bias/, /layernorm/, /rmsnorm/, /(?:^|\.)norm(?:$|\.)/, /_norm(?:$|\.)/];
export const usesWeightDecay = name => !FORBIDDEN.some(re => re.test(name));

// LambdaLR with lambda s: max(0, (total - s) / total)
export const linearLr = (baseLr, step, totalSteps) => baseLr * Math.max(0, (totalSteps - step) / totalSteps);

export class AdamW {
  constructor(tf, params, { lr, weightDecay = 0.01, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, maxGradNorm = 1.0, totalSteps }) {
    Object.assign(this, { tf, params, lr, weightDecay, beta1, beta2, eps, maxGradNorm, totalSteps });
    this.step = 0;
    this.m = new Map(); this.v = new Map();
    for (const [name, p] of params) {
      this.m.set(name, tf.tidy(() => tf.variable(tf.zerosLike(p), false)));
      this.v.set(name, tf.tidy(() => tf.variable(tf.zerosLike(p), false)));
    }
  }

  // grads: { name: tensor }. Returns the gradient norm before clipping.
  apply(grads) {
    const { tf } = this;
    const names = [...this.params.keys()];
    const norm = tf.tidy(() => tf.sqrt(tf.addN(names.map(n => tf.sum(tf.square(grads[n]))))).dataSync()[0]);
    const clip = this.maxGradNorm > 0 ? Math.min(1, this.maxGradNorm / (norm + 1e-6)) : 1;
    const lr = linearLr(this.lr, this.step, this.totalSteps);
    this.step += 1;
    const bc1 = 1 - this.beta1 ** this.step, bc2 = 1 - this.beta2 ** this.step;
    const stepSize = lr / bc1, bc2Sqrt = Math.sqrt(bc2);
    tf.tidy(() => {
      for (const name of names) {
        const p = this.params.get(name), m = this.m.get(name), v = this.v.get(name);
        const g = clip < 1 ? tf.mul(grads[name], clip) : grads[name];
        // p.mul_(1 - lr * weight_decay)
        const decayed = usesWeightDecay(name) && this.weightDecay ? tf.mul(p, 1 - lr * this.weightDecay) : p;
        const m1 = tf.add(tf.mul(m, this.beta1), tf.mul(g, 1 - this.beta1));
        const v1 = tf.add(tf.mul(v, this.beta2), tf.mul(tf.square(g), 1 - this.beta2));
        const denom = tf.add(tf.div(tf.sqrt(v1), bc2Sqrt), this.eps);
        p.assign(tf.sub(decayed, tf.mul(tf.div(m1, denom), stepSize)));
        m.assign(m1); v.assign(v1);
      }
    });
    return norm;
  }

  dispose() { for (const t of [...this.m.values(), ...this.v.values()]) t.dispose(); }
}
