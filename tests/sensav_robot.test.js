// SensAV's robot tests (tests/test_robot_gate.py, test_robot_driver.py), ported
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandGate } from '../src/sensav/robot/gate.js';
import { actionMessages, stopMessages } from '../src/sensav/robot/protocol.js';
import { RobotLink, simulatedRobot } from '../src/sensav/robot/link.js';
import { RobotDriver } from '../src/sensav/robot/driver.js';
import { Emitter } from '../src/sensav/app/emitter.js';

const ACTIONS = { up: 'forward', left: 'turn_left', idle: 'no_action', halt: 'stop', boom: 'kick' };
function gate(threshold = 0.5, smoothing = 3) { const clock = { now: 100 }; return [new CommandGate(threshold, smoothing, 0.3, () => clock.now), clock]; }
const feed = (g, clock, id, confidence = 0.9, step = 0.1) => { clock.now += step; return g.update(id, confidence, k => ACTIONS[k]); };

test('needs steady predictions before moving', () => {
  const [g, c] = gate(0.5, 3);
  assert.equal(feed(g, c, 'up'), null); assert.equal(feed(g, c, 'up'), null);
  assert.equal(feed(g, c, 'up').action, 'forward');
});
test('a different class restarts the count', () => {
  const [g, c] = gate(0.5, 3);
  feed(g, c, 'up'); feed(g, c, 'up');
  assert.equal(feed(g, c, 'left'), null); assert.equal(feed(g, c, 'up'), null); assert.equal(feed(g, c, 'up'), null);
  assert.equal(feed(g, c, 'up').action, 'forward');
});
test('only sends when the command changes', () => {
  const [g, c] = gate(0.5, 1);
  assert.equal(feed(g, c, 'up').action, 'forward');
  for (let i = 0; i < 10; i++) assert.equal(feed(g, c, 'up'), null);
});
test('unsure prediction stops right away even inside the rate limit', () => {
  const [g, c] = gate(0.5, 1);
  assert.equal(feed(g, c, 'up').action, 'forward');
  const d = feed(g, c, 'up', 0.4, 0.01);
  assert.equal(d.action, 'stop'); assert.equal(d.reason, 'not_sure');
  assert.equal(feed(g, c, 'left', 0.2), null);
});
test('threshold is inclusive', () => { const [g, c] = gate(0.5, 1); assert.equal(feed(g, c, 'up', 0.5).action, 'forward'); });
test('rate limit holds, then flushes the latest command', () => {
  const [g, c] = gate(0.5, 1);
  assert.equal(feed(g, c, 'up').action, 'forward');
  assert.equal(feed(g, c, 'left', 0.9, 0.1), null);
  assert.equal(g.flush(), null);
  c.now += 0.25;
  assert.equal(g.flush().action, 'turn_left');
  assert.equal(g.flush(), null);
});
test('No Action keeps the current command', () => {
  const [g, c] = gate(0.5, 1);
  assert.equal(feed(g, c, 'up').action, 'forward');
  assert.equal(feed(g, c, 'idle', 0.9, 1.0), null);
  assert.equal(g.current, 'forward');
});
test('force stop and reset', () => {
  const [g, c] = gate(0.5, 1);
  feed(g, c, 'up');
  const d = g.forceStop('watchdog');
  assert.equal(d.action, 'stop'); assert.equal(d.reason, 'watchdog');
  assert.equal(g.forceStop('watchdog'), null);
  g.reset(); assert.equal(g.current, null);
  assert.equal(feed(g, c, 'up').action, 'forward');
});
test('kick is sent once per streak', () => {
  const [g, c] = gate(0.5, 1);
  assert.equal(feed(g, c, 'boom', 0.9, 1).action, 'kick');
  assert.equal(feed(g, c, 'boom', 0.9, 1), null);
  assert.equal(feed(g, c, 'up', 0.9, 1).action, 'forward');
  assert.equal(feed(g, c, 'boom', 0.9, 1).action, 'kick');
});
test('protocol messages', () => {
  assert.deepEqual(actionMessages('forward', 'medium'), [{ cmd_id: 'turn', turn_rate: 0, stacking_type: 0 }, { cmd_id: 'drive', angle: 0, speed: 100, stacking_type: 0 }]);
  assert.deepEqual(actionMessages('turn_left', 'slow').at(-1), { cmd_id: 'turn', turn_rate: -54, stacking_type: 0 });
  assert.equal(actionMessages('turn_right', 'fast').at(-1).turn_rate, 144);
  assert.equal(actionMessages('backward').at(-1).angle, 180);
  assert.deepEqual(actionMessages('stop'), stopMessages());
  assert.deepEqual(actionMessages('kick'), [{ cmd_id: 'kick_hard' }]);
  assert.deepEqual(actionMessages('no_action'), []);
});

// ---------- driver with the simulated robot ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); }
const cmds = () => simulatedRobot.messages.map(m => [m.cmd_id, m.angle ?? null, m.speed ?? null, m.turn_rate ?? null]);
const STOP = [['drive', 0, 0, null], ['turn', null, null, 0]];

