// Radar configuration: the values SensDSv2's core/radar.py build_config()
// passes to the Radar SDK 3.6.4, copied as literals (SensDSv2 is a read only
// reference and is never imported). Plus the values the SDK derives from them.

export const SENSDS_CONFIG = Object.freeze({
  // Sequence (cfg_simo_seq.json)
  frame_repetition_time_s: 0.10,
  chirp_repetition_time_s: 0.0002,
  num_chirps: 128,
  tdm_mimo: false,
  // Chirp (cfg_simo_chirp.json)
  start_frequency_Hz: 58.0e9,
  end_frequency_Hz: 63.5e9,
  sample_rate_Hz: 2e6,
  num_samples: 256,
  rx_mask: 7,
  tx_mask: 1,
  tx_power_level: 31,
  lp_cutoff_Hz: 500000,
  hp_cutoff_Hz: 80000,
  if_gain_dB: 33,
});

export const popcount = m => { let n = 0; while (m) { n += m & 1; m >>>= 1; } return n; };

// BGT60TR13C device traits (lib_avian ifxAvian_DeviceTraits.cpp)
export const BGT60TR13C_FIFO_SIZE = 8192;   // in sample pairs

// DeviceFmcwBase::calculate_slice_size (Radar SDK, BSD 3-Clause).
// The SDK computes the slice rate in float32; the arithmetic is reproduced
// with Math.fround so the k threshold lands identically.
const SLICE_RATE_THRESHOLD = 20.0;
export function calculateSliceSize(numSamples, frameRepetitionTime, fifoSizeSamples) {
  if (numSamples === 0) throw new Error('num_samples out of range');
  const maxSliceSize = Math.floor(fifoSizeSamples / 2);
  const numSlicesPerFrame = Math.floor((numSamples + (maxSliceSize - 1)) / maxSliceSize);
  let sliceSize = Math.floor(numSamples / numSlicesPerFrame);
  const f = Math.fround;
  const sliceRate = f(f(f(f(1.0 * numSamples) / sliceSize)) / f(frameRepetitionTime));
  if (sliceRate > SLICE_RATE_THRESHOLD) {
    const k = Math.floor(f(sliceRate / SLICE_RATE_THRESHOLD));
    sliceSize = Math.min(sliceSize * k, maxSliceSize);
  }
  return sliceSize;
}

// Everything the acquisition path needs, derived as the SDK derives it.
export function deriveAcquisition(cfg = SENSDS_CONFIG) {
  const numRx = popcount(cfg.rx_mask);
  const numSamples = numRx * cfg.num_chirps * cfg.num_samples;      // update_frame_settings
  const fifoSamples = BGT60TR13C_FIFO_SIZE * 2;                     // start_acquisition
  const sliceSize = calculateSliceSize(numSamples, cfg.frame_repetition_time_s, fifoSamples);
  return {
    numRx,
    numChirps: cfg.num_chirps,
    samplesPerChirp: cfg.num_samples,
    numSamples,
    sliceSize,
    sliceBytes: sliceSize * 3 / 2,                                  // get_buffer_length, Packed12
    frameBytes: numSamples * 3 / 2,
  };
}

// Range map view on the Visualize tab (range_map_v1.py / range_map_live.py).
// mode 'raw': mean range-FFT magnitude, stationary reflections stay (default).
// mode 'mti': moving targets only (Doppler power without the zero-velocity bin).
// Change it here, or for one visit add ?range_mode=mti to the page address.
export const RANGE_MAP = Object.freeze({
  mode: 'raw',
});

export function rangeMapMode() {
  try {
    const m = new URLSearchParams(location.search).get('range_mode');
    if (m === 'mti' || m === 'raw') return m;
  } catch { /* not in a page */ }
  return RANGE_MAP.mode;
}
