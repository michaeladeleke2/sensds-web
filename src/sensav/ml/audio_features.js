// SensAV's sound features (app/ml/audio_features.py): 16 kHz mono, 1 second
// clips, a 64-band log mel spectrogram (512-point FFT of a 400-sample Hann
// window every 160 samples, 60 Hz to 7.6 kHz), the 0..1 scaling from -90 to
// -10 dB, the 224x224 grey picture the backbone sees (flipped so low pitches
// are at the bottom, cv2.resize INTER_LINEAR, truncated to 8 bits), the
// streaming version the live view uses, the 63-tap windowed-sinc resampler,
// and 16-bit WAV files written and read the way the desktop does.

import { fft } from '../../dsp/fft.js';
import { resizeLinearF32 } from './image_ops.js';

export const SAMPLE_RATE = 16000;
export const CLIP_SAMPLES = SAMPLE_RATE;
export const N_FFT = 512;
export const WIN_LENGTH = 400;
export const HOP_LENGTH = 160;
export const N_MELS = 64;
export const FMIN = 60.0;
export const FMAX = 7600.0;
export const DB_FLOOR = -90.0;
export const DB_CEIL = -10.0;
export const COLUMNS_PER_SECOND = SAMPLE_RATE / HOP_LENGTH;
export const MEL_TICKS_HZ = [250, 500, 1000, 2000, 4000];
const N_BINS = N_FFT / 2 + 1;
const f32 = Math.fround;

export const hzToMel = hz => 2595.0 * Math.log10(1.0 + hz / 700.0);
export const melToHz = mel => 700.0 * (10.0 ** (mel / 2595.0) - 1.0);

const linspace = (a, b, n) => Float64Array.from({ length: n }, (_, i) => (n === 1 ? a : a + (b - a) * i / (n - 1)));

let bankCache = null;
// (N_MELS x N_BINS) float32, each row normalised to sum 1
export function melFilterbank() {
  if (bankCache) return bankCache;
  const freqs = linspace(0, SAMPLE_RATE / 2, N_BINS);
  const hz = linspace(hzToMel(FMIN), hzToMel(FMAX), N_MELS + 2).map(melToHz);
  const bank = new Float32Array(N_MELS * N_BINS);
  for (let i = 0; i < N_MELS; i++) {
    const [left, center, right] = [hz[i], hz[i + 1], hz[i + 2]];
    let sum = 0;
    for (let k = 0; k < N_BINS; k++) {
      const rising = (freqs[k] - left) / (center - left), falling = (right - freqs[k]) / (right - center);
      bank[i * N_BINS + k] = Math.max(0, Math.min(rising, falling));
    }
    for (let k = 0; k < N_BINS; k++) sum = f32(sum + bank[i * N_BINS + k]);
    const div = Math.max(sum, 1e-8);
    for (let k = 0; k < N_BINS; k++) bank[i * N_BINS + k] = f32(bank[i * N_BINS + k] / div);
  }
  return (bankCache = bank);
}

let windowCache = null;
// np.hanning(400) centred in 512 samples
export function analysisWindow() {
  if (windowCache) return windowCache;
  const w = new Float32Array(N_FFT), offset = (N_FFT - WIN_LENGTH) / 2;
  for (let n = 0; n < WIN_LENGTH; n++) w[offset + n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (WIN_LENGTH - 1));
  return (windowCache = w);
}

let powerScale = 0;
function scale() {
  if (!powerScale) {
    const w = analysisWindow();
    let s = 0;
    for (let i = 0; i < N_FFT; i++) s += w[i];
    powerScale = 4.0 / (f32(s) ** 2);
  }
  return powerScale;
}

// Fractional mel row for a frequency (axis ticks)
export const melBinForHz = hz => ((hzToMel(hz) - hzToMel(FMIN)) / (hzToMel(FMAX) - hzToMel(FMIN))) * (N_MELS + 1) - 1;

