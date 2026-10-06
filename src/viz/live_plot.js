// LiveSpectrogramPlot from SensDSv2 core/doppler_spectrogram_live.py, drawn on
// a canvas the way matplotlib 3.10 lays it out with default rcParams:
//   axes rect [0.08, 0.10, 0.88, 0.82] of the figure, white figure,
//   imshow(cmap='jet', aspect='auto', origin='upper',
//          extent=[frame_start, frame_end, -max_speed, +max_speed]),
//   dashed white velocity grid (linewidth 0.7, alpha 0.55) above the image,
//   title "<title>  |  frame N (newest → right)", labels "frame" and
//   "velocity (m/s)", ticks out on left and bottom.
// Sizes in points are converted at 100 dpi times the device pixel ratio,
// as the Qt backend does on high-DPI screens.

import { makeImage, jetClim, historyToPlotData } from './image.js';
import { axisTicks, yTickSpace, xTickSpace } from './ticks.js';

const AXES_RECT = [0.08, 0.10, 0.88, 0.82];
const FONT = '"DejaVu Sans", "Bitstream Vera Sans", Verdana, Geneva, sans-serif';
const PT = {
  tickLabel: 10, label: 10, title: 12,          // font.size 10, axes.titlesize 'large'
  tickLength: 3.5, tickWidth: 0.8, tickPad: 3.5, // xtick/ytick.major.*
  spine: 0.8,                                    // axes.linewidth
  labelPad: 4.0, titlePad: 6.0,                  // axes.labelpad, axes.titlepad
  grid: 0.7,                                     // _add_velocity_grid linewidth
};
const DASH = [3.7, 1.6];                         // lines.dashed_pattern, scaled by linewidth

export class LiveSpectrogramPlot {
  constructor(canvas, { historyLength, maxSpeed = 6.19405905, jetVmin = -20.0, title = 'Doppler Spectrogram (live)' }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    Object.assign(this, { historyLength, maxSpeed, jetVmin, title });
    this.last = null;
  }

  // Resize the backing store to the element size times the device pixel ratio.
  fit() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpi = 100 * dpr;
  }

  // history: Float64Array (historyLength x dopplerBins), oldest row first.
  draw(history, frameEnd, dopplerBins = 512) {
    this.last = { history, frameEnd, dopplerBins };
    this.fit();
    const { ctx, dpi } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const px = pt => pt * dpi / 72;

    const ax = { x: AXES_RECT[0] * W, w: AXES_RECT[2] * W, h: AXES_RECT[3] * H };
    ax.y = H - (AXES_RECT[1] + AXES_RECT[3]) * H;   // top, canvas coordinates

    const frameStart = Math.max(0, frameEnd - this.historyLength);
    const xlim = [frameStart, frameEnd];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Image
    const plot = historyToPlotData(history, this.historyLength, dopplerBins);
    const { vmin, vmax } = jetClim(plot, this.jetVmin);
    const img = makeImage(plot, dopplerBins, this.historyLength, ax.w, ax.h, vmin, vmax);
    const left = Math.round(ax.x), top = Math.round(H - (AXES_RECT[1] * H + img.outH));
    ctx.putImageData(new ImageData(img.rgba, img.outW, img.outH), left, top);

    // Ticks
    const yTicks = axisTicks(-this.maxSpeed, this.maxSpeed, yTickSpace(ax.h, dpi));
    const xTicks = frameEnd > frameStart ? axisTicks(xlim[0], xlim[1], xTickSpace(ax.w, dpi)) : [];
    const yToPx = v => ax.y + ax.h * (1 - (v + this.maxSpeed) / (2 * this.maxSpeed));
    const xToPx = v => ax.x + ax.w * (v - xlim[0]) / (xlim[1] - xlim[0]);

    // Velocity grid, drawn above the image (set_axisbelow(False))
    ctx.save();
    ctx.beginPath();
    ctx.rect(ax.x, ax.y, ax.w, ax.h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = px(PT.grid);
    ctx.setLineDash(DASH.map(d => px(d * PT.grid)));
    for (const t of yTicks) {
      const y = snap(yToPx(t.value), ctx.lineWidth);
      ctx.beginPath(); ctx.moveTo(ax.x, y); ctx.lineTo(ax.x + ax.w, y); ctx.stroke();
    }
    ctx.restore();

    this._frame(ax, px, yTicks.map(t => ({ ...t, pos: yToPx(t.value) })),
      xTicks.map(t => ({ ...t, pos: xToPx(t.value) })), `${this.title}  |  frame ${frameEnd} (newest \u2192 right)`);
  }

  // Before the first frame: the figure LiveSpectrogramPlot.__init__ leaves,
  // empty axes on matplotlib's default 0..1 limits and the initial title.
  drawEmpty() {
    this.last = null;
    this.fit();
    const { ctx, dpi } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const px = pt => pt * dpi / 72;
    const ax = { x: AXES_RECT[0] * W, w: AXES_RECT[2] * W, h: AXES_RECT[3] * H };
    ax.y = H - (AXES_RECT[1] + AXES_RECT[3]) * H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    const yTicks = axisTicks(0, 1, yTickSpace(ax.h, dpi));
    const xTicks = axisTicks(0, 1, xTickSpace(ax.w, dpi));
    // The velocity grid is white on the still-white axes here, so nothing shows.
    this._frame(ax, px, yTicks.map(t => ({ ...t, pos: ax.y + ax.h * (1 - t.value) })),
      xTicks.map(t => ({ ...t, pos: ax.x + ax.w * t.value })), `${this.title}  |  newest → right`);
  }

  // Spines, ticks, tick labels, axis labels and title, shared by draw and drawEmpty.
  _frame(ax, px, yTicks, xTicks, title) {
    const { ctx } = this;
    ctx.strokeStyle = '#000000';
    ctx.setLineDash([]);
    ctx.lineWidth = px(PT.spine);
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
    ctx.fillText('frame', ax.x + ax.w / 2, sy1 + tickLen + pad + px(PT.tickLabel) * 1.17 + px(PT.labelPad));
    ctx.save();
    ctx.translate(sx0 - tickLen - pad - maxYLabel - px(PT.labelPad), ax.y + ax.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText('velocity (m/s)', 0, 0);
    ctx.restore();
    ctx.font = `${px(PT.title)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, ax.x + ax.w / 2, ax.y - px(PT.titlePad) - px(PT.title) * 0.24);
  }

  redraw() { if (this.last) this.draw(this.last.history, this.last.frameEnd, this.last.dopplerBins); else this.drawEmpty(); }
}

// Align a line of the given width to the pixel grid, as Agg's path snapping does.
function snap(v, width) {
  const w = Math.max(1, Math.round(width));
  return w % 2 ? Math.floor(v) + 0.5 : Math.round(v);
}
