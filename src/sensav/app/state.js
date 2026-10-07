// What every tab shares (app/state.py AppState): the data folder, the open
// project and mode (image or audio), the camera and microphone, the embedding
// cache, training, live predictions, the robot connection and the driver,
// and the research log. Settings that the desktop keeps in settings.json are
// kept in this browser.
// Events: 'project', 'projectRenamed', 'mode', 'classes' (mode), 'samples'
// (mode, classId), 'sampleAdded' (mode, classId, name, blob),
// 'sampleRemoved' (mode, classId, name), 'status' (message, ms),
// 'projectDialog', 'model' (mode), 'folder'.

import { Emitter } from './emitter.js';
import * as fs from '../storage/fs.js';
import { MODES, Project, ProjectError, SAMPLE_SUFFIX, deleteProject, listProjects } from '../storage/project.js';
import { CameraController } from '../capture/camera.js';
import { MicrophoneController } from '../capture/microphone.js';
import { EmbeddingService } from '../ml/embedding_service.js';
import { TrainingController } from '../ml/training.js';
import { InferenceController } from '../ml/inference.js';
import { loadReport, modelStatus } from '../ml/model_store.js';
import { RobotLink } from '../robot/link.js';
import { RobotDriver } from '../robot/driver.js';
import { events } from '../logs/events.js';

const SETTINGS_KEY = 'sensav-web-settings';
export const DEFAULT_SETTINGS = {
  theme: 'light', last_project: null, robot_host: '192.168.4.1', camera_id: '', microphone_id: '',
  capture_countdown: 3, capture_burst_count: 30, image_predictions_per_second: 10, audio_hop_ms: 250, ask_participant: true,
};

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}

export class AppState extends Emitter {
  constructor() {
    super();
    this.settings = loadSettings();
    this.dataRoot = null;
    this.projectsRoot = null;
    this.project = null;
    this.mode = 'image';
    this.camera = new CameraController();
    this.microphone = new MicrophoneController();
    this.embeddings = new EmbeddingService();
    this.training = new TrainingController(this.embeddings);
    this.inference = new InferenceController();
    this.robot = new RobotLink();
    this.driver = new RobotDriver({
      link: this.robot, inference: this.inference, getProject: () => this.project,
      predictionInterval: mode => this.predictionInterval(mode), log: (e, d) => events.log(e, d),
    });
    this.reports = { image: undefined, audio: undefined };

    this.robot.on('log', (e, d) => events.log(e, d));
    this.microphone.on('state', s => events.log('microphone_state', s === 'live' ? { state: s, device: this.microphone.deviceId, sample_rate: this.microphone.sampleRate } : { state: s }));
    this.microphone.on('problem', (kind, message) => events.log('microphone_problem', { kind, message }));
    this.camera.on('state', s => events.log('camera_state', s === 'live' ? { state: s, device_id: this.camera.deviceId } : { state: s }));
    this.camera.on('problem', (kind, message) => events.log('camera_problem', { kind, message }));
    this.embeddings.on('error', message => events.log('error', { where: 'embeddings', message }));
    this.training.on('finished', r => this.onTrainingFinished(r));
    this.training.on('failed', message => events.log('training_failed', { mode: this.training.job?.mode ?? null, message }));
    this.training.on('cancelled', () => events.log('training_cancelled', { mode: this.training.job?.mode ?? null }));
  }

  saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* this visit only */ } }

  status(message, ms = 4000) { this.emit('status', message, ms); }

  // ---------- data folder ----------
  async setDataRoot(handle) {
    this.dataRoot = handle;
    this.projectsRoot = handle ? await fs.dir(handle, ['projects'], true) : null;
    await events.setFolder(handle);
    this.emit('folder', handle);
  }

  requireProject() {
    if (!this.project) throw new ProjectError('Open or create a project first.');
    return this.project;
  }

  ensureIdle() { if (this.training.busy) throw new ProjectError('Wait for training to finish first.'); }

  listProjects() { return this.projectsRoot ? listProjects(this.projectsRoot) : Promise.resolve([]); }

  async createProject(name) {
    this.ensureIdle();
    if (!this.projectsRoot) throw new ProjectError('Choose where SensAV keeps its data first.');
    const project = await Project.create(this.projectsRoot, name);
    events.log('project_created', { project: project.name, path: `projects/${project.folder}` });
    await this.setProject(project);
    this.status(`Created project “${project.name}”`);
    return project;
  }

  async openProject(folder) {
    this.ensureIdle();
    const project = await Project.load(this.projectsRoot, folder);
    events.log('project_opened', { project: project.name, path: `projects/${project.folder}` });
    await this.setProject(project);
    this.status(`Opened “${project.name}”`);
    return project;
  }

  async setProject(project) {
    this.stopCapture();
    this.project = project;
    this.mode = project.last_mode;
    this.reports = { image: undefined, audio: undefined };
    await Promise.all(MODES.map(m => this.refreshReport(m)));
    this.settings.last_project = project.folder;
    this.saveSettings();
    this.emit('project', project);
    this.emit('mode', this.mode);
    this.embeddings.setProject(project);
  }

  async saveProject() {
    const p = this.requireProject();
    await p.save();
    events.log('project_saved', { project: p.name });
    this.status('Project saved');
  }

  async renameProject(newName) {
    this.ensureIdle();
    const p = this.requireProject(), old = p.name;
    await this.embeddings.flush();
    await p.rename(newName);
    this.settings.last_project = p.folder; this.saveSettings();
    events.log('project_renamed', { old_name: old, new_name: p.name, path: `projects/${p.folder}` });
    this.emit('projectRenamed', p);
    this.status(`Renamed project to “${p.name}”`);
  }

  async deleteProject(folder) {
    this.ensureIdle();
    const isCurrent = this.project && this.project.folder === folder;
    if (isCurrent) { this.stopCapture(); this.project = null; await this.embeddings.setProject(null); }
    await deleteProject(this.projectsRoot, folder);
    events.log('project_deleted', { path: `projects/${folder}`, was_open: Boolean(isCurrent) });
    if (this.settings.last_project === folder) { this.settings.last_project = null; this.saveSettings(); }
    if (isCurrent) this.emit('project', null);
    this.status('Project deleted');
  }

  // ---------- models ----------
  async refreshReport(mode) {
    this.reports[mode] = this.project ? await loadReport(this.project, mode) : null;
    return this.reports[mode];
  }

  modelReport(mode = this.mode) { return this.reports[mode] ?? null; }
  modelStatus(mode = this.mode) { return this.project ? modelStatus(this.project, mode, this.modelReport(mode)) : 'none'; }

  missingEmbeddings(mode = this.mode) {
    if (!this.project) return 0;
    const available = this.embeddings.availableIds(mode);
    let n = 0;
    for (const c of this.project.classes(mode)) for (const name of this.project.sampleNames(mode, c.id)) if (!available.has(name.slice(0, -SAMPLE_SUFFIX[mode].length))) n++;
    return n;
  }

  startTraining() {
    const p = this.requireProject(), mode = this.mode, s = p.modes[mode].training;
    const classes = p.classes(mode).map(c => ({ id: c.id, name: c.name, color: c.color, sampleIds: p.sampleNames(mode, c.id).map(n => n.slice(0, -SAMPLE_SUFFIX[mode].length)) }));
    const ok = this.training.start({ project: p, mode, classes, epochs: s.epochs, batchSize: s.batch_size, learningRate: s.learning_rate });
    if (ok) events.log('training_started', { mode, epochs: s.epochs, batch_size: s.batch_size, learning_rate: s.learning_rate, classes: classes.map(c => ({ id: c.id, name: c.name, samples: c.sampleIds.length })) });
    return ok;
  }

  async onTrainingFinished(report) {
    events.log('training_finished', {
      mode: report.mode, duration_s: report.duration_s?.value ?? report.duration_s, val_accuracy: report.val_accuracy?.value ?? null,
      final_accuracy: report.final_accuracy?.value ?? null, final_loss: report.final_loss?.value ?? null,
      settings: { epochs: report.settings.epochs, batch_size: report.settings.batch_size, learning_rate: report.settings.learning_rate.value },
      class_names: report.classes.map(c => c.name), confusion_matrix: report.confusion,
    });
    const job = this.training.job;
    if (job && this.project === job.project) {
      await this.refreshReport(job.mode);
      this.emit('model', job.mode);
    }
  }

  // ---------- capture and predictions ----------
  predictionInterval(mode = this.mode) {
    return mode === 'image' ? 1 / Math.max(1, this.settings.image_predictions_per_second) : Math.max(0.05, this.settings.audio_hop_ms / 1000);
  }

  startInference(purpose, mode = this.mode) {
    const p = this.requireProject();
    const source = mode === 'image' ? () => this.camera.latestFrame() : () => Promise.resolve(this.microphone.recentAudio(1.0));
    this.inference.start(p, mode, source, this.predictionInterval(mode), purpose);
  }

  stopCapture() {
    this.inference.stop();
    this.camera.stop();
    this.microphone.stop();
  }

  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.mode || this.training.busy) return;
    const previous = this.mode;
    this.mode = mode;
    if (this.project) { this.project.last_mode = mode; this.project.save(); }
    events.log('mode_switched', { from_mode: previous, to_mode: mode });
    this.emit('mode', mode);
  }

  // ---------- classes and samples ----------
  async addClass(name = null) {
    const p = this.requireProject();
    const cls = await p.addClass(this.mode, name || p.suggestClassName(this.mode));
    events.log('class_created', { mode: this.mode, class_id: cls.id, class_name: cls.name, color: cls.color });
    this.emit('classes', this.mode);
    return cls;
  }

  async renameClass(id, newName) {
    const p = this.requireProject(), old = p.getClass(this.mode, id).name;
    const cls = await p.renameClass(this.mode, id, newName);
    if (old !== cls.name) {
      events.log('class_renamed', { mode: this.mode, class_id: id, old_name: old, new_name: cls.name });
      this.emit('classes', this.mode);
    }
    return cls;
  }

  async deleteClass(id) {
    const p = this.requireProject(), count = p.sampleCount(this.mode, id), ids = p.sampleNames(this.mode, id).map(n => n.slice(0, -4));
    const cls = await p.deleteClass(this.mode, id);
    this.embeddings.remove(this.mode, ids);
    events.log('class_deleted', { mode: this.mode, class_id: id, class_name: cls.name, samples_deleted: count });
    this.emit('classes', this.mode);
    this.status(`Deleted “${cls.name}” and its ${count} samples`);
  }

  async updateClass(id, changes) {
    const cls = await this.requireProject().updateClass(this.mode, id, changes);
    events.log('class_updated', { mode: this.mode, class_id: id, ...changes });
    return cls;
  }

  sampleCaptured(mode, classId, name, blob) {
    const p = this.project;
    if (!p) return;
    p.noteSampleAdded(mode, classId, name);
    const cls = p.classes(mode).find(c => c.id === classId);
    if (cls) this.embeddings.add(mode, cls, name, blob);
    this.emit('sampleAdded', mode, classId, name, blob);
    this.emit('samples', mode, classId);
  }

  async deleteSample(mode, classId, name) {
    const p = this.requireProject(), cls = p.getClass(mode, classId);
    if (!name.endsWith(SAMPLE_SUFFIX[mode])) throw new ProjectError('That sample does not belong to this class.');
    try { await fs.remove(await p.classDir(mode, cls), name); } catch (e) { throw new ProjectError(`Could not delete the sample: ${e.message}`); }
    p.noteSampleRemoved(mode, classId, name);
    this.embeddings.remove(mode, [name.slice(0, -4)]);
    events.log('sample_deleted', { mode, class_id: classId, class_name: cls.name, sample_id: name.slice(0, -4), remaining: p.sampleCount(mode, classId) });
    this.emit('sampleRemoved', mode, classId, name);
    this.emit('samples', mode, classId);
  }

  async updateRobotSettings(changes) {
    const p = this.requireProject(), applied = {};
    for (const [k, v] of Object.entries(changes)) {
      if (!(k in p.robot)) throw new ProjectError(`Unknown robot setting ${k}.`);
      if (p.robot[k] !== v) { p.robot[k] = v; applied[k] = v; }
    }
    if (Object.keys(applied).length) { await p.save(); events.log('robot_settings_changed', applied); }
  }

  async setClassAction(mode, classId, action) {
    const p = this.requireProject(), cls = p.getClass(mode, classId);
    if (cls.robot_action === action) return;
    const previous = cls.robot_action;
    await p.updateClass(mode, classId, { robot_action: action });
    events.log('robot_mapping_changed', { mode, class_id: classId, class_name: cls.name, from_action: previous, to_action: action });
  }

  setRobotHost(host) {
    host = host.trim();
    if (host && host !== this.settings.robot_host) { this.settings.robot_host = host; this.saveSettings(); events.log('robot_host_changed', { host }); }
  }
}
