// The Results tab of SensDSv2 (ui/results_tab.py): the loaded model and its
// gestures, a confusion matrix, accuracy per gesture and the prediction
// history from the Test tab, with Clear and Export CSV.

import { Results, hms, pct, fileStamp } from '../results/results.js';
import { onPrediction, onModelLoaded } from './predictions.js';
import { currentFolder, ensureWritable, subfolder, writeFile } from '../io/folder.js';

const HINTS = [
  'Confusion matrix: each box shows how many times the model guessed that column\'s gesture when you actually did the row\'s gesture. Dark diagonal = great. It means the model got it right!',
  'Accuracy per gesture: how often the model was correct for each move. If \'push\' is low, try collecting more push samples and retraining.',
  'Confidence: the model gives every gesture a score from 0 to 100%. A high score (green ✓) means it\'s sure. Low (orange ⚠) means it\'s guessing.',
  'Threshold: you set the minimum confidence before an action happens. 60% is a safe starting point. Lower it if the robot feels unresponsive.',
  'Export CSV saves the full prediction log as a spreadsheet you can open in Excel or Google Sheets.',
  'The diagonal of the confusion matrix should be the darkest column. Off-diagonal dark boxes mean the model is mixing up those two gestures.',
];
const SOURCE_COLORS = { Single: '#8e44ad', RoboSoccer: '#27ae60', Maze: '#e67e22' };
const NAVY = '#1a3a5c';

const $ = id => document.getElementById(id);
const results = new Results();
const label = s => s.replace(/_/g, ' ');

function fit(c) {
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

// ConfusionMatrixWidget.paintEvent
function drawMatrix() {
  const c = $('matrixCanvas');
  if (c.offsetParent === null) return;
  const { ctx, w, h } = fit(c);
  const n = results.classes.length;
  ctx.textBaseline = 'middle';
  if (!n) { ctx.fillStyle = '#aaa'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('No predictions yet.', w / 2, h / 2); return; }
  ctx.font = '11px system-ui, sans-serif';
  const longest = Math.max(...results.classes.map(cl => ctx.measureText(label(cl)).width));
  const rowLabelW = longest + 10, colLabelH = longest + 10, axisW = 18, axisH = 18;
  const left = axisW + rowLabelW, top = axisH + colLabelH;
  const availW = Math.max(1, w - left - 4), availH = Math.max(1, h - top - 4);
  const cell = Math.max(12, Math.min(Math.floor(availW / n), Math.floor(availH / n)));
  const gw = cell * n, gh = cell * n;
  const x0 = left + Math.max(0, Math.floor((availW - gw) / 2)), y0 = top + Math.max(0, Math.floor((availH - gh) / 2));
  const maxVal = Math.max(1, ...results.matrix.flat());
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    const v = results.matrix[r][col], t = v / maxVal;
    ctx.fillStyle = `rgb(${Math.trunc(255 + (26 - 255) * t)},${Math.trunc(255 + (58 - 255) * t)},${Math.trunc(255 + (92 - 255) * t)})`;
    ctx.fillRect(x0 + col * cell, y0 + r * cell, cell - 1, cell - 1);
    ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 1; ctx.strokeRect(x0 + col * cell + 0.5, y0 + r * cell + 0.5, cell - 1, cell - 1);
    ctx.fillStyle = t > 0.45 ? '#fff' : NAVY; ctx.textAlign = 'center';
    ctx.font = `bold ${Math.max(8, Math.min(13, Math.floor(cell / 3)))}px system-ui, sans-serif`;
    ctx.fillText(String(v), x0 + col * cell + (cell - 1) / 2, y0 + r * cell + (cell - 1) / 2);
  }
  const text = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || NAVY;
  ctx.font = `${Math.max(8, Math.min(11, Math.floor(cell / 4)))}px system-ui, sans-serif`; ctx.fillStyle = text;
  results.classes.forEach((cl, col) => {
    ctx.save(); ctx.translate(x0 + col * cell + Math.floor(cell / 2), y0 - 4); ctx.rotate(-55 * Math.PI / 180);
    ctx.textAlign = 'left'; ctx.fillText(label(cl), 4, 0); ctx.restore();          // rising up-right, above the grid
  });
  ctx.textAlign = 'right';
  results.classes.forEach((cl, r) => ctx.fillText(label(cl), axisW + rowLabelW - 4, y0 + r * cell + cell / 2));
  ctx.font = 'bold 10px system-ui, sans-serif'; ctx.fillStyle = '#777'; ctx.textAlign = 'center';
  ctx.fillText('Predicted →', x0 + gw / 2, 2 + axisH / 2);
  ctx.save(); ctx.translate(Math.floor(axisW / 2), y0 + Math.floor(gh / 2)); ctx.rotate(-Math.PI / 2); ctx.fillText('Actual →', 0, 0); ctx.restore();
}

