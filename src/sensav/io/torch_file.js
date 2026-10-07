// PyTorch's torch.save / torch.load file format, for SensAV's model.pt (the
// trained head). A ZIP archive holding data.pkl (a protocol 2 pickle), one
// raw little-endian storage per tensor under data/, and small version files.
//
// The writer produces the same pickle torch.save writes for SensAV's payload
// dict: plain values, and the state_dict as a collections.OrderedDict of
// torch._utils._rebuild_tensor_v2 tensors (float32, contiguous) with its
// _metadata. torch.load(..., weights_only=True) accepts it.
//
// The reader understands the subset of pickle opcodes torch.save produces and
// returns plain JavaScript values, with tensors as { shape, data: Float32Array }.

import { readZip, writeZip } from './zip.js';

// Pickle values the writer understands
export class OrderedDict {
  constructor(entries = [], metadata = null) { this.entries = entries; this.metadata = metadata; }
}
export class Tensor {
  constructor(shape, data) { this.shape = shape; this.data = data; }
}

class PickleWriter {
  constructor() { this.bytes = []; this.memo = new Map(); this.next = 0; this.storages = []; }
  u8(...v) { this.bytes.push(...v); }
  u16(v) { this.u8(v & 0xFF, (v >> 8) & 0xFF); }
  u32(v) { this.u8(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
  put() { const i = this.next++; if (i < 256) this.u8(0x71, i); else { this.u8(0x72); this.u32(i); } return i; }   // BINPUT / LONG_BINPUT
  get(i) { if (i < 256) this.u8(0x68, i); else { this.u8(0x6A); this.u32(i); } }                                    // BINGET / LONG_BINGET
  str(s) {
    if (this.memo.has(`s:${s}`)) { this.get(this.memo.get(`s:${s}`)); return; }
    const b = new TextEncoder().encode(s);
    this.u8(0x58); this.u32(b.length); this.u8(...b);                    // BINUNICODE
    this.memo.set(`s:${s}`, this.put());
  }
  global(mod, name) {
    const key = `g:${mod} ${name}`;
    if (this.memo.has(key)) { this.get(this.memo.get(key)); return; }
    this.u8(0x63, ...new TextEncoder().encode(`${mod}\n${name}\n`));    // GLOBAL
    this.memo.set(key, this.put());
  }
  int(v) {
    if (v >= 0 && v < 256) this.u8(0x4B, v);                               // BININT1
    else if (v >= 0 && v < 65536) { this.u8(0x4D); this.u16(v); }         // BININT2
    else { this.u8(0x4A); this.u32(v | 0); }                               // BININT
  }
  tuple(items) {
    if (items.length === 0) { this.u8(0x29); return; }
    if (items.length <= 3) { for (const v of items) this.value(v); this.u8([0x85, 0x86, 0x87][items.length - 1]); this.put(); return; }
    this.u8(0x28); for (const v of items) this.value(v); this.u8(0x74); this.put();
  }
  dict(entries) {
    this.u8(0x7D); this.put();                                             // EMPTY_DICT
    if (!entries.length) return;
    if (entries.length === 1) { this.value(entries[0][0]); this.value(entries[0][1]); this.u8(0x73); return; }   // SETITEM
    this.u8(0x28);
    for (const [k, v] of entries) { this.value(k); this.value(v); }
    this.u8(0x75);                                                         // SETITEMS
  }
  tensor(t) {
    const key = String(this.storages.length);
    this.storages.push(t.data);
    this.global('torch._utils', '_rebuild_tensor_v2');
    this.u8(0x28);                                                         // MARK (args tuple)
    this.u8(0x28); this.str('storage'); this.global('torch', 'FloatStorage'); this.str(key); this.str('cpu'); this.int(t.data.length); this.u8(0x74); this.put();
    this.u8(0x51);                                                         // BINPERSID
    this.int(0);
    this.tuple(t.shape);
    const strides = t.shape.map((_, i) => t.shape.slice(i + 1).reduce((a, b) => a * b, 1));
    this.tuple(strides);
    this.u8(0x89);                                                         // NEWFALSE (requires_grad)
    this.global('collections', 'OrderedDict'); this.u8(0x29, 0x52); this.put();   // backward_hooks = OrderedDict()
    this.u8(0x74); this.put();                                             // TUPLE
    this.u8(0x52); this.put();                                             // REDUCE
  }
  ordered(od) {
    this.global('collections', 'OrderedDict'); this.u8(0x29, 0x52); this.put();
    if (od.entries.length) {
      this.u8(0x28);
      for (const [k, v] of od.entries) { this.value(k); this.value(v); }
      this.u8(0x75);
    }
    if (od.metadata) {
      // state dict {'_metadata': OrderedDict(...)} applied with BUILD
      this.u8(0x7D); this.put();
      this.str('_metadata');
      this.ordered(new OrderedDict(od.metadata));
      this.u8(0x73, 0x62);                                                 // SETITEM, BUILD
    }
  }
  value(v) {
    if (v instanceof Tensor) this.tensor(v);
    else if (v instanceof OrderedDict) this.ordered(v);
    else if (typeof v === 'string') this.str(v);
    else if (typeof v === 'number' && Number.isInteger(v)) this.int(v);
    else if (typeof v === 'number') { this.u8(0x47); const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v); for (let i = 0; i < 8; i++) this.u8(b.getUint8(i)); }  // BINFLOAT
    else if (v === null || v === undefined) this.u8(0x4E);
    else if (v === true) this.u8(0x88);
    else if (v === false) this.u8(0x89);
    else if (Array.isArray(v)) this.tuple(v);
    else this.dict(Object.entries(v));
  }
}

// torch.save(payload). Plain objects become dicts (insertion order kept).
export async function torchSave(payload, archive = 'model') {
  const w = new PickleWriter();
  w.u8(0x80, 2);
  w.value(payload);
  w.u8(0x2E);
  const enc = s => new TextEncoder().encode(s);
  const id = Array.from({ length: 40 }, () => Math.floor(Math.random() * 10)).join('');
  const entries = [
    [`${archive}/data.pkl`, Uint8Array.from(w.bytes)],
    [`${archive}/.format_version`, enc('1')],
    [`${archive}/.storage_alignment`, enc('64')],
    [`${archive}/byteorder`, enc('little')],
    ...w.storages.map((d, i) => [`${archive}/data/${i}`, new Uint8Array(d.buffer, d.byteOffset, d.byteLength)]),
    [`${archive}/version`, enc('3\n')],
    [`${archive}/.data/serialization_id`, enc(id)],
  ];
  return writeZip(entries, { align: 64 });
}

// torch.load(bytes) for files like SensAV's model.pt
export async function torchLoad(buffer) {
  const files = await readZip(buffer);
  const pkl = [...files.keys()].find(n => n.endsWith('/data.pkl') || n === 'data.pkl');
  if (!pkl) throw new Error('This is not a PyTorch model file.');
  const prefix = pkl.slice(0, pkl.length - 'data.pkl'.length);
  const storage = key => {
    const raw = files.get(`${prefix}data/${key}`);
    if (!raw) throw new Error(`The model file is missing storage ${key}`);
    return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  };
  return unpickle(files.get(pkl), storage);
}

const GLOBALS = {
  'collections OrderedDict': () => ({ __ordered: true, entries: [] }),
  'torch._utils _rebuild_tensor_v2': 'rebuild',
  'torch FloatStorage': 'float',
  'torch._utils _rebuild_parameter': 'parameter',
};

function unpickle(bytes, storage) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stack = [], marks = [], memo = new Map();
  let p = 0;
  const popMark = () => { const m = marks.pop(); return stack.splice(m); };
  const setItem = (d, k, v) => {
    if (d && d.__ordered) d.entries.push([k, v]);
    else d[k] = v;
  };
  const readLine = () => { let e = p; while (bytes[e] !== 0x0A) e++; const s = new TextDecoder().decode(bytes.subarray(p, e)); p = e + 1; return s; };
  for (;;) {
    const op = bytes[p++];
    switch (op) {
      case 0x80: p++; break;                                                       // PROTO
      case 0x7D: stack.push({}); break;                                            // EMPTY_DICT
      case 0x5D: stack.push([]); break;                                            // EMPTY_LIST
      case 0x29: stack.push([]); break;                                            // EMPTY_TUPLE
      case 0x28: marks.push(stack.length); break;                                  // MARK
      case 0x58: { const n = dv.getUint32(p, true); p += 4; stack.push(new TextDecoder().decode(bytes.subarray(p, p + n))); p += n; break; }
      case 0x8C: { const n = bytes[p++]; stack.push(new TextDecoder().decode(bytes.subarray(p, p + n))); p += n; break; }   // SHORT_BINUNICODE
      case 0x71: memo.set(bytes[p++], stack[stack.length - 1]); break;             // BINPUT
      case 0x72: memo.set(dv.getUint32(p, true), stack[stack.length - 1]); p += 4; break;
      case 0x94: memo.set(memo.size, stack[stack.length - 1]); break;              // MEMOIZE
      case 0x68: stack.push(memo.get(bytes[p++])); break;                          // BINGET
      case 0x6A: stack.push(memo.get(dv.getUint32(p, true))); p += 4; break;
      case 0x4B: stack.push(bytes[p++]); break;                                    // BININT1
      case 0x4D: stack.push(dv.getUint16(p, true)); p += 2; break;                 // BININT2
      case 0x4A: stack.push(dv.getInt32(p, true)); p += 4; break;                  // BININT
      case 0x47: stack.push(dv.getFloat64(p, false)); p += 8; break;               // BINFLOAT
      case 0x8A: { const n = bytes[p++]; let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[p + i]); if (n && bytes[p + n - 1] & 0x80) v -= 1n << BigInt(8 * n); p += n; stack.push(Number(v)); break; }  // LONG1
      case 0x4E: stack.push(null); break;
      case 0x88: stack.push(true); break;
      case 0x89: stack.push(false); break;
      case 0x63: { const mod = readLine(), name = readLine(); stack.push(GLOBALS[`${mod} ${name}`] ?? `${mod}.${name}`); break; }
      case 0x93: { const name = stack.pop(), mod = stack.pop(); stack.push(GLOBALS[`${mod} ${name}`] ?? `${mod}.${name}`); break; }  // STACK_GLOBAL
      case 0x85: stack.push([stack.pop()]); break;                                 // TUPLE1
      case 0x86: { const b = stack.pop(), a = stack.pop(); stack.push([a, b]); break; }
      case 0x87: { const c = stack.pop(), b = stack.pop(), a = stack.pop(); stack.push([a, b, c]); break; }
      case 0x74: stack.push(popMark()); break;                                     // TUPLE
      case 0x6C: stack.push(popMark()); break;                                     // LIST
      case 0x61: { const v = stack.pop(); stack[stack.length - 1].push(v); break; }              // APPEND
      case 0x65: { const items = popMark(); stack[stack.length - 1].push(...items); break; }      // APPENDS
      case 0x73: { const v = stack.pop(), k = stack.pop(); setItem(stack[stack.length - 1], k, v); break; }   // SETITEM
      case 0x75: { const items = popMark(), d = stack[stack.length - 1]; for (let i = 0; i < items.length; i += 2) setItem(d, items[i], items[i + 1]); break; }
      case 0x51: {                                                                 // BINPERSID
        const pid = stack.pop();
        if (pid[0] !== 'storage' || pid[1] !== 'float') throw new Error('Only float32 tensors are supported in model files');
        stack.push(storage(pid[2]));
        break;
      }
      case 0x52: {                                                                 // REDUCE
        const args = stack.pop(), fn = stack.pop();
        if (typeof fn === 'function') stack.push(fn(...args));
        else if (fn === 'rebuild') {
          const [data, offset, shape] = args;
          const n = shape.reduce((a, b) => a * b, 1);
          stack.push(new Tensor(shape, data.subarray(offset, offset + n)));
        } else if (fn === 'parameter') stack.push(args[0]);
        else throw new Error(`The model file uses ${fn}, which this app cannot read`);
        break;
      }
      case 0x62: { const state = stack.pop(), obj = stack[stack.length - 1]; if (obj && obj.__ordered) obj.metadata = state._metadata ?? state; break; }   // BUILD
      case 0x2E: return toPlain(stack.pop());                                      // STOP
      default: throw new Error(`Unsupported pickle opcode 0x${op.toString(16)}`);
    }
  }
}

function toPlain(v) {
  if (v && v.__ordered) return new Map(v.entries.map(([k, x]) => [k, toPlain(x)]));
  if (v instanceof Tensor || ArrayBuffer.isView(v) || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(toPlain);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
}
