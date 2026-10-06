// Background extraction for the Analysis tab (the desktop's FeatureWorker and
// PcaWorker threads). Receives File objects, so the page stays responsive.
//
// { type: 'features', items: [{ file, student, gesture, name }] }
// { type: 'pca',      items: [{ file, gesture, name }] }
// { type: 'stop' }

import { parseNpy } from '../io/npy.js';
import { extract } from './physical_features.js';
import { spectrogramFeatures, rangeFftFeatures, pca, silhouette } from './pca_analysis.js';

const MIN_CLASSES = 2, MIN_SAMPLES = 6;
let running = false;

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { running = false; return; }
  running = true;
  try {
    if (data.type === 'features') await runFeatures(data.items);
    else if (data.type === 'pca') await runPca(data.items);
  } catch (e) {
    self.postMessage({ type: 'error', message: `${e.message}` });
  }
};

async function load(item) {
  const arr = parseNpy(await item.file.arrayBuffer());
  return arr.shape.length === 4 ? arr : null;      // cube.ndim != 4: skipped
}

async function runFeatures(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (!running) return;
    const s = items[i];
    self.postMessage({ type: 'progress', i: i + 1, total: items.length, name: s.name });
    let cube;
    try { cube = await load(s); } catch (e) { self.postMessage({ type: 'error', message: `Could not read ${s.name}:\n${e.message}` }); return; }
    if (!cube) continue;
    const { summary, series } = extract(cube.data, cube.shape);
    out.push({ index: i, summary, series });
  }
  if (!out.length) { self.postMessage({ type: 'error', message: 'No usable raw samples found.' }); return; }
  self.postMessage({ type: 'features-done', records: out });
}

async function runPca(items) {
  const spec = [], rfft = [], kept = [];
  for (let i = 0; i < items.length; i++) {
    if (!running) return;
    const s = items[i];
    self.postMessage({ type: 'progress', i: i + 1, total: items.length, name: s.name });
    let cube;
    try { cube = await load(s); } catch (e) { self.postMessage({ type: 'error', message: `Could not read ${s.name}:\n${e.message}` }); return; }
    if (!cube) continue;
    spec.push(spectrogramFeatures(cube.data, cube.shape));
    rfft.push(rangeFftFeatures(cube.data, cube.shape));
    kept.push(s.gesture);
  }
  if (kept.length < MIN_SAMPLES) { self.postMessage({ type: 'error', message: `Only ${kept.length} usable samples, need at least ${MIN_SAMPLES}.` }); return; }
  if (new Set(kept).size < MIN_CLASSES) { self.postMessage({ type: 'error', message: `Only ${new Set(kept).size} gesture class found, need at least ${MIN_CLASSES}.` }); return; }
  const s = pca(spec, 2), r = pca(rfft, 2);
  self.postMessage({
    type: 'pca-done', labels: kept,
    spec: { proj: s.proj.map(p => [...p]), evr: [...s.evr], sil: silhouette(s.proj, kept) },
    rfft: { proj: r.proj.map(p => [...p]), evr: [...r.evr], sil: silhouette(r.proj, kept) },
  });
}
