// The part of the VEX AIM WebSocket client (SensDSv2 vex/aim.py and
// vex/vex_messages.py; Copyright (c) Innovation First 2025, MIT License) that
// the VEX AIM tab uses, written for the browser:
//   - four WebSockets, ws://<host>/ws_status, ws_img, ws_cmd and ws_audio,
//     each with a 4 s connect timeout, as Robot() opens them,
//   - the status loop: send the byte 1, read one JSON status, every 50 ms,
//   - commands: compact JSON sent as a binary frame on ws_cmd, then one JSON
//     reply read back; a reply with status "error" or cmd_id "cmd_unknown" is
//     logged, as robot_send prints it,
//   - program_init right after connecting, then wait for the first status.
// Only the commands the tab sends are here: move_for, turn_for, the kicker and
// stop_all_movement, with the defaults Robot() sets (drive_speed 100 mm/s,
// turn_speed 75 deg/s).

import { needsLocalNetwork, localNetworkState, LOCAL_NETWORK_PROMPT } from './local_network.js';

const TIMEOUT_MS = 4000;
const PROMPT_TIMEOUT_MS = 30000;     // while Chrome's local network question may be open
const STATUS_INTERVAL_MS = 50;
const SOCKETS = ['ws_status', 'ws_img', 'ws_cmd', 'ws_audio'];
const DRIVE_SPEED = 100;
const TURN_SPEED = 75;

export const TurnType = { LEFT: 'left', RIGHT: 'right' };
export const KickType = { SOFT: 'kick_soft', MEDIUM: 'kick_medium', HARD: 'kick_hard' };

export class DisconnectedError extends Error { constructor(m) { super(m); this.name = 'DisconnectedError'; } }

