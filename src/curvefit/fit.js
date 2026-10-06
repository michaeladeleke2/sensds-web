// Curve fitting for the Curve Fit tab, ported from SensDSv2 core/curve_fit.py:
// a student freezes the spectrogram, traces the ridge a moving target leaves,
// and fits a function to it. A Newton's cradle swinging toward and away from
// the radar draws a sinusoid, so the fitted frequency predicts a pendulum
// length the student can check with a ruler.
//
// Changes requested by the team on top of the desktop:
//   - the Polynomial and Linear models are gone,
//   - the model is a sum of one to four sinusoids (damped or not) plus an
//     offset, so a trace with several frequencies in it can be fitted. With
//     one sinusoid the model, the starting guess, the bounds and every line of
//     text are the desktop's.
//
// scipy's curve_fit (Trust Region Reflective, since bounds are given) is
// replaced by Levenberg-Marquardt with the same bounds held by projection. Both
// descend from the same starting point to the same least-squares minimum; the
// tests check the parameters against scipy.

import { roundHalfEven } from '../dsp/doppler_live.js';

export const G = 9.81;
export const MODEL_SINUSOID = 'sinusoid';
export const MODEL_DAMPED = 'damped_sinusoid';
export const MODEL_LABELS = { [MODEL_SINUSOID]: 'Sinusoid', [MODEL_DAMPED]: 'Damped sinusoid' };
export const MAX_COMPONENTS = 4;

// ── Python float formatting ──────────────────────────────────────────────────

