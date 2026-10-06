// STRATA DERIVED: the radar device sequence of the Radar SDK's DeviceFmcwAvian
// on the Strata transport. Infineon Evaluation Software License.
// Publishing permitted (permission confirmed 2026-10-05). See LICENSING.md.
//
// Ported from:
//   open   DeviceFmcwAvian::DeviceFmcwAvian -> Driver::create_driver
//          (pins reset, SFCTL, CHIP_ID read); detect_reference_clock does
//          nothing on BGT60TR13C (no frequency doubler).
//   start  DeviceFmcwAvian::start_acquisition: data configure, data start,
//          register list with the trigger bit (initialize_reference_clock does
//          nothing on BGT60TR13C).
//   frame  DeviceFmcwBase::get_next_frame / get_next_raw_frame (10 s default
//          timeout, ifx_fmcw_get_next_frame).
//   stop   DeviceFmcwAvian::stop_acquisition: data stop first, then
//          Driver::stop_and_reset_sequence (soft reset).

import { Link, DEFAULT_BAUD, FALLBACK_BAUD } from '../transport/link.js';
import { dataConfigure, dataStart, dataStop, SliceAssembler, RawFrameReader, FramePool, frameQueueSize } from '../transport/strata.js';
import { pinsReset, executeSpiWords } from './protocol.js';
import {
  sfctlCommand, readCommand, decodeChipId, REG_CHIP_ID, REG_MAIN,
  configurationSequence, applySliceSize, softResetCommand, readoutAddress,
} from './registers.js';
import { REGISTERS } from './registers_tr13c.js';
import { SENSDS_CONFIG, deriveAcquisition } from '../config.js';
import { frameBytesToCube } from '../frame/unpack.js';

export const INFINEON_VID = 0x058B;
const DATA_INDEX = 0;                 // DeviceFmcwBase: m_data_index = 0
const FRAME_TIMEOUT_MS = 10000;       // ifx_fmcw_get_next_frame
const REQ_BOARD_INFO = 0x80, WVALUE_VERSION = 0x01;
const HOST_PROTOCOL_MAJOR = 4;

export { FrameAcquisitionFailed, FifoOverflow, FrameSizeNotSupported } from '../transport/strata.js';

export class RadarDevice {
  constructor(port, { log = () => {} } = {}) {
    this.port = port;
    this.log = log;
    this.acq = deriveAcquisition(SENSDS_CONFIG);
    this.link = null;
    this.started = false;
  }

  // Open the port (921600, then 1000000 as the SDK tries) and identify the chip.
  async open() {
    let lastError;
    for (const baud of [DEFAULT_BAUD, FALLBACK_BAUD]) {
      const link = new Link(this.port, { log: this.log });
      try {
        await link.open(baud);
        await new Promise(r => setTimeout(r, 100));
        link.clearInput();                                   // stale bytes, as BridgeSerial::openConnection
        const v = await link.vendorRead(REQ_BOARD_INFO, WVALUE_VERSION, 0, 16);
        const major = v[8] | (v[9] << 8);
        if (major !== HOST_PROTOCOL_MAJOR) throw new Error(`Board protocol ${major}, this app speaks protocol ${HOST_PROTOCOL_MAJOR}`);
        this.firmware = `${v[0] | (v[1] << 8)}.${v[2] | (v[3] << 8)}.${v[4] | (v[5] << 8)}`;
        this.link = link;
        break;
      } catch (e) {
        lastError = e;
        await link.close();
      }
    }
    if (!this.link) throw lastError;

    // Driver::create_driver: chip reset, then read_device_type
    await pinsReset(this.link);
    await executeSpiWords(this.link, [sfctlCommand()]);
    const [chipId] = await executeSpiWords(this.link, [readCommand(REG_CHIP_ID)], true);
    this.chip = decodeChipId(chipId);
    if (!this.chip.isBGT60TR13C) {
      await this.close();
      throw new Error(`Radar chip not supported (CHIP_ID 0x${chipId.toString(16)}); expected BGT60TR13C`);
    }
    return { firmware: this.firmware, chip: this.chip };
  }

  async start() {
    if (this.started) return;
    const { sliceSize, sliceBytes, frameBytes } = this.acq;
    // DeviceFmcwBase::configure_data -> BridgeData::setFrameQueueSize
    const queueSize = frameQueueSize(SENSDS_CONFIG.frame_repetition_time_s);
    this.pool = new FramePool(queueSize + 1);
    this.reader = new RawFrameReader(frameBytes, { maxCount: queueSize, pool: this.pool });
    const assembler = new SliceAssembler(sliceBytes, {
      pool: this.pool,
      onSlice: s => this.reader.pushSlice(s),
      onError: e => this.reader.pushError(e),
    });
    this.link.onData = p => assembler.push(p);

    await dataConfigure(this.link, DATA_INDEX, readoutAddress(), sliceSize);
    await dataStart(this.link, DATA_INDEX);
    this.registers = applySliceSize(REGISTERS, sliceSize);       // Driver::set_slice_size
    await executeSpiWords(this.link, configurationSequence(this.registers, true));
    this.started = true;
  }

  // Next frame as a Float32Array (numRx x numChirps x samplesPerChirp), the
  // same layout and values as Python's get_next_frame()[0].
  async nextFrame() {
    const bytes = await this.reader.next(FRAME_TIMEOUT_MS);
    const { numRx, numChirps, samplesPerChirp } = this.acq;
    return frameBytesToCube(bytes, numRx, numChirps, samplesPerChirp);
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    try {
      await dataStop(this.link, DATA_INDEX);
    } finally {
      this.link.onData = null;
      this.reader?.reset();
      await executeSpiWords(this.link, [softResetCommand(this.registers.get(REG_MAIN))]);
    }
  }

  // Stop and start the acquisition again (data stop, soft reset, data
  // configure, data start, registers), as after a FIFO overflow.
  async restart() {
    await this.stop();
    await this.start();
  }

  async close() {
    try { await this.stop(); } catch (e) { this.log('Stop failed: ' + e.message); }
    if (this.link) { await this.link.close(); this.link = null; }
  }
}