// Frames starting every HOP_LENGTH samples in signal[0 .. ]: returns
// (N_MELS x count) float32 in dB, column-major by frame as numpy's .T gives
// row i = mel band i.
function logMelFromFrames(signal, count) {
  const w = analysisWindow(), bank = melFilterbank(), k = scale();
  const out = new Float32Array(N_MELS * count);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), power = new Float64Array(N_BINS);
  for (let c = 0; c < count; c++) {
    const start = c * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) { re[i] = f32(signal[start + i] * w[i]); im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < N_BINS; b++) power[b] = f32(f32(re[b] * re[b] + im[b] * im[b]) * k);
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const row = m * N_BINS;
      for (let b = 0; b < N_BINS; b++) s += power[b] * bank[row + b];
      out[m * count + c] = 10.0 * Math.log10(f32(s) + 1e-12);
    }
  }
  return out;
}

// log_mel(signal): (N_MELS x count) float32, with count = 1 + (len - 512) // 160
export function logMel(signal) {
  let s = signal;
  if (s.length < N_FFT) { const p = new Float32Array(N_FFT); p.set(s); s = p; }
  const count = 1 + Math.floor((s.length - N_FFT) / HOP_LENGTH);
  return { data: logMelFromFrames(s, count), rows: N_MELS, cols: count };
}

export function toUnit(db) {
  const out = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) out[i] = Math.min(1, Math.max(0, f32((db[i] - DB_FLOOR) / (DB_CEIL - DB_FLOOR))));
  return out;
}

export function fitClip(signal) {
  if (signal.length >= CLIP_SAMPLES) return signal.subarray(0, CLIP_SAMPLES);
  const out = new Float32Array(CLIP_SAMPLES);
  out.set(signal);
  return out;
}

// clip_image: the grey 224x224 picture of a clip (one channel; the desktop
// repeats it into three)
export function clipImageGray(signal, size = 224) {
  const { data, rows, cols } = logMel(fitClip(signal));
  const unit = toUnit(data);
  const flipped = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) flipped.set(unit.subarray((rows - 1 - r) * cols, (rows - r) * cols), r * cols);
  const resized = resizeLinearF32(flipped, cols, rows, size, size);
  const gray = new Uint8Array(size * size);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.min(255, Math.max(0, f32(resized[i] * 255.0)));   // astype(uint8) truncates
  return gray;
}

// The same picture as 224x224x3 RGB, as the backbone takes it
export function clipImageRgb(signal, size = 224) {
  const gray = clipImageGray(signal, size), rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < gray.length; i++) rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = gray[i];
  return rgb;
}

// Live spectrogram: feed any number of samples, get the new columns
export class StreamingMel {
  constructor() { this.pending = new Float32Array(0); }
  reset() { this.pending = new Float32Array(0); }
  // Returns { data (N_MELS x count), cols: count }
  push(samples) {
    const buffer = new Float32Array(this.pending.length + samples.length);
    buffer.set(this.pending); buffer.set(samples, this.pending.length);
    if (buffer.length < N_FFT) { this.pending = buffer; return { data: new Float32Array(0), cols: 0 }; }
    const count = 1 + Math.floor((buffer.length - N_FFT) / HOP_LENGTH);
    const data = logMelFromFrames(buffer, count);
    this.pending = buffer.slice(count * HOP_LENGTH);
    return { data, cols: count };
  }
}

const sinc = x => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

