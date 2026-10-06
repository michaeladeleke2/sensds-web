// Tick positions and labels as matplotlib 3.10 places them by default:
// MaxNLocator('auto', steps [1, 2, 2.5, 5, 10]) via AutoLocator, with
// Axis.get_tick_space(), and ScalarFormatter's label format.

const STEPS = [1, 2, 2.5, 5, 10];
const EXTENDED = [...STEPS.slice(0, -1).map(s => 0.1 * s), ...STEPS, 10 * STEPS[1]];
const MIN_N_TICKS = 2;

// Python floor division and modulo for floats
const pyFloorDiv = (a, b) => Math.floor(a / b);
const pyMod = (a, b) => a - Math.floor(a / b) * b;

function scaleRange(vmin, vmax, n = 1, threshold = 100) {
  const dv = Math.abs(vmax - vmin);
  const meanv = (vmax + vmin) / 2;
  let offset = 0;
  if (!(Math.abs(meanv) / dv < threshold)) offset = Math.sign(meanv) * 10 ** Math.floor(Math.log10(Math.abs(meanv)));
  const scale = 10 ** Math.floor(Math.log10(dv / n));
  return { scale, offset };
}

function edgeLe(x, step, offset) {
  const d = pyFloorDiv(x, step), m = pyMod(x, step);
  const tol = offset > 0 ? Math.max(1e-10, 10 ** (Math.log10(Math.abs(offset / step)) - 12)) : 1e-10;
  return Math.abs(m / step - 1) < tol ? d + 1 : d;
}
function edgeGe(x, step, offset) {
  const d = pyFloorDiv(x, step), m = pyMod(x, step);
  const tol = offset > 0 ? Math.max(1e-10, 10 ** (Math.log10(Math.abs(offset / step)) - 12)) : 1e-10;
  return Math.abs(m / step) < tol ? d : d + 1;
}

// tickSpace: Axis.get_tick_space(): floor(axis length in points / (label size * 2 for y, * 3 for x))
export function maxNLocatorTicks(vmin, vmax, tickSpace) {
  const nbins = Math.min(9, Math.max(Math.max(1, MIN_N_TICKS - 1), tickSpace));
  const { scale, offset } = scaleRange(vmin, vmax, nbins);
  const _vmin = vmin - offset, _vmax = vmax - offset;
  const steps = EXTENDED.map(s => s * scale);
  const rawStep = (_vmax - _vmin) / nbins;
  let istep = steps.length - 1;
  for (let i = 0; i < steps.length; i++) {
    const floored = pyFloorDiv(_vmin, steps[i]) * steps[i];
    if (steps[i] >= rawStep && floored + steps[i] * nbins >= _vmax) { istep = i; break; }
  }
  let ticks = [];
  for (let i = istep; i >= 0; i--) {
    const step = steps[i];
    const bestVmin = pyFloorDiv(_vmin, step) * step;
    const low = edgeLe(_vmin - bestVmin, step, offset);
    const high = edgeGe(_vmax - bestVmin, step, offset);
    ticks = [];
    for (let k = low; k <= high; k++) ticks.push(k * step + bestVmin);
    const nticks = ticks.filter(t => t <= _vmax && t >= _vmin).length;
    if (nticks >= MIN_N_TICKS) break;
  }
  return ticks.map(t => t + offset);
}

// ScalarFormatter._set_format for the no-offset, no-scientific case, then
// unicode minus as axes.unicode_minus = True renders it.
export function formatTicks(locs) {
  let range = Math.max(...locs) - Math.min(...locs);
  if (range === 0) range = Math.max(...locs.map(Math.abs));
  if (range === 0) range = 1;
  const oom = Math.floor(Math.log10(range));
  let sigfigs = Math.max(0, 3 - oom);
  const thresh = 1e-3 * 10 ** oom;
  const roundTo = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  while (sigfigs >= 0) {
    if (Math.max(...locs.map(v => Math.abs(v - roundTo(v, sigfigs)))) < thresh) sigfigs--;
    else break;
  }
  sigfigs++;
  return locs.map(v => {
    let s = v.toFixed(sigfigs);
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);    // '%1.0f' % -0.0 gives '-0'; matplotlib shows 0 for exact zero ticks
    return s.replace('-', '−');
  });
}

// Axis.get_tick_space for an axis of lengthPx at dpi, tick labels at fontPt
export const yTickSpace = (lengthPx, dpi, fontPt = 10) => Math.floor((lengthPx / dpi) * 72 / (fontPt * 2));
export const xTickSpace = (lengthPx, dpi, fontPt = 10) => Math.floor((lengthPx / dpi) * 72 / (fontPt * 3));

// Visible ticks and labels for a view interval.
export function axisTicks(vmin, vmax, tickSpace) {
  const all = maxNLocatorTicks(vmin, vmax, tickSpace);
  const labels = formatTicks(all);
  const out = [];
  all.forEach((t, i) => { if (t >= vmin - 1e-12 && t <= vmax + 1e-12) out.push({ value: t, label: labels[i] }); });
  return out;
}
