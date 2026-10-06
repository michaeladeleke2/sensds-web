// Where Collect saves samples. SensDSv2 writes to ~/SensDSv2_data/<name>/<label>/.
// A web page cannot pick a path itself, so the person chooses a data folder
// once (Chrome/Edge File System Access API) and the same subfolders and files
// are created inside it. The choice is remembered in this browser (IndexedDB).

const DB = 'sensds-web', STORE = 'handles', KEY = 'dataFolder';

export const canChooseFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

export async function rememberedFolder() {
  try { return (await idb('readonly', s => s.get(KEY))) || null; } catch { return null; }
}

export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'sensds-data', mode: 'readwrite' });
  try { await idb('readwrite', s => s.put(handle, KEY)); } catch { /* remembered for this visit only */ }
  return handle;
}

// Must run from a click: the browser may ask the person to allow access again.
export async function ensureWritable(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

export async function subfolder(handle, names, create) {
  let h = handle;
  for (const n of names) h = await h.getDirectoryHandle(n, { create });
  return h;
}

export async function tryFolder(handle, names) {
  try { return await subfolder(handle, names, false); } catch { return null; }
}

export async function listNames(dir) {
  const files = [], dirs = [];
  for await (const [name, h] of dir.entries()) (h.kind === 'directory' ? dirs : files).push(name);
  return { files, dirs };
}

export async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export async function readText(dir, name) {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
}

// True if the folder can be read now without asking.
export async function canRead(handle) {
  try { return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch { return false; }
}
