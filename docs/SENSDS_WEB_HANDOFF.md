# SensDS Web: Handoff Brief

Written 2026-10-05. Give this file to Claude Code at the start of the session.

## Goal

Rebuild SensDS as a web app that talks to the Infineon BGT60TR13C radar directly from the browser over Web Serial. No local bridge, no install.

## Hard requirements

1. **Match Infineon exactly.** Every byte sent to the board must be what the Radar SDK 3.6.5 sends. Port from the SDK source, never guess. If the source for a behavior has not been read, read it first.
2. **Match SensDSv2 desktop exactly.** Same radar configuration, same processing pipeline, same visualization. The SensDSv2 repo is the source of truth, used as a read only reference. Read its `core/radar.py`, `core/processing.py`, and `ui/spectrogram_widget.py` and port them as written.
3. **Visualization first.** The first deliverable is the live micro-Doppler spectrogram in the browser, identical to the desktop Visualize tab.
4. **Document every procedure as numbered steps** that work on Mac, Windows, and Chromebook, so others can replicate.
5. **Licensing gate.** (Cleared 2026-10-05: permission confirmed by the project owner; see `LICENSING.md`.) Strata (the transport library) is under Infineon's Evaluation Software License. Development proceeds as if permission is granted, but nothing containing Strata derived code is published or deployed until permission is confirmed.

## Project layout

This is a standalone project in its own folder with its own git repo. It is not part of the SensDSv2 repo.

| Location | Role | Rule |
|---|---|---|
| `~/sensds-web` | This project. All new code and docs go here. | The only folder to write in |
| SensDSv2 repo (path given in the session) | Reference for configuration, processing, and visualization | Read only. Never modify, never import from it at runtime |
| `~/infineon/infineon_sdk_src` | Infineon SDK 3.6.5 source subset | Read only. Never copy into this project or commit |

The web app must run with no dependency on either reference folder.

## Target platforms

Chrome or Edge on Mac, Windows, Linux, Chromebook. Not Safari, Firefox, iPhone, or iPad (no Web Serial).

## Verified so far

| Check | Mac (Chrome 154) | Windows Surface (Chrome 149) |
|---|---|---|
| Board enumerates as serial (IFX CDC, VID 0x058B, PID 0x0251) | Pass | Pass |
| Web Serial opens the port | Pass | Pass |
| Step 1 handshake (board info, version, UUID) | Pass (2026-10-05) | Pass |
| Live streaming to the Visualize page (configure, stream, stop) | Pass (2026-10-05) | Pass (2026-10-05, hosted site) |
| Collect tab: batch capture saved to a folder | Pass (2026-10-05) | Pass (2026-10-05, another Windows laptop, hosted site; Surface not yet run) |
| Analysis tab: physical features, CSV export, PCA comparison | Pass (2026-10-05) | Not yet run |

Board identity read by the Step 1 page:

- Board: Radar Baseboard MCU7 (MCU B)
- Firmware: 2.9.0
- Protocol: 4.0 (matches SDK 3.6.5 host protocol 4)
- UUID: 003233534e394b4a3138303331303331

Existing files in `tools/`: `usb_probe.html` (USB/serial probe), `sensds_web_step1_connect.html` (working transport: framing, CRC, request/response). Reuse the `Link` class from Step 1.

## Where the Infineon source lives

On the Mac: `~/infineon/infineon_sdk_src` (same layout as the SDK, paths below use backslashes as on Windows).
Original on the Surface: `C:\Infineon\Tools\Radar-Development-Kit\3.6.5\assets\software\radar_sdk\radar_sdk`

| Path | Role | License |
|---|---|---|
| `external\strata\library` | Transport to the board | Evaluation license (restricted) |
| `external\lib_avian` | Chirp settings to chip registers | BSD 3-Clause (per file headers) |
| `sdk\c\ifxFmcw`, `sdk\c\ifxAvian` | SDK device layer | Check per file headers |
| `sdk\py\wrapper_radarsdk` | Python wrapper | MIT |

## Wire protocol (Strata 4.0 over CDC serial)

Port settings: 921600 baud, fallback 1000000, 8N1, no flow control. Clear stale input after opening. Response timeout 1000 ms.

CRC: CRC16 CCITT-FALSE (poly 0x1021, init 0xFFFF), appended big endian. CRC over a whole received packet including its CRC equals 0.

**Request:** `bmReqType, bRequest, wValue(LE), wIndex(LE), wLength(LE), payload, CRC`

- Write `0x40`, Read `0xC0`, Transfer `0x43`
- For Read, wLength is the expected reply length and no payload is sent.

**Response:** `bmReqType (echo), bStatus, wLength(LE), payload, CRC`. Status 0 is success.

**Data packet:** `bmPktType, bChannel, wCounter(LE), wLength(LE), payload, CRC`

- Type is `0xD0` plus flags: bit0 first packet of frame, bit1 last, bit2 last 8 payload bytes are a timestamp, bit3 payload is an error code.
- Frames span several packets. Counter increments per packet; a gap means packet loss and the frame is dropped.
- Control responses and data packets share the stream once data is started. Dispatch on the first byte (`0xDx` is data).
- Max packet size 4095 bytes.

The request, response, and CRC formats are verified on hardware. Everything below is read from source but not yet exercised on hardware.

### Platform requests

