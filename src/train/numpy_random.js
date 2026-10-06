// numpy.random.default_rng(seed): SeedSequence entropy mixing, the PCG64 bit
// generator (128-bit LCG with XSL-RR output) and Generator.shuffle, so the web
// app picks the same validation students as SensDSv2 (np.random.default_rng(42)).
// Ported from numpy/random/bit_generator.pyx, _pcg64.pyx, pcg64.h and
// distributions.c (random_interval).

const M32 = 0xFFFFFFFFn, M64 = (1n << 64n) - 1n, M128 = (1n << 128n) - 1n;
const mul32 = (a, b) => Number((BigInt(a) * BigInt(b)) & M32);

const INIT_A = 0x43b0d7e5, MULT_A = 0x931e8875, INIT_B = 0x8b51f9dd, MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd, MIX_MULT_R = 0x4973f715, XSHIFT = 16, POOL = 4;

function seedSequenceState(seed, nWords64) {
  const entropy = [];
  let s = BigInt(seed);
  do { entropy.push(Number(s & M32)); s >>= 32n; } while (s > 0n);      // _coerce_to_uint32_array
  const hashConst = [INIT_A];
  const hashmix = value => {
    value = (value ^ hashConst[0]) >>> 0;
    hashConst[0] = mul32(hashConst[0], MULT_A);
    value = mul32(value, hashConst[0]);
    return (value ^ (value >>> XSHIFT)) >>> 0;
  };
  const mix = (x, y) => {
    let r = Number((BigInt(MIX_MULT_L) * BigInt(x) - BigInt(MIX_MULT_R) * BigInt(y)) & M32);
    return (r ^ (r >>> XSHIFT)) >>> 0;
  };
  const pool = new Array(POOL);
  for (let i = 0; i < POOL; i++) pool[i] = hashmix(i < entropy.length ? entropy[i] : 0);
  for (let src = 0; src < POOL; src++)
    for (let dst = 0; dst < POOL; dst++)
      if (src !== dst) pool[dst] = mix(pool[dst], hashmix(pool[src]));
  for (let src = POOL; src < entropy.length; src++)
    for (let dst = 0; dst < POOL; dst++) pool[dst] = mix(pool[dst], hashmix(entropy[src]));
  // generate_state(n_words, uint64): 2 * n words of 32 bits, low word first
  let hc = INIT_B;
  const words = [];
  for (let i = 0; i < nWords64 * 2; i++) {
    let v = (pool[i % POOL] ^ hc) >>> 0;
    hc = mul32(hc, MULT_B);
    v = mul32(v, hc);
    words.push((v ^ (v >>> XSHIFT)) >>> 0);
  }
  const out = [];
  for (let i = 0; i < nWords64; i++) out.push(BigInt(words[2 * i]) | (BigInt(words[2 * i + 1]) << 32n));
  return out;
}

const PCG_MULT = (2549297995355413924n << 64n) + 4865540595714422341n;

export class PCG64 {
  constructor(seed) {
    const [s0, s1, i0, i1] = seedSequenceState(seed, 4);
    const initstate = (s0 << 64n) | s1, initseq = (i0 << 64n) | i1;
    this.inc = ((initseq << 1n) | 1n) & M128;
    this.state = 0n;
    this._step();
    this.state = (this.state + initstate) & M128;
    this._step();
    this.hasUint32 = false;
    this.uinteger = 0;
  }
  _step() { this.state = (this.state * PCG_MULT + this.inc) & M128; }
  nextUint64() {
    this._step();
    const s = this.state;
    const x = ((s >> 64n) ^ s) & M64, rot = s >> 122n;
    return ((x >> rot) | (x << ((64n - rot) & 63n))) & M64;
  }
  nextUint32() {
    if (this.hasUint32) { this.hasUint32 = false; return this.uinteger; }
    const n = this.nextUint64();
    this.hasUint32 = true;
    this.uinteger = Number(n >> 32n);
    return Number(n & M32);
  }
  // random_interval(max): uniform in [0, max] by masked rejection
  randomInterval(max) {
    if (max === 0) return 0;
    let mask = max;
    mask |= mask >>> 1; mask |= mask >>> 2; mask |= mask >>> 4; mask |= mask >>> 8; mask |= mask >>> 16;
    mask >>>= 0;
    let v;
    if (max <= 0xFFFFFFFF) { do { v = (this.nextUint32() & mask) >>> 0; } while (v > max); return v; }
    throw new Error('random_interval above 32 bits is not needed here');
  }
  // Generator.shuffle on a 1-D array, in place
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.randomInterval(i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  // Uniform double in [0, 1): (next_uint64 >> 11) * 2**-53, as random_standard_uniform
  random() { return Number(this.nextUint64() >> 11n) / 9007199254740992; }
}

export const defaultRng = seed => new PCG64(seed);
