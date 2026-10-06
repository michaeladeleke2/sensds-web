import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SENSDS_CONFIG, deriveAcquisition, calculateSliceSize } from '../src/config.js';
import { unpackPacked12, rawToCube, frameBytesToCube } from '../src/frame/unpack.js';
import {
  configurationSequence, softResetCommand, readoutAddress, sfctlCommand, readCommand,
  decodeChipId, writeCommand, REG_CHIP_ID, parseRegisterFile,
} from '../src/avian/registers.js';
import { encodeSpiWords, decodeResultWords, executeSpiWords, setBitsPayload, wIndex } from '../src/avian/protocol.js';

// ---------- derived acquisition parameters ----------

test('SensDSv2 configuration derives the slice and frame sizes worked out from the SDK', () => {
  const a = deriveAcquisition(SENSDS_CONFIG);
  assert.equal(a.numRx, 3);
  assert.equal(a.numSamples, 98304);
  assert.equal(a.sliceSize, 8192);
  assert.equal(a.sliceBytes, 12288);
  assert.equal(a.frameBytes, 147456);
});

test('slice size: small frames are grouped to keep the slice rate near 20 Hz', () => {
  // 1 rx x 64 chirps x 64 samples at 10 ms: 4096 samples, rate 100 Hz, k = 5, capped at 8192
  assert.equal(calculateSliceSize(4096, 0.01, 16384), 8192);
  // 2048 samples at 100 ms: rate 10 Hz, no grouping
  assert.equal(calculateSliceSize(2048, 0.1, 16384), 2048);
});

// ---------- Packed12 and the float cube ----------

test('Packed12 unpack matches copy_slice_data', () => {
  assert.deepEqual([...unpackPacked12(Uint8Array.of(0xAB, 0xCD, 0xEF, 0x00, 0x0F, 0xFF))], [0xABC, 0xDEF, 0x000, 0xFFF]);
});

test('scaling matches float32 static_cast<float>(raw*2)/4095.0f - 1.0f', () => {
  const cube = rawToCube(Uint16Array.of(0, 4095, 2048), 1, 1, 3);
  assert.equal(cube[0], -1);
  assert.equal(cube[1], 1);
  const f = Math.fround;
  assert.equal(cube[2], f(f(4096 / 4095) - 1));
});

// Literal transcription of DeviceFmcwBase::get_next_frame (non-MIMO path),
// written independently of rawToCube, for a cross-check on random data.
function sdkGetNextFrame(raw, numRx, numChirps, numSamples) {
  const f = Math.fround;
  const cube = new Float32Array(numRx * numChirps * numSamples);
  const at = (rx, chirp, sample) => (rx * numChirps + chirp) * numSamples + sample;
  let cubeData = 0;
  for (let chirp = 0; chirp < numChirps; chirp++)
    for (let sample = 0; sample < numSamples; sample++)
      for (let rx = 0; rx < numRx; rx++)
        cube[at(rx, chirp, sample)] = f(f(f(raw[cubeData++] * 2) / f(4095)) - f(1));
  return cube;
}

test('deinterleave and scale agree with the SDK loop on a full random frame', () => {
  const a = deriveAcquisition();
  const bytes = new Uint8Array(a.frameBytes);
  let seed = 12345;
  for (let i = 0; i < bytes.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; bytes[i] = seed >>> 24; }
  const raw = unpackPacked12(bytes);
  const expected = sdkGetNextFrame(raw, a.numRx, a.numChirps, a.samplesPerChirp);
  const got = frameBytesToCube(bytes, a.numRx, a.numChirps, a.samplesPerChirp);
  assert.equal(got.length, 3 * 128 * 256);
  assert.deepEqual(got, expected);
  // rx is the fastest index in the raw stream: raw[1] is rx1, chirp0, sample0
  assert.equal(got[1 * 128 * 256], expected[1 * 128 * 256]);
});

// ---------- register words ----------

test('configuration sequence: ascending addresses, MAIN last with FRAME_START', () => {
  const regs = new Map([[0x05, 0x123456], [0x00, 0x1C8270], [0x01, 0x000001]]);
  assert.deepEqual(configurationSequence(regs, true), [
    writeCommand(0x01, 0x000001), writeCommand(0x05, 0x123456), (writeCommand(0x00, 0x1C8270) | 1) >>> 0,
  ]);
  assert.deepEqual(configurationSequence(regs, false), [
    writeCommand(0x00, 0x1C8270), writeCommand(0x01, 0x000001), writeCommand(0x05, 0x123456),
  ]);
  assert.equal(writeCommand(0x05, 0x123456), 0x0B123456);
});

