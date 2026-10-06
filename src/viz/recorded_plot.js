// ReferenceRecordedView / plot_recorded_spectrogram from SensDSv2: one finished
// capture drawn by the reference script's offline path. Its axes cover the
// whole figure ([0, 0, 1, 1]), so the picture fills the panel with no tick
// labels or title visible, and the dashed white velocity grid sits on top.

import { makeImage, jetClim } from './image.js';
import { axisTicks, yTickSpace } from './ticks.js';

const DASH = [3.7, 1.6], GRID_PT = 0.7, MAX_SPEED = 6.19405905;

export class RecordedSpectrogramPlot {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.last = null; }

  // spectrogram: Float64Array (nFrame x bins), as compute_recorded returns it
  draw(spectrogram, nFrame, bins, jetVmin) {
    this.last = { spectrogram, nFrame, bins, jetVmin };
    const dpr = window.devicePixelRatio || 1, r = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const dpi = 100 * dpr, px = pt => pt * dpi / 72, ctx = this.ctx;

    const plot = new Float64Array(bins * nFrame);                 // spectrogram.T
    for (let f = 0; f < nFrame; f++) for (let b = 0; b < bins; b++) plot[b * nFrame + f] = spectrogram[f * bins + b];
    const { vmin, vmax } = jetClim(plot, jetVmin);
    const img = makeImage(plot, bins, nFrame, W, H, vmin, vmax);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.putImageData(new ImageData(img.rgba, img.outW, img.outH), 0, 0);

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = px(GRID_PT);
    ctx.setLineDash(DASH.map(d => px(d * GRID_PT)));
    for (const t of axisTicks(-MAX_SPEED, MAX_SPEED, yTickSpace(H, dpi))) {
      const y = Math.floor(H * (1 - (t.value + MAX_SPEED) / (2 * MAX_SPEED))) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }

  redraw(jetVmin) {
    if (!this.last) return;
    const { spectrogram, nFrame, bins } = this.last;
    this.draw(spectrogram, nFrame, bins, jetVmin ?? this.last.jetVmin);
  }
}
