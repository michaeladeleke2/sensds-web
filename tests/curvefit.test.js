// Curve Fit: the desktop's core/curve_fit.py (one sinusoid, damped, trace
// cleanup, snapping, number formatting) and scipy on sums of sinusoids.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fmtG, cleanTrace, snapToPeak, fitCurve, leastSquares, sinusoidGuess, evaluate, MODEL_SINUSOID, MODEL_DAMPED } from '../src/curvefit/fit.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/curvefit/curvefit.json', import.meta.url)));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test('fmtG is Python format(x, ".3g")', () => {
  assert.deepEqual(fx.g.values.map(x => fmtG(x)), fx.g.out);
});

test('cleanTrace and the starting guess match the desktop', () => {
  for (const c of fx.desktop.filter(c => c.clean_t)) {
    const { t, v } = cleanTrace(c.points);
    assert.equal(t.length, c.clean_t.length);
    t.forEach((x, i) => close(x, c.clean_t[i], 1e-12, 't'));
    v.forEach((x, i) => close(x, c.clean_v[i], 1e-12, 'v'));
    const gs = sinusoidGuess(t, v);
    [gs.amplitude, gs.freq, gs.offset, gs.span].forEach((x, i) => close(x, c.guess[i], 1e-12, 'guess'));
  }
});

test('snapToPeak matches the desktop, ties included', () => {
  const s = fx.snap.spec, rows = s.length, cols = s[0].length;
  const spec = { data: Float64Array.from(s.flat()), rows, cols };
  const out = snapToPeak(fx.snap.points, spec, 0.125, 0.2);
  out.forEach(([t, v], i) => { close(t, fx.snap.snapped[i][0], 1e-12, 't'); close(v, fx.snap.snapped[i][1], 1e-12, `v ${i}`); });
});

test('one sinusoid and damped: the desktop\'s fit, equation and readout', () => {
  for (const c of fx.desktop.filter(c => c.ok && c.r_squared > 0.5)) {
    const r = fitCurve(c.points, c.model);
    assert.ok(r.ok);
    // (A, phi) and (-A, phi + pi) are the same curve; the two optimisers can
    // land on either, so compare the curve, then the text when the sign agrees
    const ts = Array.from({ length: 50 }, (_, i) => c.clean_t[0] + i * (c.clean_t.at(-1) - c.clean_t[0]) / 49);
    const theirs = evaluate(c.model, 1, c.params, ts), ours = r.predict(ts);
    ours.forEach((x, i) => close(x, theirs[i], 1e-6, `${c.model} curve at ${ts[i]}`));
    const fi = c.model === MODEL_DAMPED ? 2 : 1;
    close(r.params[fi], c.params[fi], 1e-6, 'frequency');
    close(r.params.at(-1), c.params.at(-1), 1e-6, 'offset');
    close(r.rSquared, c.r_squared, 1e-8, 'R²');
    assert.equal(r.physics, c.physics);
    if (Math.sign(r.params[0]) === Math.sign(c.params[0])) {
      assert.equal(r.equation, c.equation);
      assert.equal(r.paramText, c.param_text);
    }
  }
});

test('where the desktop lands on a poor minimum, the web fit does better', () => {
  const c = fx.desktop.find(c => c.ok && c.r_squared < 0.5);
  const r = fitCurve(c.points, c.model);
  assert.ok(r.rSquared > 0.9, `R² ${r.rSquared}`);
  close(r.comps[0].f, 0.35, 0.02, 'frequency');
});

test('too few points: the desktop\'s message', () => {
  const c = fx.desktop.find(c => !c.ok);
  const r = fitCurve(c.points, c.model);
  assert.equal(r.ok, false);
  assert.equal(r.message, c.message);
});

test('sums of sinusoids: same minimum as scipy from the same start', () => {
  for (const c of fx.sums) {
    const model = c.damped ? MODEL_DAMPED : MODEL_SINUSOID;
    const { params } = leastSquares(model, c.k, c.p0, c.t, c.v);
    params.forEach((x, i) => close(x, c.params[i], 1e-5, `k=${c.k} p${i}`));
  }
});

test('sums of sinusoids: fitCurve finds the frequencies on its own', () => {
  for (const c of fx.sums) {
    const model = c.damped ? MODEL_DAMPED : MODEL_SINUSOID;
    const pts = c.t.map((t, i) => [t, c.v[i]]);
    const r = fitCurve(pts, model, { components: c.k });
    assert.ok(r.ok, r.message);
    assert.ok(r.rSquared > 0.98, `R² ${r.rSquared}`);
    const m = c.damped ? 4 : 3, fi = c.damped ? 2 : 1;
    const trueF = Array.from({ length: c.k }, (_, j) => c.true[j * m + fi]).sort((a, b) => a - b);
    r.comps.forEach((q, j) => close(q.f, trueF[j], 0.02, `curve ${j + 1} frequency`));
    assert.equal(r.physics.split('Curve').length - 1, c.k);
  }
});

