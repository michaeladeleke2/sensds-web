// STRATA DERIVED: Avian component commands, ported from Strata
// remote/RemoteProtocolAvian.cpp and remote/RemotePinsAvian.cpp, with the word
// byte order from lib_avian ports/ifxAvian_StrataControlPort.hpp.
// Infineon Evaluation Software License. Publishing permitted (permission
// confirmed 2026-10-05). See LICENSING.md.

import { MAX_TRANSFER } from '../transport/link.js';

export const CMD_COMPONENT = 0x20;
export const COMPONENT_TYPE_RADAR_AVIAN = 0x0103;
export const COMPONENT_SUBIF_DEFAULT = 0x00;
export const COMPONENT_SUBIF_PINS = 0x02;
export const COMPONENT_SUBIF_PROTOCOL = 0x03;

export const FN_PINS_SET_RESET_PIN = 0x01;
export const FN_PINS_RESET = 0x05;
export const FN_PINS_GET_IRQ = 0x06;
export const FN_PROTOCOL_EXECUTE = 0x01;
export const FN_PROTOCOL_SET_BITS = 0x02;

const COMPONENT_ID = 0;   // StrataControlPort uses component id 0
const SPI_WORD_SIZE = 4;  // sizeof(IProtocolAvian::Command)

// CMD_W_INDEX(id, subInterface, function)
export const wIndex = (subif, fn, id = COMPONENT_ID) => (fn << 8) | (subif << 4) | id;

// StrataControlPort::send_commands byte-swaps each 32 bit command word before
// handing the buffer to execute(), so each word goes out most significant byte
// first: [(address << 1) | write, value >> 16, value >> 8, value].
export function encodeSpiWords(words) {
  const out = new Uint8Array(words.length * SPI_WORD_SIZE);
  words.forEach((w, i) => {
    out[i * 4] = (w >>> 24) & 0xFF;
    out[i * 4 + 1] = (w >>> 16) & 0xFF;
    out[i * 4 + 2] = (w >>> 8) & 0xFF;
    out[i * 4 + 3] = w & 0xFF;
  });
  return out;
}

// Result words are written straight into a host uint32 buffer with no swap,
// so on a little-endian host each result word is read little endian.
export function decodeResultWords(bytes) {
  const out = new Uint32Array(bytes.length / SPI_WORD_SIZE);
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = (bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24)) >>> 0;
  }
  return out;
}

// RemoteProtocolAvian::execute. Splits into chunks of getMaxTransfer() / 4 words
// (1021 over serial). With withResults, uses Transfer and returns the result words.
export async function executeSpiWords(link, words, withResults = false) {
  const maxCount = Math.floor(MAX_TRANSFER / SPI_WORD_SIZE);
  const results = withResults ? new Uint32Array(words.length) : null;
  for (let start = 0; start < words.length; start += maxCount) {
    const chunk = words.slice(start, start + maxCount);
    const payload = encodeSpiWords(chunk);
    const idx = wIndex(COMPONENT_SUBIF_PROTOCOL, FN_PROTOCOL_EXECUTE);
    if (withResults) {
      // vendorTransferChecked: the reply must be exactly as long as the request
      const reply = await link.vendorTransfer(CMD_COMPONENT, COMPONENT_TYPE_RADAR_AVIAN, idx, payload, payload.length);
      if (reply.length !== payload.length) throw new Error(`Unexpected transfer request response length (${reply.length} vs ${payload.length})`);
      results.set(decodeResultWords(reply), start);
    } else {
      await link.vendorWrite(CMD_COMPONENT, COMPONENT_TYPE_RADAR_AVIAN, idx, payload);
    }
  }
  return results;
}

// RemoteProtocolAvian::setBits: payload u32 (address << 24) | (mask & 0xFFFFFF),
// serialised little endian (common/Serialization.hpp hostToSerial(uint32_t)).
export function setBitsPayload(address, mask) {
  const v = ((address << 24) | (mask & 0x00FFFFFF)) >>> 0;
  return Uint8Array.of(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, v >>> 24);
}
export const setBits = (link, address, mask) =>
  link.vendorWrite(CMD_COMPONENT, COMPONENT_TYPE_RADAR_AVIAN, wIndex(COMPONENT_SUBIF_PROTOCOL, FN_PROTOCOL_SET_BITS), setBitsPayload(address, mask));

// RemotePinsAvian::reset: vendorWrite(FN_PINS_RESET), no payload.
export const pinsReset = link =>
  link.vendorWrite(CMD_COMPONENT, COMPONENT_TYPE_RADAR_AVIAN, wIndex(COMPONENT_SUBIF_PINS, FN_PINS_RESET));
