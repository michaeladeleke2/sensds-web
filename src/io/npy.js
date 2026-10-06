// Minimal reader for NumPy .npy files (format versions 1.0 to 3.0), enough for
// the raw radar cubes SensDSv2's Collect tab saves as sample_NNN_raw.npy.

const DTYPES = {
  '<f4': [Float32Array, 4], '<f8': [Float64Array, 8],
  '<i2': [Int16Array, 2], '<u2': [Uint16Array, 2], '<i4': [Int32Array, 4],
};

export function parseNpy(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = [0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59];   // \x93NUMPY
  if (!magic.every((b, i) => bytes[i] === b)) throw new Error('Not a .npy file');
  const major = bytes[6];
  const dv = new DataView(buffer);
  const headerLen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder('latin1').decode(bytes.subarray(headerStart, headerStart + headerLen));

  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1] === 'True';
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1] ?? '';
  const shape = shapeText.split(',').map(s => s.trim()).filter(Boolean).map(Number);

  const dtype = DTYPES[descr];
  if (!dtype) throw new Error(`Unsupported dtype ${descr}`);
  if (fortran) throw new Error('Fortran-ordered arrays are not supported');

  const [Ctor, size] = dtype;
  const offset = headerStart + headerLen;
  const count = shape.reduce((a, b) => a * b, 1);
  if (offset + count * size > buffer.byteLength) throw new Error('File is shorter than its header says');
  // Copy so the data is aligned whatever the header length.
  const data = new Ctor(buffer.slice(offset, offset + count * size));
  return { data, shape, descr };
}

// Interprets a parsed array as radar frames: (n_frame, n_ant, n_chirp, n_sample)
// or a single (n_ant, n_chirp, n_sample) frame. Returns a function giving
// antenna 0 of frame i as (n_chirp x n_sample) float data.
export function framesFromNpy({ data, shape }) {
  let s = shape;
  if (s.length === 3) s = [1, ...s];
  if (s.length !== 4) throw new Error(`Expected (frames, antennas, chirps, samples), got (${shape.join(', ')})`);
  const [nFrame, nAnt, nChirp, nSample] = s;
  const per = nAnt * nChirp * nSample;
  return {
    nFrame, nAnt, nChirp, nSample,
    antenna0: i => data.subarray(i * per, i * per + nChirp * nSample),
  };
}

// Writes a float32 array as a version 1.0 .npy file (C order, little endian).
export function writeNpyFloat32(data, shape) {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const total = 10 + header.length + 1;
  header += ' '.repeat((64 - (total % 64)) % 64) + '\n';     // pad so the data starts on a 64-byte boundary
  const out = new Uint8Array(10 + header.length + data.byteLength);
  out.set([0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59, 1, 0, header.length & 0xFF, header.length >> 8]);
  out.set(new TextEncoder().encode(header), 10);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 10 + header.length);
  return out;
}
