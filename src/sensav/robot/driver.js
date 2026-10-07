// Driving with the model (app/robot/driver.py): live predictions go through
// the safety gate, and what comes out is sent to the robot (or only shown, in
// practice mode with no robot connected). A 100 ms timer sends a held-back
// command once the rate limit allows and stops the robot when predictions stop
// arriving for max(1 s, 4 prediction intervals). Driving stops, and the robot
// with it, when predictions stop or fail and when the connection drops.
// Events: 'active' (bool), 'decision' ({ action, reason, classId, className,
// confidence, sent, timestamp }).

import { Emitter } from '../app/emitter.js';
import { CommandGate } from './gate.js';
import { ACTIONS_BY_KEY, DEFAULT_ACTION } from './actions.js';

export const WATCHDOG_MIN_S = 1.0;
export const WATCHDOG_INTERVALS = 4;

export class RobotDriver extends Emitter {
  // deps: { link, inference, getProject(), predictionInterval(mode) seconds,
  //         log(event, data), now() seconds }
  constructor(deps) {
    super();
    this.d = { now: () => performance.now() / 1000, log: () => {}, ...deps };
    this.gate = new CommandGate();
    this.active = false;
    this.mode = 'image';
    this.lastPrediction = 0;
    this.started = 0;
    this.timer = null;
    const { inference, link } = this.d;
    inference.on('prediction', p => this.onPrediction(p));
    inference.on('failed', () => this.stop('prediction_failed'));
    inference.on('state', s => { if (this.active && (s === 'off' || s === 'error')) this.stop('prediction_stopped'); });
    link.on('state', s => {
      if (s === 'lost' && this.active) this.stop('connection_lost');
      else if (s === 'connected') this.gate.reset();
    });
  }

  speed() { return this.d.getProject()?.robot.speed ?? 'medium'; }

  // startInference is called by the page with the right source
  start(startInference) {
    const project = this.d.getProject();
    if (!project) throw new Error('Open or create a project first.');
    this.mode = project.robot.source;
    this.gate = new CommandGate(project.robot.confidence_threshold, project.robot.smoothing_count, undefined, this.d.now);
    startInference(this.mode);
    this.active = true;
    this.started = this.lastPrediction = this.d.now();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 100);
    this.d.log('driving_started', {
      source: this.mode, robot_connected: this.d.link.isConnected, threshold: project.robot.confidence_threshold,
      smoothing: project.robot.smoothing_count, speed: project.robot.speed,
    });
    this.emit('active', true);
  }

  stop(reason, sendStop = true) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer); this.timer = null;
    this.gate.forceStop(reason);
    if (sendStop) this.execute({ action: 'stop', reason, classId: null, confidence: null });
    if (this.d.inference.purpose === 'robot') this.d.inference.stop();
    this.d.log('driving_stopped', { reason, duration_s: Math.round((this.d.now() - this.started) * 100) / 100 });
    this.emit('active', false);
  }

  emergencyStop() {
    const sent = this.d.link.send('stop', this.speed());
    this.d.log('emergency_stop', { robot_connected: this.d.link.isConnected, sent, driving: this.active });
    this.publish({ action: 'stop', reason: 'emergency', classId: null, confidence: null }, sent);
    if (this.active) this.stop('emergency', false);
  }

  updateSettings(threshold, smoothing) { this.gate.threshold = threshold; this.gate.smoothing = Math.max(1, smoothing); }

  actionFor(classId) {
    const project = this.d.getProject();
    const cls = project?.classes(this.mode).find(c => c.id === classId);
    return cls && ACTIONS_BY_KEY[cls.robot_action] ? cls.robot_action : DEFAULT_ACTION;
  }

  onPrediction(p) {
    if (!this.active || this.d.inference.purpose !== 'robot' || p.mode !== this.mode) return;
    this.lastPrediction = this.d.now();
    const decision = this.gate.update(p.classId, p.confidence, id => this.actionFor(id));
    if (decision) this.execute(decision);
  }

  tick() {
    if (!this.active) return;
    const limit = Math.max(WATCHDOG_MIN_S, WATCHDOG_INTERVALS * this.d.predictionInterval(this.mode));
    if (this.d.inference.state === 'running' && this.d.now() - this.lastPrediction > limit) {
      const decision = this.gate.forceStop('no_predictions');
      if (decision) this.execute(decision);
      return;
    }
    const decision = this.gate.flush();
    if (decision) this.execute(decision);
  }

  execute(decision) { this.publish(decision, this.d.link.send(decision.action, this.speed())); }

  publish(decision, sent) {
    let className = null;
    if (decision.classId !== null) className = this.d.getProject()?.classes(this.mode).find(c => c.id === decision.classId)?.name ?? null;
    this.d.log('robot_command', {
      action: decision.action, reason: decision.reason, class_id: decision.classId, class_name: className,
      confidence: decision.confidence === null ? null : Math.round(decision.confidence * 1e4) / 1e4, sent, source: this.mode,
    });
    this.emit('decision', { ...decision, className, sent, timestamp: Date.now() / 1000 });
  }
}
