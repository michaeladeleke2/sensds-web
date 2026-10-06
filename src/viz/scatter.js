// Scatterplot drawn on a canvas, standing in for the desktop's pyqtgraph
// PlotWidget + ScatterPlotItem: title, axis labels, grid at alpha 0.25, a
// backed legend in the top-right corner with counts, hover tips, click to
// select (with a ring), scroll to zoom, drag to pan, and zoom buttons.
// Colours follow the desktop's light and dark plot styles.

import { axisTicks } from './ticks.js';

const STYLES = {
  light: { bg: '#ffffff', axis: '#999999', axisText: '#555555', title: '#1a3a5c', legendBg: 'rgba(255,255,255,0.92)', legendBorder: '#cccccc', legendText: '#333333' },
  dark: { bg: '#1a1a2e', axis: '#888899', axisText: '#cccccc', title: '#e6e6e6', legendBg: 'rgba(30,30,46,0.92)', legendBorder: '#4a4a5a', legendText: '#e6e6e6' },
};
export const CLASS_COLORS_LIGHT = ['#e74c3c', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085', '#d35400', '#2c3e50'];
export const CLASS_COLORS_DARK = ['#ff6b6b', '#5dade2', '#2ecc71', '#f5b041', '#bb8fce', '#48c9b0', '#f0932b', '#aab7b8'];

export function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
export const classColors = () => (isDark() ? CLASS_COLORS_DARK : CLASS_COLORS_LIGHT);

export class ScatterPlot {
  // opts: { title, size (point diameter px), tip(point) -> string, onClick(point), accent }
  constructor(canvas, tipEl, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tipEl = tipEl;
    this.opts = { size: 12, ...opts };
    this.groups = [];           // [{ label, color, points: [{ x, y, data }] }]
    this.xLabel = ''; this.yLabel = '';
    this.view = null;           // { x0, x1, y0, y1 }
    this.selected = null;
    this.hover = null;
    this._bind();
  }

  setData(groups, { xLabel, yLabel, keepView = false } = {}) {
    this.groups = groups;
    if (xLabel !== undefined) this.xLabel = xLabel;
    if (yLabel !== undefined) this.yLabel = yLabel;
    if (!keepView || !this.view) this.autoRange();
    this.draw();
  }
  setLabels(xLabel, yLabel) { this.xLabel = xLabel; this.yLabel = yLabel; this.draw(); }
  select(data) { this.selected = data; this.draw(); }
  clear() { this.groups = []; this.selected = null; this.view = null; this.draw(); }

  // pyqtgraph autoRange: data bounds plus a small margin
  autoRange() {
    const pts = this.groups.flatMap(g => g.points);
    if (!pts.length) { this.view = { x0: 0, x1: 1, y0: 0, y1: 1 }; return; }
    let x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x));
    let y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
    const pad = (a, b) => { const d = b - a || Math.abs(a) || 1; return [a - d * 0.08, b + d * 0.08]; };   // room for the point size
    [x0, x1] = pad(x0, x1); [y0, y1] = pad(y0, y1);
    this.view = { x0, x1, y0, y1 };
  }
  zoom(factor) {
    const v = this.view; if (!v) return;
    const cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
    this.view = { x0: cx + (v.x0 - cx) * factor, x1: cx + (v.x1 - cx) * factor, y0: cy + (v.y0 - cy) * factor, y1: cy + (v.y1 - cy) * factor };
    this.draw();
  }
  reset() { this.autoRange(); this.draw(); }

  _layout() {
    const dpr = window.devicePixelRatio || 1, r = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const left = 64 * dpr, right = 14 * dpr, top = (this.opts.title ? 30 : 12) * dpr, bottom = 46 * dpr;
    return { dpr, W, H, box: { x: left, y: top, w: Math.max(10, W - left - right), h: Math.max(10, H - top - bottom) } };
  }
  _toPx(p, L) {
    const v = this.view, b = L.box;
    return [b.x + (p.x - v.x0) / (v.x1 - v.x0) * b.w, b.y + (1 - (p.y - v.y0) / (v.y1 - v.y0)) * b.h];
  }

  draw() {
    const L = this._layout(), { ctx } = this, s = isDark() ? STYLES.dark : STYLES.light, { dpr, W, H, box } = L;
    if (!this.view) this.autoRange();
    const v = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = s.bg; ctx.fillRect(0, 0, W, H);
    const font = px => `${px * dpr}px system-ui, -apple-system, "Segoe UI", sans-serif`;

    // Grid and ticks
    const xt = axisTicks(v.x0, v.x1, Math.max(2, Math.floor(box.w / (80 * dpr))));
    const yt = axisTicks(v.y0, v.y1, Math.max(2, Math.floor(box.h / (40 * dpr))));
    ctx.strokeStyle = s.axisText; ctx.globalAlpha = 0.25; ctx.lineWidth = dpr;
    for (const t of xt) { const x = Math.round(this._toPx({ x: t.value, y: v.y0 }, L)[0]) + 0.5; ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h); ctx.stroke(); }
    for (const t of yt) { const y = Math.round(this._toPx({ x: v.x0, y: t.value }, L)[1]) + 0.5; ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y); ctx.stroke(); }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = s.axis;
    ctx.beginPath(); ctx.moveTo(box.x, box.y); ctx.lineTo(box.x, box.y + box.h); ctx.lineTo(box.x + box.w, box.y + box.h); ctx.stroke();
    ctx.fillStyle = s.axisText; ctx.font = font(11);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of xt) ctx.fillText(t.label, this._toPx({ x: t.value, y: v.y0 }, L)[0], box.y + box.h + 5 * dpr);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of yt) ctx.fillText(t.label, box.x - 6 * dpr, this._toPx({ x: v.x0, y: t.value }, L)[1]);

    // Labels and title
    ctx.font = font(12); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(this.xLabel, box.x + box.w / 2, H - 6 * dpr);
    ctx.save(); ctx.translate(14 * dpr, box.y + box.h / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(this.yLabel, 0, 0); ctx.restore();
    if (this.opts.title) { ctx.fillStyle = s.title; ctx.font = `bold ${font(14.5)}`; ctx.textBaseline = 'top'; ctx.fillText(this.opts.title, W / 2, 8 * dpr); }

    // Points
    ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
    const r = this.opts.size / 2 * dpr;
    for (const g of this.groups) {
      ctx.fillStyle = g.color; ctx.strokeStyle = s.bg; ctx.lineWidth = dpr;
      for (const p of g.points) { const [x, y] = this._toPx(p, L); ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); }
    }
    if (this.selected) {
      const p = this.groups.flatMap(g => g.points).find(q => q.data === this.selected);
      if (p) { const [x, y] = this._toPx(p, L); ctx.strokeStyle = this.opts.accent || '#5b9bd5'; ctx.lineWidth = 3 * dpr; ctx.beginPath(); ctx.arc(x, y, 12 * dpr, 0, 2 * Math.PI); ctx.stroke(); }
    }
    ctx.restore();

    // Legend, top right
    if (this.groups.length) {
      ctx.font = font(13);
      const rows = this.groups.map(g => `${g.label}  (${g.points.length})`);
      const lw = Math.max(...rows.map(t => ctx.measureText(t).width)) + 36 * dpr, lh = 20 * dpr;
      const lx = box.x + box.w - lw - 12 * dpr, ly = box.y + 12 * dpr;
      ctx.fillStyle = s.legendBg; ctx.strokeStyle = s.legendBorder; ctx.lineWidth = dpr;
      ctx.fillRect(lx, ly, lw, lh * rows.length + 8 * dpr); ctx.strokeRect(lx + 0.5, ly + 0.5, lw, lh * rows.length + 8 * dpr);
      rows.forEach((t, i) => {
        const cy = ly + 4 * dpr + lh * i + lh / 2;
        ctx.fillStyle = this.groups[i].color; ctx.beginPath(); ctx.arc(lx + 14 * dpr, cy, 5 * dpr, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = s.legendText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, lx + 26 * dpr, cy);
      });
    }
    this._lastLayout = L;
  }

  _pick(ev) {
    const L = this._lastLayout; if (!L) return null;
    const rect = this.canvas.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * L.dpr, my = (ev.clientY - rect.top) * L.dpr;
    let best = null, bestD = (this.opts.size / 2 + 3) * L.dpr;
    for (const g of this.groups) for (const p of g.points) {
      const [x, y] = this._toPx(p, L), d = Math.hypot(x - mx, y - my);
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  }

  _bind() {
    let drag = null;
    this.canvas.addEventListener('mousemove', ev => {
      if (drag) {
        const L = this._lastLayout, dx = (ev.clientX - drag.x) * L.dpr / L.box.w * (drag.v.x1 - drag.v.x0), dy = (ev.clientY - drag.y) * L.dpr / L.box.h * (drag.v.y1 - drag.v.y0);
        this.view = { x0: drag.v.x0 - dx, x1: drag.v.x1 - dx, y0: drag.v.y0 + dy, y1: drag.v.y1 + dy };
        drag.moved = true; this.draw(); return;
      }
      const p = this._pick(ev);
      this.canvas.style.cursor = p ? 'pointer' : 'default';
      if (p && this.opts.tip) {
        this.tipEl.textContent = this.opts.tip(p);
        this.tipEl.hidden = false;
        const host = this.tipEl.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
        this.tipEl.style.left = `${ev.clientX - host.left + 14}px`;
        this.tipEl.style.top = `${ev.clientY - host.top + 14}px`;
      } else this.tipEl.hidden = true;
    });
    this.canvas.addEventListener('mouseleave', () => { this.tipEl.hidden = true; drag = null; });
    this.canvas.addEventListener('mousedown', ev => { if (this.view) drag = { x: ev.clientX, y: ev.clientY, v: { ...this.view }, moved: false }; });
    window.addEventListener('mouseup', ev => {
      if (!drag) return;
      const wasClick = !drag.moved;
      drag = null;
      if (wasClick && ev.target === this.canvas) { const p = this._pick(ev); if (p && this.opts.onClick) this.opts.onClick(p); }
    });
    this.canvas.addEventListener('wheel', ev => { if (!this.view) return; ev.preventDefault(); this.zoom(ev.deltaY > 0 ? 1.1 : 1 / 1.1); }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
  }
}

// The desktop's zoom_button_row: −, +, Reset.
export function zoomButtons(plot) {
  const row = document.createElement('div');
  row.className = 'zoom-row';
  const add = (text, title, fn) => { const b = Object.assign(document.createElement('button'), { textContent: text, title }); b.className = 'zoom-btn'; b.onclick = fn; row.append(b); };
  add('−', 'Zoom out', () => plot.zoom(1.25));
  add('+', 'Zoom in', () => plot.zoom(0.8));
  add('Reset', 'Fit all points', () => plot.reset());
  return row;
}