test('soft reset, readout address, SFCTL and CHIP_ID words', () => {
  assert.equal(softResetCommand(0x1C8270), (0x01000000 | 0x1C8270 | 0x0C) >>> 0);
  assert.equal(readoutAddress(), 0x60);
  assert.equal(sfctlCommand(), 0x0D100000);   // SFCTL (0x06), MISO_HS_READ 0, QSPI_WT 1
  assert.equal(readCommand(REG_CHIP_ID), 0x04000000);
  assert.deepEqual(decodeChipId(0x000303), { rfId: 3, digitalId: 3, stepId: 0, techId: 0, isBGT60TR13C: true });
});

test('register file parser reads address/value pairs', () => {
  const regs = parseRegisterFile('MAIN 0x00 0x1C8270\nADC0 0x01 0x0A0240\n\n# comment\n');
  assert.deepEqual([...regs], [[0x00, 0x1C8270], [0x01, 0x0A0240]]);
});

// ---------- Avian protocol ----------

test('wIndex values match the handoff command table', () => {
  assert.equal(wIndex(3, 0x01), 0x0130);   // execute SPI words
  assert.equal(wIndex(3, 0x02), 0x0230);   // set bits
  assert.equal(wIndex(2, 0x05), 0x0520);   // pins reset sequence
});

test('SPI words go out big endian; results are read little endian', () => {
  assert.deepEqual([...encodeSpiWords([0x0D100000, 0x04000000])], [0x0D, 0x10, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
  assert.deepEqual([...decodeResultWords(Uint8Array.of(0x03, 0x03, 0x00, 0x00))], [0x000303]);
});

test('set bits payload is little endian (address << 24) | mask', () => {
  assert.deepEqual([...setBitsPayload(0x00, 0x00000C)], [0x0C, 0x00, 0x00, 0x00]);
});

test('execute splits into 1021-word chunks and uses Transfer only when results are wanted', async () => {
  const calls = [];
  const fakeLink = {
    vendorWrite: async (req, wValue, idx, payload) => { calls.push(['write', req, wValue, idx, payload.length]); },
    vendorTransfer: async (req, wValue, idx, payload) => { calls.push(['transfer', req, wValue, idx, payload.length]); return new Uint8Array(payload.length); },
  };
  await executeSpiWords(fakeLink, new Array(2500).fill(0x0B000000));
  assert.deepEqual(calls, [
    ['write', 0x20, 0x0103, 0x0130, 4084], ['write', 0x20, 0x0103, 0x0130, 4084], ['write', 0x20, 0x0103, 0x0130, 458 * 4],
  ]);
  calls.length = 0;
  const res = await executeSpiWords(fakeLink, [readCommand(REG_CHIP_ID)], true);
  assert.deepEqual(calls, [['transfer', 0x20, 0x0103, 0x0130, 4]]);
  assert.equal(res.length, 1);
});

test('slice size sets SFCTL FIFO_CREF and leaves the other SFCTL bits alone', async () => {
  const { applySliceSize, REG_SFCTL } = await import('../src/avian/registers.js');
  const regs = new Map([[REG_SFCTL, 0x1027FF], [0x00, 0x1C8270]]);   // CREF 0x7FF (slice 4096)
  const out = applySliceSize(regs, 8192);
  assert.equal(out.get(REG_SFCTL), 0x102FFF);                          // CREF 0xFFF (slice 8192)
  assert.equal(out.get(0x00), 0x1C8270);
  assert.equal(regs.get(REG_SFCTL), 0x1027FF);                         // input untouched
});

test('register file parser reads the NamedMemory::saveConfig format', async () => {
  const { parseRegisterFile } = await import('../src/avian/registers.js');
  const regs = parseRegisterFile('MAIN 0x0000 0x001c8270\nreg 0x005f 0x00000000\n');
  assert.deepEqual([...regs], [[0x00, 0x1C8270], [0x5F, 0]]);
});

test('exported SensDSv2 register list: 38 registers, start sequence with slice 8192', async () => {
  const { REGISTERS, EXPORT_INFO } = await import('../src/avian/registers_tr13c.js');
  const { applySliceSize, configurationSequence, REG_SFCTL } = await import('../src/avian/registers.js');
  assert.equal(EXPORT_INFO.sensor, 'BGT60TR13C');
  assert.ok(EXPORT_INFO.sdk_version.startsWith('3.6.4'));
  assert.equal(REGISTERS.size, 38);
  const regs = applySliceSize(REGISTERS, 8192);
  assert.equal(regs.get(REG_SFCTL) & 0x1FFF, 4095);
  const seq = configurationSequence(regs, true);
  assert.equal(seq.length, 38);
  assert.equal(seq.at(-1), (((0x00 << 25) | 0x01000000 | REGISTERS.get(0x00)) | 1) >>> 0);   // MAIN last, FRAME_START set
});
