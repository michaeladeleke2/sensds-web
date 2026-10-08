// The range map figures, drawn on a canvas the way matplotlib 3.10 draws them:
//   live (range_map_live.py LiveRangePlot): axes [0.08, 0.12, 0.78, 0.78],
//     which fig.colorbar shrinks to [0.08, 0.12, 0.624, 0.78] with the bar at
//     x 0.743, 1/20 of the axes height wide; x = time of the frames filled so
//     far, y = range; title "<title>  |  frame N (newest → right)";
//   recording (range_map_v1.py plot_range_map): constrained layout, here as
//     the margins matplotlib computes for it (left 55, bottom 47, top 26.5,
//     right of the bar 78 pixels at 100 dpi), x = 0 .. duration.
// Both: imshow(cmap='jet', Normalize(vmin, vmax, clip=True), aspect='auto',
// origin='lower'), dashed white range grid at the y ticks above the image,
// colour bar labelled "dB", vmin/vmax from _jet_clim. Sizes in points at
// 100 dpi times the device pixel ratio, as the Qt backend uses.

import { makeImage, jetClim } from './image.js';
import { axisTicks, yTickSpace, xTickSpace } from './ticks.js';
import { JET_LUT_BYTES, lutIndex } from './jet.js';

const FONT = '"DejaVu Sans", "Bitstream Vera Sans", Verdana, Geneva, sans-serif';
const PT = { tickLabel: 10, label: 10, title: 12, tickLength: 3.5, tickWidth: 0.8, tickPad: 3.5, spine: 0.8, labelPad: 4.0, titlePad: 6.0, grid: 0.7 };
const DASH = [3.7, 1.6];

function snap(v, width) {
  const w = Math.max(1, Math.round(width));
  return w % 2 ? Math.floor(v) + 0.5 : Math.round(v);
}

export class RangeMapPlot {
  // layout: 'live' or 'recording'
  constructor(canvas, { layout = 'live', jetVmin = -20.0, title = 'Range map (live)', frameRepetitionTimeS = 0.1 }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    Object.assign(this, { layout, jetVmin, title, frameRepetitionTimeS });
    this.last = null;
  }

