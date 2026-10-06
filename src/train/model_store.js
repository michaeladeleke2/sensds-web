// The base models SensDSv2 fine-tunes, downloaded once from Hugging Face (the
// desktop's "Download Model (once)") and kept in the browser's Cache Storage.

export const MODEL_OPTIONS = {
  Small: 'WinKawaks/vit-small-patch16-224',     // ~22 M params
  Base: 'google/vit-base-patch16-224',          // ~86 M params
};
export const DEFAULT_MODEL_KEY = 'Small';
const FILES = ['config.json', 'preprocessor_config.json', 'model.safetensors'];
const CACHE = 'sensds-models-v1';
const url = (id, f) => `https://huggingface.co/${id}/resolve/main/${f}`;

export async function isCached(id) {
  try {
    const cache = await caches.open(CACHE);
    for (const f of FILES) if (!(await cache.match(url(id, f)))) return false;
    return true;
  } catch { return false; }
}

// onProgress(text)
export async function download(id, onProgress = () => {}) {
  const cache = await caches.open(CACHE);
  for (const f of FILES) {
    if (await cache.match(url(id, f))) continue;
    const res = await fetch(url(id, f));
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (total > 1e6) onProgress(`Downloading ${id}: ${f} ${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
    }
    await cache.put(url(id, f), new Response(new Blob(chunks), { headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream' } }));
  }
}

// { configText, preprocessor, weights (ArrayBuffer) }
export async function load(id) {
  const cache = await caches.open(CACHE);
  const get = async f => { const r = await cache.match(url(id, f)); if (!r) throw new Error(`${f} is not downloaded`); return r; };
  return {
    configText: await (await get('config.json')).text(),
    preprocessor: await (await get('preprocessor_config.json')).json(),
    weights: await (await get('model.safetensors')).arrayBuffer(),
  };
}
