// Training off the page's main thread (the desktop's TrainingWorker thread):
// receives the embeddings in the dataset order, runs trainClassifier, posts
// each epoch and the finished head. Stopping terminates the worker.

import { trainClassifier } from './trainer.js';

self.onmessage = ({ data: msg }) => {
  if (msg.type !== 'train') return;
  try {
    const r = trainClassifier(msg.trainX, msg.trainY, msg.valX, msg.valY, msg.numClasses, {
      epochs: msg.epochs, batchSize: msg.batchSize, learningRate: msg.learningRate, embedDim: msg.embedDim,
      onEpoch: m => self.postMessage({ type: 'epoch', metrics: m }),
    });
    const { head } = r;
    self.postMessage({
      type: 'done',
      head: { embedDim: head.embedDim, numClasses: head.numClasses, denseUnits: head.denseUnits, w1: head.w1, b1: head.b1, w2: head.w2 },
      history: r.history, confusion: r.confusion, classAccuracy: r.classAccuracy,
      trainCounts: r.trainCounts, valCounts: r.valCounts, valAccuracy: r.valAccuracy,
    }, [head.w1.buffer, head.b1.buffer, head.w2.buffer]);
  } catch (e) {
    self.postMessage({ type: 'failed', message: e.message || String(e) });
  }
};
