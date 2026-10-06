# SensDS Web: Reference Summary and Step 2 Plan

Written 2026-10-05. Status: **plan approved with the decisions below. Step 2.3 (offline modules) done; nothing has been written to the sensor.**

Update 2026-10-05: the Visualize page (Steps 4 and 5 for the default Infineon SDK method) is built ahead of the live radar path. It plays SensDSv2 `*_raw.npy` captures (real data only; the synthetic signal exists only as test input in `tests/`). Validated against the reference script run in Python: dB within 1e-8, identical range bins, identical jet LUT and tick labels, image pixels within 2/255 (mean 0.024) of a matplotlib render. How to run it: `docs/procedures/run_visualization.md`.

Update 2026-10-05 (later): register list exported with SDK 3.6.4 (38 registers); live radar streams into the Visualize page on the Mac. Step 3 behaviour ported: frame queue of 100 slices with FrameQueueTrimmed, pool of 101 buffers with FramePoolDepleted, dropped frames skipped as SensDSv2 does, FIFO overflow and other errors stop the stream. Numeric frame check: `docs/procedures/validate_frames.md`.

Update 2026-10-05 (later): Collect tab ported (Infineon SDK method). compute_recorded, reference_rgb, Pillow BILINEAR resize and the 400x300 training image are byte-identical to SensDSv2 (tests/collect.test.js, fixtures from reference/python/make_collect_fixtures.py). Procedure: `docs/procedures/collect_samples.md`.

Update 2026-10-05 (later): Analysis tab ported (Physical Features, PCA Comparison). Tracked range bins identical, features within 1e-9, CSV text identical, zoom resize within 1e-12, PCA variance and silhouette match SensDSv2 (tests/analysis.test.js, fixtures from reference/python/make_analysis_fixtures.py, including the 20 real frames). Extraction runs in a Web Worker. Procedure: `docs/procedures/analysis.md`.

Decisions (2026-10-05):

1. Radar SDK **3.6.4** is the reference (what SensDSv2 runs).
2. Step 5 reproduces the **matplotlib reference view** (section 2a).
3. **All three antennas** (rx_mask 7).
4. The product is a **web application**: no Python, no install, no local bridge at run time.

Sources read (all read only):

- SensDSv2: `core/radar.py`, `core/processing.py`, `ui/spectrogram_widget.py`, plus `ui/reference_view.py`, `core/reference_image.py`, `core/doppler_spectrogram_live.py` and the streaming glue in `ui/main_window.py`. The extra files are included because the default Visualize view is drawn by them, not by `spectrogram_widget.py`.
- SDK 3.6.5 source: `sdk/c/ifxFmcw/DeviceFmcwBase.cpp`, `sdk/c/ifxFmcw/avian/DeviceFmcwAvian.cpp`, `lib_avian/src/ifxAvian_RegisterSet.cpp`, `lib_avian/src/ifxAvian_StrataUtilities.cpp`, `lib_avian/src/ifxAvian_Utilities.cpp` (chip ID, clock init), `lib_avian/src/Driver/ifxRadar_BGT60TRxx.cpp` (`create_driver`, constructor, `get_clock_config_command`), `lib_avian/src/Driver/data_acquisition.cpp`, `lib_avian/src/ifxAvian_DeviceTraits.cpp` (BGT60TR13C entry), `lib_avian/include/ports/ifxAvian_StrataControlPort.hpp`, `strata/library/remote/RemoteProtocolAvian.cpp`, `RemotePinsAvian.cpp`.

---

## 1. Radar configuration SensDSv2 uses

From `core/radar.py::build_config()`. The SDK used is the **3.6.4** wheel (`inf_wheel/ifxradarsdk-3.6.4+4b4a6245-*.whl`, `vendor/...win_amd64.whl`). API: `DeviceFmcw()`, `create_simple_sequence(cfg)`, `set_acquisition_sequence(seq)`, `get_next_frame()[0]`.

