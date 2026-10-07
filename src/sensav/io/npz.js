// numpy .npz archives (np.savez: a stored ZIP of .npy files), for SensAV's
// embeddings.npz cache: per mode, the sample ids as a fixed-width unicode
// array ('<U<n>', UTF-32) and the embeddings as float16 (n x 1 x 1024).

import { readZip, writeZip } from './zip.js';

function npyHeader(descr, shape) {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const total = 10 + header.length + 1;
  header += ' '.repeat((64 - (total % 64)) % 64) + '\n';
  const out = new Uint8Array(10 + header.length);
  out.set([0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59, 1, 0, header.length & 0xFF, header.length >> 8]);
  out.set(new TextEncoder().encode(header), 10);
  return out;
}

const join = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

// Strings as numpy's '<U<n>' array (n = longest string, at least 1)
export function npyStrings(strings) {
  const cps = strings.map(s => [...s].map(c => c.codePointAt(0)));
  const width = Math.max(1, ...cps.map(c => c.length));
  const data = new Uint32Array(strings.length * width);
  cps.forEach((c, i) => data.set(c, i * width));
  return join(npyHeader(`<U${width}`, [strings.length]), new Uint8Array(data.buffer));
}

// A Uint16Array of float16 bits as '<f2'
export const npyFloat16 = (bits, shape) => join(npyHeader('<f2', shape), new Uint8Array(bits.buffer, bits.byteOffset, bits.byteLength));

// .npy bytes -> { descr, shape, data } (strings for '<U', Uint16Array bits for '<f2', Float32Array for '<f4')
export function parseNpyAny(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const start = major === 1 ? 10 : 12;
  const header = new TextDecoder('latin1').decode(bytes.subarray(start, start + headerLen));
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)[1];
  const shape = (/'shape'\s*:\s*\(([^)]*)\)/.exec(header)[1]).split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const body = bytes.slice(start + headerLen);
  if (descr.startsWith('<U')) {
    const width = Number(descr.slice(2)), cps = new Uint32Array(body.buffer, 0, count * width);
    const strings = [];
    for (let i = 0; i < count; i++) {
      let s = '';
      for (let k = 0; k < width; k++) { const c = cps[i * width + k]; if (!c) break; s += String.fromCodePoint(c); }
      strings.push(s);
    }
    return { descr, shape, data: strings };
  }
  if (descr === '<f2') return { descr, shape, data: new Uint16Array(body.buffer, 0, count) };
  if (descr === '<f4') return { descr, shape, data: new Float32Array(body.buffer, 0, count) };
  throw new Error(`Unsupported array type ${descr}`);
}

// Map(name without .npy -> parsed array)
export async function readNpz(buffer) {
  const files = await readZip(buffer), out = new Map();
  for (const [name, bytes] of files) out.set(name.replace(/\.npy$/, ''), parseNpyAny(bytes));
  return out;
}

// arrays: [[name, npy bytes]]
export const writeNpz = arrays => writeZip(arrays.map(([n, b]) => [`${n}.npy`, b]));