// Resampler(in_rate, out_rate): 63-tap low-pass, then linear interpolation at
// in/out steps, keeping its state between calls
export class Resampler {
  static TAPS = 63;
  constructor(inRate, outRate = SAMPLE_RATE) {
    this.inRate = inRate; this.outRate = outRate;
    this.passthrough = Math.abs(inRate - outRate) < 1e-6;
    this.step = inRate / outRate;
    const T = Resampler.TAPS, cutoff = Math.min(1.0, outRate / inRate) * 0.9;
    const taps = new Float64Array(T);
    let sum = 0;
    for (let i = 0; i < T; i++) {
      const n = i - (T - 1) / 2;
      const hamming = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (T - 1));
      taps[i] = cutoff * sinc(cutoff * n) * hamming;
    }
    for (let i = 0; i < T; i++) sum += taps[i];
    this.taps = Float32Array.from(taps, v => v / sum);
    this.history = new Float32Array(T - 1);
    this.last = new Float32Array(1);
    this.position = 1.0;
  }

  process(samples) {
    if (this.passthrough || samples.length === 0) return samples;
    const T = Resampler.TAPS, taps = this.taps;
    const padded = new Float32Array(this.history.length + samples.length);
    padded.set(this.history); padded.set(samples, this.history.length);
    // np.convolve(padded, taps, 'valid'): out[i] = sum_k padded[i + k] * taps[T-1-k]
    const nOut = padded.length - T + 1;
    const buffer = new Float32Array(nOut + 1);
    buffer[0] = this.last[0];
    for (let i = 0; i < nOut; i++) {
      let s = 0;
      for (let k = 0; k < T; k++) s += padded[i + k] * taps[T - 1 - k];
      buffer[i + 1] = s;
    }
    this.history = padded.slice(padded.length - (T - 1));
    const limit = buffer.length - 1;
    // np.arange(position, limit + 1e-9, step), filled as numpy does
    const start = this.position, stop = limit + 1e-9;
    const n = Math.max(0, Math.ceil((stop - start) / this.step));
    const delta = (start + this.step) - start;
    const out = new Float32Array(n);
    let lastPos = 0;
    for (let i = 0; i < n; i++) {
      const x = i === 0 ? start : start + i * delta;
      lastPos = x;
      // np.interp(x, arange(len(buffer)), buffer)
      let v;
      if (x >= limit) v = buffer[limit];
      else if (x <= 0) v = buffer[0];
      else {
        const j = Math.floor(x);
        const slope = buffer[j + 1] - buffer[j];
        v = slope * (x - j) + buffer[j];
      }
      out[i] = v;
    }
    const next = n ? lastPos + this.step : this.position;
    this.position = next - limit;
    this.last = buffer.slice(buffer.length - 1);
    return out;
  }
}

// write_wav: 16-bit mono PCM, the same bytes Python's wave module writes
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const n = samples.length, out = new Uint8Array(44 + 2 * n), dv = new DataView(out.buffer);
  const ascii = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + 2 * n, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ascii(36, 'data'); dv.setUint32(40, 2 * n, true);
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.max(-1, samples[i]));
    dv.setInt16(44 + 2 * i, Math.trunc(f32(v * 32767.0)), true);
  }
  return out;
}

// read_wav: 16-bit PCM of any rate and channel count -> 16 kHz mono float32
export function decodeWav(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12, channels = 1, width = 2, rate = SAMPLE_RATE, data = null;
  while (o + 8 <= b.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') { channels = dv.getUint16(body + 2, true); rate = dv.getUint32(body + 4, true); width = dv.getUint16(body + 14, true) / 8; }
    else if (id === 'data') { data = [body, Math.min(size, b.length - body)]; break; }
    o = body + size + (size & 1);
  }
  if (!data) throw new Error('The WAV file has no sound data');
  if (width !== 2) throw new Error('The WAV file is not 16 bit audio');
  const frames = Math.floor(data[1] / (2 * channels));
  let samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    if (channels === 1) samples[i] = dv.getInt16(data[0] + 2 * i, true) / 32768.0;
    else {
      let s = 0;
      for (let c = 0; c < channels; c++) s = f32(s + f32(dv.getInt16(data[0] + 2 * (i * channels + c), true) / 32768.0));
      samples[i] = s / channels;
    }
  }
  if (rate !== SAMPLE_RATE) samples = new Resampler(rate, SAMPLE_RATE).process(samples);
  return samples;
}