// ── team feedback: exponential, Auto Fit, the range map, the student readout ──

import { MODEL_EXP, autoTrace, findPeaks, peakStart, exponentialGuess } from '../src/curvefit/fit.js';
import { explainFit, explainPeaks, fitQuality, g } from '../src/curvefit/explain.js';

test('exponential: decay and growth are recovered, A at t = 0', () => {
  for (const [A, k, c] of [[0.8, -0.5, 0.1], [0.05, 0.3, -0.2], [1.5, -0.8, 1.0]]) {
    const pts = Array.from({ length: 60 }, (_, i) => { const t = 2 + i * 0.08; return [t, A * Math.exp(k * t) + c + 0.002 * Math.sin(41 * t)]; });
    const r = fitCurve(pts, MODEL_EXP);
    assert.ok(r.ok, r.message);
    close(r.comps[0].A, A, 0.03, 'A'); close(r.comps[0].k, k, 0.03, 'k'); close(r.offset, c, 0.03, 'c');
    assert.ok(r.rSquared > 0.99);
    assert.match(r.equation, /^v\(t\) = .* e\^\(/);
    assert.match(r.physics, k < 0 ? /Half-life/ : /Doubling time/);
  }
  assert.equal(exponentialGuess([1], [2]).A, 0);              // one point: no rate to find
});

test('range quantity: r(t) in metres; velocity text unchanged', () => {
  const pts = Array.from({ length: 50 }, (_, i) => { const t = i * 0.1; return [t, 1.2 + 0.1 * Math.sin(2 * Math.PI * 0.6 * t + 0.4)]; });
  const r = fitCurve(pts, MODEL_SINUSOID, { quantity: 'range' });
  assert.ok(r.ok);
  assert.match(r.equation, /^r\(t\) = /);
  assert.match(r.paramText, /A = [-0-9.]+ m {3}f = /);
  assert.match(r.paramText, /c = 1\.2 m$/);
  close(r.comps[0].f, 0.6, 1e-6, 'f');
});

// A picture with a ridge at velocity v(t) = 1.5 sin(2π 0.5 t), row 0 the most negative
function ridgePicture(fn, { rows = 512, cols = 80, ts = 0.1, scale = 2 * 4.112380411522634 / 512, offset = 256, gaps = [] } = {}) {
  const data = new Float64Array(rows * cols).fill(-80);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] += 4 * Math.sin(r * 12.9898 + c * 78.233);   // noise
  for (let c = 0; c < cols; c++) {
    if (gaps.includes(c)) continue;
    const row = Math.round(fn((c + 0.5) * ts) / scale + offset);
    for (let d = -2; d <= 2; d++) if (row + d >= 0 && row + d < rows) data[(row + d) * cols + c] = -20 - 3 * Math.abs(d);
  }
  return { spec: { data, rows, cols }, ts, scale, offset };
}

test('autoTrace follows the ridge, skips the still band and weak columns', () => {
  const fn = t => 1.5 * Math.sin(2 * Math.PI * 0.5 * t);
  const { spec, ts, scale, offset } = ridgePicture(fn, { gaps: [10, 11, 12] });
  const pts = autoTrace(spec, { timeScale: ts, scale, rowOffset: offset, yRange: [-3, 3], deadZone: 0.1 });
  assert.ok(pts.length >= 60 && pts.length <= 77, `${pts.length} points`);
  for (const [t, v] of pts) assert.ok(Math.abs(v - fn(t)) < 0.05 || Math.abs(fn(t)) < 0.15, `t ${t}: ${v} vs ${fn(t)}`);
  assert.ok(!pts.some(([t]) => Math.abs(t - 1.15) < 0.01), 'a column with no signal is skipped');
  const r = fitCurve(pts, MODEL_SINUSOID);
  close(r.comps[0].f, 0.5, 0.01, 'frequency'); assert.ok(r.rSquared > 0.98);
});

