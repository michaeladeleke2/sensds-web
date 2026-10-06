import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crc16 } from '../src/transport/crc16.js';
import { buildRequest, checkResponse, PacketParser, MAX_TRANSFER, VENDOR_REQ_READ, VENDOR_REQ_WRITE } from '../src/transport/link.js';
import {
  dataConfigurePayload, SliceAssembler, RawFrameReader, FrameAcquisitionFailed, FifoOverflow,
  DataError_FrameDropped, E_OVERFLOW,
} from '../src/transport/strata.js';

const withCrc = bytes => { const c = crc16(bytes); return Uint8Array.from([...bytes, c >> 8, c & 0xFF]); };
const dataPacket = (type, channel, counter, payload) =>
  withCrc([type, channel, counter & 0xFF, counter >> 8, payload.length & 0xFF, payload.length >> 8, ...payload]);
const controlPacket = (type, status, payload) =>
  withCrc([type, status, payload.length & 0xFF, payload.length >> 8, ...payload]);

test('crc16 CCITT-FALSE check value', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29B1);
});

test('request packet: header LE, CRC big endian, whole-packet CRC is 0', () => {
  const p = buildRequest(0x40, 0x0D, 0x0001, 0x0000, 3, Uint8Array.of(1, 2, 3));
  assert.deepEqual([...p.subarray(0, 8)], [0x40, 0x0D, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00]);
  assert.equal(p.length, 8 + 3 + 2);
  assert.equal(crc16(p), 0);
});

test('read request carries wLength but no payload', () => {
  const p = buildRequest(VENDOR_REQ_READ, 0x80, 0x01, 0, 16, Uint8Array.of(9, 9));
  assert.equal(p.length, 10);
  assert.equal(p[6], 16);
});

test('max transfer over serial is 4085 bytes, 1021 SPI words', () => {
  assert.equal(MAX_TRANSFER, 4085);
  assert.equal(Math.floor(MAX_TRANSFER / 4), 1021);
});

test('parser splits interleaved control and data packets across arbitrary chunking', () => {
  const stream = Uint8Array.from([
    ...dataPacket(0xD1, 0, 7, [1, 2, 3, 4]),
    ...controlPacket(0x40, 0, []),
    ...dataPacket(0xD2, 0, 8, [5, 6]),
  ]);
  for (const chunk of [1, 2, 3, 5, stream.length]) {
    const control = [], data = [];
    const parser = new PacketParser({ onControl: p => control.push(p), onData: p => data.push(p) });
    for (let i = 0; i < stream.length; i += chunk) parser.push(stream.subarray(i, i + chunk));
    assert.equal(control.length, 1);
    assert.equal(control[0].type, 0x40);
    assert.ok(control[0].crcOk);
    assert.deepEqual(data.map(d => [d.type, d.counter, [...d.payload], d.crcOk]),
      [[0xD1, 7, [1, 2, 3, 4], true], [0xD2, 8, [5, 6], true]]);
  }
});

test('parser flags a corrupted data packet and reports sync loss on unknown start byte', () => {
  const bad = dataPacket(0xD3, 0, 1, [1, 2, 3]); bad[7] ^= 0xFF;
  const data = []; let lost = 0;
  const parser = new PacketParser({ onControl: () => {}, onData: p => data.push(p), onSyncLost: () => lost++ });
  parser.push(bad);
  parser.push(Uint8Array.of(0x55, 0, 0, 0, 0, 0));
  assert.equal(data.length, 1);
  assert.equal(data[0].crcOk, false);
  assert.equal(lost, 1);
});

test('response checks match BridgeSerial::receiveResponse', () => {
  const parse = pkt => { let out; new PacketParser({ onControl: p => (out = p), onData: () => {} }).push(pkt); return out; };
  assert.deepEqual([...checkResponse(parse(controlPacket(0xC0, 0, [1, 2])), 0xC0, 2, 2)], [1, 2]);
  assert.throws(() => checkResponse(parse(controlPacket(0x40, 0x86, [])), VENDOR_REQ_WRITE, 0, 0), /status 0x86/);
  assert.throws(() => checkResponse(parse(controlPacket(0xC0, 0, [1])), 0xC0, 2, 2), /length error/);
  assert.throws(() => checkResponse(parse(controlPacket(0x43, 0, [])), 0x40, 0, 0), /type error/);
});

test('data configure payload for the SensDSv2 configuration', () => {
  assert.deepEqual([...dataConfigurePayload(0x60, 8192)],
    [0x10, 0, 0, 0, 0, 0, 0, 0, 0x60, 0x00, 0x00, 0x20]);
});

function collect(sliceBytes) {
  const slices = [], errors = [];
  const asm = new SliceAssembler(sliceBytes, { onSlice: s => slices.push(s), onError: e => errors.push(e) });
  const push = (type, counter, payload, crcOk = true) => asm.push({ type, channel: 0, counter, payload: Uint8Array.from(payload), crcOk });
  return { asm, slices, errors, push };
}

