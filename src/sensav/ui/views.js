// SensAV's drawing widgets on <canvas>: the camera view (mirrored picture,
// the saved square outlined, the rest shaded), the scrolling mel spectrogram
// (5 seconds, inferno colours, pitch labels), the overlays both share
// (recording frame and badge, countdown, prediction badge), the per-epoch
// line charts and the confetti burst after training
// (app/ui/widgets/camera_view.py, spectrogram_view.py, overlays.py,
// training_views.py).

import { INFERNO, infernoIndex } from './inferno.js';
import { COLUMNS_PER_SECOND, MEL_TICKS_HZ, N_MELS, melBinForHz, toUnit } from '../ml/audio_features.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const FONT = '"Inter", "Segoe UI", "SF Pro Text", "Helvetica Neue", Arial, sans-serif';

// Keeps a canvas's backing store at its CSS size times the pixel ratio
function fit(canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: canvas.clientWidth, h: canvas.clientHeight };
}

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

class Overlays {
  constructor() { this.recording = null; this.recordColor = '#E5484D'; this.progress = null; this.countdown = null; this.prediction = null; }
  setRecording(text, color) { this.recording = text; if (color) this.recordColor = color; if (text === null) this.progress = null; }
  setProgress(p) { this.progress = p; }
  setCountdown(v) { this.countdown = v; }
  setPrediction(text, color) { this.prediction = text ? [text, color || '#999999'] : null; }

  draw(ctx, w, h) {
    ctx.textAlign = 'left';
    if (this.recording !== null) {
      ctx.save();
      ctx.strokeStyle = this.recordColor; ctx.lineWidth = 4;
      roundRect(ctx, 2, 2, w - 4, h - 4, 11); ctx.stroke();
      ctx.font = `700 14px ${FONT}`;
      const bw = ctx.measureText(this.recording).width + 44;
      ctx.fillStyle = 'rgba(0,0,0,0.67)'; roundRect(ctx, 16, 16, bw, 34, 17); ctx.fill();
      ctx.fillStyle = '#FF3B30'; ctx.beginPath(); ctx.arc(34, 33, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFFFFF'; ctx.textBaseline = 'middle'; ctx.fillText(this.recording, 48, 33.5);
      if (this.progress !== null) {
        ctx.fillStyle = 'rgba(255,255,255,0.24)'; roundRect(ctx, 30, 58, bw - 28, 4, 2); ctx.fill();
        ctx.fillStyle = '#FFFFFF'; roundRect(ctx, 30, 58, (bw - 28) * Math.max(0, Math.min(1, this.progress)), 4, 2); ctx.fill();
      }
      ctx.restore();
    }
    if (this.countdown !== null) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, w, h);
      const r = Math.min(w, h) * 0.16;
      ctx.fillStyle = 'rgba(0,0,0,0.67)'; ctx.beginPath(); ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFFFFF'; ctx.font = `700 ${Math.round(r * 1.1)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(this.countdown), w / 2, h / 2 + r * 0.04);
      ctx.restore();
    }
    if (this.prediction) {
      const [text, color] = this.prediction;
      ctx.save();
      ctx.font = `700 17px ${FONT}`;
      const bw = ctx.measureText(text).width + 46;
      ctx.fillStyle = 'rgba(0,0,0,0.69)'; roundRect(ctx, 16, h - 58, bw, 42, 21); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(37, h - 37, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFFFFF'; ctx.textBaseline = 'middle'; ctx.fillText(text, 52, h - 36.5);
      ctx.restore();
    }
  }
}

export class CameraView extends Overlays {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.source = null;
    this.showCrop = true;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setFrame(video) { this.source = video; this.draw(); }
  clear() { this.source = null; this.recording = null; this.countdown = null; this.prediction = null; this.draw(); }

  draw() {
    if (this.canvas.hidden || !this.canvas.clientWidth) return;
    const { ctx, w, h } = fit(this.canvas);
    ctx.fillStyle = css('--stage'); ctx.fillRect(0, 0, w, h);
    const v = this.source;
    if (v && v.videoWidth) {
      const s = Math.min(w / v.videoWidth, h / v.videoHeight), tw = v.videoWidth * s, th = v.videoHeight * s;
      const x = (w - tw) / 2, y = (h - th) / 2;
      ctx.save(); ctx.translate(x + tw, y); ctx.scale(-1, 1); ctx.drawImage(v, 0, 0, tw, th); ctx.restore();
      if (this.showCrop) {
        const side = Math.min(tw, th), sx = x + (tw - side) / 2, sy = y + (th - side) / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.43)';
        ctx.fillRect(x, y, sx - x, th); ctx.fillRect(sx + side, y, x + tw - sx - side, th);
        ctx.strokeStyle = 'rgba(255,255,255,0.59)'; ctx.lineWidth = 1.5;
        roundRect(ctx, sx + 1, sy + 1, side - 2, side - 2, 8); ctx.stroke();
      }
    }
    super.draw(ctx, w, h);
  }
}