| Purpose | Type | bRequest | wValue | wIndex | Notes |
|---|---|---|---|---|---|
| Board info | Transfer | 0x80 | 0x00 | 0 | VID, PID (u16 LE), name string |
| Version info | Read | 0x80 | 0x01 | 0 | 8 x u16 LE |
| UUID | Read | 0x80 | 0x02 | 0 | 16 bytes |
| Data configure | Write | 0x0D | 0x01 | data index | payload below |
| Data start | Write | 0x0D | 0x03 | data index | |
| Data stop | Write | 0x0D | 0x04 | data index | |
| Data status flags | Read | 0x0D | 0x00 | data index | 4 bytes |

Data configure payload: `IDataProperties` (format u8, rxChannels u8, ramps u16, samples u16, channelSwapping u8, bitWidth u8) followed by readout entries (address u16, count u16), all LE. The SDK sends properties zeroed except `format = 0x10` (Packed12), with one readout entry: address = low byte of the driver's burst prefix, count = slice size.

### Avian component commands

`bRequest = 0x20`, `wValue = 0x0103` (Avian radar), `wIndex = (function << 8) | (subinterface << 4) | id`, id 0.

| Action | Subif | Fn | wIndex | Type and payload |
|---|---|---|---|---|
| Radar reset | 0 | 0x00 | 0x0000 | Write, 1 byte: 1 soft, 0 hard |
| Radar initialize | 0 | 0x01 | 0x0100 | Write, none |
| Get data index | 0 | 0x02 | 0x0200 | Read, 1 byte |
| Start data | 0 | 0x03 | 0x0300 | Write, none |
| Stop data | 0 | 0x04 | 0x0400 | Write, none |
| Set reset pin | 2 | 0x01 | 0x0120 | Write, 1 byte |
| Pins reset sequence | 2 | 0x05 | 0x0520 | Write, none |
| Get IRQ pin | 2 | 0x06 | 0x0620 | Read, 1 byte |
| Execute SPI words | 3 | 0x01 | 0x0130 | Write (no results) or Transfer (results), 4 bytes per word |
| Set bits | 3 | 0x02 | 0x0230 | Write, u32 = (address << 24) or (mask and 0xFFFFFF) |

SPI word bytes on the wire: `[(address << 1) | writeBit, value >> 16, value >> 8, value]`. Confirm the byte order of returned result words and of the u32 parameter serialization in `common\Serialization.hpp` and `lib_avian\include\ports\ifxAvian_StrataControlPort.hpp` before first use.

### Samples

Packed12: every 3 bytes hold two 12 bit samples. `s0 = (b0 << 4) | (b1 >> 4)`, `s1 = ((b1 & 0x0F) << 8) | b2`. See `common\Packed12.hpp`.

## Acquisition sequence (from `sdk\c\ifxFmcw\avian\DeviceFmcwAvian.cpp`)

Open:
1. Create the control port. Its constructor sends set bits (address 0x00, mask 0x00000C) to stop any measurement and clear the FIFO.
2. `Driver::create_driver` identifies the chip.
3. `detect_reference_clock`.

Start (`start_acquisition`):
1. Slice size from `calculate_slice_size`, capped at half the chip FIFO.
2. `set_slice_size` on the driver.
3. Data configure with readout address and slice size, Packed12.
4. Data start.
5. `initialize_reference_clock`, then send the full register configuration with the trigger bit, then `notify_trigger`.

Stop (`stop_acquisition`): data stop first, then the driver's stop and reset sequence (soft reset: MAIN register with FIFO_RESET and FSM_RESET set). Order matters.

## Still to read before writing Step 2

- `lib_avian\src\Driver\ifxRadar_BGT60TRxx.cpp`: `create_driver`, chip ID read
- `lib_avian\src\ifxAvian_StrataUtilities.cpp`: `initialize_reference_clock`, clock detection
- `lib_avian\src\ifxAvian_RegisterSet.cpp`: `send_to_device`, write order and trigger handling
- `sdk\c\ifxFmcw\DeviceFmcwBase.cpp`: rest of `calculate_slice_size`, `get_next_frame`, slice to frame assembly, antenna deinterleaving, scaling of raw samples to the float values Python returns

## Register strategy

- **Phase A (now):** export the register list from the SDK for the exact SensDSv2 configuration, and have the browser write those registers. The chip is then configured bit for bit as under Python. The wrapper exposes `get_register_list_string(trigger)` and `save_register_file(filename)` in `ifxAvian\Avian.py`; check what the `ifxradarsdk.fmcw` device offers.
- **Phase B (later):** compile `lib_avian` to WebAssembly so the browser computes registers for any configuration.

## SensDSv2 pipeline (from earlier build notes, confirm against the repo, repo wins)

- SDK 3.6.4, `ifxradarsdk.fmcw.DeviceFmcw`, chirp parameters set on `cfg.chirp.*`, `rx_mask=7`, frame shape (3, 64, 64), antenna 0 used
- Range FFT, then MTI filter, then range bin sum, then STFT, then dB scale
- 10 frame deque before first output
- `WINDOW=256, NOVERLAP=248, NFFT=1024`
- Velocity axis plus or minus 2.46 m/s (PRF 2000 Hz, 61 GHz center)
- pyqtgraph image, jet colormap, `DB_MIN=-20`, gaussian smoothing `sigma=[2.0, 1.5]`

## Build steps

1. Done: connect and handshake.
2. Configure the sensor and read one frame. Validate against a frame captured with the Python SDK using the same registers.
3. Continuous streaming with packet loss and FIFO overflow handling as in the SDK.
4. Port the processing pipeline. Validate numerically: feed the same recorded raw frames to Python and JavaScript and compare outputs.
5. Spectrogram display matching the desktop Visualize tab (colormap, dB range, smoothing, axes, scroll behavior).

## Validation rule

Each step is done only when its output matches the Python reference on the same input, and the result is logged per device in the table above.