async function rig(t) {
  simulatedRobot.reset();
  const link = new RobotLink();
  const inference = Object.assign(new Emitter(), { state: 'off', purpose: '', stop() { this.state = 'off'; this.emit('state', 'off'); } });
  const classes = [{ id: 'go', name: 'Go', robot_action: 'forward' }, { id: 'turn', name: 'Turn', robot_action: 'turn_left' }];
  const project = { robot: { source: 'image', confidence_threshold: 0.6, smoothing_count: 2, speed: 'medium' }, classes: () => classes };
  const driver = new RobotDriver({ link, inference, getProject: () => project, predictionInterval: () => 0.1 });
  const start = () => driver.start(() => { inference.purpose = 'robot'; inference.state = 'running'; inference.emit('state', 'running'); });
  const predict = (i, conf) => inference.emit('prediction', { mode: 'image', classId: classes[i].id, confidence: conf });
  t.after(async () => { driver.stop('user'); await link.shutdown(); });
  link.connectTo('simulated');
  assert.ok(await until(() => link.isConnected, 3000));
  simulatedRobot.messages.length = 0;
  return { link, inference, driver, start, predict };
}

test('drives after steady predictions and stops when unsure', async t => {
  const { link, driver, start, predict } = await rig(t);
  start();
  predict(0, 0.9); await sleep(200);
  assert.deepEqual(cmds(), []);
  predict(0, 0.9);
  assert.ok(await until(() => JSON.stringify(cmds()) === JSON.stringify([['turn', null, null, 0], ['drive', 0, 100, null]]), 3000));
  simulatedRobot.messages.length = 0;
  predict(0, 0.55);
  assert.ok(await until(() => JSON.stringify(cmds()) === JSON.stringify(STOP), 3000));
  const events = []; driver.on('decision', e => events.push(e));
  predict(0, 0.3); await sleep(200);
  assert.deepEqual(events, []);
});

test('watchdog stops the robot when predictions stop', async t => {
  const { link, driver, start, predict } = await rig(t);
  start();
  predict(1, 0.95); predict(1, 0.95);
  assert.ok(await until(() => JSON.stringify(cmds().slice(-1)) === JSON.stringify([['turn', null, null, -90]]), 3000));
  simulatedRobot.messages.length = 0;
  const t0 = Date.now();
  assert.ok(await until(() => JSON.stringify(cmds()) === JSON.stringify(STOP), 3000));
  const dt = (Date.now() - t0) / 1000;
  assert.ok(dt > 0.8 && dt < 2.0, `watchdog after ${dt} s`);
  assert.ok(driver.active);
});

test('stops when predictions stop and when the connection drops', async t => {
  const { link, inference, driver, start, predict } = await rig(t);
  start();
  predict(0, 0.9); predict(0, 0.9);
  assert.ok(await until(() => cmds().length === 2, 3000));
  simulatedRobot.messages.length = 0;
  inference.state = 'off'; inference.emit('state', 'off');
  assert.equal(driver.active, false);
  assert.ok(await until(() => JSON.stringify(cmds()) === JSON.stringify(STOP), 3000));
  start();
  simulatedRobot.dropConnection = true;
  assert.ok(await until(() => link.state === 'lost', 5000));
  assert.equal(driver.active, false);
});

test('emergency stop works even when not driving; practice mode sends nothing', async t => {
  const { link, driver, start, predict } = await rig(t);
  driver.emergencyStop();
  assert.ok(await until(() => JSON.stringify(cmds()) === JSON.stringify(STOP), 3000));
  link.disconnect(); await sleep(300);
  simulatedRobot.messages.length = 0;
  const decisions = []; driver.on('decision', d => decisions.push(d));
  start(); predict(0, 0.9); predict(0, 0.9); await sleep(300);
  assert.deepEqual(cmds(), []);
  assert.equal(decisions.at(-1).action, 'forward'); assert.equal(decisions.at(-1).sent, false);
});

// ---------- Chrome's local network permission, from the https site ----------
class RefusedSocket {
  constructor() { this.readyState = 0; setTimeout(() => { this.onerror?.(); this.onclose?.(); }, 5); }
  send() {} close() {}
}
async function withPage(state, fn) {
  const saved = { location: globalThis.location, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  globalThis.location = { protocol: 'https:' };
  Object.defineProperty(globalThis, 'navigator', { value: { permissions: { query: async ({ name }) => { if (name !== 'local-network') throw new TypeError('unknown'); return { state }; } } }, configurable: true });
  try { await fn(); } finally {
    globalThis.location = saved.location;
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator); else delete globalThis.navigator;
  }
}

test('https site: a refused connection without local network permission says how to allow it', async () => {
  for (const state of ['denied', 'prompt']) {
    await withPage(state, async () => {
      const link = new RobotLink({ WebSocketImpl: RefusedSocket }), problems = [], notes = [];
      link.on('problem', (k, m) => problems.push([k, m])); link.on('note', n => notes.push(n));
      link.connectTo('192.168.4.1');
      assert.ok(await until(() => problems.length, 3000));
      assert.equal(problems[0][0], 'blocked', state);
      assert.match(problems[0][1], /Local network access/);
      assert.equal(notes.length, state === 'prompt' ? 1 : 0);
      assert.equal(link.state, 'disconnected');
    });
  }
});

test('https site with permission granted: a refused connection is "not reachable"', async () => {
  await withPage('granted', async () => {
    const link = new RobotLink({ WebSocketImpl: RefusedSocket }), problems = [];
    link.on('problem', (k, m) => problems.push([k, m]));
    link.connectTo('192.168.4.1');
    assert.ok(await until(() => problems.length, 3000));
    assert.equal(problems[0][0], 'unreachable');
  });
});
