// Writing JSON the way Python / Hugging Face does, without losing the
// difference between 0.0 and 0. JSON.parse turns 0.0 into 0, and
// transformers 5 rejects a config with "hidden_dropout_prob": 0 (int where a
// float is expected), so numbers keep their original text.

class Num {
  constructor(source) { this.source = source; }
}

// Parse keeping each number's source text (JSON.parse source text access;
// browsers without it fall back to marking every non-integer as a float).
export function parseKeepNumbers(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value !== 'number') return value;
    return new Num(context?.source ?? (Number.isInteger(value) ? String(value) : String(value)));
  });
}

// Python float literal for a JS number, as json.dumps writes floats
export const pyFloat = v => (Number.isInteger(v) ? `${v}.0` : String(v));
export const float = v => new Num(pyFloat(v));
export const int = v => new Num(String(v));

const escape = s => JSON.stringify(s).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// json.dumps(obj, indent=2, sort_keys=True) (ensure_ascii=True)
export function dumps(obj, { sortKeys = true, indent = 2, level = 0 } = {}) {
  const pad = ' '.repeat(indent * (level + 1)), end = ' '.repeat(indent * level);
  if (obj instanceof Num) return obj.source;
  if (obj === null) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return escape(obj);
  if (Array.isArray(obj)) {
    if (!obj.length) return '[]';
    return `[\n${obj.map(v => pad + dumps(v, { sortKeys, indent, level: level + 1 })).join(',\n')}\n${end}]`;
  }
  const keys = Object.keys(obj);
  if (!keys.length) return '{}';
  if (sortKeys) keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{\n${keys.map(k => `${pad}${escape(k)}: ${dumps(obj[k], { sortKeys, indent, level: level + 1 })}`).join(',\n')}\n${end}}`;
}
