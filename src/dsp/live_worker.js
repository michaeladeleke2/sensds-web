// LiveDopplerProcessor off the page: the Range-Doppler map of every frame
// (about 16 ms on a fast laptop, several times that on a busy one) would
// otherwise run on the page, where it competes with reading the radar.
//
// in:  { type: 'init', gen, nSample, nChirp, historyLength }
//      { type: 'frame', gen, frame: Float32Array antenna 0 }
// out: { gen, history: Float64Array (historyLength x dopplerBins), dopplerBins, rangeBin }

import { LiveDopplerProcessor } from './doppler_live.js';

let proc = null, gen = 0;
self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    gen = data.gen;
    proc = new LiveDopplerProcessor({ nSample: data.nSample, nChirp: data.nChirp, historyLength: data.historyLength });
  } else if (data.type === 'frame' && proc && data.gen === gen) {
    const { history, rangeBin } = proc.processFrame(data.frame);
    self.postMessage({ gen, history, dopplerBins: proc.dopplerFftSize, rangeBin }, [history.buffer]);
  }
};
