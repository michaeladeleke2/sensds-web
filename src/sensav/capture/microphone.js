// The microphone (app/capture/microphone.py MicrophoneController): raw sound
// (no echo cancellation, noise suppression or gain control), at 16 kHz when
// the browser allows it, otherwise at the device rate through SensAV's
// resampler. Blocks of 50 ms feed the live mel spectrogram, a level meter, the
// last 5 seconds kept for predictions, and recording: every full second
// becomes one 16-bit WAV clip.
// States: off, starting, live, error. Events: 'state', 'problem', 'columns'
// ({ data, cols }), 'level' (0..1), 'clipProgress' (0..1), 'sampleSaved'
// (classId, fileName, blob), 'recordingFinished' (classId, count).

import { Emitter } from '../app/emitter.js';
import { SAMPLE_RATE, CLIP_SAMPLES, Resampler, StreamingMel, encodeWav } from '../ml/audio_features.js';
import { newSampleId } from '../storage/project.js';
import { saveInto } from '../storage/fs.js';

const BLOCK_SECONDS = 0.05;
const HISTORY_SECONDS = 5;
const SILENCE_CHECK_MS = 2000;
const LEVEL_INTERVAL_MS = 50;
const STALE_AUDIO_MS = 500;

// The audio worklet that copies the microphone's samples (first channel) to
// the page in 128-sample blocks. Kept in this file and loaded from a blob, so
// starting the microphone needs no download (the robot's WiFi has no internet).
const WORKLET_SOURCE = `
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('sensav-mic-tap', MicTap);
`;
let workletUrl = null;
const workletModule = () => (workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' })));

export async function listMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, name: d.label || `Microphone ${i + 1}` }));
  } catch { return []; }
}

export class MicrophoneController extends Emitter {
  constructor() {
    super();
    this.state = 'off';
    this.deviceId = null;
    this.sampleRate = 0;
    this.lastProblem = null;
    this.recording = null;
    this.clip = new Float32Array(0);
    this.history = new Float32Array(HISTORY_SECONDS * SAMPLE_RATE);
    this.historyTime = 0;
    this.run = 0;
    this.saving = Promise.resolve();
  }

  get isLive() { return this.state === 'live'; }
  setState(s) { if (s !== this.state) { this.state = s; this.emit('state', s); } }