// A WebSocket with "read the next message" on top, the way websocket-client's
// blocking recv() is used by aim.py
class Socket {
  constructor(url, WebSocketImpl) {
    this.url = url;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.ws = new WebSocketImpl(url);
    this.ws.binaryType = 'arraybuffer';
    // Mixed content: older Chrome throws SecurityError for ws:// on an https
    // page; Chrome 154 returns a socket that is already closed
    this.blocked = this.ws.readyState === 3;
    this.ws.onmessage = e => {
      const data = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
      const w = this.waiters.shift();
      if (w) w.resolve(data); else this.queue.push(data);
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new DisconnectedError(`${url} closed`));
    };
  }
  open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('timed out')); try { this.ws.close(); } catch { /* already closed */ } }, timeoutMs);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('connection refused')); };
    });
  }
  send(payload) {
    if (this.closed || this.ws.readyState !== 1) throw new DisconnectedError(`${this.url}: error sending data to robot, apparently disconnected`);
    this.ws.send(payload);
  }
  recv(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new DisconnectedError(`${this.url} closed`));
    return new Promise((resolve, reject) => {
      const w = {
        resolve: d => { clearTimeout(timer); resolve(d); },
        reject: e => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new DisconnectedError(`${this.url}: error receiving data from robot, apparently disconnected`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  close() { this.closed = true; try { this.ws.close(); } catch { /* already closed */ } }
}

export class AimRobot {
  // log(msg): where robot_send's printed messages go
  constructor(host, { WebSocketImpl = globalThis.WebSocket, timeoutMs = TIMEOUT_MS, log = () => {} } = {}) {
    Object.assign(this, { host, WebSocketImpl, timeoutMs, log });
    this.sockets = {};
    this.status = null;
    this.running = false;
    this.chain = Promise.resolve();          // one command at a time, as robot_send blocks
  }

  async connect() {
    // From the https site Chrome asks for local network access first (see local_network.js)
    const lna = needsLocalNetwork(this.host);
    let firstTimeout = this.timeoutMs;
    if (lna) {
      const state = await localNetworkState();
      if (state === 'denied') throw Object.assign(new Error('Local network access is blocked for this site.'), { blocked: true });
      if (state === 'prompt') { firstTimeout = Math.max(this.timeoutMs, PROMPT_TIMEOUT_MS); this.log(LOCAL_NETWORK_PROMPT); }
    }
    for (const name of SOCKETS) {
      const url = `ws://${this.host}/${name}`;
      let s;
      try { s = new Socket(url, this.WebSocketImpl); } catch (e) {
        this.close();
        throw Object.assign(new Error(`The browser blocked the connection to ${url}: ${e.message}`), { blocked: true });
      }
      this.sockets[name] = s;
      if (s.blocked) {
        this.close();
        throw Object.assign(new Error(`The browser blocked the connection to ${url} (an https page may not open ws:// connections).`), { blocked: true });
      }
      const t0 = Date.now();
      try { await s.open(name === SOCKETS[0] ? firstTimeout : this.timeoutMs); } catch (e) {
        this.close();
        if (lna && Date.now() - t0 < 1500 && (await localNetworkState()) !== 'granted') {
          throw Object.assign(new Error(`The browser blocked the connection to ${url} (local network access).`), { blocked: true });
        }
        throw new Error(`Could not connect to ${url} (reason: ${e.message}). Verify that "${this.host}" is the correct IP/hostname of the AIM robot and that it is connected to the same network (AP mode is 192.168.4.1)`);
      }
    }
    this.running = true;
    this.statusLoop();
    await this.send({ cmd_id: 'program_init' });
    // Robot() waits for the first status packet before it returns
    const t0 = Date.now();
    while (!this.status) {
      if (Date.now() - t0 > this.timeoutMs) { this.close(); throw new Error('The robot accepted the connection but sent no status.'); }
      await sleep(STATUS_INTERVAL_MS);
    }
  }

  async statusLoop() {
    const s = this.sockets.ws_status;
    let lost = 0;
    while (this.running && !s.closed) {
      try {
        s.send(Uint8Array.of(1));
        this.status = JSON.parse(await s.recv(this.timeoutMs));
        lost = 0;
      } catch {
        if (++lost > 5) this.status = null;
      }
      await sleep(STATUS_INTERVAL_MS);
    }
  }

  get connected() { return this.running && !this.sockets.ws_cmd?.closed; }

  // robot_send: queued so replies pair with their commands
  send(cmd) {
    const run = async () => {
      const s = this.sockets.ws_cmd;
      if (!s || s.closed) throw new DisconnectedError(`error calling ${cmd.cmd_id}: not connected to robot`);
      s.send(new TextEncoder().encode(JSON.stringify(cmd)));
      let reply;
      try { reply = await s.recv(this.timeoutMs); } catch {
        throw new DisconnectedError(`robot got disconnected after sending cmd_id: ${cmd.cmd_id}`);
      }
      let r;
      try { r = JSON.parse(reply); } catch (e) { this.log(`${cmd.cmd_id} Error: could not parse ws_cmd JSON response: '${e.message}'`); return null; }
      if (r.cmd_id === 'cmd_unknown') this.log(`robot: did not recognize command: ${cmd.cmd_id}`);
      else if (r.status === 'error') this.log(`robot: error processing command, reason: ${r.error_info ?? 'no reason given'}`);
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  // move_for(distance, angle) at the default speeds, without waiting
  moveFor(distance, angle) {
    let velocity = DRIVE_SPEED;
    if (velocity < 0) { velocity = -velocity; distance = -distance; }
    return this.send({ cmd_id: 'drive_for', distance, angle, final_heading: 0, drive_speed: velocity, turn_speed: TURN_SPEED, stacking_type: 0 });
  }

  // turn_for(direction, angle) at the default turn speed, without waiting
  turnFor(direction, angle) {
    if (direction === TurnType.LEFT) angle = -angle;
    return this.send({ cmd_id: 'turn_for', angle, turn_rate: TURN_SPEED, stacking_type: 0 });
  }

  kick(kickType) { return this.send({ cmd_id: kickType }); }

  // move_at(0, 0) then turn(RIGHT, 0)
  async stopAllMovement() {
    await this.send({ cmd_id: 'drive', angle: 0, speed: 0, stacking_type: 0 });
    await this.send({ cmd_id: 'turn', turn_rate: 0, stacking_type: 0 });
  }

  close() {
    this.running = false;
    for (const s of Object.values(this.sockets)) s.close();
    this.sockets = {};
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