| Parameter | Value |
|---|---|
| `frame_repetition_time_s` | 0.10 (10 fps) |
| `chirp_repetition_time_s` | 0.0002 (PRF 5000 Hz) |
| `num_chirps` | 128 |
| `tdm_mimo` | False |
| `start_frequency_Hz` | 58.0e9 |
| `end_frequency_Hz` | 63.5e9 (5.5 GHz bandwidth, centre 60.75 GHz) |
| `sample_rate_Hz` | 2e6 |
| `num_samples` | 256 |
| `rx_mask` | 7 (3 RX) |
| `tx_mask` | 1 |
| `tx_power_level` | 31 |
| `lp_cutoff_Hz` | 500000 |
| `hp_cutoff_Hz` | 80000 |
| `if_gain_dB` | 33 |

Frame delivered to processing: `get_next_frame()[0]`, shape **(3, 128, 256)** float32 (rx, chirp, sample).

### What the SDK derives from this (read from source)

| Item | Value | Source |
|---|---|---|
| IF gain split | HP gain 18 dB + VGA 15 dB (index 3). 30 dB HP branch gives 35 dB, error 2 > 0, so 18 dB wins | `DeviceFmcwAvian.cpp` `setup_chirp` |
| HP cutoff / AAF | 80 kHz on all 4 channels / 500 kHz | same |
| ADC | 2 MHz, 50 ns sample time, 1 subconversion tracking (falls back to none if rejected), no oversampling | same |
| Total samples per frame | 3 x 128 x 256 = 98304 | `update_frame_settings` |
| FIFO | 8192 sample pairs = 16384 samples; max slice = 8192 | `DeviceTraits` BGT60TR13C, `calculate_slice_size` |
| Slice size | 8192 samples (12 slices per frame, 120 slices/s; the 20 Hz rule is capped by max slice) | `calculate_slice_size` |
| Bytes per slice / frame | 12288 / 147456 (Packed12) | `get_buffer_length` |
| Data rate | 1.47 MB/s | derived |
| Readout address | `get_burst_prefix() & 0xFF` = `num_registers` = **0x60** | `data_acquisition.cpp`, `registers_BGT60TRxxC.h` |
| Data format | `0x10` Packed12, all other `IDataProperties` fields 0 | `configure_data` |
| Sample scaling | `float = 2 * raw / 4095 - 1` | `DeviceFmcwBase::get_next_frame` |
| Raw interleave | per chirp: for sample, for rx (rx is the fastest index) | same |
| Reference clock | 80 MHz; TR13C has no doubler, so `detect_reference_clock` returns immediately and `initialize_reference_clock` is a no-op (clock command = 0). **No bus traffic for either.** | `StrataUtilities.cpp`, `Utilities.cpp`, `ifxRadar_BGT60TRxx.cpp` |

Register timing (chirp end delays, frame end delay, power modes) comes from lib_avian's timing model, which is why Phase A exports the register list instead of re-deriving it.

---

## 2. Processing and visualization SensDSv2 uses

SensDSv2 has two spectrogram methods. **The default is `METHOD_INFINEON`** (`processing.py: _METHOD = METHOD_INFINEON`). In that mode the Visualize tab's main view is the **reference script's own matplotlib plot** (`doppler_spectrogram_live.py`, hosted by `ui/reference_view.py`). The pyqtgraph `SpectrogramWidget` is hidden unless "Show SensDS view alongside" is ticked.

### 2a. Default live view: reference script (`LiveDopplerProcessor` + `LiveSpectrogramPlot`)

Per frame, antenna 0 only, shape (128 chirps, 256 samples), float64:

1. Range FFT: subtract each chirp's mean over fast time, multiply by Blackman-Harris(256), zero pad to 1024, FFT, keep bins 0..511, transpose to (512 range, 128 chirps).
2. Doppler FFT: subtract each range bin's mean over slow time, multiply by Chebyshev(128, at=100) normalised to sum 1, zero pad to 512, FFT, fftshift.
3. Power `|X|^2`. dB = `10*log10(power)` where `power >= 1e-12`, otherwise `20*log10(1e-6)` = -120 dB.
4. Raw range bin = argmax over range of (sum of dB over Doppler).
5. Range bin smoothing: deque of the last 5 raw bins (`SMOOTH_WINDOW = 5`). Once full: `scipy.ndimage.median_filter(buf, size=5)` (default `mode='reflect'`) and take the **last** element, so the window is `[b2, b3, b4, b4, b3]`, not the plain median of 5. Before full: `round(median(buf))`. Clipped to 0..511.
6. History (history_length x 512), initialised to -120 dB; shift left, newest column on the right.

