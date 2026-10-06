// End-to-end test of RadarDevice against a simulated board: request framing,
// the open/start/stop command sequence, data packet reassembly and frame decode.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crc16 } from '../src/transport/crc16.js';
import { RadarDevice } from '../src/avian/device.js';
import { unpackPacked12, rawToCube } from '../src/frame/unpack.js';

const withCrc = bytes => { const c = crc16(bytes); return Uint8Array.from([...bytes, c >> 8, c & 0xFF]); };
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ');

// A fake Web Serial port that behaves like the MCU7 firmware for the requests we send.
class FakeBoard {
  constructor(frameBytes) {
    this.frameBytes = frameBytes;
    this.requests = [];
    this.counter = 0x1234;
    this.inbox = [];
    const self = this;
    this.readable = new ReadableStream({ start(c) { self.rx = c; } });
    this.writable = new WritableStream({ write(chunk) { self.inbox.push(...chunk); self.handle(); } });
  }
  async open(opts) { this.openOpts = opts; }
  async close() {}
  send(bytes) { this.rx.enqueue(Uint8Array.from(bytes)); }

  handle() {
    for (;;) {
      if (this.inbox.length < 8) return;
      const [type, req, wv0, wv1, wi0, wi1, wl0, wl1] = this.inbox;
      const wLength = wl0 | (wl1 << 8);
      const payloadLen = type === 0xC0 ? 0 : wLength;
      if (this.inbox.length < 8 + payloadLen + 2) return;
      const raw = Uint8Array.from(this.inbox.splice(0, 8 + payloadLen + 2));
      assert.equal(crc16(raw), 0, 'request CRC');
      const r = { type, req, wValue: wv0 | (wv1 << 8), wIndex: wi0 | (wi1 << 8), wLength, payload: raw.subarray(8, 8 + payloadLen), raw };
      this.requests.push(r);
      this.respond(r);
    }
  }

  respond(r) {
    let payload = [];
    if (r.type === 0xC0 && r.req === 0x80 && r.wValue === 0x01) payload = [2, 0, 9, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0];
    if (r.type === 0x43 && r.req === 0x20 && r.wIndex === 0x0130) {
      // SPI transfer: CHIP_ID read returns 0x000303, little endian per word
      payload = [];
      for (let i = 0; i < r.payload.length; i += 4) payload.push(0x03, 0x03, 0x00, 0x00);
    }
    this.send(withCrc([r.type, 0, payload.length & 0xFF, payload.length >> 8, ...payload]));
    // The trigger word (MAIN with FRAME_START) starts the radar: stream one frame.
    if (r.type === 0x40 && r.req === 0x20 && r.wIndex === 0x0130) {
      const last = r.payload.subarray(r.payload.length - 4);
      if (last[0] === 0x01 && (last[3] & 1)) {
        this.triggers = (this.triggers || 0) + 1;
        setTimeout(() => (this.overflowOnTrigger === this.triggers ? this.sendOverflow() : this.streamFrame()), 0);
      }
    }
  }

  // An error data packet carrying E_OVERFLOW, as the firmware reports a FIFO overflow
  sendOverflow() {
    const c = this.counter++ & 0xFFFF;
    this.send(withCrc([0xDB, 0, c & 0xFF, c >> 8, 4, 0, 0x07, 0, 0, 0]));
  }

  streamFrame() {
    const sliceBytes = 12288;
    for (let s = 0; s < this.frameBytes.length; s += sliceBytes) {
      const slice = this.frameBytes.subarray(s, s + sliceBytes);
      for (let p = 0; p < slice.length; p += 4084) {
        const chunk = slice.subarray(p, p + 4084);
        const type = 0xD0 | (p === 0 ? 1 : 0) | (p + 4084 >= slice.length ? 2 : 0);
        const c = this.counter++ & 0xFFFF;
        this.send(withCrc([type, 0, c & 0xFF, c >> 8, chunk.length & 0xFF, chunk.length >> 8, ...chunk]));
      }
    }
  }
}

