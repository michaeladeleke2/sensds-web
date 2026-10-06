// A LiveDopplerProcessor running in src/dsp/live_worker.js. push() hands a
// frame over; onResult({ history, dopplerBins, count }) gets the rolling
// spectrogram after each one. reset() starts a new history (results still in
// flight for the old one are ignored).

export class LiveProcessorClient {
  constructor(onResult) {
    this.onResult = onResult;
    this.gen = 0;
    this.count = 0;
    this.inFlight = 0;
    this.worker = new Worker(new URL('./live_worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.gen !== this.gen) return;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.count += 1;
      this.onResult({ history: data.history, dopplerBins: data.dopplerBins, count: this.count });
    };
  }

  reset({ nSample, nChirp, historyLength }) {
    this.gen += 1;
    this.count = 0;
    this.inFlight = 0;
    this.worker.postMessage({ type: 'init', gen: this.gen, nSample, nChirp, historyLength });
  }

  // frame: antenna 0, (nChirp x nSample). Copied, so the caller keeps its array.
  push(frame) {
    const copy = Float32Array.from(frame);
    this.inFlight += 1;
    this.worker.postMessage({ type: 'frame', gen: this.gen, frame: copy }, [copy.buffer]);
  }
}
