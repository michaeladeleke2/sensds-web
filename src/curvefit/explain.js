// The Curve Fit result in words a student can read: the model's general
// form, the same equation with the fitted numbers in it, one card per
// variable saying what it means, and what the fit predicts (period, pendulum
// length, half-life). fit.js keeps the desktop's plain text; this is the
// page's version of it.

import { fmtG, G, MODEL_DAMPED, MODEL_EXP, QUANTITIES } from './fit.js';

// Three significant figures, written for a student: 32,400 rather than
// 3.24e+04, and 1.2 × 10⁻⁵ for very small numbers
export function g(x) {
  const a = Math.abs(x);
  if (Number.isFinite(x) && a >= 1e4 && a < 1e12) return Number(x.toPrecision(3)).toLocaleString('en-US').replace('-', '−');
  if (Number.isFinite(x) && a > 0 && a < 1e-3) {
    const [m, e] = x.toExponential(2).split('e');
    return `${fmtG(Number(m)).replace('-', '−')} × 10<sup>${Number(e)}</sup>`.replace(/<sup>-/, '<sup>−');
  }
  return fmtG(x).replace(/-/g, '−');
}
const sub = j => (j ? `<sub>${j}</sub>` : '');

// How the R² reads to a student
export function fitQuality(r2) {
  if (r2 >= 0.95) return { word: 'Excellent fit', level: 'ok' };
  if (r2 >= 0.8) return { word: 'Good fit', level: 'ok' };
  if (r2 >= 0.5) return { word: 'Fair fit', level: 'warn' };
  return { word: 'Poor fit', level: 'bad' };
}

const WHAT = {
  velocity: { noun: 'speed', thing: 'speed toward or away from the radar', y: 'v', unit: 'm/s' },
  range: { noun: 'distance', thing: 'distance from the radar', y: 'r', unit: 'm' },
};

function meaningA(model, q, multi) {
  if (model === MODEL_EXP) return `How far the ${q.noun} starts from its final value c, at t = 0.`;
  const base = q.noun === 'speed'
    ? 'How far the speed swings above and below its middle value. A bigger swing gives a bigger A.'
    : 'How far the object moves toward and away from the radar, measured from the middle of its swing.';
  return model === MODEL_DAMPED ? `${base} This is its size at t = 0, before it dies down.` : multi ? `${base} For this curve only.` : base;
}

