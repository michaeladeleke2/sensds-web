// The range map worker (src/dsp/range_worker.js) from the page. Like
// LiveProcessorClient: reset() starts a new history, push() hands a frame
// over, onResult gets the newest history; whole() maps a recording at once.

export class RangeMapClient {
  constructor(onResult) {
    this.onResult = onResult;
    this.gen = 0;
    this.count = 0;
    this.worker = new Worker(new URL('./range_worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.gen !== this.gen) return;
      if (data.kind === 'live') this.count += 1;
      this.onResult({ ...data, count: this.count });
    };
  }

  reset({ nSample, nChirp, historyLength, mode }) {
    this.gen += 1;
    this.count = 0;
    this.worker.postMessage({ type: 'init', gen: this.gen, nSample, nChirp, historyLength, mode });
  }

  push(frame) {
    const copy = Float32Array.from(frame);
    this.worker.postMessage({ type: 'frame', gen: this.gen, frame: copy }, [copy.buffer]);
  }

  // frames: Float32Array (nFrame x nChirp x nSample), antenna 0
  whole({ frames, nFrame, nChirp, nSample, mode }) {
    this.gen += 1;
    this.worker.postMessage({ type: 'whole', gen: this.gen, frames, nFrame, nChirp, nSample, mode }, [frames.buffer]);
  }
}
