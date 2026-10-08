// Offline cache for the published site (made by scripts/build.mjs, which fills
// in VERSION and FILES). The robot's WiFi has no internet, so once the site
// has been opened online every file it needs is kept here:
//   - this site's files: from the network when it answers, otherwise from the
//     cache (pages, code, the SensAV image model weights);
//   - TensorFlow.js and fonts from their CDNs: from the cache, fetched once.
// Each deploy has its own cache; older ones are removed.

const VERSION = '__VERSION__';
const FILES = __FILES__;
const CDN = __CDN__;
const CACHE = `sensds-web-${VERSION}`;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One file failing (a flaky CDN) must not stop the rest
    await Promise.all(FILES.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    // CDN modules, and the modules they import in turn ("/npm/...")
    const seen = new Set(), queue = [...CDN];
    while (queue.length) {
      const u = queue.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      try {
        const res = await fetch(u);
        if (!res.ok) continue;
        await cache.put(u, res.clone());
        for (const m of (await res.text()).matchAll(/(?:from|import)\s*["'](\/npm\/[^"']+)["']/g)) queue.push(`https://cdn.jsdelivr.net${m[1]}`);
      } catch { /* cached later, when the app loads it */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('sensds-web-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

const sameOrigin = url => url.origin === self.location.origin;
const cacheable = url => sameOrigin(url) || /(^|\.)cdn\.jsdelivr\.net$|^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!cacheable(url)) return;               // the robot, Hugging Face downloads, ...
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (sameOrigin(url)) {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req) ?? (req.mode === 'navigate' ? await cache.match(new URL(url.pathname.endsWith('/') ? 'index.html' : url.pathname, url).href) : undefined);
        if (hit) return hit;
        throw new Error(`offline and not cached: ${url.pathname}`);
      }
    }
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  })());
});
