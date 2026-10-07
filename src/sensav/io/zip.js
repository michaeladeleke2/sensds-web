// Small ZIP reader and writer for the archives SensAV uses: PyTorch's model.pt
// (stored entries, data aligned to 64 bytes), numpy's .npz (stored) and the
// .sensavmodel transfer file (deflated). Deflate goes through the browser's
// CompressionStream / DecompressionStream ('deflate-raw'), which Node has too.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const inflateRaw = bytes => pipe(bytes, new DecompressionStream('deflate-raw'));
const deflateRaw = bytes => pipe(bytes, new CompressionStream('deflate-raw'));

// Map(name -> Uint8Array)
export async function readZip(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014B50) throw new Error('Damaged ZIP directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = b.subarray(dataStart, dataStart + csize);
    if (method === 0) files.set(name, raw.slice());
    else if (method === 8) files.set(name, await inflateRaw(raw));
    else throw new Error(`${name}: unsupported compression ${method}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// entries: [[name, Uint8Array]]. align: pad each entry's data to that many
// bytes with an "FB" extra field, as PyTorch does. deflate: compress entries.
export async function writeZip(entries, { align = 0, deflate = false } = {}) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name), crc = crc32(data);
    const body = deflate ? await deflateRaw(data) : data, method = deflate ? 8 : 0;
    let extra = new Uint8Array(0);
    if (align) {
      const start = offset + 30 + nameBytes.length;
      let pad = (align - ((start + 4) % align)) % align;
      extra = new Uint8Array(4 + pad);
      extra[0] = 0x46; extra[1] = 0x42; extra[2] = pad & 0xFF; extra[3] = pad >> 8;
    }
    const header = new Uint8Array(30 + nameBytes.length + extra.length), hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034B50, true); hv.setUint16(4, 20, true); hv.setUint16(6, 0x0800, true); hv.setUint16(8, method, true);
    hv.setUint16(10, dosTime, true); hv.setUint16(12, dosDate, true);
    hv.setUint32(14, crc, true); hv.setUint32(18, body.length, true); hv.setUint32(22, data.length, true);
    hv.setUint16(26, nameBytes.length, true); hv.setUint16(28, extra.length, true);
    header.set(nameBytes, 30); header.set(extra, 30 + nameBytes.length);
    parts.push(header, body);
    const cd = new Uint8Array(46 + nameBytes.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014B50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += header.length + body.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054B50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const total = offset + cdSize + 22, out = new Uint8Array(total);
  let o = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, o); o += p.length; }
  return out;
}
