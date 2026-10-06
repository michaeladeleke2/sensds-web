// Reader and writer for the safetensors format Hugging Face models are saved
// in: 8-byte little-endian header length, a JSON header naming each tensor's
// dtype, shape and byte range, then the raw little-endian data.

// Returns { tensors: Map(name -> { dtype, shape, data: Float32Array }), metadata }
export function readSafetensors(buffer) {
  const dv = new DataView(buffer);
  const headerLen = Number(dv.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLen)));
  const base = 8 + headerLen;
  const tensors = new Map();
  for (const [name, t] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    if (t.dtype !== 'F32') throw new Error(`Tensor ${name} is ${t.dtype}; only F32 is supported`);
    const [start, end] = t.data_offsets;
    tensors.set(name, { dtype: t.dtype, shape: t.shape, data: new Float32Array(buffer.slice(base + start, base + end)) });
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
