// matplotlib's "jet" colormap, built the way matplotlib builds it
// (_cm.py _jet_data, colors.py _create_lookup_table, N = 256), and the
// Colormap.__call__ float-to-index rule.

const JET_DATA = {
  red: [[0.00, 0, 0], [0.35, 0, 0], [0.66, 1, 1], [0.89, 1, 1], [1.00, 0.5, 0.5]],
  green: [[0.000, 0, 0], [0.125, 0, 0], [0.375, 1, 1], [0.640, 1, 1], [0.910, 0, 0], [1.000, 0, 0]],
  blue: [[0.00, 0.5, 0.5], [0.11, 1, 1], [0.34, 1, 1], [0.65, 0, 0], [1.00, 0, 0]],
};

export const N = 256;

function lookupTable(data, n) {
  const x = data.map(d => d[0] * (n - 1));
  const y0 = data.map(d => d[1]);
  const y1 = data.map(d => d[2]);
  const step = 1 / (n - 1);                       // numpy.linspace(0, 1, n)
  const xind = Array.from({ length: n }, (_, i) => (n - 1) * (i === n - 1 ? 1 : i * step));
  const lut = new Float64Array(n);
  lut[0] = y1[0];
  lut[n - 1] = y0[y0.length - 1];
  for (let i = 1; i < n - 1; i++) {
    let ind = 0;                                   // numpy.searchsorted, side='left'
    while (ind < x.length && x[ind] < xind[i]) ind++;
    const distance = (xind[i] - x[ind - 1]) / (x[ind] - x[ind - 1]);
    lut[i] = distance * (y0[ind] - y1[ind - 1]) + y1[ind - 1];
  }
  for (let i = 0; i < n; i++) lut[i] = Math.min(1, Math.max(0, lut[i]));
  return lut;
}

// Float LUT, (N x 3) row major
export const JET_LUT = (() => {
  const r = lookupTable(JET_DATA.red, N), g = lookupTable(JET_DATA.green, N), b = lookupTable(JET_DATA.blue, N);
  const lut = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) { lut[i * 3] = r[i]; lut[i * 3 + 1] = g[i]; lut[i * 3 + 2] = b[i]; }
  return lut;
})();

// (lut * 255).astype(np.uint8)
export const JET_LUT_BYTES = Uint8Array.from(JET_LUT, v => Math.trunc(v * 255));

// Colormap.__call__ for a normalised value in [0, 1] (clip=True upstream).
export function lutIndex(v) {
  let xa = v * N;
  if (xa === N) xa = N - 1;
  if (xa < 0) return 0;          // _i_under of a fresh jet is index 0
  if (xa >= N) return N - 1;     // _i_over is index N-1
  return Math.trunc(xa);
}
