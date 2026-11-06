// The starter model: a six-gesture model (idle, push, swipe_down, swipe_left,
// swipe_right, swipe_up) that ships with the site, so students can try the
// Test tab and the Maze before training their own.
//
// It lives in assets/models/six_class/: config.json, preprocessor_config.json,
// and model.safetensors stored as float16 (predictions match the float32
// original) in parts under GitHub's file size limit, listed with their sizes
// and checksums in manifest.json. It is downloaded once, checked, and kept in
// its own cache, so it loads again without internet (on the robot's WiFi) and
// is not downloaded again on the next visit.

const BASE = new URL('../../assets/models/six_class/', import.meta.url);
const CACHE_PREFIX = 'sensds-starter-model-';

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The manifest from the network when it answers, otherwise the cached copy
async function manifest() {
  const url = new URL('manifest.json', BASE).href;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) return { data: await res.clone().json(), res };
  } catch { /* offline */ }
  for (const key of await caches.keys()) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    const hit = await (await caches.open(key)).match(url);
    if (hit) return { data: await hit.json(), res: null };
  }
  throw new Error('The starter model needs internet the first time it is used.');
}

// True when the starter model can load without downloading anything
export async function starterCached() {
  try {
    const { data } = await manifest();
    const cache = await caches.open(CACHE_PREFIX + data.id);
    for (const f of ['config.json', 'preprocessor_config.json', ...data.weights.parts.map(p => p.file)])
      if (!(await cache.match(new URL(f, BASE).href))) return false;
    return true;
  } catch { return false; }
}

// Returns { name, files: { configText, preprocessorText, weights } } as a model
// folder does. onProgress(text) reports the download.
export async function loadStarterModel(onProgress = () => {}) {
  const { data, res } = await manifest();
  const cache = await caches.open(CACHE_PREFIX + data.id);
  // Older versions of the starter model are removed
  for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX) && key !== CACHE_PREFIX + data.id) await caches.delete(key);
  if (res) await cache.put(new URL('manifest.json', BASE).href, res);

  const get = async (file, check) => {
    const url = new URL(file, BASE).href;
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Could not download the starter model (${file}: HTTP ${r.status}).`);
    const bytes = await r.arrayBuffer();
    if (check && (bytes.byteLength !== check.bytes || (await sha256(bytes)) !== check.sha256))
      throw new Error(`The starter model download was damaged (${file}). Try again.`);
    await cache.put(url, new Response(bytes));
    return bytes;
  };

  const [configText, preprocessorText] = await Promise.all(['config.json', 'preprocessor_config.json'].map(async f => new TextDecoder().decode(await get(f))));
  const total = data.weights.bytes, weights = new Uint8Array(total);
  let done = 0, offset = 0;
  const mb = n => (n / 1048576).toFixed(0);
  onProgress(`Starter model: ${mb(0)} of ${mb(total)} MB…`);
  for (const part of data.weights.parts) {
    const bytes = await get(part.file, part);
    weights.set(new Uint8Array(bytes), offset);
    offset += bytes.byteLength;
    done += bytes.byteLength;
    onProgress(`Starter model: ${mb(done)} of ${mb(total)} MB…`);
  }
  if (offset !== total) throw new Error('The starter model is incomplete. Try again.');
  return { name: data.name, files: { configText, preprocessorText, weights: weights.buffer } };
}
