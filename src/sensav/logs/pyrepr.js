// Python's way of printing numbers and JSON, so files the web app writes read
// the same as the desktop's: repr(float) ("1.0", "1e-05") and json.dumps'
// default separators (", " and ": ").

export function pyRepr(x) {
  if (typeof x !== 'number') return String(x);
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, expText] = x.toExponential().split('e');
  const exp = Number(expText), neg = mant.startsWith('-');
  const digits = mant.replace('-', '').replace('.', '');
  let out;
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, '0'), frac = digits.slice(exp + 1);
      out = `${intPart}.${frac || '0'}`;
    } else out = `0.${'0'.repeat(-exp - 1)}${digits}`;
  } else {
    const e = exp < 0 ? `-${String(-exp).padStart(2, '0')}` : `+${String(exp).padStart(2, '0')}`;
    out = `${digits[0]}${digits.length > 1 ? '.' + digits.slice(1) : ''}e${e}`;
  }
  return neg ? `-${out}` : out;
}

// json.dumps(record, ensure_ascii=False) for log lines. floatKeys: keys whose
// numbers Python holds as floats.
export function pyJsonLine(value, floatKeys = new Set()) {
  const fmt = (v, key) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return floatKeys.has(key) ? pyRepr(v) : String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(x => fmt(x, key)).join(', ')}]`;
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${fmt(x, k)}`).join(', ')}}`;
  };
  return fmt(value, '');
}