Display (`LiveSpectrogramPlot.draw`, called every 200 ms, i.e. 5 Hz):

- history_length = `max(10, round(time_window * 10))`. Time window default is 5 s, so **50 frames**.
- Colour limits: `vmax = nanmax(data)`; `vmin = jet_vmin if jet_vmin < vmax else vmax - 40`. `jet_vmin = -20` (or -50 with "Reduce noise").
- matplotlib `jet`, `Normalize(clip=True)`, `imshow(aspect='auto', origin='upper', extent=[frame_start, frame_end, -6.19405905, +6.19405905])`.
- `origin='upper'` puts Doppler row 0 (most negative velocity) at the **top**, while the axis reads +6.19 at the top. SensDSv2 documents this mismatch and keeps it; we reproduce it as is.
- Dashed white grid on the velocity axis (`linewidth 0.7, alpha 0.55`), labels "frame" and "velocity (m/s)", title `Doppler Spectrogram (live)  |  frame N (newest → right)`, axes rect `[0.08, 0.10, 0.88, 0.82]`.
- Velocity half range is the hard-coded 6.19405905 m/s (not computed from PRF).

### 2b. Alternate: STFT method (selectable, used by older models)

`spectrogram_from_frames`: antenna 0; frames concatenated into one slow-time sequence; range FFT of length 512 keeping bins 256..511, divided by 256; subtract slow-time mean; MTI `butter(1, 0.01, 'high')` + `lfilter` (**skipped in the live display**, `mti=False`); sum range rows 128..254; STFT with Hanning(256), noverlap 200 (shift 56), nfft 1024, `n_cols = (n - 257) // 56`; fftshift; magnitude; dB relative to max, clipped to [-20, 0].

Live display: worker at 5 Hz uses the **last 8 frames** (needs at least 4), emits the newest 4 columns. Widget buffer 5 s x 20 col/s = 100 columns; Gaussian smoothing `sigma = [s, 0.55 s]` with default `s = 1.5` (so [1.5, 0.825]); pyqtgraph 6-stop jet (`0:(0,0,143) .125:(0,0,255) .375:(0,255,255) .625:(255,255,0) .875:(255,0,0) 1:(128,0,0)`), levels [-20, 0], background `#00008F`, velocity ±6.17 m/s (`PRF*λ/4`), positive velocity at top, smooth pixmap interpolation.

---

## 3. Differences from the handoff notes (repo wins)

| # | Handoff says | SensDSv2 / SDK source says |
|---|---|---|
| 1 | Match SDK 3.6.5 | SensDSv2 runs the **3.6.4** wheel. Register export should be done with 3.6.4, or checked to match under both. |
| 2 | Frame shape (3, 64, 64) | **(3, 128, 256)** |
| 3 | PRF 2000 Hz, velocity ±2.46 m/s | **PRF 5000 Hz**; velocity **±6.194** (default view) / ±6.17 (STFT view) |
| 4 | 61 GHz centre | 60.75 GHz (58.0 to 63.5) |
| 5 | Pipeline: range FFT, MTI, range sum, STFT, dB | That is the **non-default** STFT method. Default is the per-frame range-Doppler map with tracked range bin (section 2a). |
| 6 | `NOVERLAP=248` | **200** (shift 56) |
| 7 | 10 frame deque before first output | STFT: at least 4 frames, last 8 used, 30 held. Default view: outputs from the first frame. |
| 8 | pyqtgraph, `DB_MIN=-20`, gaussian `[2.0, 1.5]` | Default view is **matplotlib**, auto `vmax`, `jet_vmin=-20`, no blur. STFT view blur is `[1.5, 0.825]`. |
| 9 | "Control port constructor sends set bits (0x00, 0x0C)" | `DeviceFmcwAvian` uses `StrataControlPort`, whose constructor sends **nothing**. The `setBits(0x00, 0x0C)` call is in `StrataPort` (a different class, not used here). |
| 10 | `initialize_reference_clock` / `detect_reference_clock` | Both are **no-ops** on BGT60TR13C (no frequency doubler). |
| 11 | Readout address = "low byte of burst prefix" | Resolved: **0x60**. |
| 12 | (not mentioned) | SensDSv2 internal inconsistency: `processing.py` uses range-bin median window 7, but the reference script (which draws the view and the training images) uses **5**. We follow 5. |
| 13 | (not mentioned) | Bandwidth: rx_mask 7 is 1.47 MB/s. The reference script's own live mode drops to rx_mask 1 "to cut USB bandwidth", but the SensDSv2 app streams all 3. Web Serial throughput at this rate is unverified. |