  fit() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpi = 100 * dpr;
    return { W: w, H: h, s: this.dpi / 100 };
  }

  // Axes and colour bar rectangles in canvas pixels (y from the top)
  rects(W, H, s, withBar = true) {
    if (this.layout === 'live') {
      if (!withBar) return { ax: { x: 0.08 * W, y: H * (1 - 0.90), w: 0.78 * W, h: 0.78 * H } };
      const ax = { x: 0.08 * W, y: H * (1 - 0.90), w: 0.624 * W, h: 0.78 * H };
      return { ax, bar: { x: 0.743 * W, y: ax.y, w: ax.h / 20, h: ax.h } };
    }
    const left = 55.4 * s, bottom = 47.4 * s, top = 26.5 * s, right = 78 * s, gap = 0.055 * W;
    const h = H - top - bottom, barW = h / 20;
    const w = W - left - right - barW - gap;
    const ax = { x: left, y: top, w, h };
    return { ax, bar: { x: left + w + gap, y: top, w: barW, h } };
  }

  // rangeMap: Float64Array (frames x nBins), oldest first. rangeM: bin centres.
  // Live: frameEnd = frames received; the last nFilled rows are drawn.
  draw({ rows, nFilled, nBins, rangeM, frameEnd = null, durationS = null }) {
    this.last = { rows, nFilled, nBins, rangeM, frameEnd, durationS };
    const { W, H, s } = this.fit();
    const { ctx } = this, px = pt => pt * s * 100 / 72;
    const { ax, bar } = this.rects(W, H, s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

    // plot_data = history[-n_filled:].T, origin='lower': nearest range at the bottom
    const total = rows.length / nBins, first = total - nFilled;
    const plot = new Float64Array(nBins * nFilled);
    for (let t = 0; t < nFilled; t++) for (let b = 0; b < nBins; b++) plot[(nBins - 1 - b) * nFilled + t] = rows[(first + t) * nBins + b];
    const { vmin, vmax } = jetClim(plot, this.jetVmin);
    const img = makeImage(plot, nBins, nFilled, ax.w, ax.h, vmin, vmax);
    ctx.putImageData(new ImageData(img.rgba, img.outW, img.outH), Math.round(ax.x), Math.round(ax.y + ax.h - img.outH));

    const dr = rangeM.length > 1 ? rangeM[1] - rangeM[0] : 0;
    const near = rangeM[0] - 0.5 * dr, far = rangeM[rangeM.length - 1] + 0.5 * dr;
    let x0, x1;
    if (this.layout === 'live') { x1 = frameEnd * this.frameRepetitionTimeS; x0 = (frameEnd - nFilled) * this.frameRepetitionTimeS; }
    else { x0 = 0; x1 = durationS; }
    const yTicks = axisTicks(near, far, yTickSpace(ax.h, this.dpi)).filter(t => t.value >= near - 1e-9 && t.value <= far + 1e-9);
    const xTicks = x1 > x0 ? axisTicks(x0, x1, xTickSpace(ax.w, this.dpi)).filter(t => t.value >= x0 - 1e-9 && t.value <= x1 + 1e-9) : [];
    const yToPx = v => ax.y + ax.h * (1 - (v - near) / (far - near));
    const xToPx = v => ax.x + ax.w * (v - x0) / (x1 - x0);

    // Dashed white range grid above the image
    ctx.save();
    ctx.beginPath(); ctx.rect(ax.x, ax.y, ax.w, ax.h); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = px(PT.grid);
    ctx.setLineDash(DASH.map(d => px(d * PT.grid)));
    for (const t of yTicks) { const y = snap(yToPx(t.value), ctx.lineWidth); ctx.beginPath(); ctx.moveTo(ax.x, y); ctx.lineTo(ax.x + ax.w, y); ctx.stroke(); }
    ctx.restore();

    const title = this.layout === 'live' ? `${this.title}  |  frame ${frameEnd} (newest → right)` : this.title;
    this.frame(ax, px, yTicks.map(t => ({ ...t, pos: yToPx(t.value) })), xTicks.map(t => ({ ...t, pos: xToPx(t.value) })), title);
    this.colorbar(bar, px, vmin, vmax);
  }

  // range_map_live.py before the first frame: empty axes, no colour bar yet
  drawEmpty() {
    this.last = null;
    const { W, H, s } = this.fit();
    const { ctx } = this, px = pt => pt * s * 100 / 72;
    const { ax } = this.rects(W, H, s, this.layout !== 'live');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    const yTicks = axisTicks(0, 1, yTickSpace(ax.h, this.dpi)), xTicks = axisTicks(0, 1, xTickSpace(ax.w, this.dpi));
    this.frame(ax, px, yTicks.map(t => ({ ...t, pos: ax.y + ax.h * (1 - t.value) })), xTicks.map(t => ({ ...t, pos: ax.x + ax.w * t.value })),
      this.layout === 'live' ? `${this.title}  |  newest → right` : this.title);
  }

  frame(ax, px, yTicks, xTicks, title) {
    const { ctx } = this;
    ctx.strokeStyle = '#000000'; ctx.setLineDash([]); ctx.lineWidth = px(PT.spine);
    const sx0 = snap(ax.x, ctx.lineWidth), sx1 = snap(ax.x + ax.w, ctx.lineWidth);
    const sy0 = snap(ax.y, ctx.lineWidth), sy1 = snap(ax.y + ax.h, ctx.lineWidth);
    ctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    const tickLen = px(PT.tickLength), pad = px(PT.tickPad);
    ctx.lineWidth = px(PT.tickWidth);
    ctx.fillStyle = '#000000';
    ctx.font = `${px(PT.tickLabel)}px ${FONT}`;
    let maxYLabel = 0;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of yTicks) {
      const y = snap(t.pos, ctx.lineWidth);
      ctx.beginPath(); ctx.moveTo(sx0, y); ctx.lineTo(sx0 - tickLen, y); ctx.stroke();
      ctx.fillText(t.label, sx0 - tickLen - pad, t.pos);
      maxYLabel = Math.max(maxYLabel, ctx.measureText(t.label).width);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of xTicks) {
      const x = snap(t.pos, ctx.lineWidth);
      ctx.beginPath(); ctx.moveTo(x, sy1); ctx.lineTo(x, sy1 + tickLen); ctx.stroke();
      ctx.fillText(t.label, t.pos, sy1 + tickLen + pad);
    }
    ctx.font = `${px(PT.label)}px ${FONT}`;
    ctx.fillText('time (s)', ax.x + ax.w / 2, sy1 + tickLen + pad + px(PT.tickLabel) * 1.17 + px(PT.labelPad));
    ctx.save();
    ctx.translate(sx0 - tickLen - pad - maxYLabel - px(PT.labelPad), ax.y + ax.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText('range (m)', 0, 0);
    ctx.restore();
    ctx.font = `${px(PT.title)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, ax.x + ax.w / 2, ax.y - px(PT.titlePad) - px(PT.title) * 0.24);
  }

  // fig.colorbar(image, label="dB"): jet from vmin (bottom) to vmax (top), ticks on the right
  colorbar(bar, px, vmin, vmax) {
    const { ctx } = this;
    const x = Math.round(bar.x), y = Math.round(bar.y), w = Math.max(1, Math.round(bar.w)), h = Math.max(1, Math.round(bar.h));
    const img = ctx.createImageData(w, h);
    for (let r = 0; r < h; r++) {
      const k = lutIndex(1 - (r + 0.5) / h) * 3;
      for (let c = 0; c < w; c++) { const o = (r * w + c) * 4; img.data[o] = JET_LUT_BYTES[k]; img.data[o + 1] = JET_LUT_BYTES[k + 1]; img.data[o + 2] = JET_LUT_BYTES[k + 2]; img.data[o + 3] = 255; }
    }
    ctx.putImageData(img, x, y);
    ctx.strokeStyle = '#000000'; ctx.setLineDash([]); ctx.lineWidth = px(PT.spine);
    const sx0 = snap(x, ctx.lineWidth), sx1 = snap(x + w, ctx.lineWidth), sy0 = snap(y, ctx.lineWidth), sy1 = snap(y + h, ctx.lineWidth);
    ctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    const ticks = axisTicks(vmin, vmax, yTickSpace(h, this.dpi)).filter(t => t.value >= vmin - 1e-9 && t.value <= vmax + 1e-9);
    const tickLen = px(PT.tickLength), pad = px(PT.tickPad);
    ctx.lineWidth = px(PT.tickWidth);
    ctx.fillStyle = '#000000';
    ctx.font = `${px(PT.tickLabel)}px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let maxLabel = 0;
    for (const t of ticks) {
      const pos = y + h * (1 - (t.value - vmin) / (vmax - vmin)), yy = snap(pos, ctx.lineWidth);
      ctx.beginPath(); ctx.moveTo(sx1, yy); ctx.lineTo(sx1 + tickLen, yy); ctx.stroke();
      ctx.fillText(t.label, sx1 + tickLen + pad, pos);
      maxLabel = Math.max(maxLabel, ctx.measureText(t.label).width);
    }
    ctx.save();
    ctx.translate(sx1 + tickLen + pad + maxLabel + px(PT.labelPad), y + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `${px(PT.label)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('dB', 0, 0);
    ctx.restore();
  }

  redraw() { if (this.last) this.draw(this.last); else this.drawEmpty(); }
}
