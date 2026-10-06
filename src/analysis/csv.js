// CSV export in the exact text SensDSv2's core/physical_features.py writes:
// Python csv.writer (excel dialect: comma, minimal quoting, CRLF) with values
// formatted as f"{v:.6g}".

import { SUMMARY_KEYS, FRAME_KEYS } from './physical_features.js';

// Python format(v, '.6g')
export function pyG(v, p = 6) {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const [mant, expStr] = v.toExponential(p - 1).split('e');
  const exp = parseInt(expStr, 10);
  const strip = s => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp < -4 || exp >= p) {
    const e = Math.abs(exp) < 10 ? `0${Math.abs(exp)}` : `${Math.abs(exp)}`;
    return `${strip(mant)}e${exp < 0 ? '-' : '+'}${e}`;
  }
  return strip(v.toFixed(p - 1 - exp));
}

function field(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = cells => cells.map(field).join(',') + '\r\n';

export const SUMMARY_ID_COLS = ['sample_id', 'student', 'gesture', 'file'];
export const FRAME_ID_COLS = ['sample_id', 'student', 'gesture', 'frame'];

// records: [{ student, gesture, name, summary }]
export function summaryCsv(records) {
  let out = row([...SUMMARY_ID_COLS, ...SUMMARY_KEYS]);
  records.forEach((r, i) => { out += row([i + 1, r.student, r.gesture, r.name, ...SUMMARY_KEYS.map(k => pyG(r.summary[k]))]); });
  return out;
}

// records: [{ student, gesture, name, series }]
export function framesCsv(records) {
  let out = row([...FRAME_ID_COLS, ...FRAME_KEYS]);
  let rows = 0;
  records.forEach((r, i) => {
    for (let j = 0; j < r.series.time_s.length; j++) {
      out += row([i + 1, r.student, r.gesture, j, ...FRAME_KEYS.map(k => pyG(r.series[k][j]))]);
      rows++;
    }
  });
  return { text: out, rows };
}