// AccuracyBarsWidget.paintEvent
function drawAccuracy() {
  const c = $('accCanvas');
  if (c.offsetParent === null) return;
  const { ctx, w, h } = fit(c);
  const n = results.classes.length;
  ctx.textBaseline = 'middle'; ctx.font = '11px system-ui, sans-serif';
  if (!n) { ctx.fillStyle = '#aaa'; ctx.textAlign = 'center'; ctx.fillText('No predictions yet.', w / 2, h / 2); return; }
  const margin = 5, labelW = 100, pctW = 48, cntW = 40, barW = Math.max(20, w - margin * 2 - labelW - pctW - cntW);
  const barH = Math.max(10, Math.floor((h - margin * (n + 1)) / n));
  const text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#333';
  results.classes.forEach((cl, i) => {
    const y = margin + i * (barH + margin), tot = results.total[cl], cor = results.correct[cl], acc = tot > 0 ? cor / tot : 0;
    ctx.fillStyle = '#eeeeee'; ctx.beginPath(); ctx.roundRect(margin + labelW, y, barW, barH, 3); ctx.fill();
    const bp = Math.trunc(barW * acc);
    if (bp > 0) { ctx.fillStyle = acc >= 0.7 ? NAVY : acc >= 0.4 ? '#e67e22' : '#c0392b'; ctx.beginPath(); ctx.roundRect(margin + labelW, y, bp, barH, 3); ctx.fill(); }
    ctx.fillStyle = text; ctx.textAlign = 'right'; ctx.fillText(label(cl), margin + labelW - 4, y + barH / 2);
    ctx.textAlign = 'left'; ctx.fillStyle = '#888'; ctx.fillText(tot > 0 ? pct(acc, 0) : '—', margin + labelW + barW + 4, y + barH / 2);
    ctx.fillStyle = '#999'; ctx.fillText(tot > 0 ? `(${cor}/${tot})` : '', margin + labelW + barW + pctW + 2, y + barH / 2);
  });
}

function addRow(p) {
  const tr = document.createElement('tr');
  const ok = p.confidence >= p.threshold;
  const cells = [
    [hms(p.time), 'center'],
    [p.source, 'center', SOURCE_COLORS[p.source] || '#555', true],
    [label(p.gesture), '', null, true, 'predicted'],
    [pct(p.confidence, 1), 'center'],
    [p.actual ? label(p.actual) : 'not recorded', 'center'],
    [ok ? '✓  Confident' : '⚠  Low', 'center', ok ? '#27ae60' : '#e67e22'],
  ];
  for (const [text, align, color, bold, cls] of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    if (align) td.style.textAlign = align;
    if (color) td.style.color = color;
    if (bold) td.style.fontWeight = 'bold';
    if (cls) td.className = cls;
    tr.append(td);
  }
  $('historyBody').append(tr);
  const wrap = $('historyWrap'); wrap.scrollTop = wrap.scrollHeight;
}

function refresh() {
  $('resModel').textContent = results.modelName ? `Model:  ${results.modelName}` : 'No model loaded.';
  $('resClasses').textContent = results.classes.length ? `Gestures:  ${results.classes.join('  ·  ')}` : '';
  $('resSummary').textContent = results.summary();
  $('exportBtn').disabled = $('clearBtn').disabled = results.history.length === 0;
  drawMatrix(); drawAccuracy();
}

async function exportCsv() {
  const name = `results_${fileStamp(new Date())}.csv`;
  const folder = currentFolder();
  try {
    if (folder && await ensureWritable(folder)) {
      await writeFile(await subfolder(folder, ['results'], true), name, results.csv());
      $('resMsg').textContent = `Saved to: ${folder.name}/results/${name}`;
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([results.csv()], { type: 'text/csv' })), download: name });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      $('resMsg').textContent = `Saved to your downloads: ${name}`;
    }
  } catch (e) { $('resMsg').textContent = `Export failed: ${e.message}`; }
}

export function initResults() {
  onModelLoaded((name, classes) => { results.setModel(name, classes); $('historyBody').replaceChildren(); refresh(); });
  onPrediction(p => { results.add(p); addRow(p); refresh(); });
  $('clearBtn').onclick = () => { results.clear(); $('historyBody').replaceChildren(); $('resMsg').textContent = ''; refresh(); };
  $('exportBtn').onclick = exportCsv;
  let hint = 0;
  $('resHint').textContent = HINTS[0];
  setInterval(() => { hint = (hint + 1) % HINTS.length; $('resHint').textContent = HINTS[hint]; }, 6000);
  new ResizeObserver(() => { drawMatrix(); drawAccuracy(); }).observe($('resultsPane'));
  refresh();
}

export function showResults() { requestAnimationFrame(() => { drawMatrix(); drawAccuracy(); }); }
