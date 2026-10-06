// CRC16 CCITT-FALSE (poly 0x1021, init 0xFFFF), as Strata's Crc16CcittFalse.
// Packets append it big endian; the CRC over a whole packet including its CRC is 0.

export function crc16(bytes, crc = 0xFFFF) {
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}