test('RadarDevice: open, start, one frame, stop against a simulated board', async () => {
  const frameBytes = new Uint8Array(147456);
  for (let i = 0; i < frameBytes.length; i++) frameBytes[i] = (i * 7 + 3) & 0xFF;
  const board = new FakeBoard(frameBytes);
  const dev = new RadarDevice(board);

  const info = await dev.open();
  assert.equal(board.openOpts.baudRate, 921600);
  assert.equal(info.firmware, '2.9.0');
  assert.ok(info.chip.isBGT60TR13C);

  await dev.start();
  const cube = await dev.nextFrame();
  const expected = rawToCube(unpackPacked12(frameBytes), 3, 128, 256);
  assert.deepEqual(cube, expected);

  await dev.close();

  const seq = board.requests.map(r => `${r.type.toString(16)} req=${r.req.toString(16)} wValue=${r.wValue.toString(16)} wIndex=${r.wIndex.toString(16)} len=${r.wLength}`);
  // The command sequence, in order
  assert.deepEqual(seq, [
    'c0 req=80 wValue=1 wIndex=0 len=16',          // version info (protocol check)
    '40 req=20 wValue=103 wIndex=520 len=0',       // pins reset sequence
    '40 req=20 wValue=103 wIndex=130 len=4',       // SPI write SFCTL
    '43 req=20 wValue=103 wIndex=130 len=4',       // SPI read CHIP_ID
    '40 req=d wValue=1 wIndex=0 len=12',           // data configure
    '40 req=d wValue=3 wIndex=0 len=0',            // data start
    '40 req=20 wValue=103 wIndex=130 len=152',     // 38 registers, MAIN + trigger last
    '40 req=d wValue=4 wIndex=0 len=0',            // data stop
    '40 req=20 wValue=103 wIndex=130 len=4',       // soft reset
  ]);
  if (process.env.SHOW_BYTES) for (const r of board.requests) console.log(hex(r.raw));
});

test('RadarDevice: a FIFO overflow raises FifoOverflow, and restart() streams again', async () => {
  const { FifoOverflow } = await import('../src/avian/device.js');
  const frameBytes = new Uint8Array(147456).map((_, i) => (i * 5 + 1) & 0xFF);
  const board = new FakeBoard(frameBytes);
  board.overflowOnTrigger = 1;                 // the first start reports an overflow
  const dev = new RadarDevice(board);
  await dev.open();
  await dev.start();
  await assert.rejects(dev.nextFrame(), FifoOverflow);
  await dev.restart();                         // data stop, soft reset, configure, start, registers
  const cube = await dev.nextFrame();
  assert.deepEqual(cube, rawToCube(unpackPacked12(frameBytes), 3, 128, 256));
  await dev.close();
  const kinds = board.requests.map(r => `${r.req.toString(16)}:${r.wValue.toString(16)}`);
  assert.equal(kinds.filter(k => k === 'd:3').length, 2, 'data started twice');
  assert.equal(kinds.filter(k => k === 'd:4').length, 2, 'data stopped twice (restart, close)');
});

test('RadarDevice: restart() still starts again when the board does not answer the stop', async () => {
  const frameBytes = new Uint8Array(147456).map((_, i) => (i * 3 + 7) & 0xFF);
  const board = new FakeBoard(frameBytes);
  const dev = new RadarDevice(board);
  await dev.open();
  await dev.start();
  await dev.nextFrame();
  // The next data stop gets no reply, as when the reply is lost behind a backlog
  const respond = board.respond.bind(board);
  let swallowed = false;
  board.respond = r => { if (!swallowed && r.req === 0x0d && r.wValue === 4) { swallowed = true; return; } respond(r); };
  await dev.restart();
  assert.ok(swallowed);
  const cube = await dev.nextFrame();
  assert.deepEqual(cube, rawToCube(unpackPacked12(frameBytes), 3, 128, 256));
  await dev.close();
});