// { general, numbers, params: [{ sym, name, value, unit, meaning }], results: [...], r2, quality }
export function explainFit(fit) {
  const q = WHAT[fit.quantity] ?? WHAT.velocity;
  const U = (QUANTITIES[fit.quantity] ?? QUANTITIES.velocity).unit;
  const Y = `<i>${q.y}</i>(<i>t</i>)`;
  const k = fit.components, multi = k > 1;
  const params = [], results = [];
  let general, numbers;

  if (fit.model === MODEL_EXP) {
    const { A, k: rate } = fit.comps[0];
    general = `${Y} = <i>A</i> · e<sup><i>k</i>·<i>t</i></sup> + <i>c</i>`;
    numbers = `${Y} = ${g(A)} · e<sup>${g(rate)}·<i>t</i></sup> ${fit.offset < 0 ? '−' : '+'} ${g(Math.abs(fit.offset))}`;
    params.push(
      { sym: '<i>A</i>', name: 'Starting gap', value: g(A), unit: U, meaning: meaningA(fit.model, q) },
      { sym: '<i>k</i>', name: 'Rate', value: g(rate), unit: '1/s', meaning: `How quickly the ${q.noun} changes. Negative: it shrinks toward c. Positive: it grows. Bigger numbers mean faster change.` },
      { sym: '<i>c</i>', name: 'Final value', value: g(fit.offset), unit: U, meaning: `The ${q.noun} the curve settles toward (when k is negative).` },
    );
    if (rate) {
      const tc = 1 / Math.abs(rate);
      results.push(
        { name: 'Time constant', value: g(tc), unit: 's', meaning: rate < 0 ? 'After this long the gap to c has shrunk to about 37 %.' : 'After this long the gap to c has grown about 2.7 times.' },
        { name: rate < 0 ? 'Half-life' : 'Doubling time', value: g(Math.LN2 * tc), unit: 's', meaning: rate < 0 ? 'After this long the gap to c is half as big.' : 'After this long the gap to c is twice as big.' },
      );
    }
  } else {
    const damped = fit.model === MODEL_DAMPED;
    const termGeneral = j => `<i>A</i>${sub(j)} · ${damped ? `e<sup>−<i>t</i>/<i>τ</i>${sub(j)}</sup> · ` : ''}sin(2π · <i>f</i>${sub(j)} · <i>t</i> + <i>φ</i>${sub(j)})`;
    const termNumbers = c => `${g(Math.abs(c.A))} · ${damped ? `e<sup>−<i>t</i>/${g(c.tau)}</sup> · ` : ''}sin(2π · ${g(c.f)} · <i>t</i> ${c.phi < 0 ? '−' : '+'} ${g(Math.abs(c.phi))})`;
    general = `${Y} = ${fit.comps.map((_, j) => termGeneral(multi ? j + 1 : 0)).join(' + ')} + <i>c</i>`;
    numbers = `${Y} = ${fit.comps.map((c, j) => `${c.A < 0 ? '−' : j ? '+' : ''} ${termNumbers(c)}`.trim()).join(' ')} ${fit.offset < 0 ? '−' : '+'} ${g(Math.abs(fit.offset))}`;
    fit.comps.forEach((c, j) => {
      const s = multi ? j + 1 : 0, group = multi ? `Curve ${j + 1}` : '';
      params.push({ sym: `<i>A</i>${sub(s)}`, name: 'Amplitude', group, value: g(c.A), unit: U, meaning: meaningA(fit.model, q, multi) });
      if (damped) {
        const span = fit.t.length > 1 ? fit.t[fit.t.length - 1] - fit.t[0] : 0;
        const note = span > 0 && c.tau > 10 * span ? ' Here τ is far longer than your trace: the swing hardly dies out at all.' : '';
        params.push({ sym: `<i>τ</i>${sub(s)}`, name: 'Decay time', group, value: g(c.tau), unit: 's', meaning: `How long the swing lasts. After τ seconds it has shrunk to about 37 % of its size; a bigger τ dies out more slowly.${note}` });
      }
      params.push(
        { sym: `<i>f</i>${sub(s)}`, name: 'Frequency', group, value: g(c.f), unit: 'Hz', meaning: 'How many complete back-and-forth swings happen each second.' },
        { sym: `<i>φ</i>${sub(s)}`, name: 'Phase', group, value: g(c.phi), unit: 'rad', meaning: 'Where in its swing the motion was at t = 0. One whole swing is 2π ≈ 6.28 rad.' },
      );
      const f = Math.abs(c.f);
      if (f > 0) {
        const pre = multi ? `Curve ${j + 1}: ` : '';
        results.push(
          { name: `${pre}Period`, sym: '<i>T</i> = 1/<i>f</i>', value: g(1 / f), unit: 's', meaning: 'Seconds for one complete swing, there and back.' },
          { name: `${pre}Pendulum length`, sym: '<i>L</i> = <i>g</i>/(2π<i>f</i>)²', value: g(G / (4 * Math.PI ** 2 * f ** 2)), unit: 'm', meaning: 'The string length of a simple pendulum that swings this fast. Measure yours to check!' },
        );
      }
    });
    params.push({
      sym: '<i>c</i>', name: 'Offset', value: g(fit.offset), unit: U,
      meaning: q.noun === 'speed' ? 'The average speed. Near 0 means the object moves toward and away from the radar equally.' : 'The middle of the swing: the average distance from the radar.',
    });
  }
  return { general, numbers, params, results, r2: fit.rSquared, quality: fitQuality(fit.rSquared), what: q.thing, unit: U };
}

// What the peaks say, for the Auto Fit summary
export function explainPeaks(peaks, unit) {
  if (!peaks || !peaks.all.length) return '';
  const { positive, negative, all } = peaks;
  const halves = [];
  for (let i = 1; i < all.length; i++) if (all[i].sign !== all[i - 1].sign) halves.push(all[i].t - all[i - 1].t);
  const parts = [`Found <b>${positive.length}</b> high peak${positive.length === 1 ? '' : 's'} ▲ and <b>${negative.length}</b> low peak${negative.length === 1 ? '' : 's'} ▼.`];
  if (halves.length) {
    const mean = halves.reduce((a, b) => a + b, 0) / halves.length;
    parts.push(`From a high peak to the next low one takes about <b>${g(mean)} s</b>, half a swing, so one full swing takes about <b>${g(2 * mean)} s</b>.`);
  }
  if (positive.length && negative.length) {
    const up = positive.reduce((s, p) => s + p.v, 0) / positive.length, down = negative.reduce((s, p) => s + p.v, 0) / negative.length;
    parts.push(`The peaks are about <b>${g(up - down)} ${unit}</b> apart from top to bottom.`);
  }
  return parts.join(' ');
}
