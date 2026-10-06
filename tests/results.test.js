import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Results, pct } from '../src/results/results.js';

const t = new Date(2026, 9, 5, 14, 3, 9);

test('confusion matrix, accuracy per gesture, summary and CSV follow the desktop', () => {
  const r = new Results();
  r.setModel('Michael_v1', ['idle', 'push', 'swipe_left']);
  r.add({ time: t, gesture: 'push', confidence: 0.91, threshold: 0.6, actual: 'push', source: 'Single' });
  r.add({ time: t, gesture: 'push', confidence: 0.55, threshold: 0.6, actual: 'swipe_left', source: 'Single' });
  r.add({ time: t, gesture: 'idle', confidence: 0.70, threshold: 0.6, actual: null, source: 'RoboSoccer' });
  r.add({ time: t, gesture: 'swipe_left', confidence: 0.83, threshold: 0.55, actual: 'swipe_left', source: 'Maze' });   // fired: counts
  assert.deepEqual(r.matrix, [[0, 0, 0], [0, 1, 0], [0, 1, 1]]);
  assert.deepEqual(r.total, { idle: 0, push: 1, swipe_left: 2 });
  assert.deepEqual(r.correct, { idle: 0, push: 1, swipe_left: 1 });
  assert.equal(r.summary(), '4 predictions  ·  3 confident  (75%)');
  assert.equal(r.csv(),
    'timestamp,mode,predicted,confidence,actual,above_threshold\r\n' +
    '2026-10-05 14:03:09,Single,push,0.9100,push,yes\r\n' +
    '2026-10-05 14:03:09,Single,push,0.5500,swipe_left,no\r\n' +
    '2026-10-05 14:03:09,RoboSoccer,idle,0.7000,,yes\r\n' +
    '2026-10-05 14:03:09,Maze,swipe_left,0.8300,swipe_left,yes\r\n');
  r.clear();
  assert.equal(r.history.length, 0);
  assert.deepEqual(r.matrix, [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  assert.equal(pct(0.912, 1), '91.2%');
});

test('a gesture outside the model classes is kept in history but not counted', () => {
  const r = new Results();
  r.setModel('m', ['idle', 'push']);
  r.add({ time: t, gesture: 'push', confidence: 0.9, threshold: 0.6, actual: 'wave', source: 'Single' });
  assert.equal(r.history.length, 1);
  assert.deepEqual(r.matrix, [[0, 0], [0, 0]]);
  assert.equal(r.summary(), '1 prediction  ·  1 confident  (100%)');
});