const DISPLAY_SECONDS = 5;
const hzLabel = hz => (hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`);

export class SpectrogramView extends Overlays {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.width = DISPLAY_SECONDS * COLUMNS_PER_SECOND;
    this.buffer = new Float32Array(N_MELS * this.width);     // unit values, row-major (mel x time)
    this.boundaries = [];                                      // [seconds from now (<= 0), color]
    this.image = new ImageData(this.width, N_MELS);
    this.off = document.createElement('canvas');
    this.off.width = this.width; this.off.height = N_MELS;
    this.pending = false;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  appendDb({ data, cols }) {
    if (!cols) return;
    const unit = toUnit(data), W = this.width;
    for (let m = 0; m < N_MELS; m++) {
      const row = this.buffer.subarray(m * W, (m + 1) * W);
      if (cols >= W) row.set(unit.subarray(m * cols + cols - W, (m + 1) * cols));
      else { row.copyWithin(0, cols); row.set(unit.subarray(m * cols, (m + 1) * cols), W - cols); }
    }
    const shift = cols / COLUMNS_PER_SECOND;
    this.boundaries = this.boundaries.map(([p, c]) => [p - shift, c]).filter(([p]) => p >= -DISPLAY_SECONDS);
    this.requestDraw();
  }

  markClip(color) { this.boundaries.push([0, color]); this.requestDraw(); }

  clear() {
    this.buffer.fill(0); this.boundaries = [];
    this.recording = null; this.countdown = null; this.prediction = null; this.progress = null;
    this.draw();
  }

  requestDraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.draw(); });
  }

  draw() {
    if (this.canvas.hidden || !this.canvas.clientWidth) return;
    const { ctx, w, h } = fit(this.canvas);
    ctx.fillStyle = css('--stage'); ctx.fillRect(0, 0, w, h);
    const W = this.width, px = this.image.data;
    for (let m = 0; m < N_MELS; m++) {
      const y = N_MELS - 1 - m;            // low pitches at the bottom
      for (let t = 0; t < W; t++) {
        const k = infernoIndex(this.buffer[m * W + t]) * 3, o = (y * W + t) * 4;
        px[o] = INFERNO[k]; px[o + 1] = INFERNO[k + 1]; px[o + 2] = INFERNO[k + 2]; px[o + 3] = 255;
      }
    }
    this.off.getContext('2d').putImageData(this.image, 0, 0);
    const left = 62, right = 18, top = 14, bottom = 30;
    const pw = Math.max(1, w - left - right), ph = Math.max(1, h - top - bottom);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, left, top, pw, ph);
    ctx.fillStyle = css('--stage-text'); ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const hz of MEL_TICKS_HZ) {
      const y = top + ph - ((melBinForHz(hz) + 0.5) / N_MELS) * ph;
      ctx.fillText(hzLabel(hz), left - 8, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let s = DISPLAY_SECONDS; s >= 0; s--) {
      const x = left + pw * (1 - s / DISPLAY_SECONDS);
      ctx.fillText(s === 0 ? 'now' : `${s} s ago`, Math.min(w - 20, Math.max(left + 14, x)), top + ph + 8);
    }
    ctx.lineWidth = 2;
    for (const [p, c] of this.boundaries) {
      const x = left + pw * (1 + p / DISPLAY_SECONDS);
      ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke();
    }
    super.draw(ctx, w, h);
  }
}

export const TRAIN_COLOR = '#2F6FED';
export const VALIDATION_COLOR = '#F07F2A';

// Accuracy or loss per epoch, training and validation lines
export class MetricChart {
  constructor(canvas, percent) {
    this.canvas = canvas; this.percent = percent; this.history = []; this.epochs = 2;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  reset(epochs) { this.history = []; this.epochs = Math.max(2, epochs); this.draw(); }
  setHistory(history, epochs) { this.history = history; this.epochs = Math.max(2, epochs); this.draw(); }

  draw() {
    if (!this.canvas.clientWidth) return;
    const { ctx, w, h } = fit(this.canvas);
    ctx.fillStyle = css('--surface'); ctx.fillRect(0, 0, w, h);
    const key = this.percent ? 'accuracy' : 'loss', vkey = this.percent ? 'val_accuracy' : 'val_loss';
    const values = this.history.flatMap(r => [r[key], r[vkey]]).filter(v => v !== null && v !== undefined && Number.isFinite(v));
    let lo = 0, hi = 1;
    if (!this.percent) { hi = values.length ? Math.max(...values) : 1; lo = values.length ? Math.min(0, ...values) : 0; if (hi <= lo) hi = lo + 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const left = 44, right = 10, top = 6, bottom = 30, pw = w - left - right, ph = h - top - bottom;
    const X = e => left + ((e - 1) / Math.max(1, this.epochs - 1)) * pw, Y = v => top + ph - ((v - lo) / (hi - lo)) * ph;
    ctx.font = `11px ${FONT}`; ctx.fillStyle = css('--text-secondary'); ctx.strokeStyle = css('--border-strong'); ctx.lineWidth = 1;
    const ticks = this.percent ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(lo + pad, hi - pad, 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of ticks) {
      const y = Y(t);
      ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + pw, y); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillText(this.percent ? `${Math.round(t * 100)}%` : fmtTick(t), left - 6, y);
    }
    ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(left, top + ph); ctx.lineTo(left + pw, top + ph); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const e of niceTicks(1, this.epochs, 5).filter(e => Number.isInteger(e) && e >= 1 && e <= this.epochs)) ctx.fillText(String(e), X(e), top + ph + 4);
    ctx.fillText('epoch', left + pw / 2, top + ph + 17);
    for (const [k, color] of [[key, TRAIN_COLOR], [vkey, VALIDATION_COLOR]]) {
      const pts = this.history.filter(r => r[k] !== null && r[k] !== undefined);
      if (!pts.length) continue;
      ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.beginPath();
      pts.forEach((r, i) => (i ? ctx.lineTo(X(r.epoch), Y(r[k])) : ctx.moveTo(X(r.epoch), Y(r[k]))));
      ctx.stroke();
      if (pts.length === 1) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(pts[0].epoch), Y(pts[0][k]), 2.5, 0, Math.PI * 2); ctx.fill(); }
    }
  }
}

function niceTicks(lo, hi, n) {
  const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => span / s <= n) ?? 10 * mag;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Math.round(t / step) * step);
  return out;
}
const fmtTick = v => (Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));

// CelebrationOverlay: 70 falling confetti pieces for 1.8 s
export function celebrate(canvas, colors) {
  const parent = canvas.parentElement;
  canvas.hidden = false;
  canvas.style.width = `${parent.clientWidth}px`; canvas.style.height = `${parent.clientHeight}px`;
  const choices = [...colors, css('--accent')];
  const W = parent.clientWidth;
  const parts = Array.from({ length: 70 }, () => ({
    x: (0.1 + Math.random() * 0.8) * W, y: -60 + Math.random() * 80, vx: -60 + Math.random() * 120, vy: 40 + Math.random() * 180,
    size: 4 + Math.random() * 4, spin: Math.random() * Math.PI * 2, color: choices[Math.floor(Math.random() * choices.length)],
  }));
  const t0 = performance.now();
  const frame = () => {
    const t = (performance.now() - t0) / 1000;
    if (t > 1.8) { canvas.hidden = true; return; }
    const { ctx, w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = Math.max(0, 1 - t / 1.8);
    for (const p of parts) {
      ctx.save();
      ctx.translate(p.x + p.vx * t, p.y + p.vy * t + 180 * t * t);
      ctx.rotate(p.spin + t * 6);
      ctx.fillStyle = p.color;
      roundRect(ctx, -p.size / 2, -p.size / 4, p.size, p.size / 2, 1); ctx.fill();
      ctx.restore();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Thumbnail of a clip: its spectrogram picture in inferno colours
export function spectrogramThumb(gray, size, canvas) {
  canvas.width = canvas.height = size;
  const img = new ImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const k = gray[i] * 3;     // unit_to_rgb: int(unit * 255)
    img.data[4 * i] = INFERNO[k]; img.data[4 * i + 1] = INFERNO[k + 1]; img.data[4 * i + 2] = INFERNO[k + 2]; img.data[4 * i + 3] = 255;
  }
  canvas.getContext('2d').putImageData(img, 0, 0);
}