test('slice spanning first, middle and last packets is reassembled', () => {
  const { slices, errors, push } = collect(9);
  push(0xD1, 10, [1, 2, 3]);
  push(0xD0, 11, [4, 5, 6]);
  push(0xD2, 12, [7, 8, 9]);
  assert.equal(errors.length, 0);
  assert.deepEqual([...slices[0].data], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('counter wraps at 16 bits without a loss report', () => {
  const { slices, errors, push } = collect(4);
  push(0xD1, 0xFFFF, [1, 2]);
  push(0xD2, 0x0000, [3, 4]);
  assert.equal(errors.length, 0);
  assert.equal(slices.length, 1);
});

test('packet loss in a follow-up packet reports FrameDropped and discards that packet', () => {
  const { slices, errors, push } = collect(9);
  push(0xD1, 1, [1, 2, 3]);
  push(0xD0, 3, [4, 5, 6]);          // counter 2 missing
  assert.deepEqual(errors.map(e => e.code), [DataError_FrameDropped]);
  push(0xD3, 4, [7, 8, 9]);          // single-packet slice restarts cleanly
  assert.deepEqual([...slices[0].data], [7, 8, 9]);
});

test('timestamp flag strips the last 8 bytes and reads them little endian', () => {
  const { slices, push } = collect(4);
  push(0xD7, 0, [1, 2, 3, 4, 0x01, 0, 0, 0, 0, 0, 0, 0x02]);
  assert.deepEqual([...slices[0].data], [1, 2, 3, 4]);
  assert.equal(slices[0].timestamp, 0x0200000000000001n);
});

test('error flag delivers the u32 error code', () => {
  const { slices, errors, push } = collect(4);
  push(0xDB, 0, [E_OVERFLOW, 0, 0, 0]);
  assert.equal(slices.length, 0);
  assert.equal(errors[0].code, E_OVERFLOW);
});

test('CRC failure drops the partial slice', () => {
  const { slices, errors, push } = collect(6);
  push(0xD1, 0, [1, 2, 3]);
  push(0xD2, 1, [4, 5, 6], false);
  assert.equal(slices.length, 0);
  assert.deepEqual(errors.map(e => e.code), [DataError_FrameDropped]);
});

test('raw frame reader joins whole slices into frames and keeps leftovers', async () => {
  const r = new RawFrameReader(6);
  r.pushSlice({ data: Uint8Array.of(1, 2, 3, 4) });
  r.pushSlice({ data: Uint8Array.of(5, 6, 7, 8) });
  r.pushSlice({ data: Uint8Array.of(9, 10, 11, 12) });
  assert.deepEqual([...await r.next(10)], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...await r.next(10)], [7, 8, 9, 10, 11, 12]);
});

test('raw frame reader maps error codes to the SDK exceptions', async () => {
  const r = new RawFrameReader(6);
  r.pushError({ code: DataError_FrameDropped });
  await assert.rejects(r.next(10), FrameAcquisitionFailed);
  r.pushError({ code: E_OVERFLOW });
  await assert.rejects(r.next(10), FifoOverflow);
  await assert.rejects(r.next(5), /Timeout/);
});

test('frame queue size for 0.1 s frames is 100 (float32 10/0.1, truncated)', async () => {
  const { frameQueueSize } = await import('../src/transport/strata.js');
  assert.equal(frameQueueSize(0.1), 100);
});

test('queue trimming drops the oldest slices, puts QueueTrimmed first, returns buffers to the pool', async () => {
  const { RawFrameReader, FramePool, DataError_FrameQueueTrimmed } = await import('../src/transport/strata.js');
  const pool = new FramePool(4);
  const r = new RawFrameReader(2, { maxCount: 3, pool });
  for (let i = 0; i < 4; i++) { assert.ok(pool.acquire()); r.pushSlice({ data: Uint8Array.of(i, i) }); }
  // 4 > 3: drop 4 - 3 + 1 = 2 oldest, then prepend the error
  assert.deepEqual(r.queue.map(q => q.code ?? q.data[0]), [DataError_FrameQueueTrimmed, 2, 3]);
  assert.equal(pool.free, 2);
  await assert.rejects(r.next(10), FrameAcquisitionFailed);
  assert.deepEqual([...await r.next(10)], [2, 2]);
  assert.equal(pool.free, 3);
});

test('assembler reports FramePoolDepleted when no buffer is free', async () => {
  const { SliceAssembler, FramePool, DataError_FramePoolDepleted } = await import('../src/transport/strata.js');
  const errors = [], slices = [];
  const pool = new FramePool(1);
  const asm = new SliceAssembler(2, { pool, onSlice: s => slices.push(s), onError: e => errors.push(e.code) });
  asm.push({ type: 0xD3, channel: 0, counter: 0, payload: Uint8Array.of(1, 2), crcOk: true });
  asm.push({ type: 0xD3, channel: 0, counter: 1, payload: Uint8Array.of(3, 4), crcOk: true });
  assert.equal(slices.length, 1);
  assert.deepEqual(errors, [DataError_FramePoolDepleted]);
});