Items resolved from source after the first draft:

- **Result word byte order.** `endian::swap` (`common/endian/General.hpp`) is an unconditional byte swap, so command words go out most significant byte first. Result words are written raw into a host `uint32_t` buffer, so the SDK reads them **little endian**. The first CHIP_ID read on hardware (expected `DIGITAL_ID = 3`, `RF_ID = 3`) confirms it.
- **SPI words per packet.** `BridgeSerial::getMaxTransfer()` = `SERIAL_MAX_PACKET_SIZE (4095) - 8 - 2` = 4085 bytes, so **1021 words** per command.
- **Data packets.** Framing, the counter check, the first/last/timestamp/error flags and the error codes are ported from `platform/serial/BridgeSerial.cpp::dataThreadFunction` (readable; only `platform/impl` is not).
- **Data configure payload.** `BridgeProtocolData::configure` + `TypeSerialization.cpp`: 8-byte properties then readout entries, little endian. For our settings: `10 00 00 00 00 00 00 00 60 00 00 20`.

Still open:

- **`Driver` constructor traffic.** `update_spi_register_set` appears to only build the register image; confirm it sends nothing.
- **Frame queue limit.** `BridgeData` (queue size, `FrameQueueTrimmed`) not yet read; needed for Step 3.

---

## 4. Proposed folder structure

Plain ES modules, no build step, so it runs from any static server on Mac, Windows and Chromebook.

```
sensds-web/
  index.html                 app shell (Step 5)
  src/
    transport/
      crc16.js               CRC16 CCITT-FALSE
      link.js                Link class from Step 1 (framing, request/response)
      strata.js              platform requests (board info, data configure/start/stop), data packet reassembly
    avian/
      protocol.js            Avian component commands, SPI word encode/decode, pins reset
      device.js              open/start/stop sequence ported from DeviceFmcwAvian
      registers_tr13c.js     Phase A register list exported from the SDK (generated, with provenance header)
    frame/
      unpack.js              Packed12 unpack, deinterleave, 2*raw/4095-1 scaling
    dsp/                     Step 4
      fft.js, windows.js     radix-2 FFT, Blackman-Harris, Chebyshev(at=100)
      doppler_live.js        port of LiveDopplerProcessor
      stft.js                port of spectrogram_from_frames
    viz/                     Step 5
      jet.js, spectrogram_view.js
  tools/                     standalone diagnostic pages (existing two, plus step2_one_frame.html)
  reference/python/          scripts run against the installed ifxradarsdk only (never import SensDSv2)
    export_registers.py
    capture_frames.py
  tests/
    fixtures/                register dumps, captured raw frames (.npy / .bin)
    *.test.js                Node tests (unpack, deinterleave, later DSP vs Python outputs)
  docs/
    SENSDS_WEB_HANDOFF.md
    STEP2_PLAN.md            this file
    procedures/              numbered steps per task, Mac / Windows / Chromebook
  LICENSING.md               which files are Strata derived; publish gate
```

Strata-derived files (`transport/strata.js`, `avian/protocol.js`, `avian/device.js`) get a header comment marking them, so the licensing gate is easy to enforce.

---

## 5. Step 2 plan: configure the sensor and read one frame

Each sub-step ends at a checkpoint. Sub-steps marked **(sensor)** talk to the hardware and need approval.

