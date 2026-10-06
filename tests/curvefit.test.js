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
