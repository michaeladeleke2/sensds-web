// Per-epoch metric chart, standing in for the desktop's pyqtgraph charts:
// title, "Epoch" axis, grid at alpha 0.3, lines with point markers (a single
// epoch still shows), optional fixed y range and legend.

import { axisTicks } from './ticks.js';
import { isDark } from './scatter.js';

export class LineChart {
  // series: [{ name, color, dash, marker: 'circle' | 'triangle' }]
  constructor(canvas, { title, series, yRange = null, legend = false }) {
    Object.assign(this, { canvas, ctx: canvas.getContext('2d'), title, series, yRange, legend });
    this.data = series.map(() => []);
    new ResizeObserver(() => this.draw()).observe(canvas);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
  }
  setTitle(t) { this.title = t; this.draw(); }
  set(i, values) { this.data[i] = values; this.draw(); }
  clear() { this.data = this.series.map(() => []); this.draw(); }

  draw() {
    const dpr = window.devicePixelRatio || 1, r = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const dark = isDark(), ctx = this.ctx;
    const bg = dark ? '#1a1a2e' : '#f7f8fc', fg = dark ? '#cccccc' : '#333333';
    const box = { x: 48 * dpr, y: 30 * dpr, w: W - 62 * dpr, h: H - 72 * dpr };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const font = px => `${px * dpr}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = fg; ctx.font = `bold ${font(13)}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(this.title, W / 2, 8 * dpr);
    if (box.w < 20 || box.h < 20) return;

    const n = Math.max(1, ...this.data.map(d => d.length));
    const all = this.data.flat();
    let [y0, y1] = this.yRange ?? [Math.min(...all), Math.max(...all)];
    if (!this.yRange) { if (!all.length) { y0 = 0; y1 = 1; } const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.08; y0 -= pad; y1 += pad; }
    const x0 = 0.5, x1 = n + 0.5;
    const px = x => box.x + (x - x0) / (x1 - x0) * box.w, py = y => box.y + (1 - (y - y0) / (y1 - y0)) * box.h;

    ctx.strokeStyle = fg; ctx.lineWidth = dpr;
    // Epochs are whole numbers
    const xt = axisTicks(x0, x1, Math.max(2, Math.floor(box.w / (60 * dpr)))).filter(t => Number.isInteger(t.value) && t.value >= 1).map(t => ({ ...t, label: String(t.value) }));
    if (!xt.length) xt.push({ value: 1, label: '1' });
    const yt = axisTicks(y0, y1, Math.max(2, Math.floor(box.h / (36 * dpr))));
    ctx.globalAlpha = 0.3;
    for (const t of xt) { const x = Math.round(px(t.value)) + 0.5; ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h); ctx.stroke(); }
    for (const t of yt) { const y = Math.round(py(t.value)) + 0.5; ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y); ctx.stroke(); }
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(box.x, box.y); ctx.lineTo(box.x, box.y + box.h); ctx.lineTo(box.x + box.w, box.y + box.h); ctx.stroke();
    ctx.fillStyle = fg; ctx.font = font(11);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of xt) ctx.fillText(t.label, px(t.value), box.y + box.h + 5 * dpr);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of yt) ctx.fillText(t.label, box.x - 6 * dpr, py(t.value));
    ctx.font = font(12); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('Epoch', box.x + box.w / 2, H - 4 * dpr);

    ctx.save(); ctx.beginPath(); ctx.rect(box.x - 6 * dpr, box.y - 6 * dpr, box.w + 12 * dpr, box.h + 12 * dpr); ctx.clip();
    this.series.forEach((s, i) => {
      const d = this.data[i];
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = 2 * dpr;
      ctx.setLineDash(s.dash ? [6 * dpr, 4 * dpr] : []);
      ctx.beginPath(); d.forEach((v, k) => (k ? ctx.lineTo(px(k + 1), py(v)) : ctx.moveTo(px(k + 1), py(v)))); ctx.stroke();
      ctx.setLineDash([]);
      for (let k = 0; k < d.length; k++) {
        const x = px(k + 1), y = py(d[k]), m = 3 * dpr;
        ctx.beginPath();
        if (s.marker === 'triangle') { ctx.moveTo(x, y - m * 1.2); ctx.lineTo(x + m, y + m * 0.8); ctx.lineTo(x - m, y + m * 0.8); ctx.closePath(); }
        else ctx.arc(x, y, m, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    ctx.restore();

    if (this.legend) {
      ctx.font = font(11); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      let y = box.y + 12 * dpr;
      const lw = Math.max(...this.series.map(s => ctx.measureText(s.name).width)) + 34 * dpr;
      const lx = box.x + box.w - lw - 10 * dpr;
      this.series.forEach(s => {
        ctx.strokeStyle = s.color; ctx.lineWidth = 2 * dpr; ctx.setLineDash(s.dash ? [5 * dpr, 3 * dpr] : []);
        ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(lx + 20 * dpr, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = fg; ctx.fillText(s.name, lx + 26 * dpr, y);
        y += 16 * dpr;
      });
    }
  }
}
