// VEX AIM client against a simulated robot (commands checked byte for byte
// against SensDSv2 vex/aim.py), and the badges against ui/gamification.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AimRobot, TurnType, KickType, DisconnectedError } from '../src/vex/aim_client.js';
import { GamificationManager } from '../src/gamification/manager.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/vex_badges/vex_badges.json', import.meta.url)));

// A WebSocket that behaves like the robot's four endpoints
function fakeRobot({ answerCommands = true, refuse = false } = {}) {
  const robot = { urls: [], commands: [], statusPolls: 0 };
  robot.WebSocket = class {
    constructor(url) {
      this.url = url; this.readyState = 0;
      robot.urls.push(url);
      setTimeout(() => {
        if (refuse) { this.onerror?.(); return; }
        this.readyState = 1; this.onopen?.();
      }, 1);
    }
    send(data) {
      const name = this.url.split('/').pop();
      const reply = text => setTimeout(() => this.onmessage?.({ data: text }), 1);
      if (name === 'ws_status') { robot.statusPolls++; assert.deepEqual([...data], [1]); reply(JSON.stringify({ robot: { flags: '0x00' } })); }
      if (name === 'ws_cmd') {
        assert.ok(data instanceof Uint8Array, 'commands go as binary frames');
        const text = new TextDecoder().decode(data);
        robot.commands.push(text);
        if (answerCommands) reply(new TextEncoder().encode(JSON.stringify({ cmd_id: JSON.parse(text).cmd_id, status: 'complete' })).buffer);
      }
    }
    close() { this.readyState = 3; this.onclose?.(); }
  };
  return robot;
}

test('VEX AIM: connect opens the four sockets, sends program_init, waits for status', async () => {
  const fake = fakeRobot();
  const robot = new AimRobot('192.168.4.1', { WebSocketImpl: fake.WebSocket });
  await robot.connect();
  assert.deepEqual(fake.urls, ['ws_status', 'ws_img', 'ws_cmd', 'ws_audio'].map(n => `ws://192.168.4.1/${n}`));
  assert.ok(robot.status);
  assert.ok(fake.statusPolls >= 1);
  robot.close();
});

test('VEX AIM: every command is the desktop\'s JSON, in order', async () => {
  const fake = fakeRobot();
  const robot = new AimRobot('192.168.4.1', { WebSocketImpl: fake.WebSocket });
  await robot.connect();
  await Promise.all([robot.moveFor(500, 0), robot.turnFor(TurnType.LEFT, 30), robot.turnFor(TurnType.RIGHT, 30), robot.kick(KickType.HARD)]);
  await robot.stopAllMovement();
  assert.deepEqual(fake.commands, fx.commands);
  robot.close();
});

test('VEX AIM: an https page blocking ws:// is reported as blocked', async () => {
  const Blocking = class { constructor() { throw new DOMException("An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.", 'SecurityError'); } };
  const robot = new AimRobot('192.168.4.1', { WebSocketImpl: Blocking });
  await assert.rejects(robot.connect(), e => e.blocked === true);
});

test('VEX AIM: an unreachable robot gives the desktop\'s message', async () => {
  const fake = fakeRobot({ refuse: true });
  const robot = new AimRobot('10.0.0.9', { WebSocketImpl: fake.WebSocket });
  await assert.rejects(robot.connect(), /Could not connect to ws:\/\/10\.0\.0\.9\/ws_status .*AP mode is 192\.168\.4\.1/);
});

test('VEX AIM: a robot that stops answering raises DisconnectedError', async () => {
  const fake = fakeRobot();
  const robot = new AimRobot('192.168.4.1', { WebSocketImpl: fake.WebSocket, timeoutMs: 60 });
  await robot.connect();
  fake.WebSocket.prototype.send = function () {};          // powered off: nothing comes back
  await assert.rejects(robot.moveFor(500, 0), DisconnectedError);
  robot.close();
});

test('badges: XP, levels, badges and signals match the desktop', () => {
  const signals = [];
  const mgr = new GamificationManager({
    xpChanged: (xp, lvl) => signals.push(['xp', xp, lvl]),
    badgeEarned: key => signals.push(['badge', key]),
    levelUp: lvl => signals.push(['level_up', lvl]),
  });
  fx.badges.events.forEach((e, i) => {
    if (e[0] === 'prediction') mgr.onPrediction(e[1], e[2]);
    else if (e[0] === 'soccer') mgr.onSoccerGesture(e[1]);
    else mgr.onMazeSolved(e[1], e[2]);
    const s = fx.badges.states[i];
    assert.equal(mgr.xp, s.xp); assert.equal(mgr.levelIdx, s.level);
    assert.deepEqual([...mgr.badges].sort(), s.badges);
    assert.deepEqual(mgr.levelXpRange, s.range);
  });
  assert.deepEqual(signals, fx.badges.signals);
});

test('VEX AIM: Chrome 154 style blocking (a socket born closed) is reported as blocked', async () => {
  const BornClosed = class { constructor() { this.readyState = 3; } close() {} };
  const robot = new AimRobot('192.168.4.1', { WebSocketImpl: BornClosed });
  await assert.rejects(robot.connect(), e => e.blocked === true);
});
