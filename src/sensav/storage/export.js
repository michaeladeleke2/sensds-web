// The CSV exports on the Data tab (app/storage/export.py), for CODAP:
//   image samples: brightness and mean colour, plus two PCA components
//   audio clips:   loudness (dB and RMS), peak frequency, spectral centroid, PCA
//   test and robot sessions, and the whole event log, from logs/events/.
// Written as UTF-8 with a byte order mark and \r\n line ends, like Python's
// csv module with encoding="utf-8-sig".

import * as fs from './fs.js';
import { pyRepr } from '../logs/pyrepr.js';
import { pyJsonLine } from '../logs/pyrepr.js';
import { pcaTwo, pyRound, imageFeatures, audioFeatures } from '../ml/stats.js';
import { decodeWav } from '../ml/audio_features.js';

export const IMAGE_COLUMNS = ['brightness', 'red', 'green', 'blue'];
export const AUDIO_COLUMNS = ['loudness_db', 'loudness_rms', 'peak_frequency_hz', 'spectral_centroid_hz'];
export const BASE_COLUMNS = ['project', 'model', 'class', 'sample_id', 'captured_at'];
export const PCA_COLUMNS = ['pca_1', 'pca_2'];
export const SESSION_COLUMNS = ['timestamp', 'session_id', 'participant_id', 'row_type', 'purpose', 'model', 'class', 'confidence', 'command', 'reason', 'command_sent_to_robot'];
export const EVENT_FIRST_COLUMNS = ['timestamp', 'session_id', 'participant_id', 'event'];
const FLOAT_COLUMNS = new Set([...IMAGE_COLUMNS, ...AUDIO_COLUMNS, ...PCA_COLUMNS, 'confidence']);

export const sampleColumns = mode => [...BASE_COLUMNS, ...(mode === 'image' ? IMAGE_COLUMNS : AUDIO_COLUMNS), ...PCA_COLUMNS];

// parse_sample_time("20261007_154512_123456_ab12") -> "2026-10-07T15:45:12.123"
export function parseSampleTime(id) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(\d{6})/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7].slice(0, 3)}` : '';
}

// decodeImage(blob) -> RGB bytes (the page decodes JPEGs with the browser)
export async function sampleRows(project, mode, { embeddings = null, decodeImage, progress = () => {}, shouldStop = () => false }) {
  const entries = [];
  for (const cls of project.classes(mode)) {
    const dir = await project.classDir(mode, cls, false).catch(() => null);
    if (!dir) continue;
    for (const name of project.sampleNames(mode, cls.id)) entries.push([cls.name, name.replace(/\.[^.]+$/, ''), dir, name]);
  }
  const rows = [];
  for (let i = 0; i < entries.length; i++) {
    if (shouldStop()) throw new Error('export cancelled');
    const [className, id, dir, name] = entries[i];
    const row = { project: project.name, model: mode, class: className, sample_id: id, captured_at: parseSampleTime(id) };
    try {
      const file = await fs.readFile(dir, name);
      Object.assign(row, mode === 'image' ? imageFeatures(await decodeImage(file)) : audioFeatures(decodeWav(new Uint8Array(await file.arrayBuffer()))));
    } catch (e) { console.warn(`Skipping ${name} in the export: ${e.message}`); continue; }
    rows.push(row);
    progress(i + 1, entries.length);
  }
  if (embeddings && rows.length) {
    try {
      const vectors = embeddings(rows.map(r => r.sample_id));
      const projected = pcaTwo(vectors, rows.length, vectors.length / rows.length);
      rows.forEach((r, i) => { r.pca_1 = pyRound(projected[2 * i], 4); r.pca_2 = pyRound(projected[2 * i + 1], 4); });
    } catch (e) { console.warn('Could not add PCA columns', e); }
  }
  return rows;
}

// Every record in the session logs, oldest file first
export async function readEvents(dataRoot) {
  const dir = await fs.tryDir(dataRoot, ['logs', 'events']);
  if (!dir) return [];
  const names = (await fs.entries(dir)).filter(e => e.kind === 'file' && /^session_.*\.jsonl$/.test(e.name)).map(e => e.name).sort();
  const out = [];
  for (const n of names) {
    let text;
    try { text = await fs.readText(dir, n); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && typeof r === 'object' && !Array.isArray(r)) out.push(r); } catch { /* skip */ }
    }
  }
  return out;
}

export function sessionRows(records) {
  const rows = [];
  let lastPrediction = null;
  const base = r => ({ timestamp: r.ts ?? '', session_id: r.session_id ?? '', participant_id: r.participant_id || '' });
  for (const r of records) {
    if (r.event === 'prediction') {
      lastPrediction = { ...base(r), row_type: 'prediction', purpose: r.purpose ?? '', model: r.mode ?? '', class: r.class_name ?? '', confidence: r.confidence ?? '', command: '', reason: '', command_sent_to_robot: '' };
      rows.push(lastPrediction);
    } else if (r.event === 'robot_command') {
      const sent = r.sent ? 'yes' : 'no';
      if (r.reason === 'prediction' && lastPrediction && lastPrediction.class === r.class_name) {
        Object.assign(lastPrediction, { command: r.action ?? '', reason: r.reason ?? '', command_sent_to_robot: sent });
        continue;
      }
      rows.push({ ...base(r), row_type: 'command', purpose: 'robot', model: r.source ?? '', class: r.class_name || '', confidence: r.confidence ?? '', command: r.action ?? '', reason: r.reason ?? '', command_sent_to_robot: sent });
    } else if (r.event === 'emergency_stop') {
      rows.push({ ...base(r), row_type: 'command', purpose: 'robot', model: '', class: '', confidence: '', command: 'stop', reason: 'emergency', command_sent_to_robot: r.sent ? 'yes' : 'no' });
    }
  }
  return rows;
}

export function eventRows(records) {
  const rows = [], extra = [];
  for (const r of records) {
    const row = { timestamp: r.ts ?? '', session_id: r.session_id ?? '', participant_id: r.participant_id || '', event: r.event ?? '' };
    for (const [k, v] of Object.entries(r)) {
      if (['ts', 'session_id', 'participant_id', 'event'].includes(k)) continue;
      if (!extra.includes(k)) extra.push(k);
      row[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    }
    rows.push(row);
  }
  return { rows, columns: [...EVENT_FIRST_COLUMNS, ...extra.sort()] };
}

function cell(v, key) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? (FLOAT_COLUMNS.has(key) ? pyRepr(v) : String(v)) : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// The CSV file's bytes
export function csvBytes(rows, columns) {
  const lines = [columns.map(c => cell(c)).join(',')];
  for (const r of rows) lines.push(columns.map(c => cell(r[c] ?? '', c)).join(','));
  return new TextEncoder().encode('﻿' + lines.join('\r\n') + '\r\n');
}

export { pyJsonLine };
