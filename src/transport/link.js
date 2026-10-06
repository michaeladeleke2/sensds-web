// STRATA DERIVED: packet framing and control/data dispatch ported from
// Strata platform/serial/BridgeSerial.cpp (Infineon Evaluation Software License).
// Publishing permitted (permission confirmed 2026-10-05). See LICENSING.md.
//
// Serial link to the board. Starts from the Step 1 Link class, with the byte
// queue replaced by a packet parser, because once data is started control
// responses and data packets share one stream.
//
// Control response: bmReqType(echo), bStatus, wLength(LE), payload, CRC16(BE)
// Data packet:      bmPktType(0xDx), bChannel, wCounter(LE), wLength(LE), payload, CRC16(BE)
// Request:          bmReqType, bRequest, wValue(LE), wIndex(LE), wLength(LE), payload, CRC16(BE)

import { crc16 } from './crc16.js';

export const VENDOR_REQ_WRITE = 0x40;
export const VENDOR_REQ_READ = 0xC0;
export const VENDOR_REQ_TRANSFER = 0x43;
export const DATA_FRAME_PACKET = 0xD0;

export const DEFAULT_BAUD = 921600;   // same order the SDK tries
export const FALLBACK_BAUD = 1000000;
export const TIMEOUT_MS = 1000;       // BridgeSerial defaultTimeout

// SERIAL_MAX_PACKET_SIZE (universal/link_definitions.h)
export const MAX_PACKET_SIZE = 1024 * 4 - 1;
const COMMAND_HEADER_SIZE = 8;
const RESPONSE_HEADER_SIZE = 4;
const DATA_HEADER_SIZE = 6;
const CRC_SIZE = 2;
// BridgeSerial::getMaxTransfer()
export const MAX_TRANSFER = MAX_PACKET_SIZE - COMMAND_HEADER_SIZE - CRC_SIZE;

export const STATUS_NAMES = {
  0x80: 'header incomplete', 0x81: 'payload incomplete', 0x82: 'payload too long',
  0x83: 'payload fragmented', 0x84: 'CRC error', 0x85: 'request type invalid',
  0x86: 'request invalid', 0x87: 'not implemented', 0x88: 'wLength invalid',
  0x89: 'wValue invalid', 0x8A: 'wIndex invalid', 0x8B: 'payload invalid', 0x8C: 'not available'
};

export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');

const isControlType = t => t === VENDOR_REQ_READ || t === VENDOR_REQ_WRITE || t === VENDOR_REQ_TRANSFER;

// Growable byte FIFO. Data arrives at about 1.5 MB/s, so no per-byte arrays.
export class ByteQueue {
  constructor(capacity = 1 << 16) { this.buf = new Uint8Array(capacity); this.start = 0; this.end = 0; }
  get length() { return this.end - this.start; }
  push(bytes) {
    if (this.end + bytes.length > this.buf.length) {
      const live = this.length;
      if (live + bytes.length > this.buf.length) {
        let cap = this.buf.length;
        while (cap < live + bytes.length) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(this.start, this.end));
        this.buf = next;
      } else {
        this.buf.copyWithin(0, this.start, this.end);
      }
      this.start = 0; this.end = live;
    }
    this.buf.set(bytes, this.end);
    this.end += bytes.length;
  }
  peek(i) { return this.buf[this.start + i]; }
  take(n) { const out = this.buf.slice(this.start, this.start + n); this.start += n; if (this.start === this.end) this.start = this.end = 0; return out; }
  clear() { this.start = this.end = 0; }
}

// Splits the byte stream into packets. Pure logic, no I/O, so it can be tested.
// onControl(packet) and onData(packet) receive whole packets with the CRC checked.
export class PacketParser {
  constructor({ onControl, onData, onSyncLost }) {
    this.queue = new ByteQueue();
    this.onControl = onControl;
    this.onData = onData;
    this.onSyncLost = onSyncLost;
  }

  push(bytes) {
    this.queue.push(bytes);
    const q = this.queue;
    for (;;) {
      if (q.length < 4) return;
      const type = q.peek(0);
      if ((type & 0xF0) === DATA_FRAME_PACKET) {
        if (q.length < DATA_HEADER_SIZE) return;
        const wLength = q.peek(4) | (q.peek(5) << 8);
        const total = DATA_HEADER_SIZE + wLength + CRC_SIZE;
        if (q.length < total) return;
        const raw = q.take(total);
        this.onData({
          type,
          channel: raw[1],
          counter: raw[2] | (raw[3] << 8),
          payload: raw.subarray(DATA_HEADER_SIZE, DATA_HEADER_SIZE + wLength),
          crcOk: crc16(raw) === 0,
        });
      } else if (isControlType(type)) {
        const wLength = q.peek(2) | (q.peek(3) << 8);
        const total = RESPONSE_HEADER_SIZE + wLength + CRC_SIZE;
        if (q.length < total) return;
        const raw = q.take(total);
        this.onControl({
          type,
          status: raw[1],
          payload: raw.subarray(RESPONSE_HEADER_SIZE, RESPONSE_HEADER_SIZE + wLength),
          crcOk: crc16(raw) === 0,
          raw,
        });
      } else {
        // BridgeSerial::readPacketStart: unknown packet type, synchronization lost.
        // The SDK marks the link for resynchronisation and clears the input
        // buffer before the next command; we drop what is buffered now.
        const head = q.take(Math.min(4, q.length));
        q.clear();
        if (this.onSyncLost) this.onSyncLost(head);
      }
    }
  }

