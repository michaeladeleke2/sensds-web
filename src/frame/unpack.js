// Raw frame bytes to the float cube Python's get_next_frame() returns.
// Ported from the Radar SDK (BSD 3-Clause): DeviceFmcwBase::copy_slice_data
// and DeviceFmcwBase::get_next_frame.

export const MAX_ADC_VALUE = 4095;   // DeviceFmcwAvian.cpp, 2**12 - 1

// Packed12: every 3 bytes hold two 12 bit samples.
export function unpackPacked12(bytes, out = new Uint16Array(Math.floor(bytes.length / 3) * 2)) {
  const n = out.length / 2;
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 3) {
    out[k++] = (bytes[j] << 4) | (bytes[j + 1] >> 4);
    out[k++] = ((bytes[j + 1] & 0x0F) << 8) | bytes[j + 2];
  }
  return out;
}

// Raw samples are interleaved per chirp as: for sample, for rx (rx fastest).
// Output is a Float32Array laid out [rx][chirp][sample], the same memory order
// as the numpy array get_next_frame()[0] of shape (numRx, numChirps, numSamples).
//
// Scaling matches the SDK's float32 arithmetic exactly:
//   static_cast<float>(raw * 2) / 4095.0f - 1.0f
// The division and subtraction are each rounded to float32 by storing through
// a Float32Array, which gives the same result as float32 hardware arithmetic.
export function rawToCube(raw, numRx, numChirps, numSamples) {
  const cube = new Float32Array(numRx * numChirps * numSamples);
  const tmp = new Float32Array(1);
  let p = 0;
  for (let chirp = 0; chirp < numChirps; chirp++) {
    for (let sample = 0; sample < numSamples; sample++) {
      for (let rx = 0; rx < numRx; rx++) {
        tmp[0] = (raw[p++] * 2) / MAX_ADC_VALUE;
        tmp[0] = tmp[0] - 1;
        cube[(rx * numChirps + chirp) * numSamples + sample] = tmp[0];
      }
    }
  }
  return cube;
}

export function frameBytesToCube(bytes, numRx, numChirps, numSamples) {
  return rawToCube(unpackPacked12(bytes), numRx, numChirps, numSamples);
}
