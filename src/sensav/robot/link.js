// The robot connection (app/robot/link.py): two of the VEX AIM robot's
// WebSockets, ws://<host>/ws_cmd for commands and ws://<host>/ws_status for
// status, each command a compact JSON binary frame answered by one reply.
// program_init is sent after connecting; the battery is read every 0.5 s;
// moves are queued and Stop jumps the queue; Stop is sent before closing.
// Events: 'state' (disconnected, connecting, connected, lost), 'battery',
// 'command' (action, ms), 'problem' (kind, message).
//
// The host "simulated" is a pretend robot inside the page that records what
// it is sent, as on the desktop.

import { Emitter } from '../app/emitter.js';
import { actionMessages, programInit, stopMessages } from './protocol.js';

export const FAKE_HOST = 'simulated';
const CONNECT_TIMEOUT_MS = 4000;
const IO_TIMEOUT_MS = 2000;
const STATUS_INTERVAL_MS = 500;

export const simulatedRobot = {
  messages: [], reachable: true, dropConnection: false, battery: 87,
  reset() { this.messages = []; this.reachable = true; this.dropConnection = false; },
};

export const isSimulated = host => host.trim().toLowerCase() === FAKE_HOST;

class SimulatedSocket {
  constructor(channel) { this.channel = channel; this.reply = '{}'; this.closed = false; }
  async open() { if (!simulatedRobot.reachable) throw new Error('simulated robot is off'); }
  send(payload) {
    if (simulatedRobot.dropConnection) throw new Error('simulated robot went away');
    if (this.channel === 'cmd') {
      const message = JSON.parse(new TextDecoder().decode(payload));
      simulatedRobot.messages.push(message);
      this.reply = JSON.stringify({ cmd_id: message.cmd_id, status: 'complete' });
    } else this.reply = JSON.stringify({ robot: { battery: simulatedRobot.battery } });
  }
  async recv() {
    if (simulatedRobot.dropConnection) throw new Error('simulated robot went away');
    await new Promise(r => setTimeout(r, 5));
    return this.reply;
  }
  close() { this.closed = true; }
}

export class BlockedError extends Error {}

class Socket {
  constructor(url, WebSocketImpl) {
    this.url = url; this.queue = []; this.waiters = []; this.closed = false;
    try { this.ws = new WebSocketImpl(url); } catch (e) { throw new BlockedError(e.message); }
    this.ws.binaryType = 'arraybuffer';
    // Chrome returns an already-closed socket when an https page may not reach the address
    if (this.ws.readyState === 3) throw new BlockedError('closed at once');
    this.ws.onmessage = e => {
      const data = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
      const w = this.waiters.shift();
      if (w) w.resolve(data); else this.queue.push(data);
    };
    this.ws.onclose = () => { this.closed = true; for (const w of this.waiters.splice(0)) w.reject(new Error('connection closed')); };
  }
  open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('timed out')); try { this.ws.close(); } catch { /* closed */ } }, timeoutMs);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('connection refused')); };
    });
  }
  send(payload) {
    if (this.closed || this.ws.readyState !== 1) throw new Error('connection closed');
    this.ws.send(payload);
  }
  recv(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error('connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error('timed out')); }, timeoutMs);
      const w = { resolve: d => { clearTimeout(timer); resolve(d); }, reject: e => { clearTimeout(timer); reject(e); } };
      this.waiters.push(w);
    });
  }
  close() { this.closed = true; try { this.ws.close(); } catch { /* closed */ } }
}

