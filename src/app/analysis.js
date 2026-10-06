// The Analysis tab of SensDSv2 (ui/analysis_tab.py) with its two sub-tabs:
//   Physical Features (ui/features_tab.py): distance and speed per sample,
//     scatterplot with any two features, click a point for its spectrogram,
//     CSV export for CODAP.
//   PCA Comparison (ui/pca_tab.py): Doppler-domain against range-domain
//     features, each projected to 2D, scored with the silhouette coefficient.
// Both read every sample_*_raw.npy in the data folder; extraction runs in a
// Web Worker (the desktop's worker threads).

import { scanSamples } from '../analysis/dataset.js';
import { SUMMARY_FEATURES, SUMMARY_KEYS, FRAME_S, featureLabel } from '../analysis/physical_features.js';
import { summaryCsv, framesCsv, pyG } from '../analysis/csv.js';
import { ScatterPlot, zoomButtons, classColors } from '../viz/scatter.js';
import { currentFolder, setCurrentFolder, onFolderChange, chooseFolder, ensureWritable, canRead, canChooseFolder } from '../io/folder.js';

const MIN_CLASSES = 2, MIN_SAMPLES = 6;
const $ = id => document.getElementById(id);
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
const pct = v => `${(v * 100).toFixed(1)}%`;                       // Python {:.1%}
const signed = v => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(3)}`; // Python {:+.3f}

function newWorker() { return new Worker(new URL('../analysis/worker.js', import.meta.url), { type: 'module' }); }

function hintCard(el, hints) {
  let i = 0;
  el.textContent = hints[0];
  setInterval(() => { i = (i + 1) % hints.length; el.textContent = hints[i]; }, 6000);
}

async function readableFolder(ask) {
  const f = currentFolder();
  if (!f) return null;
  if (await canRead(f)) return f;
  return ask && (await ensureWritable(f)) ? f : null;
}

async function pickFolder() {
  if (!canChooseFolder()) return;
  try { setCurrentFolder(await chooseFolder()); } catch { /* closed the picker */ }
}

// ══════════════ Physical Features ══════════════
const feat = { samples: [], records: [], selected: null, worker: null, imgUrl: null };
let featPlot;

function featStatus(cls, text) { const el = $('featStatus'); el.className = cls; el.textContent = text; }

async function featRefresh(ask = false) {
  const folder = await readableFolder(ask);
  $('featFolderBtn').textContent = currentFolder() ? `📂  ${currentFolder().name}` : '📂  Choose Data Folder';
  if (!currentFolder()) { featStatus('status-err', '✗  No data folder chosen'); $('featMsg').textContent = 'Choose the folder your samples are saved in (the same one the Collect tab uses).'; $('extractBtn').disabled = true; return; }
  if (!folder) { featStatus('status-err', `✗  Allow access to ${currentFolder().name}`); $('featMsg').textContent = 'Click Refresh to allow this page to read the data folder.'; $('extractBtn').disabled = true; return; }
  feat.samples = await scanSamples(folder);
  const n = feat.samples.length;
  const gestures = [...new Set(feat.samples.map(s => s.gesture))].sort();
  const students = [...new Set(feat.samples.map(s => s.student))].sort();
  if (n) {
    featStatus('status-ok', `✓  ${n} raw samples\n    ${gestures.length} gestures: ${gestures.join(', ')}\n    ${students.length} students: ${students.join(', ')}`);
    $('featMsg').textContent = '';
  } else {
    featStatus('status-err', '✗  No raw samples found');
    $('featMsg').textContent = 'Physical features need the raw radar cube (sample_NNN_raw.npy), which only newer captures save. Collect fresh samples to use this tab.';
  }
  $('extractBtn').disabled = n === 0;
}

async function featStart() {
  $('extractBtn').disabled = true; $('featRefreshBtn').disabled = true;
  const prog = $('featProgress'); prog.max = feat.samples.length; prog.value = 0; prog.hidden = false;
  const items = await Promise.all(feat.samples.map(async s => ({ file: await s.file.getFile(), student: s.student, gesture: s.gesture, name: s.name })));
  feat.worker = newWorker();
  feat.worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { prog.value = data.i; $('featMsg').textContent = `Extracting ${data.i}/${data.total}: ${data.name}`; }
    else if (data.type === 'error') { featEnd(); $('featMsg').textContent = `✗  ${data.message.split('\n')[0]}`; }
    else if (data.type === 'features-done') {
      featEnd();
      feat.records = data.records.map(r => ({ ...feat.samples[r.index], summary: r.summary, series: r.series }));
      clearSelection();
      $('summaryCsvBtn').disabled = false; $('framesCsvBtn').disabled = false;
      const frames = feat.records.reduce((n, r) => n + r.series.time_s.length, 0);
      $('featMsg').textContent = `Extracted ${feat.records.length} samples (${frames} frames total).`;
      replot();
    }
  };
  feat.worker.postMessage({ type: 'features', items });
}

function featEnd() {
  feat.worker?.terminate(); feat.worker = null;
  $('featProgress').hidden = true; $('extractBtn').disabled = false; $('featRefreshBtn').disabled = false;
}

// The desktop re-fits the axes on every replot (enableAutoRange).
function replot() {
  if (!feat.records.length) return;
  const xk = $('xSel').value, yk = $('ySel').value, groupKey = $('colorSel').value;
  const groups = [...new Set(feat.records.map(r => r[groupKey]))].sort();
  const palette = classColors();
  featPlot.setData(groups.map((g, i) => ({
    label: g, color: palette[i % palette.length],
    points: feat.records.filter(r => r[groupKey] === g).map(r => ({ x: r.summary[xk], y: r.summary[yk], data: r })),
  })), { xLabel: featureLabel(xk), yLabel: featureLabel(yk) });
  $('featCaption').textContent = `${feat.records.length} samples  ·  X = ${featureLabel(xk)}  ·  Y = ${featureLabel(yk)}  ·  colored by ${groupKey}  ·  click a point to see its spectrogram`;
  if (feat.selected) showRecord(feat.selected);
}

function pointTip(p) {
  const d = p.data, xk = $('xSel').value, yk = $('ySel').value;
  return `${d.student} / ${d.gesture}\n${d.name}\n${featureLabel(xk)}: ${pyG(p.x, 4)}\n${featureLabel(yk)}: ${pyG(p.y, 4)}\nClick to open this sample`;
}

function clearSelection() {
  feat.selected = null;
  featPlot.select(null);
  $('detailBody').hidden = true; $('detailHint').hidden = false;
}

async function showRecord(r) {
  feat.selected = r;
  $('detailHint').hidden = true; $('detailBody').hidden = false;
  const img = $('detailImg'), noImg = $('detailNoImg');
  if (feat.imgUrl) { URL.revokeObjectURL(feat.imgUrl); feat.imgUrl = null; }
  if (r.png) {
    try { feat.imgUrl = URL.createObjectURL(await r.png.getFile()); img.src = feat.imgUrl; img.hidden = false; noImg.hidden = true; }
    catch { img.hidden = true; noImg.hidden = false; }
  } else { img.hidden = true; noImg.hidden = false; }
  const n = r.series.time_s.length;
  $('detailGesture').textContent = r.gesture;
  $('detailStudent').textContent = r.student;
  $('detailName').textContent = r.name;
  $('detailFrames').textContent = `${n} frames  ·  ${(n * FRAME_S).toFixed(1)} s`;
  $('detailFolder').textContent = `Folder: ${currentFolder()?.name ?? ''}/${r.student}/${r.gesture}/`;
  const xk = $('xSel').value, yk = $('ySel').value;
  for (const [key, , unit] of SUMMARY_FEATURES) {
    const row = $(`feat-${key}`);
    row.querySelector('.feat-val').textContent = `${r.summary[key].toFixed(3)} ${unit}`.trim();
    row.classList.toggle('on-axis', key === xk || key === yk);
  }
  featPlot.select(r);
}

async function exportCsv(kind) {
  const name = kind === 'summary' ? 'radar_features_summary.csv' : 'radar_features_frames.csv';
  const text = kind === 'summary' ? summaryCsv(feat.records) : framesCsv(feat.records).text;
  const rows = kind === 'summary' ? feat.records.length : framesCsv(feat.records).rows;
  try {
    if ('showSaveFilePicker' in window) {
      // The desktop's save dialog, opening in <data folder>/exports
      let startIn;
      try { startIn = await currentFolder()?.getDirectoryHandle('exports', { create: true }); } catch { startIn = undefined; }
      const handle = await window.showSaveFilePicker({ suggestedName: name, startIn, types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }] });
      const w = await handle.createWritable(); await w.write(text); await w.close();
      $('featMsg').textContent = `Saved ${rows} rows to ${handle.name}`;
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      $('featMsg').textContent = `Saved ${rows} rows to ${name}`;
    }
  } catch (e) {
    if (e.name !== 'AbortError') $('featMsg').textContent = `✗  Export failed: ${e.message}`;
  }
}

// ══════════════ PCA Comparison ══════════════
const pcaState = { samples: [], worker: null };
let specPlot, rfftPlot;
const SPEC_UNITS = 'dB', RFFT_UNITS = 'mixed: amplitude + rad';

async function pcaRefresh(ask = false) {
  const folder = await readableFolder(ask);
  $('pcaFolderBtn').textContent = currentFolder() ? `📂  ${currentFolder().name}` : '📂  Choose Data Folder';
  pcaState.samples = folder ? await scanSamples(folder) : [];
  const n = pcaState.samples.length, classes = [...new Set(pcaState.samples.map(s => s.gesture))].sort();
  const set = (id, ok, text) => { const el = $(id); el.className = ok ? 'status-ok' : 'status-err'; el.textContent = text; };
  set('pcaSamples', n >= MIN_SAMPLES, n >= MIN_SAMPLES ? `✓  ${n} raw samples found` : `✗  ${n} raw samples (need ${MIN_SAMPLES})`);
  set('pcaClasses', classes.length >= MIN_CLASSES, classes.length >= MIN_CLASSES ? `✓  ${classes.length} gestures: ${classes.join(', ')}` : `✗  ${classes.length} gesture class (need ${MIN_CLASSES})`);
  const ready = n >= MIN_SAMPLES && classes.length >= MIN_CLASSES;
  $('pcaRunBtn').disabled = !ready;
  if (!currentFolder()) $('pcaMsg').textContent = 'Choose the folder your samples are saved in (the same one the Collect tab uses).';
  else if (!folder) $('pcaMsg').textContent = 'Click Refresh to allow this page to read the data folder.';
  else if (!ready && n === 0) $('pcaMsg').textContent = 'No raw samples yet. Collect gestures first. Each capture saves a sample_NNN_raw.npy alongside the spectrogram.';
  else if (!ready) $('pcaMsg').textContent = 'Collect more samples to unlock analysis.';
  else $('pcaMsg').textContent = '';
}

async function pcaStart() {
  $('pcaRunBtn').disabled = true; $('pcaRefreshBtn').disabled = true;
  const prog = $('pcaProgress'); prog.max = pcaState.samples.length; prog.value = 0; prog.hidden = false;
  $('pcaSummary').textContent = 'Analyzing…';
  const items = await Promise.all(pcaState.samples.map(async s => ({ file: await s.file.getFile(), gesture: s.gesture, name: s.name })));
  pcaState.worker = newWorker();
  pcaState.worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { prog.value = data.i; $('pcaMsg').textContent = `Processing ${data.i}/${data.total}: ${data.name}`; }
    else if (data.type === 'error') { pcaEnd(); $('pcaMsg').textContent = ''; $('pcaSummary').textContent = `✗  ${data.message.split('\n')[0]}`; }
    else if (data.type === 'pca-done') { pcaEnd(); pcaFinished(data); }
  };
  pcaState.worker.postMessage({ type: 'pca', items });
}

function pcaEnd() {
  pcaState.worker?.terminate(); pcaState.worker = null;
  $('pcaProgress').hidden = true; $('pcaRunBtn').disabled = false; $('pcaRefreshBtn').disabled = false;
}

function pcaFinished({ labels, spec, rfft }) {
  $('pcaMsg').textContent = `Done. ${labels.length} samples analyzed.`;
  const classes = [...new Set(labels)].sort(), palette = classColors();
  const groups = proj => classes.map((c, i) => ({
    label: c, color: palette[i % palette.length],
    points: labels.map((l, j) => [l, j]).filter(([l]) => l === c).map(([, j]) => ({ x: proj[j][0], y: proj[j][1], data: j })),
  }));
  const axis = (units, var_, i) => `PC${i + 1}  (${units}),  ${pct(var_[i])} of variance`;
  specPlot.setData(groups(spec.proj), { xLabel: axis(SPEC_UNITS, spec.evr, 0), yLabel: axis(SPEC_UNITS, spec.evr, 1) });
  rfftPlot.setData(groups(rfft.proj), { xLabel: axis(RFFT_UNITS, rfft.evr, 0), yLabel: axis(RFFT_UNITS, rfft.evr, 1) });
  const caption = r => `PC1 ${pct(r.evr[0])}   PC2 ${pct(r.evr[1])}   (${pct(r.evr[0] + r.evr[1])} of detail kept)   silhouette ${signed(r.sil)}  (-1 to +1, higher = better separated)`;
  $('specCaption').textContent = caption(spec);
  $('rfftCaption').textContent = caption(rfft);
  $('pcaSummary').textContent = summarise(spec.sil, rfft.sil);
}

// PcaTab._summarise
function summarise(specSil, rfftSil) {
  const diff = Math.abs(specSil - rfftSil);
  const [better, worse] = specSil > rfftSil ? ['Spectrogram (Doppler domain)', 'Range FFT'] : ['Range FFT (range domain)', 'Spectrogram'];
  const best = Math.max(specSil, rfftSil);
  const quality = best < 0.1 ? 'Neither representation separates these gestures cleanly, the clusters overlap a lot.'
    : best < 0.35 ? 'The better one separates them only weakly.'
      : best < 0.6 ? 'The better one separates them reasonably well.'
        : 'The better one separates them into clean, tight clusters.';
  if (diff < 0.02) return `Both representations perform about the same (silhouette ${signed(specSil)} vs ${signed(rfftSil)}). ${quality}`;
  return `${better} separates the gestures better than ${worse}. Silhouette ${signed(Math.max(specSil, rfftSil))} vs ${signed(Math.min(specSil, rfftSil))}, a gap of ${diff.toFixed(3)}. ${quality}`;
}

// ══════════════ wiring ══════════════
function selectSub(name) {
  for (const k of ['features', 'pca']) {
    $(`sub-${k}`).hidden = k !== name;
    $(`subtab-${k}`).setAttribute('aria-selected', String(k === name));
  }
  (name === 'features' ? featPlot : specPlot).draw();
  if (name === 'pca') rfftPlot.draw();
}

export function initAnalysis() {
  for (const [key, label, unit] of SUMMARY_FEATURES) {
    for (const sel of [$('xSel'), $('ySel')]) sel.append(new Option(unit ? `${label} (${unit})` : label, key));
    const row = document.createElement('div');
    row.className = 'feat-row'; row.id = `feat-${key}`;
    row.innerHTML = '<span class="feat-name"></span><span class="feat-val"></span>';
    row.querySelector('.feat-name').textContent = label;
    $('featRows').append(row);
  }
  $('xSel').value = 'range_travel_m';
  $('ySel').value = 'radial_speed_max_ms';
  for (const id of ['xSel', 'ySel', 'colorSel']) $(id).onchange = () => replot();

  featPlot = new ScatterPlot($('featCanvas'), $('featTip'), { title: 'Physical Feature Scatterplot', size: 12, tip: pointTip, onClick: p => showRecord(p.data), accent: accent() });
  $('featZoom').replaceWith(Object.assign(zoomButtons(featPlot), { id: 'featZoom' }));
  specPlot = new ScatterPlot($('specCanvas'), $('specTip'), { title: 'Spectrogram (Doppler domain)', size: 11 });
  rfftPlot = new ScatterPlot($('rfftCanvas'), $('rfftTip'), { title: 'Range FFT (range domain)', size: 11 });
  specPlot.setLabels(`PC1  (${SPEC_UNITS})`, `PC2  (${SPEC_UNITS})`);
  rfftPlot.setLabels(`PC1  (${RFFT_UNITS})`, `PC2  (${RFFT_UNITS})`);
  $('specZoom').replaceWith(Object.assign(zoomButtons(specPlot), { id: 'specZoom' }));
  $('rfftZoom').replaceWith(Object.assign(zoomButtons(rfftPlot), { id: 'rfftZoom' }));

  $('featRefreshBtn').onclick = () => featRefresh(true);
  $('extractBtn').onclick = () => featStart();
  $('summaryCsvBtn').onclick = () => exportCsv('summary');
  $('framesCsvBtn').onclick = () => exportCsv('frames');
  $('featFolderBtn').onclick = () => pickFolder();
  $('pcaRefreshBtn').onclick = () => pcaRefresh(true);
  $('pcaRunBtn').onclick = () => pcaStart();
  $('pcaFolderBtn').onclick = () => pickFolder();

  hintCard($('featHint'), [
    'Every number here has real units (meters and m/s), so you can sanity check them against what your hand actually did.',
    "A push moves toward the radar, so 'Distance traveled' is large. A swipe moves sideways, so it stays small.",
    'The radar measures motion toward and away from itself. Sideways movement barely registers, which is why a swipe looks slow here.',
    'Distance against speed separates the gestures better than two distance features or two speed features.',
    'Click a point to see the spectrogram it came from. A point sitting far from the rest of its group is usually a recording that went wrong, and the picture will show you how.',
  ]);
  hintCard($('pcaHint'), [
    'PCA finds the directions your data varies in most, then keeps the top two so it can be drawn on a flat plot.',
    'The silhouette score runs from -1 to +1. Above ~0.5 means classes sit in clean, well separated clusters.',
    'Explained variance tells you how much of the original detail survived the squash to 2D. Higher is more faithful.',
    'If neither representation separates well, the model will struggle too, so collect more samples or more distinct gestures.',
  ]);

  for (const k of ['features', 'pca']) $(`subtab-${k}`).onclick = () => selectSub(k);
  onFolderChange(() => { featRefresh().catch(() => {}); pcaRefresh().catch(() => {}); });
  selectSub('features');
}

// AnalysisTab.refresh, when the tab is shown
export function showAnalysis() {
  featRefresh().catch(() => {});
  pcaRefresh().catch(() => {});
  featPlot.draw(); specPlot.draw(); rfftPlot.draw();
}
