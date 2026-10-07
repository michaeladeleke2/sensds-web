// Loads the arrays reference/python/make_sensav_fixtures.py saved from SensAV's
// own Python code.
import { readFileSync } from 'node:fs';

const FIX = new URL('./fixtures/sensav/', import.meta.url);
export const meta = JSON.parse(readFileSync(new URL('meta.json', FIX)));
const bin = readFileSync(new URL('arrays.bin', FIX));
export const fixtureBytes = name => { const b = readFileSync(new URL(name, FIX)); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

const CTORS = { '<f4': Float32Array, '|u1': Uint8Array, '<u1': Uint8Array, '<f2': Uint16Array, '<i8': BigInt64Array };
export function arr(name) {
  const { dtype, shape, offset } = meta.arrays[name];
  const C = CTORS[dtype];
  if (!C) throw new Error(`dtype ${dtype}`);
  const n = shape.reduce((a, b) => a * b, 1);
  const data = new C(bin.buffer.slice(bin.byteOffset + offset, bin.byteOffset + offset + n * C.BYTES_PER_ELEMENT));
  return Object.assign(data, { shape });
}

export function maxAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error(`length ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

export function countDiff(a, b, tol = 0) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) n++;
  return n;
}
