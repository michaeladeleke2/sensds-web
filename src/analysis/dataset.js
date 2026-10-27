// scan_samples / scan_dataset from SensDSv2 (core/physical_features.py,
// core/pca_analysis.py): every sample_*_raw.npy under the data folder, as
// <student>/<gesture>/sample_*_raw.npy, sorted, skipping hidden entries and the
// desktop's non-data folders.

import { listNames } from '../io/folder.js';
import { CHIRP_REP_S } from './physical_features.js';

export const EXCLUDE_DIRS = new Set(['models', 'model', 'predict_temp', 'temp', 'test', 'checkpoints']);
const RAW = /^sample_.*_raw\.npy$/;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // Python sorted() on str

// The chirp spacing a gesture folder was recorded with (chirp_for_folder):
// capture_info.json's chirp_repetition_time_s, or the radar's current spacing
async function chirpForFolder(gdir, names) {
  if (!names.has('capture_info.json')) return CHIRP_REP_S;
  try {
    const info = JSON.parse(await (await (await gdir.getFileHandle('capture_info.json')).getFile()).text());
    const v = Number(info.chirp_repetition_time_s ?? CHIRP_REP_S);
    return v > 0 ? v : CHIRP_REP_S;
  } catch { return CHIRP_REP_S; }
}

// Returns [{ student, gesture, name, file (FileSystemFileHandle), png (handle or null), chirpRepS }]
export async function scanSamples(root) {
  const out = [];
  if (!root) return out;
  const { dirs: students } = await listNames(root);
  for (const student of students.sort(byName)) {
    if (EXCLUDE_DIRS.has(student) || student.startsWith('.')) continue;
    const sdir = await root.getDirectoryHandle(student);
    const { dirs: gestures } = await listNames(sdir);
    for (const gesture of gestures.sort(byName)) {
      if (gesture.startsWith('.')) continue;
      const gdir = await sdir.getDirectoryHandle(gesture);
      const { files } = await listNames(gdir);
      const names = new Set(files);
      const chirpRepS = await chirpForFolder(gdir, names);
      for (const name of files.filter(f => RAW.test(f)).sort(byName)) {
        const pngName = name.slice(0, -'_raw.npy'.length) + '.png';     // png_for_sample
        out.push({
          student, gesture, name,
          file: await gdir.getFileHandle(name),
          png: names.has(pngName) ? await gdir.getFileHandle(pngName) : null,
          chirpRepS,
        });
      }
    }
  }
  return out;
}