// format(x, '.{p}g')
export function fmtG(x, p = 3) {
  x = Number(x);
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const [mant, expStr] = x.toExponential(p - 1).split('e');
  const exp = Number(expStr);
  const strip = s => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp >= -4 && exp < p) return strip(x.toFixed(Math.max(0, p - 1 - exp)));
  return `${strip(mant)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}
const g = fmtG;
// A term's sign folded into the operator, so no equation reads '+ -0.2'
const signed = x => (x < 0 ? `- ${g(Math.abs(x))}` : `+ ${g(x)}`);

// ── trace cleanup ────────────────────────────────────────────────────────────

// Sort a traced path by time and collapse repeated times: tracing backtracks,
// so one instant can carry several velocities; each cluster of near equal
// times becomes its mean.
export function cleanTrace(points) {
  const pts = points.map(([t, v]) => [Number(t), Number(v)]);
  if (!pts.length) return { t: [], v: [] };
  const order = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0] || a - b);   // stable
  const t = order.map(i => pts[i][0]), v = order.map(i => pts[i][1]);
  if (t.length === 1) return { t, v };
  // Scaled to the traced span so it means the same in any time window
  const span = t[t.length - 1] - t[0];
  const tol = span > 0 ? span * 1e-3 : 1e-9;
  const ot = [], ov = [];
  let st = t[0], sv = v[0], n = 1;
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] > tol) { ot.push(st / n); ov.push(sv / n); st = 0; sv = 0; n = 0; }
    st += t[i]; sv += v[i]; n++;
  }
  ot.push(st / n); ov.push(sv / n);
  return { t: ot, v: ov };
}

// Pull each traced point onto the strongest bin near it, so the fit follows
// the signal rather than the steadiness of the hand.
//   spec: { data (row major), rows: velocity bins, cols }, row 0 the most
//         negative velocity on the plot's axis
//   timeScale: seconds per column; velScale: m/s per bin
export function snapToPeak(points, spec, timeScale, velScale, windowBins = 20) {
  const pts = points.map(([t, v]) => [Number(t), Number(v)]);
  if (!spec || !spec.rows || !spec.cols || !timeScale || !velScale) return pts;
  const { data, rows, cols } = spec;
  const half = rows / 2;
  return pts.map(([t, v]) => {
    const col = Math.min(cols - 1, Math.max(0, Math.trunc(roundHalfEven(t / timeScale))));
    const row = Math.trunc(roundHalfEven(v / velScale + half));
    const lo = Math.max(0, row - windowBins), hi = Math.min(rows, row + windowBins + 1);
    if (hi <= lo) return [t, v];
    let max = -Infinity;
    for (let r = lo; r < hi; r++) max = Math.max(max, data[r * cols + col]);
    // On a tie, which is what a window with no signal in it looks like, keep
    // the bin nearest the traced point rather than the lowest one
    let best = -1;
    for (let r = lo; r < hi; r++) if (data[r * cols + col] === max && (best < 0 || Math.abs(r - row) < Math.abs(best - row))) best = r;
    return [t, (best - half) * velScale];
  });
}

// ── models ───────────────────────────────────────────────────────────────────

// Parameters: per component [A, f, phi] (sinusoid) or [A, tau, f, phi]
// (damped), then the offset c. With one component that is the desktop's order.
const perComp = model => (model === MODEL_DAMPED ? 4 : 3);
export const nParams = (model, k) => perComp(model) * k + 1;

export function evaluate(model, k, p, t) {
  const m = perComp(model), c = p[m * k];
  const out = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    let s = c;
    for (let j = 0; j < k; j++) {
      const o = j * m;
      if (model === MODEL_DAMPED) s += p[o] * Math.exp(-t[i] / p[o + 1]) * Math.sin(2 * Math.PI * p[o + 2] * t[i] + p[o + 3]);
      else s += p[o] * Math.sin(2 * Math.PI * p[o + 1] * t[i] + p[o + 2]);
    }
    out[i] = s;
  }
  return out;
}

// d model / d params, (n x nParams) row major
function jacobian(model, k, p, t) {
  const m = perComp(model), np = m * k + 1, J = new Float64Array(t.length * np);
  for (let i = 0; i < t.length; i++) {
    const ti = t[i], row = i * np;
    for (let j = 0; j < k; j++) {
      const o = j * m;
      if (model === MODEL_DAMPED) {
        const [A, tau, f, phi] = [p[o], p[o + 1], p[o + 2], p[o + 3]];
        const e = Math.exp(-ti / tau), arg = 2 * Math.PI * f * ti + phi, s = Math.sin(arg), co = Math.cos(arg);
        J[row + o] = e * s;
        J[row + o + 1] = A * e * s * ti / (tau * tau);
        J[row + o + 2] = A * e * co * 2 * Math.PI * ti;
        J[row + o + 3] = A * e * co;
      } else {
        const [A, f, phi] = [p[o], p[o + 1], p[o + 2]];
        const arg = 2 * Math.PI * f * ti + phi;
        J[row + o] = Math.sin(arg);
        J[row + o + 1] = A * Math.cos(arg) * 2 * Math.PI * ti;
        J[row + o + 2] = A * Math.cos(arg);
      }
    }
    J[row + m * k] = 1;
  }
  return J;
}

function bounds(model, k) {
  const m = perComp(model), lo = new Array(m * k + 1).fill(-Infinity);
  for (let j = 0; j < k; j++) {
    if (model === MODEL_DAMPED) { lo[j * m + 1] = 1e-6; lo[j * m + 2] = 0; }   // tau stays positive or the exponential runs away
    else lo[j * m + 1] = 0;
  }
  return lo;
}

// Solve (A) x = b for a small symmetric positive definite A (Cholesky)
function solveSpd(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let q = 0; q < j; q++) s -= L[i * n + q] * L[j * n + q];
      if (i === j) { if (!(s > 0)) return null; L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let q = 0; q < i; q++) s -= L[i * n + q] * y[q]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let q = i + 1; q < n; q++) s -= L[q * n + i] * x[q]; x[i] = s / L[i * n + i]; }
  return x;
}

const sse = (r) => { let s = 0; for (const x of r) s += x * x; return s; };

// Levenberg-Marquardt (MINPACK-style scaling, gain-ratio damping); lower
// bounds held by projection. Throws a RuntimeError, as curve_fit does, when it
// runs out of iterations.
export function leastSquares(model, k, p0, t, v, { maxIter = 500, ftol = 1e-12, xtol = 1e-12, gtol = 1e-14 } = {}) {
  const np = p0.length, lo = bounds(model, k), n = t.length;
  const project = q => q.map((x, i) => Math.max(lo[i], x));
  const resid = q => { const f = evaluate(model, k, q, t); return f.map((x, i) => x - v[i]); };
  let p = project(p0.slice()), r = resid(p), cost = sse(r);
  if (!Number.isFinite(cost)) throw Object.assign(new Error('Residuals are not finite in the initial point'), { name: 'ValueError' });
  const D = new Float64Array(np);
  let lambda = -1, nu = 2;
  for (let it = 0; it < maxIter; it++) {
    const J = jacobian(model, k, p, t);
    const JtJ = new Float64Array(np * np), grad = new Float64Array(np);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < np; a++) {
        const ja = J[i * np + a];
        grad[a] += ja * r[i];
        for (let b = 0; b <= a; b++) JtJ[a * np + b] += ja * J[i * np + b];
      }
    }
    for (let a = 0; a < np; a++) for (let b = 0; b < a; b++) JtJ[b * np + a] = JtJ[a * np + b];
    let gmax = 0;
    for (let a = 0; a < np; a++) {
      D[a] = Math.max(D[a], JtJ[a * np + a], 1e-300);
      // a component held at its bound with the gradient pushing outward is converged
      const free = !(p[a] <= lo[a] && grad[a] > 0);
      if (free) gmax = Math.max(gmax, Math.abs(grad[a]) / Math.sqrt(D[a]));
    }
    if (gmax <= gtol * Math.max(1, Math.sqrt(cost))) return { params: p, cost };
    if (lambda < 0) lambda = 1e-3 * Math.max(...Array.from(D));
    for (;;) {
      const M = JtJ.slice();
      for (let a = 0; a < np; a++) M[a * np + a] += lambda * D[a];
      const step = solveSpd(M, grad.map(x => -x), np);
      if (!step) { lambda *= nu; nu *= 2; if (lambda > 1e300) return { params: p, cost }; continue; }
      const pn = project(p.map((x, i) => x + step[i]));
      const d = pn.map((x, i) => x - p[i]);
      let gd = 0, dHd = 0;
      for (let a = 0; a < np; a++) { gd += grad[a] * d[a]; for (let b = 0; b < np; b++) dHd += d[a] * JtJ[a * np + b] * d[b]; }
      const predicted = -2 * gd - dHd;                    // predicted drop in the sum of squares
      const rn = resid(pn), cn = sse(rn);
      const actual = cost - cn;
      const rho = predicted > 0 && Number.isFinite(cn) ? actual / predicted : -1;
      if (rho > 0) {
        p = pn; r = rn; const prev = cost; cost = cn;
        lambda *= Math.max(1 / 3, 1 - (2 * rho - 1) ** 3); nu = 2;
        const dn = Math.sqrt(d.reduce((s2, x, a) => s2 + D[a] * x * x, 0)), xn = Math.sqrt(p.reduce((s2, x, a) => s2 + D[a] * x * x, 0));
        if (dn <= xtol * (xn + xtol)) return { params: p, cost };
        if (actual <= ftol * prev && predicted <= ftol * prev) return { params: p, cost };
        break;
      }
      lambda *= nu; nu *= 2;
      if (lambda > 1e300 || Math.sqrt(d.reduce((s2, x, a) => s2 + D[a] * x * x, 0)) <= xtol * xtol) return { params: p, cost };
    }
  }
  throw Object.assign(new Error('Optimal parameters not found'), { name: 'RuntimeError' });
}

// ── starting guesses ─────────────────────────────────────────────────────────

// _sinusoid_guess: amplitude from peak to peak, frequency from zero crossings,
// offset from the mean. curve_fit's defaults are all ones, which never
// converges here.
export function sinusoidGuess(t, v) {
  let amplitude = (Math.max(...v) - Math.min(...v)) / 2;
  if (amplitude <= 0) amplitude = 1;
  const offset = v.reduce((a, b) => a + b, 0) / v.length;
  const span = t.length > 1 ? t[t.length - 1] - t[0] : 0;
  let crossings = 0;
  for (let i = 1; i < v.length; i++) if ((v[i] - offset < 0 || Object.is(v[i] - offset, -0)) !== (v[i - 1] - offset < 0 || Object.is(v[i - 1] - offset, -0))) crossings++;
  const freq = span > 0 && crossings ? crossings / (2 * span) : span > 0 ? 1 / span : 1;
  return { amplitude, freq, offset, span };
}

// The strongest frequency left in a residual: least-squares sine fit over a
// frequency grid (a periodogram that copes with uneven tracing), then its
// amplitude and phase.
function strongestFrequency(t, r, span, avoid = []) {
  const fMin = 0.5 / span, fMax = Math.max(fMin * 2, 0.5 * (t.length - 1) / span);
  const step = 0.05 / span, gap = 1 / span;           // frequencies closer than 1/span cannot be told apart
  let best = { power: -1, f: fMin, A: 0, phi: 0 };
  for (let f = fMin; f <= fMax; f += step) {
    if (avoid.some(a => Math.abs(f - a) < gap)) continue;
    let ss = 0, cc = 0, sc = 0, ys = 0, yc = 0;
    for (let i = 0; i < t.length; i++) {
      const a = 2 * Math.PI * f * t[i], s = Math.sin(a), c = Math.cos(a);
      ss += s * s; cc += c * c; sc += s * c; ys += r[i] * s; yc += r[i] * c;
    }
    const det = ss * cc - sc * sc;
    if (Math.abs(det) < 1e-12) continue;
    const a = (ys * cc - yc * sc) / det, b = (yc * ss - ys * sc) / det;    // r ≈ a sin + b cos
    const power = a * ys + b * yc;
    if (power > best.power) best = { power, f, A: Math.hypot(a, b), phi: Math.atan2(b, a) };
  }
  return best;
}

// Starting parameters for k components. One component: the desktop's guess.
// More: peel the strongest frequency off the residual one at a time, refining
// each with a one-sinusoid fit. startFreqs (Hz, or null) override the guessed
// frequencies, for traces where the student knows roughly what to expect.
export function initialGuess(model, k, t, v, startFreqs = []) {
  const { amplitude, freq, offset, span } = sinusoidGuess(t, v);
  const m = perComp(model);
  const comps = [];
  if (k === 1) comps.push({ A: amplitude, f: startFreqs[0] > 0 ? startFreqs[0] : freq, phi: 0 });
  else {
    // Pick the strongest frequency not yet taken, refit everything picked so
    // far together, and look again in what is left
    let resid = v.map(x => x - offset);
    for (let j = 0; j < k; j++) {
      const forced = startFreqs[j] > 0 ? startFreqs[j] : null;
      const c = forced ? { f: forced, A: amplitude / k, phi: 0 } : strongestFrequency(t, resid, span > 0 ? span : 1, comps.map(q => q.f));
      comps.push({ A: c.A || amplitude / k, f: c.f, phi: c.phi });
      try {
        const n = comps.length;
        const fit = leastSquares(MODEL_SINUSOID, n, [...comps.flatMap(q => [q.A, q.f, q.phi]), offset], t, v);
        if (fit.params.every(Number.isFinite)) comps.forEach((q, i) => {
          const [A, f, phi] = fit.params.slice(i * 3, i * 3 + 3);
          if (f > 0) Object.assign(q, { A, f: startFreqs[i] > 0 && i === n - 1 ? q.f : f, phi });
        });
      } catch { /* keep the grid estimates */ }
      const sum = evaluate(MODEL_SINUSOID, comps.length, [...comps.flatMap(q => [q.A, q.f, q.phi]), offset], t);
      resid = v.map((x, i) => x - sum[i]);
    }
  }
  const p = [];
  for (const c of comps) {
    if (model === MODEL_DAMPED) p.push(c.A, span > 0 ? span : 1, c.f, c.phi);
    else p.push(c.A, c.f, c.phi);
  }
  p.push(offset);
  if (p.length !== m * k + 1) throw new Error('internal: parameter count');
  return p;
}

// ── result text ──────────────────────────────────────────────────────────────

function rSquared(v, pred) {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let res = 0, tot = 0;
  v.forEach((x, i) => { res += (x - pred[i]) ** 2; tot += (x - mean) ** 2; });
  if (tot <= 0) return res <= 0 ? 1 : 0;
  return 1 - res / tot;
}

// Frequency, period, and the simple pendulum that would swing at it
export function pendulumReadout(freqHz) {
  const f = Math.abs(Number(freqHz));
  if (!Number.isFinite(f) || f <= 0) return '';
  const length = G / (4 * Math.PI ** 2 * f ** 2);
  return `Frequency  ${g(f)} Hz\nPeriod     ${g(1 / f)} s\nPredicted length for a simple pendulum  ${g(length)} m`;
}

// ── fitting ──────────────────────────────────────────────────────────────────

// Fit `model` with `k` sinusoids to a traced path. Never throws: a fit that
// will not converge comes back as ok=false with something readable in message.
export function fitCurve(points, model = MODEL_SINUSOID, { components = 1, startFreqs = [] } = {}) {
  const k = Math.max(1, Math.min(MAX_COMPONENTS, Math.trunc(components)));
  const { t, v } = cleanTrace(points);
  const needed = nParams(model, k);
  const label = MODEL_LABELS[model] ?? model;
  if (t.length < needed) {
    const what = k === 1 ? label : `${label} with ${k} curves`;
    return { ok: false, message: `${what} needs at least ${needed} points; the trace has ${t.length}.` };
  }
  // Start from the desktop's guess; with one sinusoid also from the trace's
  // strongest frequency, since jitter adds zero crossings and can push the
  // desktop's guess onto a poor local minimum. The lower cost wins, so where
  // the desktop's guess works the answer is the same.
  const starts = [initialGuess(model, k, t, v, startFreqs)];
  if (k === 1 && !(startFreqs[0] > 0)) {
    const { span, offset } = sinusoidGuess(t, v);
    const s = strongestFrequency(t, v.map(x => x - offset), span > 0 ? span : 1);
    starts.push(model === MODEL_DAMPED ? [s.A, span > 0 ? span : 1, s.f, s.phi, offset] : [s.A, s.f, s.phi, offset]);
  }
  let params = null, bestCost = Infinity, lastError = null;
  for (const p0 of starts) {
    try {
      const fit = leastSquares(model, k, p0, t, v);
      if (fit.params.every(Number.isFinite) && fit.cost < bestCost * (1 - 1e-6)) { params = fit.params; bestCost = fit.cost; }
    } catch (e) { lastError = e; }
  }
  if (!params) {
    const name = lastError?.name || 'ValueError';
    return { ok: false, message: `The fit did not converge (${name}). Trace more of the curve, or try a different model.` };
  }

  const m = perComp(model);
  let comps = [];
  for (let j = 0; j < k; j++) {
    const o = j * m;
    comps.push(model === MODEL_DAMPED ? { A: params[o], tau: params[o + 1], f: params[o + 2], phi: params[o + 3] } : { A: params[o], f: params[o + 1], phi: params[o + 2] });
  }
  const c = params[m * k];
  if (k > 1) {
    // Lowest frequency first, so curve 1 is the slow swing
    comps.sort((a, b) => a.f - b.f);
    params = [...comps.flatMap(q => (model === MODEL_DAMPED ? [q.A, q.tau, q.f, q.phi] : [q.A, q.f, q.phi])), c];
  }
  const predict = x => evaluate(model, k, params, x);

  const term = q => (model === MODEL_DAMPED ? `${g(q.A)} e^(-t/${g(q.tau)}) sin(2π ${g(q.f)} t ${signed(q.phi)})` : `${g(q.A)} sin(2π ${g(q.f)} t ${signed(q.phi)})`);
  const terms = comps.map((q, j) => (j === 0 ? term(q) : q.A < 0 ? `- ${term({ ...q, A: -q.A })}` : `+ ${term(q)}`));
  const equation = `v(t) = ${terms.join(' ')} ${signed(c)}`;

  const names = model === MODEL_DAMPED ? ['A', 'tau', 'f', 'phi'] : ['A', 'f', 'phi'];
  const units = model === MODEL_DAMPED ? ['m/s', 's', 'Hz', 'rad'] : ['m/s', 'Hz', 'rad'];
  const paramText = k === 1
    ? [...names.map((n, i) => `${n} = ${g(params[i])} ${units[i]}`), `c = ${g(c)} m/s`].join('   ')
    : [...comps.map((q, j) => names.map((n, i) => `${n}${j + 1} = ${g(params[j * m + i])} ${units[i]}`).join('   ')), `c = ${g(c)} m/s`].join('\n');
  const physics = k === 1 ? pendulumReadout(comps[0].f)
    : comps.map((q, j) => { const r = pendulumReadout(q.f); return r ? `Curve ${j + 1}\n${r}` : ''; }).filter(Boolean).join('\n\n');

  return {
    ok: true, model, components: k, params, comps, offset: c, paramText, equation, physics,
    rSquared: rSquared(v, predict(t)), t, v, predict, message: '',
  };
}
