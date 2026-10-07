// torch.Generator (CPU) and Tensor.normal_, so the web app starts training
// from the same random weights SensAV draws. Ported from PyTorch:
//   - at::mt19937 (Mersenne Twister, 32-bit seed), random() and random64();
//   - uniform_real_distribution: 24 random bits for float, 53 for double;
//   - normal_ on a contiguous float tensor of 16 or more values: fill with
//     uniforms, Box-Muller in blocks of 16, redo the last 16 when the size is
//     not a multiple of 16 (normal_fill, the scalar CPU kernel);
//   - normal_ on fewer than 16 values: one normal_distribution<double> draw per
//     value, which caches its second Box-Muller value in the generator.
// This is the scalar kernel PyTorch uses on ARM (Apple silicon) Macs; x86 CPUs
// with AVX2 use a vectorized variant whose last bits can differ.

const f32 = Math.fround;

export class TorchGenerator {
  constructor(seed = 67280421310721) { this.manualSeed(seed); }

  manualSeed(seed) {
    const mt = this.mt = new Uint32Array(624);
    mt[0] = Number(BigInt(seed) & 0xFFFFFFFFn);
    for (let i = 1; i < 624; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.left = 1; this.next = 0;
    this.nextDoubleNormal = null;
    return this;
  }

  _reload() {
    const mt = this.mt;
    for (let i = 0; i < 624; i++) {
      const y = (mt[i] & 0x80000000) | (mt[(i + 1) % 624] & 0x7FFFFFFF);
      mt[i] = mt[(i + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908B0DF : 0);
    }
    this.left = 624; this.next = 0;
  }

  // engine_(): next 32-bit value
  random() {
    if (--this.left <= 0) this._reload();
    let y = this.mt[this.next++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9D2C5680;
    y ^= (y << 15) & 0xEFC60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  // (first << 32) | second, as a BigInt
  random64() { const a = this.random(), b = this.random(); return (BigInt(a) << 32n) | BigInt(b); }

  uniformFloat() { return f32((this.random() & 0xFFFFFF) * 2 ** -24); }
  uniformDouble() { return Number(this.random64() & ((1n << 53n) - 1n)) * 2 ** -53; }

  // at::normal_distribution<double>(mean, std)(generator)
  normalDouble(mean, std) {
    if (this.nextDoubleNormal !== null) {
      const v = this.nextDoubleNormal;
      this.nextDoubleNormal = null;
      return v * std + mean;
    }
    const u1 = this.uniformDouble(), u2 = this.uniformDouble();
    const r = Math.sqrt(-2.0 * Math.log1p(-u2));
    const theta = 2.0 * Math.PI * u1;
    this.nextDoubleNormal = r * Math.sin(theta);
    return r * Math.cos(theta) * std + mean;
  }

  // tensor.normal_(mean, std, generator=self) on a float32 array, in place
  normal_(data, mean, std) {
    const size = data.length;
    if (size >= 16) {
      const m = f32(mean), s = f32(std);
      for (let i = 0; i < size; i++) data[i] = this.uniformFloat();
      for (let i = 0; i < size - 15; i += 16) fill16(data, i, m, s);
      if (size % 16 !== 0) {
        const o = size - 16;
        for (let i = 0; i < 16; i++) data[o + i] = this.uniformFloat();
        fill16(data, o, m, s);
      }
    } else {
      for (let i = 0; i < size; i++) data[i] = this.normalDouble(mean, std);
    }
    return data;
  }
}

function fill16(data, o, mean, std) {
  for (let j = 0; j < 8; j++) {
    const u1 = f32(1 - data[o + j]);
    const u2 = data[o + j + 8];
    const radius = f32(Math.sqrt(f32(-2 * f32(Math.log(u1)))));
    const theta = f32(2.0 * Math.PI * u2);
    data[o + j] = f32(f32(f32(radius * f32(Math.cos(theta))) * std) + mean);
    data[o + j + 8] = f32(f32(f32(radius * f32(Math.sin(theta))) * std) + mean);
  }
}