test('autoTrace on a range map: rows from 0 m, distance window respected', () => {
  const step = 0.0068, fn = t => 1.0 + 0.15 * Math.sin(2 * Math.PI * 0.7 * t);
  const { spec } = ridgePicture(fn, { scale: step, offset: 0 });
  // a stronger still reflector at 0.3 m that the distance window leaves out
  for (let c = 0; c < spec.cols; c++) spec.data[Math.round(0.3 / step) * spec.cols + c] = -5;
  const pts = autoTrace(spec, { timeScale: 0.1, scale: step, rowOffset: 0, yRange: [0.6, 2] });
  assert.ok(pts.length > 70);
  for (const [t, v] of pts) assert.ok(Math.abs(v - fn(t)) < 0.02, `t ${t}: ${v}`);
  const all = autoTrace(spec, { timeScale: 0.1, scale: step, rowOffset: 0, yRange: [0, 3.48] });
  assert.ok(all.every(([, v]) => Math.abs(v - 0.3) < 0.01), 'without the window the strong still reflector wins');
});

test('snapToPeak with rowOffset 0 snaps on a range axis', () => {
  const { spec } = ridgePicture(() => 1.0, { scale: 0.01, offset: 0, rows: 300, cols: 20 });
  const out = snapToPeak([[0.55, 1.08], [1.05, 0.93]], spec, 0.1, 0.01, 20, 0);
  for (const [, v] of out) close(v, 1.0, 1e-9, 'snapped range');
});

test('findPeaks and peakStart: the peaks give the swing', () => {
  const f = 0.8, A = 0.6, c = 0.2, phi = 0.9;
  const t = Array.from({ length: 120 }, (_, i) => i * 0.05), v = t.map(x => A * Math.sin(2 * Math.PI * f * x + phi) + c + 0.02 * Math.sin(37 * x));
  const peaks = findPeaks(t, v);
  assert.ok(peaks.positive.length >= 4 && peaks.negative.length >= 4);
  peaks.all.slice(1).forEach((p, i) => assert.notEqual(p.sign, peaks.all[i].sign, 'peaks alternate'));
  const s = peakStart(MODEL_SINUSOID, peaks);
  close(s.freq, f, 0.05, 'peak frequency'); close(s.params[0], A, 0.08, 'peak amplitude'); close(s.params[3], c, 0.05, 'peak middle');
  const fit = fitCurve(t.map((x, i) => [x, v[i]]), MODEL_SINUSOID, { extraStarts: [s.params] });
  close(fit.comps[0].f, f, 1e-3, 'fit frequency');
  // damped: the shrinking peaks give tau
  const tau = 2.5, vd = t.map(x => A * Math.exp(-x / tau) * Math.sin(2 * Math.PI * f * x + phi));
  const sd = peakStart(MODEL_DAMPED, findPeaks(t, vd));
  close(sd.params[1], tau, 0.15, 'peak tau');
  assert.equal(peakStart(MODEL_EXP, peaks), null);
  assert.match(explainPeaks(peaks, 'm/s'), /high peaks ▲ and <b>\d+<\/b> low peaks ▼/);
});

test('explainFit: every letter has a name, a value, a unit and a meaning', () => {
  const wave = (t, tau) => 0.5 * Math.exp(-t / tau) * Math.sin(2 * Math.PI * 0.9 * t + 0.3) + 0.2 * Math.sin(2 * Math.PI * 2.1 * t) + 0.05;
  for (const [model, n, letters] of [[MODEL_SINUSOID, 1, ['A', 'f', 'φ', 'c']], [MODEL_DAMPED, 1, ['A', 'τ', 'f', 'φ', 'c']], [MODEL_SINUSOID, 2, ['A', 'f', 'φ', 'A', 'f', 'φ', 'c']], [MODEL_EXP, 1, ['A', 'k', 'c']]]) {
    const pts = Array.from({ length: 80 }, (_, i) => { const t = i * 0.05; return [t, model === MODEL_EXP ? 0.5 * Math.exp(-t / 1.5) + 0.05 : wave(t, model === MODEL_DAMPED ? 3 : 1e9)]; });
    const r = fitCurve(pts, model, { components: n });
    assert.ok(r.ok, `${model}: ${r.message}`);
    const x = explainFit(r);
    assert.deepEqual(x.params.map(p => p.sym.replace(/<[^>]+>|\d/g, '')), letters);
    for (const p of x.params) { assert.ok(p.name && p.meaning && p.unit); assert.match(p.value, /^−?[0-9.,]+( × 10<sup>−?\d+<\/sup>)?$/); }
    assert.ok(x.general.includes('<i>v</i>(<i>t</i>)') && x.numbers.startsWith('<i>v</i>'));
    if (model !== MODEL_EXP) assert.ok(x.results.some(q => /Pendulum length/.test(q.name)));
  }
  assert.equal(fitQuality(0.97).word, 'Excellent fit');
  assert.equal(g(32412.7), '32,400'); assert.equal(g(-0.0000123), '−1.23 × 10<sup>−5</sup>'); assert.equal(g(-0.691), '−0.691'); assert.equal(g(0), '0');
  assert.equal(fitQuality(0.3).level, 'bad');
});