**2.1 Export the reference register list (Python, sensor).** Decided 2026-10-05: option A. Script `reference/python/export_registers.py`, procedure `docs/procedures/export_registers.md`. Only SFCTL FIFO_CREF depends on slice size; the web app sets it (`applySliceSize`) as `Driver::set_slice_size` does at start.
`reference/python/export_registers.py`: open `DeviceFmcw()`, build the sequence from the section 1 values (written as literals, not imported from SensDSv2), `set_acquisition_sequence`, then `save_register_file()` and, if the wrapper exposes it, the trigger-ordered list (`export_register_list_legacy(True)` equivalent). Run with SDK 3.6.4 (what SensDSv2 uses). Also save sensor type and SDK version. This configures the chip the same way SensDSv2 does on Connect; it does not start acquisition.

**2.2 Capture reference frames (Python, sensor).**
`reference/python/capture_frames.py`: same config, capture about 20 frames of a still scene with `get_next_frame()`, save as `.npy` (float) plus per-frame stats (mean and std per antenna, min/max raw). Stored in `tests/fixtures/`.

**2.3 Pure JS modules, tested offline (no sensor). DONE 2026-10-05**, 28 Node tests passing (`npm test`). Files: `src/transport/{crc16,link,strata}.js`, `src/avian/{protocol,registers}.js`, `src/frame/unpack.js`, `src/config.js`. Remaining: `registers_tr13c.js`, which needs the register list (see 2.1).
Extract `Link` and CRC into `src/transport/`. Write `unpack.js` (Packed12 per `copy_slice_data`, deinterleave per `get_next_frame`, scaling) and `registers_tr13c.js` (generated from 2.1). Node tests: synthetic bytes through unpack/deinterleave against a direct transcription of the SDK loops; register words `(addr << 25) | 0x01000000 | value`, ascending address, MAIN last with `FRAME_START`.

**2.4 Open and identify (sensor, read mostly).**
Port of `Driver::create_driver` as the SDK does it on BGT60TR13C:
1. Pins reset sequence (Avian subif 2, fn 0x05).
2. Write SFCTL: `MISO_HS_READ = 0`, `QSPI_WT = 1` (from `StrataControlPort` properties `{false, 2}`).
3. Read CHIP_ID (register 0x02) via Execute SPI words, Transfer.
Checkpoint: DIGITAL_ID 3 and RF_ID 3, which also confirms result byte order.

**2.5 Start, read one frame, stop (sensor).**
Port of `start_acquisition` / `stop_acquisition`:
1. Data configure: data index 0, properties zero except format 0x10, one readout entry (0x60, 8192).
2. Data start (platform 0x0D/0x03).
3. Send the full register list in ascending address order, MAIN last with `FRAME_START`, chunked to the packet limit.
4. Collect data packets (counter check, drop the frame on a gap), concatenate payloads until 147456 bytes, unpack to 98304 samples, shape (3, 128, 256), scale.
5. Stop: data stop first, then soft reset (MAIN value | `FIFO_RESET` | `FSM_RESET`).
The page shows per-antenna stats and a raw chirp plot, and saves the frame as `.bin` for comparison.

**2.6 Validate.**
- Register words sent by JS are byte-identical to the 2.1 export.
- Raw bytes captured by JS, decoded by a Python transcription of the SDK unpack loops, give exactly the JS floats.
- With the same still scene, JS frame stats match the 2.2 Python frames (same DC level per antenna, same noise std within run-to-run spread, values in [-1, 1]).
- Log the result per device (Mac, Surface) in the handoff table.

**2.7 Document.** `docs/procedures/step2_read_one_frame.md` with numbered steps for Mac, Windows and Chromebook.

### Decisions

Answered 2026-10-05; see the top of this file.

### Open question: where the register list comes from

The register values depend on lib_avian's timing model (chirp end delays, frame end delay, power modes), so they cannot be written down by hand. Two options:

- **A. One-time export with the 3.6.4 SDK** (the handoff's Phase A). A developer runs a small script once on a machine with the SDK and commits the resulting register list to `src/avian/registers_tr13c.js` as data. The web app has no Python at run time. The same script captures reference frames for the validation rule.
- **B. Compute registers in the browser** by compiling lib_avian (BSD 3-Clause) to WebAssembly (the handoff's Phase B). No Python anywhere, works for any configuration, but it is a larger job, and there is still nothing to validate against without an SDK reference.
