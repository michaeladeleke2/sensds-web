// The camera (app/capture/camera.py CameraController): a getUserMedia video
// stream, mirrored like the desktop (cv2.flip), shown as a live preview with
// the saved square outlined. While recording, one sample every 0.1 s: the
// centre square, INTER_AREA to 224x224, saved as a JPEG (quality 90).
// States: off, starting, live, error. Events: 'state', 'problem' (kind,
// message), 'sampleSaved' (classId, fileName, blob), 'recordingFinished'
// (classId, count), 'frame' (canvas source for previews).

import { Emitter } from '../app/emitter.js';
import { squareSampleRgbaToRgb, SAMPLE_SIZE } from '../ml/image_ops.js';
import { newSampleId } from '../storage/project.js';
import { saveInto } from '../storage/fs.js';

export const SAMPLE_INTERVAL_S = 0.1;
export const JPEG_QUALITY = 0.9;
const STALE_FRAME_MS = 500;

export async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, name: d.label || `Camera ${i + 1}` }));
  } catch { return []; }
}

export class CameraController extends Emitter {
  constructor() {
    super();
    this.state = 'off';
    this.video = document.createElement('video');
    Object.assign(this.video, { muted: true, playsInline: true, autoplay: true });
    this.stream = null;
    this.deviceId = null;
    this.recording = null;
    this.lastProblem = null;
    this.grab = document.createElement('canvas');
    this.grabCtx = this.grab.getContext('2d', { willReadFrequently: true });
    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = this.sampleCanvas.height = SAMPLE_SIZE;
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
      const video = { width: { ideal: 640 }, height: { ideal: 480 } };
      if (deviceId) video.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      if (run !== this.run) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => { if (run === this.run) this.lost(); });
      this.video.srcObject = stream;
      await this.video.play().catch(() => {});
      await new Promise(r => (this.video.readyState >= 2 ? r() : this.video.addEventListener('loadeddata', r, { once: true })));
      if (run !== this.run) return;
      this.setState('live');
      this.loop(run);
    } catch (e) {
      if (run !== this.run) return;
      this.stopTracks();
      const kind = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'permission_denied'
        : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'no_camera' : 'open_failed';
      const message = {
        permission_denied: 'Camera access is blocked for this site. Click the camera icon in the address bar, allow the camera, then try again.',
        no_camera: 'No camera found. Connect a camera or choose a different one, then try again.',
        open_failed: 'The camera could not be opened. Close other apps that might be using it, such as Teams or Zoom, then try again.',
      }[kind];
      this.report(kind, message);
    }
  }

  lost() {
    this.stop();
    this.report('lost', 'The camera stopped sending pictures. It may have been unplugged or used by another app.');
  }

  report(kind, message, fatal = true) {
    if (fatal) { this.lastProblem = [kind, message]; this.setState('error'); }
    this.emit('problem', kind, message);
  }

  stopTracks() { this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; this.video.srcObject = null; }

  stop() {
    this.run++;
    this.stopRecording();
    this.stopTracks();
    if (this.state !== 'error') this.setState('off');
  }

  loop(run) {
    const tick = () => {
      if (run !== this.run) return;
      const now = performance.now() / 1000;
      const r = this.recording;
      if (r && now >= r.nextTime) this.saveSample(r, now);
      this.emit('frame', this.video);
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    tick();
  }

  // The current frame, mirrored, as RGBA pixels
  frameRgba() {
    const v = this.video, w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) return null;
    if (this.grab.width !== w || this.grab.height !== h) { this.grab.width = w; this.grab.height = h; }
    const ctx = this.grabCtx;
    ctx.setTransform(-1, 0, 0, 1, w, 0);
    ctx.drawImage(v, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  }

  // Newest frame for predictions (the worker mirrors and crops it)
  async latestFrame() {
    if (!this.isLive || this.video.readyState < 2) return null;
    try { return await createImageBitmap(this.video); } catch { return null; }
  }

  // folder(): the class folder, looked up again for every sample, so a class
  // renamed or a folder changed while recording still gets its samples
  startRecording(classId, folder, limit = null) {
    if (!this.isLive) return false;
    this.recording = { classId, folder, limit, count: 0, nextTime: 0, started: performance.now() };
    return true;
  }

  stopRecording() {
    const r = this.recording;
    this.recording = null;
    return r ? r.count : 0;
  }

  saveSample(r, now) {
    const onSchedule = r.nextTime > 0 && now - r.nextTime < SAMPLE_INTERVAL_S;
    r.nextTime = (onSchedule ? r.nextTime : now) + SAMPLE_INTERVAL_S;
    const frame = this.frameRgba();
    if (!frame) return;
    const rgb = squareSampleRgbaToRgb(frame.data, frame.width, frame.height);
    const rgba = new Uint8ClampedArray(SAMPLE_SIZE * SAMPLE_SIZE * 4);
    for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) { rgba[i] = rgb[j]; rgba[i + 1] = rgb[j + 1]; rgba[i + 2] = rgb[j + 2]; rgba[i + 3] = 255; }
    this.sampleCanvas.getContext('2d').putImageData(new ImageData(rgba, SAMPLE_SIZE, SAMPLE_SIZE), 0, 0);
    const name = `${newSampleId()}.jpg`;
    r.count += 1;
    const count = r.count;
    if (r.limit !== null && count >= r.limit && this.recording === r) this.recording = null;
    this.saving = this.saving.then(async () => {
      try {
        const blob = await new Promise(res => this.sampleCanvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
        await saveInto(r.folder, name, blob);
        this.emit('sampleSaved', r.classId, name, blob);
        if (r.limit !== null && count >= r.limit) this.emit('recordingFinished', r.classId, count);
      } catch (e) {
        if (this.recording === r) this.recording = null;
        this.report('save_failed', String(e.message || e), false);
      }
    });
  }
}
