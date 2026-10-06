// STRATA DERIVED: platform data requests (BridgeProtocolData.cpp), slice
// reassembly (BridgeSerial::dataThreadFunction) and the slice-to-frame reader
// (DeviceFmcwBase::get_next_raw_frame). Infineon Evaluation Software License.
// Publishing permitted (permission confirmed 2026-10-05). See LICENSING.md.

// ---------- Platform data requests (universal/protocol/protocol_definitions.h) ----------
export const REQ_DATA = 0x0D;
export const REQ_DATA_STATUS_FLAGS = 0x00;   // read, 4 bytes
export const REQ_DATA_CONFIGURE = 0x01;
export const REQ_DATA_START = 0x03;
export const REQ_DATA_STOP = 0x04;

export const DataFormat_Packed12 = 0x10;     // universal/data_definitions.h

// Data frame flags, low nibble of bmPktType
export const DATA_FRAME_FLAG_FIRST = 1 << 0;
export const DATA_FRAME_FLAG_LAST = 1 << 1;
export const DATA_FRAME_FLAG_TIMESTAMP = 1 << 2;
export const DATA_FRAME_FLAG_ERROR = 1 << 3;

// universal/data_definitions.h, universal/error_definitions.h
export const DataError_NoError = 0x00000000;
export const DataError_LowLevelError = 0x40000001;
export const DataError_FrameDropped = 0x40000002;
export const DataError_FramePoolDepleted = 0x40000003;
export const DataError_FrameSizeExceeded = 0x40000004;
export const DataError_FrameQueueTrimmed = 0x40000005;
export const E_OVERFLOW = 0x07;

const TIMESTAMP_SIZE = 8;

// Payload of REQ_DATA_CONFIGURE as DeviceFmcwBase::configure_data builds it:
// IDataProperties_t (format u8, rxChannels u8, ramps u16, samples u16,
// channelSwapping u8, bitWidth u8), all zero except format, followed by one
// DataSettingsBgtRadar readout entry (address u16, count u16). Little endian.
export function dataConfigurePayload(readoutAddress, sliceSize, format = DataFormat_Packed12) {
  return Uint8Array.of(
    format, 0, 0, 0, 0, 0, 0, 0,
    readoutAddress & 0xFF, readoutAddress >> 8,
    sliceSize & 0xFF, sliceSize >> 8,
  );
}

export const dataConfigure = (link, index, readoutAddress, sliceSize, format) =>
  link.vendorWrite(REQ_DATA, REQ_DATA_CONFIGURE, index, dataConfigurePayload(readoutAddress, sliceSize, format));
