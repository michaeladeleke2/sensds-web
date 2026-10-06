// TEST INPUT ONLY, never used by the app. Integer-only synthetic radar
// frames (a target with a varying Doppler shift over clutter and noise),
// identical to synthetic_raw() in reference/python/make_viz_fixtures.py, so
// the JS port and the Python reference are compared on exactly the same input.

export const COS_TAB = Array.from({ length: 4096 }, (_, k) => Math.round(1000 * Math.cos(2 * Math.PI * k / 4096)) || 0);   // || 0: no negative zero

export function syntheticRaw(f, cosTab = COS_TAB, nChirp = 128, nSample = 256) {
  const raw = new Int32Array(nChirp * nSample);
  let seed = (Math.imul(f, 2654435761) + 12345) >>> 0;      // 32-bit wrap, as & 0xFFFFFFFF
  const tri = f % 8;
  const dop = 60 + 40 * (tri < 4 ? tri : 8 - tri);
  const rng = 37 + (f % 5);
  for (let c = 0; c < nChirp; c++) {
    for (let s = 0; s < nSample; s++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const noise = ((seed >>> 16) % 33) - 16;
      const target = cosTab[(s * rng + c * dop) & 4095] >> 2;
      const clutter = cosTab[(s * 11) & 4095] >> 3;
      raw[c * nSample + s] = Math.min(4095, Math.max(0, 2048 + target + clutter + noise));
    }
  }
  return raw;
}

// DeviceFmcwBase::get_next_frame scaling, float32
export function sdkScale(raw) {
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) { out[i] = (raw[i] * 2) / 4095; out[i] = out[i] - 1; }
  return out;
}
