// Builds dist/: exactly the files index.html loads (including code it loads
// on demand, such as the radar on Connect Radar), nothing else.
//
//   npm run build

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

const isStrata = f => readFileSync(join(root, f), 'utf8').includes('STRATA DERIVED');

// Static imports (always loaded) and dynamic import() calls (loaded on demand).
function imports(file) {
  const text = readFileSync(join(root, file), 'utf8');
  const rel = spec => normalize(join(dirname(file), spec));
  const stat = [...text.matchAll(/(?:\bfrom\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)].map(m => rel(m[1]));
  const dyn = [...text.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map(m => rel(m[1]));
  // Workers: new URL('./worker.js', import.meta.url)
  for (const m of text.matchAll(/new\s+URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) dyn.push(rel(m[1]));
  return { stat, dyn };
}

// Everything reachable through static imports from the given entry points.
function staticClosure(entries) {
  const seen = new Set(), dynamic = [], queue = [...entries];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const { stat, dyn } = imports(f);
    queue.push(...stat);
    dynamic.push(...dyn);
  }
  return { seen, dynamic };
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
const entries = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => normalize(m[1]));
const main = staticClosure(entries);

// Code loaded on demand (the radar, on Connect Radar) is included too.
const files = new Set(['index.html', 'assets/logo-mark.png', 'assets/favicon.png', ...main.seen]);
for (const d of new Set(main.dynamic)) for (const f of staticClosure([d]).seen) files.add(f);
const strata = [...files].filter(isStrata);

// Version tag on every script URL (index.html, imports, workers). A browser then
// caches one complete set of files per deploy and never mixes a new page with
// an older script (GitHub Pages lets browsers cache files for 10 minutes).
let version = (process.env.GITHUB_SHA || '').slice(0, 12);
if (!version) { try { version = execSync('git rev-parse --short=12 HEAD', { cwd: root }).toString().trim(); } catch { version = String(Date.now()); } }
const tag = spec => `${spec}?v=${version}`;
const versioned = (file, text) => {
  if (file === 'index.html') return text.replace(/(<script[^>]*\ssrc=")([^"?]+\.js)(")/g, (m, a, src, b) => a + tag(src) + b);
  if (!file.endsWith('.js')) return text;
  return text
    .replace(/(\bfrom\s*|^\s*import\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2/gm, (m, a, q, spec) => `${a}${q}${tag(spec)}${q}`)
    .replace(/(new\s+URL\(\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2(\s*,\s*import\.meta\.url)/g, (m, a, q, spec, b) => `${a}${q}${tag(spec)}${q}${b}`);
};

rmSync(out, { recursive: true, force: true });
for (const f of [...files].sort()) {
  mkdirSync(dirname(join(out, f)), { recursive: true });
  const isText = f.endsWith('.js') || f.endsWith('.html');
  writeFileSync(join(out, f), isText ? versioned(f, readFileSync(join(root, f), 'utf8')) : readFileSync(join(root, f)));
  console.log('  ' + relative(root, join(out, f)));
}
console.log(`version tag: ?v=${version}`);
console.log(`dist/ ready: ${files.size} files, including ${strata.length} Strata-derived (publishing permitted, see LICENSING.md).`);
