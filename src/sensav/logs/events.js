// SensAV's research log (app/logs/events.py): one JSON Lines file per session
// in <data folder>/logs/events/session_<id>.jsonl, every entry stamped with
// the time, session id and the optional anonymous participant id. Entries are
// queued and written every two seconds, so logging never slows predictions.

import * as fs from '../storage/fs.js';
import { nowIso } from '../storage/project.js';
import { pyJsonLine } from './pyrepr.js';

const FLUSH_MS = 2000;
const FLOAT_KEYS = new Set(['confidence', 'latency_ms', 'duration_s', 'interval_s', 'val_accuracy', 'final_accuracy', 'final_loss', 'threshold', 'confidence_threshold', 'learning_rate']);

class EventLog {
  constructor() {
    this.queue = [];
    this.dir = null;
    this.fileName = null;
    this.sessionId = '';
    this.participantId = null;
    this.timer = null;
    this.writing = Promise.resolve();
    this.started = false;
  }

  get path() { return this.fileName ? `logs/events/${this.fileName}` : null; }

  start() {
    if (this.started) return;
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(3)), b => b.toString(16).padStart(2, '0')).join('');
    this.sessionId = `${stamp}_${hex}`;
    this.fileName = `session_${this.sessionId}.jsonl`;
    this.started = true;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    addEventListener('pagehide', () => this.flush());
  }

  // Where the file goes; entries logged before this wait in memory
  async setFolder(dataRoot) {
    this.dir = dataRoot ? await fs.dir(dataRoot, ['logs', 'events'], true) : null;
    await this.flush();
  }

  setParticipant(id) {
    this.participantId = id || null;
    this.log('participant_set', { participant_id: this.participantId });
  }

  log(event, data = {}) {
    if (!this.started) return;
    this.queue.push(pyJsonLine({ ts: nowIso(true), session_id: this.sessionId, participant_id: this.participantId, event, ...data }, FLOAT_KEYS) + '\n');
  }

  flush() {
    if (!this.dir || !this.queue.length) return this.writing;
    const text = this.queue.join('');
    this.queue = [];
    const dir = this.dir, name = this.fileName;
    this.writing = this.writing.then(() => fs.appendFile(dir, name, text)).catch(e => console.warn('Could not write the research log', e));
    return this.writing;
  }
}

export const events = new EventLog();