export const dataStart = (link, index) => link.vendorWrite(REQ_DATA, REQ_DATA_START, index);
export const dataStop = (link, index) => link.vendorWrite(REQ_DATA, REQ_DATA_STOP, index);
export async function dataStatusFlags(link, index) {
  const b = await link.vendorRead(REQ_DATA, REQ_DATA_STATUS_FLAGS, index, 4);
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u64le = (b, i) => BigInt(u32le(b, i)) | (BigInt(u32le(b, i + 4)) << 32n);

// ---------- Slice reassembly: port of BridgeSerial::dataThreadFunction ----------
// A Strata "frame" is one slice of radar data (slice_size samples). It may span
// several packets. Emits onSlice({ data, channel, timestamp }) for good slices
// and onError({ code, channel, timestamp }) where the SDK queues an ErrorFrame.
//
// pool: a FramePool. A buffer is taken from it when a slice starts and goes
// back when the reader has consumed the slice (or the queue trims it).
export class SliceAssembler {
  constructor(sliceBytes, { onSlice, onError, pool = null }) {
    // BridgeSerial::setFrameBufferSize adds room for the timestamp
    this.capacity = sliceBytes + TIMESTAMP_SIZE;
    this.onSlice = onSlice;
    this.onError = onError;
    this.pool = pool;
    this.buf = null;
    this.reset();
  }

  reset() {
    if (this.buf && this.pool) this.pool.release();
    this.firstFrame = true;
    this.packetCounter = 0;
    this.buf = null;       // current frame buffer, null when none is dequeued
    this.pos = 0;
    this.virtualChannel = 0;
  }

  push({ type, channel, counter, payload, crcOk }) {
    const wLength = payload.length;

    if (this.firstFrame) {
      this.firstFrame = false;
      this.packetCounter = (counter + 1) & 0xFFFF;
    } else if (counter !== this.packetCounter) {
      // Packet loss
      this.packetCounter = (counter + 1) & 0xFFFF;
      this.onError({ code: DataError_FrameDropped, channel, timestamp: 0n });
      if (!(type & DATA_FRAME_FLAG_FIRST)) return;   // dumpRemainder; discard this follow-up packet
    } else {
      this.packetCounter = (this.packetCounter + 1) & 0xFFFF;
    }

    if (!this.buf) {
      // FramePool::dequeueFrame; with no free buffer the packet is dumped
      if (this.pool && !this.pool.acquire()) {
        this.onError({ code: DataError_FramePoolDepleted, channel: VIRTUAL_CHANNEL_UNDEFINED, timestamp: 0n });
        return;
      }
      this.buf = new Uint8Array(this.capacity);
      this.pos = 0;
    }
    if (wLength > this.capacity - this.pos) {
      this.onError({ code: DataError_FrameSizeExceeded, channel, timestamp: 0n });
      return;
    }

    if (type & DATA_FRAME_FLAG_FIRST) {
      this.virtualChannel = channel;
      this.pos = 0;   // a new frame starts; any incomplete previous frame is dropped
    }

    // The SDK reads the payload into the buffer before checking the CRC.
    this.buf.set(payload, this.pos);

    if (!crcOk) {
      this.pos = 0;
      this.onError({ code: DataError_FrameDropped, channel, timestamp: 0n });
      return;
    }

    if (!(type & DATA_FRAME_FLAG_FIRST)) {
      if (this.pos === 0) return;   // unexpected follow-up packet
      if (this.virtualChannel !== channel) {
        this.pos = 0;
        this.onError({ code: DataError_FrameDropped, channel, timestamp: 0n });
        return;
      }
    }

    this.pos += wLength;

    if (type & DATA_FRAME_FLAG_LAST) {
      let timestamp = 0n;
      if (type & DATA_FRAME_FLAG_TIMESTAMP) {
        this.pos -= TIMESTAMP_SIZE;
        timestamp = u64le(this.buf, this.pos);
      }
      if (type & DATA_FRAME_FLAG_ERROR) {
        const errorFrameLength = 4 + ((type & DATA_FRAME_FLAG_TIMESTAMP) ? TIMESTAMP_SIZE : 0);
        if (wLength === errorFrameLength) {
          this.onError({ code: u32le(this.buf, this.pos - 4), channel, timestamp });
        }
        // otherwise the SDK logs it as a debug frame
        this.pos = 0;
      } else {
        const data = this.buf.slice(0, this.pos);
        this.buf = null;
        this.pos = 0;
        this.onSlice({ data, channel: this.virtualChannel, timestamp });
      }
    }
  }
}

// ---------- Frame pool and queue limits (BridgeData, FrameQueue, FramePool) ----------
// DeviceFmcwBase::configure_data sets the queue to hold seconds_to_buffer (10 s)
// worth of frame repetitions, computed in float32 and truncated:
// 10.0f / 0.1f = 100. BridgeData::setFrameQueueSize makes the pool one larger.
export const VIRTUAL_CHANNEL_UNDEFINED = 0xFF;
export const SECONDS_TO_BUFFER = 10.0;
export const frameQueueSize = frameRepetitionTime =>
  Math.trunc(Math.fround(Math.fround(SECONDS_TO_BUFFER) / Math.fround(frameRepetitionTime)));

export class FramePool {
  constructor(count) { this.count = count; this.free = count; }
  acquire() { if (this.free === 0) return false; this.free--; return true; }
  release() { if (this.free < this.count) this.free++; }
}

// ---------- Slice to raw frame: port of DeviceFmcwBase::get_next_raw_frame ----------
// Errors are thrown with the same mapping the SDK uses to raise exceptions.
// The queue in front of it is FrameQueue: when it holds more than maxCount
// entries, the oldest (maxCount + 1 - size) more are dropped and a
// FrameQueueTrimmed error is put at the front (FrameQueue::trimQueue).
// The SDK unpacks each slice as it copies it; this reader copies packed bytes
// and frame/unpack.js unpacks the whole frame. The two agree whenever slice
// sizes are multiples of 3 bytes, which holds for our 12288-byte slices.
export class FrameAcquisitionFailed extends Error {}
export class FifoOverflow extends Error {}
export class FrameSizeNotSupported extends Error {}

export class RawFrameReader {
  // frameBytes: m_frame_length = get_buffer_length(num_samples)
  constructor(frameBytes, { maxCount = 0, pool = null } = {}) {
    this.frameBytes = frameBytes;
    this.maxCount = maxCount; // 0: unlimited, as FrameQueue with m_maxCount 0
    this.pool = pool;
    this.queue = [];          // slices and errors, in arrival order
    this.waiter = null;
    this.slice = null;        // m_slice: partly consumed slice { data, offset }
    this.trimmed = 0;         // slices dropped by queue trimming (for diagnostics)
  }

  pushSlice(slice) { this._enqueue({ data: slice.data }); }
  pushError(err) { this._enqueue({ code: err.code }); }

  _enqueue(item) {
    this.queue.push(item);
    if (this.maxCount && this.queue.length > this.maxCount) {
      let count = this.queue.length - this.maxCount + 1;
      while (count--) this._release(this.queue.shift());
      this.queue.unshift({ code: DataError_FrameQueueTrimmed });
    }
    this._wake();
  }

  _release(item) {
    if (item && item.data) { this.trimmed++; if (this.pool) this.pool.release(); }
  }
  _wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }

  async _getFrame(timeoutMs) {
    if (!this.queue.length && timeoutMs > 0) {
      await new Promise(res => {
        const timer = setTimeout(res, timeoutMs);
        this.waiter = () => { clearTimeout(timer); res(); };
      });
      this.waiter = null;
    }
    return this.queue.shift() || null;
  }

  // Returns a Uint8Array of exactly frameBytes packed bytes.
  async next(timeoutMs = 1000) {
    const frame = new Uint8Array(this.frameBytes);
    let pos = 0;
    let remaining = this.frameBytes;
    const expiry = performance.now() + timeoutMs;
    while (remaining) {
      if (!this.slice) {
        const left = Math.floor(expiry - performance.now());
        if (left <= 0) throw new Error('Timeout waiting for radar data');
        const s = await this._getFrame(left);
        if (!s) throw new Error('Timeout waiting for radar data');
        if (s.code !== undefined) {
          switch (s.code) {
            case DataError_FrameDropped:
            case DataError_FramePoolDepleted:
            case DataError_FrameQueueTrimmed:
              throw new FrameAcquisitionFailed('Frame acquisition failed (0x' + s.code.toString(16) + ')');
            case DataError_FrameSizeExceeded:
              throw new FrameSizeNotSupported('Frame size not supported');
            case E_OVERFLOW:
              throw new FifoOverflow('Radar FIFO overflow');
            default:
              throw new Error('Radar data error 0x' + s.code.toString(16));
          }
        }
        this.slice = { data: s.data, offset: 0 };
      }

      const avail = this.slice.data.length - this.slice.offset;
      if (remaining < avail) {
        // Frame finished; keep the rest of the slice for the next call.
        frame.set(this.slice.data.subarray(this.slice.offset, this.slice.offset + remaining), pos);
        this.slice.offset += remaining;
        return frame;
      }
      frame.set(this.slice.data.subarray(this.slice.offset), pos);
      this.slice = null;
      if (this.pool) this.pool.release();   // the slice buffer goes back to the pool
      pos += avail;
      remaining -= avail;
    }
    return frame;
  }

  // stop_data() resets m_slice
  reset() {
    if (this.pool) {
      for (const item of this.queue) if (item.data) this.pool.release();
      if (this.slice) this.pool.release();
    }
    this.queue.length = 0;
    this.slice = null;
  }
}
