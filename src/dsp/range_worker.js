// The range map off the page (src/dsp/range_map.js): the live processor's
// rolling history per frame, or the whole recording at once.
//
// in:  { type: 'init', gen, nSample, nChirp, historyLength, mode }
//      { type: 'frame', gen, frame: Float32Array antenna 0 }
//      { type: 'whole', gen, frames: Float32Array (nFrame x nChirp x nSample), nFrame, nChirp, nSample, mode }
// out: { gen, kind: 'live', history, nFilled, nBins, rangeM } or { gen, kind: 'whole', map, nBins, rangeM, nFrame }

import { LiveRangeProcessor, computeRangeMap } from './range_map.js';

let proc = null, gen = 0;
self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    gen = data.gen;
    proc = new LiveRangeProcessor({ nSample: data.nSample, nChirp: data.nChirp, mode: data.mode, historyLength: data.historyLength });
  } else if (data.type === 'frame' && proc && data.gen === gen) {
    const { history, nFilled } = proc.processFrame(data.frame);
    const copy = history.slice();
    self.postMessage({ gen, kind: 'live', history: copy, nFilled, nBins: proc.nRangeBins, rangeM: proc.rangeM }, [copy.buffer]);
  } else if (data.type === 'whole') {
    gen = data.gen;
    const per = data.nChirp * data.nSample;
    const { map, nBins, rangeM } = computeRangeMap(i => data.frames.subarray(i * per, (i + 1) * per), data.nFrame, data.nChirp, data.nSample, data.mode);
    self.postMessage({ gen, kind: 'whole', map, nBins, rangeM, nFrame: data.nFrame }, [map.buffer]);
  }
};