  async start(deviceId = null) {
    if ((this.state === 'live' || this.state === 'starting') && deviceId === this.deviceId) return;
    this.stop();
    const run = ++this.run;
    this.deviceId = deviceId;
    this.lastProblem = null;
    this.setState('starting');
    try {
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (deviceId) audio.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      if (run !== this.run) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      let ctx;
      try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE }); } catch { ctx = new AudioContext(); }
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletModule());
      if (run !== this.run) { this.teardown(); return; }
      const source = ctx.createMediaStreamSource(stream);
      const tap = new AudioWorkletNode(ctx, 'sensav-mic-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
      source.connect(tap);
      this.sampleRate = ctx.sampleRate;
      const resampler = new Resampler(ctx.sampleRate, SAMPLE_RATE), mel = new StreamingMel();
      const blockLen = Math.round(ctx.sampleRate * BLOCK_SECONDS);
      let block = new Float32Array(blockLen), fill = 0, heard = false, silenceReported = false, lastLevel = 0;
      const started = performance.now();
      tap.port.onmessage = ({ data }) => {
        if (run !== this.run) return;
        for (let i = 0; i < data.length; i++) {
          block[fill++] = data[i];
          if (fill === blockLen) {
            const samples = resampler.process(block);
            block = new Float32Array(blockLen); fill = 0;
            if (!samples.length) continue;
            if (!heard && samples.some(v => v !== 0)) heard = true;
            if (!heard && !silenceReported && performance.now() - started > SILENCE_CHECK_MS) {
              silenceReported = true;
              this.report('silent', 'The microphone is on but no sound is coming in. Check that it is not muted, or choose a different microphone.', false);
            }
            this.pushHistory(samples);
            const cols = mel.push(samples);
            if (cols.cols) this.emit('columns', cols);
            const now = performance.now();
            if (now - lastLevel >= LEVEL_INTERVAL_MS) {
              lastLevel = now;
              let s = 0; for (const v of samples) s += v * v;
              const rms = Math.sqrt(s / samples.length) + 1e-10;
              this.emit('level', Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)));
            }
            this.record(samples);
          }
        }
      };
      stream.getAudioTracks()[0].addEventListener('ended', () => {
        if (run !== this.run) return;
        this.stop();
        this.report('lost', 'The microphone stopped sending sound. It may have been unplugged or disconnected.');
      });
      this.setState('live');
    } catch (e) {
      if (run !== this.run) return;
      this.teardown();
      const kind = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'permission_denied' : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'no_microphone' : 'open_failed';
      this.report(kind, {
        permission_denied: 'Microphone access is blocked for this site. Click the microphone icon in the address bar, allow the microphone, then try again.',
        no_microphone: 'No microphone found. Connect a microphone or choose a different one, then try again.',
        open_failed: 'The microphone could not be opened. Choose a different microphone or try again.',
      }[kind]);
    }
  }

  report(kind, message, fatal = true) {
    if (fatal) { this.lastProblem = [kind, message]; this.setState('error'); }
    this.emit('problem', kind, message);
  }

  pushHistory(samples) {
    const h = this.history, n = samples.length;
    if (n >= h.length) h.set(samples.subarray(n - h.length));
    else { h.copyWithin(0, n); h.set(samples, h.length - n); }
    this.historyTime = performance.now();
  }

  // The last `seconds` of sound, or null when the microphone is not live
  recentAudio(seconds = 1) {
    if (!this.isLive || performance.now() - this.historyTime > STALE_AUDIO_MS) return null;
    return this.history.slice(this.history.length - Math.round(seconds * SAMPLE_RATE));
  }

  // folder(): the class folder, looked up again for every sample, so a class
  // renamed or a folder changed while recording still gets its samples
  startRecording(classId, folder, limit = null) {
    if (!this.isLive) return false;
    this.recording = { classId, folder, limit, count: 0 };
    this.clip = new Float32Array(0);
    return true;
  }

  stopRecording() {
    const r = this.recording;
    this.recording = null;
    this.clip = new Float32Array(0);
    return r ? r.count : 0;
  }

  record(samples) {
    const r = this.recording;
    if (!r) return;
    let clip = new Float32Array(this.clip.length + samples.length);
    clip.set(this.clip); clip.set(samples, this.clip.length);
    while (clip.length >= CLIP_SAMPLES) {
      if (r.limit !== null && r.count >= r.limit) break;
      const audio = clip.slice(0, CLIP_SAMPLES);
      clip = clip.slice(CLIP_SAMPLES);
      r.count += 1;
      const count = r.count, name = `${newSampleId()}.wav`;
      const finished = r.limit !== null && count >= r.limit;
      if (finished && this.recording === r) { this.recording = null; clip = new Float32Array(0); }
      this.saving = this.saving.then(async () => {
        try {
          const blob = new Blob([encodeWav(audio)], { type: 'audio/wav' });
          await saveInto(r.folder, name, blob);
          this.emit('sampleSaved', r.classId, name, blob);
          if (finished) this.emit('recordingFinished', r.classId, count);
        } catch (e) {
          if (this.recording === r) this.recording = null;
          this.report('save_failed', String(e.message || e), false);
        }
      });
      if (finished) break;
    }
    this.clip = clip;
    if (this.recording === r) this.emit('clipProgress', this.clip.length / CLIP_SAMPLES);
  }

  teardown() {
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.ctx?.close().catch(() => {}); this.ctx = null;
  }

  stop() {
    this.run++;
    this.stopRecording();
    this.teardown();
    if (this.state !== 'error') this.setState('off');
  }
}
