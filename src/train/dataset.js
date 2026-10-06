// Dataset discovery from SensDSv2's train tab: is_subject_dir,
// discover_subjects and scan_dataset. A subject is a folder (not hidden, not
// one of the desktop's non-data folders) with at least one sub-folder holding
// PNGs; classes are the gesture folders holding PNGs.

import { listNames } from '../io/folder.js';
import { EXCLUDE_DIRS } from '../analysis/dataset.js';

const isPng = n => n.toLowerCase().endsWith('.png');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function gestureDirs(subjectDir) {
  const out = [];
  const { dirs } = await listNames(subjectDir);
  for (const g of dirs.sort(byName)) {
    const gd = await subjectDir.getDirectoryHandle(g);
    const { files } = await listNames(gd);
    const pngs = files.filter(isPng).sort(byName);
    if (pngs.length) out.push({ gesture: g, dir: gd, pngs });
  }
  return out;
}

// Returns [{ name, gestures: [{ gesture, dir, pngs }] }] for every subject, sorted
export async function discoverSubjects(root) {
  const out = [];
  if (!root) return out;
  const { dirs } = await listNames(root);
  for (const name of dirs.sort(byName)) {
    if (name.startsWith('.') || EXCLUDE_DIRS.has(name)) continue;
    const gestures = await gestureDirs(await root.getDirectoryHandle(name));
    if (gestures.length) out.push({ name, gestures });
  }
  return out;
}

// scan_dataset: PNG count per gesture over the chosen subjects
export function classCounts(subjects, filter) {
  const counts = {};
  for (const s of subjects) {
    if (filter && !filter.includes(s.name)) continue;
    for (const g of s.gestures) counts[g.gesture] = (counts[g.gesture] || 0) + g.pngs.length;
  }
  return counts;
}
