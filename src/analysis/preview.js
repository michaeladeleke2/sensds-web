// The Analysis tab's picture of one recorded sample, drawn the way the
// Visualize tab draws the radar (SensDSv2 core/sample_preview.py):
//   Doppler: LiveDopplerProcessor over every frame of the sample, antenna 0,
//            for LiveSpectrogramPlot, as the Visualize tab's spectrogram;
//   range:   compute_range_map (range_map_v1.py) with the MTI setting, for
//            RangeMapPlot's whole-recording figure.
// Runs in the analysis worker.

import { LiveDopplerProcessor } from '../dsp/doppler_live.js';
import { computeRangeMap } from '../dsp/range_map.js';

const ANTENNA = 0;

// cube: flat Float32Array (n_frame, n_ant, n_chirp, n_sample)
export function samplePreview(cube, shape, mode) {
  const [nFrame, nAnt, nChirp, nSample] = shape;
  const per = nChirp * nSample;
  const frameAt = i => cube.subarray((i * nAnt + ANTENNA) * per, (i * nAnt + ANTENNA + 1) * per);
  const proc = new LiveDopplerProcessor({ nSample, nChirp, historyLength: nFrame });
  let history = null;
  for (let i = 0; i < nFrame; i++) history = proc.processFrame(frameAt(i)).history;
  const { map, nBins, rangeM } = computeRangeMap(frameAt, nFrame, nChirp, nSample, mode);
  return { doppler: history, dopplerBins: proc.dopplerFftSize, rangeMap: map, nBins, rangeM, nFrame, mode };
}
