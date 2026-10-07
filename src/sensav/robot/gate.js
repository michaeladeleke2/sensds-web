// SensAV's safety gate (app/robot/gate.py), between predictions and the robot:
//   - below the confidence threshold, the robot stops right away;
//   - a class must be the top prediction `smoothing` times in a row before its
//     move is sent ("No Action" keeps the current move);
//   - a command is only sent when it changes, at most once every 0.3 s, except
//     Stop, which is never delayed; a held-back command goes out on flush().

export const MIN_COMMAND_INTERVAL_S = 0.3;

export class CommandGate {
  // clock() returns seconds
  constructor(threshold = 0.5, smoothing = 3, minIntervalS = MIN_COMMAND_INTERVAL_S, clock = () => performance.now() / 1000) {
    this.threshold = threshold;
    this.smoothing = Math.max(1, smoothing);
    this.minIntervalS = minIntervalS;
    this.clock = clock;
    this.reset();
  }

  reset() {
    this.current = null;
    this.streakClass = null;
    this.streak = 0;
    this.lastSent = -Infinity;
    this.pending = null;
  }

  // Returns a decision { action, reason, classId, confidence } to send now, or null
  update(classId, confidence, actionForClass) {
    if (confidence < this.threshold) {
      this.streakClass = null; this.streak = 0;
      return this.propose({ action: 'stop', reason: 'not_sure', classId, confidence });
    }
    if (classId === this.streakClass) this.streak += 1;
    else { this.streakClass = classId; this.streak = 1; }
    if (this.streak < this.smoothing) return null;
    const action = actionForClass(classId);
    if (action === 'no_action') { this.pending = null; return null; }
    return this.propose({ action, reason: 'prediction', classId, confidence });
  }

  forceStop(reason) {
    this.streakClass = null; this.streak = 0;
    return this.propose({ action: 'stop', reason, classId: null, confidence: null });
  }

  flush() {
    if (this.pending === null || this.clock() - this.lastSent < this.minIntervalS) return null;
    const d = this.pending;
    this.pending = null;
    return this.send(d);
  }

  propose(d) {
    if (d.action === this.current) { this.pending = null; return null; }
    if (d.action !== 'stop' && this.clock() - this.lastSent < this.minIntervalS) { this.pending = d; return null; }
    this.pending = null;
    return this.send(d);
  }

  send(d) {
    this.current = d.action;
    this.lastSent = this.clock();
    return d;
  }
}