  clear() { this.queue.clear(); }
}

export class Link {
  // port: a Web Serial SerialPort (or anything with the same open/readable/writable shape)
  constructor(port, { log = () => {} } = {}) {
    this.port = port;
    this.log = log;
    this.closed = true;
    this.pending = null;           // the one outstanding command, as in BridgeSerial
    this.onData = null;            // set by the data path; data packets are dropped while null
    this.parser = new PacketParser({
      onControl: p => this._onControl(p),
      onData: p => { if (this.onData) this.onData(p); },
      onSyncLost: head => this.log('Sync lost, unknown packet start ' + hex(head)),
    });
  }

  async open(baudRate) {
    await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 1 << 20 });
    this.closed = false;
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.pump = this._readLoop();
  }

  async _readLoop() {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this.parser.push(value);
      }
    } catch (e) { if (!this.closed) this.log('Read loop error: ' + e.message); }
  }

  clearInput() { this.parser.clear(); }

  _onControl(p) {
    // A response with no command outstanding is discarded, as the SDK does.
    if (!this.pending) { this.log('Discarding unexpected control response ' + hex(p.raw.subarray(0, 4))); return; }
    const { resolve } = this.pending;
    this.pending = null;
    resolve(p);
  }

  async close() {
    this.closed = true;
    try { await this.reader.cancel(); } catch {}
    try { this.reader.releaseLock(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    try { await this.pump; } catch {}
    try { await this.port.close(); } catch {}
  }

  // One request/response exchange (BridgeSerial::sendRequest + receiveResponse).
  async request(bmReqType, bRequest, wValue, wIndex, wLength, payload, maxReceive) {
    if (this.pending) throw new Error('A command is already in progress');
    const packet = buildRequest(bmReqType, bRequest, wValue, wIndex, wLength, payload);
    this.log('TX ' + hexShort(packet));

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; reject(new Error('Timeout: request response header not received')); }, TIMEOUT_MS);
      this.pending = { resolve: p => { clearTimeout(timer); resolve(p); } };
    });
    await this.writer.write(packet);
    const p = await response;
    this.log('RX ' + hexShort(p.raw));
    return checkResponse(p, bmReqType, wLength, maxReceive);
  }

  vendorWrite(bRequest, wValue, wIndex, payload) {
    const p = payload || new Uint8Array(0);
    return this.request(VENDOR_REQ_WRITE, bRequest, wValue, wIndex, p.length, p, 0);
  }
  vendorRead(bRequest, wValue, wIndex, wLength) {
    return this.request(VENDOR_REQ_READ, bRequest, wValue, wIndex, wLength, null, wLength);
  }
  vendorTransfer(bRequest, wValue, wIndex, payload, maxReceive) {
    const p = payload || new Uint8Array(0);
    return this.request(VENDOR_REQ_TRANSFER, bRequest, wValue, wIndex, p.length, p, maxReceive);
  }
}

export function buildRequest(bmReqType, bRequest, wValue, wIndex, wLength, payload) {
  const header = Uint8Array.of(bmReqType, bRequest, wValue & 0xFF, wValue >> 8, wIndex & 0xFF, wIndex >> 8, wLength & 0xFF, wLength >> 8);
  // For a read, wLength is the expected reply length and no payload is sent.
  const body = (bmReqType === VENDOR_REQ_READ || !payload) ? new Uint8Array(0) : payload;
  const crc = crc16(body, crc16(header));
  const packet = new Uint8Array(header.length + body.length + CRC_SIZE);
  packet.set(header, 0); packet.set(body, header.length);
  packet[packet.length - 2] = crc >> 8; packet[packet.length - 1] = crc & 0xFF;
  return packet;
}

// Same checks, in the same order, as BridgeSerial::receiveResponse.
export function checkResponse(p, bmReqType, wLength, maxReceive) {
  if (p.payload.length > maxReceive) throw new Error(`Request response too long for buffer (${p.payload.length} > ${maxReceive})`);
  if (!p.crcOk) throw new Error('Request response CRC error');
  if (p.type !== bmReqType) throw new Error(`Request response type error: got 0x${p.type.toString(16)}`);
  if (p.status) {
    const err = new Error(`Board returned status 0x${p.status.toString(16)} (${STATUS_NAMES[p.status] || 'error code'})`);
    err.status = p.status;
    throw err;
  }
  if (bmReqType === VENDOR_REQ_READ && p.payload.length !== wLength) throw new Error(`Read request response length error: ${p.payload.length} vs ${wLength}`);
  return p.payload;
}

const hexShort = bytes => bytes.length <= 48 ? hex(bytes) : `${hex(bytes.subarray(0, 40))} ... (${bytes.length} bytes)`;
