// Reader and writer for the safetensors format Hugging Face models are saved
// in: 8-byte little-endian header length, a JSON header naming each tensor's
// dtype, shape and byte range, then the raw little-endian data.

// IEEE half and bfloat16 to float32 (the starter model is stored as float16)
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
function halfToFloat(h) {
  const s = (h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) { if (m === 0) { U32[0] = s; return F32[0]; } return (s ? -1 : 1) * m * 2 ** -24; }   // zero, subnormal
  if (e === 31) { U32[0] = s | 0x7f800000 | (m << 13); return F32[0]; }                              // inf, NaN
  U32[0] = s | ((e + 112) << 23) | (m << 13);
  return F32[0];
}
function toFloat32(dtype, bytes) {
  if (dtype === 'F32') return new Float32Array(bytes);
  const src = new Uint16Array(bytes), out = new Float32Array(src.length);
  if (dtype === 'F16') { for (let i = 0; i < src.length; i++) out[i] = halfToFloat(src[i]); return out; }
  if (dtype === 'BF16') { const u = new Uint32Array(out.buffer); for (let i = 0; i < src.length; i++) u[i] = src[i] << 16; return out; }
  throw new Error(`a ${dtype} tensor; only F32, F16 and BF16 are supported`);
}

// Returns { tensors: Map(name -> { dtype, shape, data: Float32Array }), metadata }
// F16 and BF16 tensors are widened to float32 (dtype says what was stored).
export function readSafetensors(buffer) {
  const dv = new DataView(buffer);
  const headerLen = Number(dv.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLen)));
  const base = 8 + headerLen;
  const tensors = new Map();
  for (const [name, t] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const [start, end] = t.data_offsets;
    let data;
    try { data = toFloat32(t.dtype, buffer.slice(base + start, base + end)); }
    catch (e) { throw new Error(`Tensor ${name} is ${e.message}`); }
    tensors.set(name, { dtype: t.dtype, shape: t.shape, data });
  }
  return { tensors, metadata: header.__metadata__ || {} };
}

// tensors: Map or array of [name, { shape, data: Float32Array }]. Names are
// written in sorted order, as safetensors does, with {"format": "pt"} metadata
// so PyTorch / transformers load the file.
export function writeSafetensors(tensors, metadata = { format: 'pt' }) {
  const entries = [...tensors].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const header = { __metadata__: metadata };
  let offset = 0;
  for (const [name, t] of entries) {
    header[name] = { dtype: 'F32', shape: t.shape, data_offsets: [offset, offset + t.data.byteLength] };
    offset += t.data.byteLength;
  }
  let json = JSON.stringify(header);
  json += ' '.repeat((8 - (json.length % 8)) % 8);              // align the data to 8 bytes
  const headerBytes = new TextEncoder().encode(json);
  const out = new Uint8Array(8 + headerBytes.length + offset);
  new DataView(out.buffer).setBigUint64(0, BigInt(headerBytes.length), true);
  out.set(headerBytes, 8);
  let o = 8 + headerBytes.length;
  for (const [, t] of entries) { out.set(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength), o); o += t.data.byteLength; }
  return out;
}