async function exchange(sock, message) {
  sock.send(new TextEncoder().encode(JSON.stringify(message)));
  const reply = await sock.recv(IO_TIMEOUT_MS);
  try {
    const parsed = JSON.parse(reply);
    if (parsed && parsed.status === 'error') console.warn(`Robot rejected ${message.cmd_id}: ${parsed.error_info ?? 'no reason given'}`);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

class Worker {
  constructor(host, WebSocketImpl, link) {
    this.host = host; this.WebSocketImpl = WebSocketImpl; this.link = link;
    this.pending = []; this.stopRequested = false; this.stopOnClose = true; this.wake = null;
  }
  enqueue(action, speed, priority) {
    if (priority) this.pending.length = 0;
    this.pending.push([action, speed]);
    this.wake?.();
  }
  requestClose(sendStop) { this.stopOnClose = sendStop; this.stopRequested = true; this.wake?.(); }
  openSocket(channel) {
    if (isSimulated(this.host)) return new SimulatedSocket(channel);
    return new Socket(`ws://${this.host}/ws_${channel}`, this.WebSocketImpl);
  }
  async run() {
    const sockets = [];
    let lost = false, cmd, status;
    try {
      try {
        cmd = this.openSocket('cmd'); sockets.push(cmd); await cmd.open(CONNECT_TIMEOUT_MS);
        status = this.openSocket('status'); sockets.push(status); await status.open(CONNECT_TIMEOUT_MS);
        await exchange(cmd, programInit());
      } catch (e) {
        this.link._failed(this, e);
        return;
      }
      if (this.stopRequested) return;
      this.link._connected(this);
      let lastStatus = 0;
      try {
        while (!this.stopRequested) {
          if (!this.pending.length) await new Promise(r => { const t = setTimeout(r, 100); this.wake = () => { clearTimeout(t); r(); }; });
          this.wake = null;
          while (this.pending.length && !this.stopRequested) {
            const [action, speed] = this.pending.shift();
            const started = performance.now();
            for (const m of actionMessages(action, speed)) await exchange(cmd, m);
            this.link._command(this, action, performance.now() - started);
          }
          if (performance.now() - lastStatus >= STATUS_INTERVAL_MS) {
            lastStatus = performance.now();
            status.send(Uint8Array.of(1));
            const s = JSON.parse(await status.recv(IO_TIMEOUT_MS));
            const level = s?.robot?.battery;
            if (typeof level === 'number') this.link._battery(this, Math.trunc(level));
          }
        }
      } catch (e) {
        lost = true;
        this.link._lost(this, e);
      }
      if (!lost && this.stopOnClose) {
        try { for (const m of stopMessages()) await exchange(cmd, m); } catch { /* the robot stops on its own */ }
      }
    } finally {
      for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
    }
  }
}

export class RobotLink extends Emitter {
  constructor({ WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.WebSocketImpl = WebSocketImpl;
    this.worker = null;
    this.state = 'disconnected';
    this.host = '';
    this.battery = null;
    this.lastProblem = null;
  }

  get isConnected() { return this.state === 'connected'; }

  connectTo(host) {
    host = host.trim();
    if (!host) return;
    this._retire(true);
    Object.assign(this, { host, battery: null, lastProblem: null });
    const w = this.worker = new Worker(host, this.WebSocketImpl, this);
    this._setState('connecting');
    this.emit('log', 'robot_connecting', { host, simulated: isSimulated(host) });
    w.done = w.run();
  }

  disconnect() {
    const was = this.state === 'connected' || this.state === 'connecting';
    this._retire(true);
    if (was) this.emit('log', 'robot_disconnected', { host: this.host });
    this._setState('disconnected');
  }

  // Returns whether the move was handed to the robot connection
  send(action, speed) {
    if (!this.worker || this.state !== 'connected') return false;
    this.worker.enqueue(action, speed, action === 'stop');
    return true;
  }

  // Resolves once the connection has sent its final stop and closed
  shutdown() { return this._retire(true); }

  _retire(sendStop) {
    const w = this.worker;
    this.worker = null;
    w?.requestClose(sendStop);
    return w?.done ?? Promise.resolve();
  }

  _setState(s) { if (s !== this.state) { this.state = s; this.emit('state', s); } }

  _connected(w) {
    if (w !== this.worker) return;
    this.emit('log', 'robot_connected', { host: this.host });
    this._setState('connected');
  }

  _failed(w, error) {
    if (w !== this.worker) return;
    this._retire(false);
    const blocked = error instanceof BlockedError;
    const message = blocked
      ? `The browser blocked the connection to ${this.host}. When Chrome asks to let this site find and connect to devices on your local network, choose Allow, then try again.`
      : `Robot not reachable at ${this.host}. Make sure the robot is turned on and this computer is connected to the robot's WiFi network, then try again.`;
    this.lastProblem = [blocked ? 'blocked' : 'unreachable', message];
    this.emit('log', 'robot_connection_failed', { host: this.host, detail: String(error?.message ?? error) });
    this._setState('disconnected');
    this.emit('problem', ...this.lastProblem);
  }

  _lost(w, error) {
    if (w !== this.worker) return;
    this._retire(false);
    const message = 'The connection to the robot dropped. The robot stops on its own when this happens. Reconnect to keep driving.';
    this.lastProblem = ['lost', message];
    this.emit('log', 'robot_connection_lost', { host: this.host, detail: String(error?.message ?? error) });
    this._setState('lost');
    this.emit('problem', 'lost', message);
  }

  _command(w, action, ms) { if (w === this.worker) this.emit('command', action, ms); }

  _battery(w, level) {
    if (w !== this.worker || level === this.battery) return;
    this.battery = level;
    this.emit('battery', level);
  }
}
