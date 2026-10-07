// Folder access for SensAV's data, through the File System Access API
// (Chrome and Edge): the person picks their SensAV data folder once, and the
// app reads and writes the same layout the desktop uses inside it. Without a
// chosen folder the browser's private storage (OPFS) is used instead.

const DB = 'sensav-web', STORE = 'handles', KEY = 'dataFolder';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

export const canChooseFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function rememberedFolder() {
  try { return (await idb('readonly', s => s.get(KEY))) || null; } catch { return null; }
}

export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'sensav-data', mode: 'readwrite' });
  try { await idb('readwrite', s => s.put(handle, KEY)); } catch { /* remembered for this visit only */ }
  return handle;
}

export async function browserStorageFolder() {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getDirectoryHandle('SensAV_data', { create: true });
  try { await idb('readwrite', s => s.put(handle, KEY)); } catch { /* this visit only */ }
  return handle;
}

export async function forgetFolder() { try { await idb('readwrite', s => s.delete(KEY)); } catch { /* nothing stored */ } }

// queryPermission without prompting
export async function hasAccess(handle) {
  try { return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch { return true; }
}

// Must run from a click: the browser may ask again
export async function requestAccess(handle) {
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch { return true; }
}

export async function dir(root, parts, create = false) {
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}

export async function tryDir(root, parts) {
  try { return await dir(root, parts, false); } catch { return null; }
}

export async function exists(parent, name) {
  try { await parent.getDirectoryHandle(name); return true; } catch { /* not a folder */ }
  try { await parent.getFileHandle(name); return true; } catch { return false; }
}

// [{ name, kind, handle }]
export async function entries(d) {
  const out = [];
  for await (const [name, handle] of d.entries()) out.push({ name, kind: handle.kind, handle });
  return out;
}

export async function readBytes(d, name) {
  const f = await (await d.getFileHandle(name)).getFile();
  return new Uint8Array(await f.arrayBuffer());
}

export async function readFile(d, name) { return (await d.getFileHandle(name)).getFile(); }

export async function readText(d, name) { return (await readFile(d, name)).text(); }

export async function tryReadText(d, name) { try { return await readText(d, name); } catch { return null; } }

// Written to a temporary file and swapped in when complete (createWritable)
export async function writeFile(d, name, data) {
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export async function appendFile(d, name, text) {
  const fh = await d.getFileHandle(name, { create: true });
  const size = (await fh.getFile()).size;
  const w = await fh.createWritable({ keepExistingData: true });
  await w.seek(size);
  await w.write(text);
  await w.close();
}

export async function remove(d, name, recursive = false) {
  try { await d.removeEntry(name, { recursive }); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
}

async function copyDir(from, to) {
  for (const e of await entries(from)) {
    if (e.kind === 'directory') await copyDir(e.handle, await to.getDirectoryHandle(e.name, { create: true }));
    else await writeFile(to, e.name, await e.handle.getFile());
  }
}

// Renames a folder inside parent (move() where the browser has it, otherwise
// copy and delete)
export async function renameDir(parent, oldName, newName) {
  if (oldName === newName) return;
  let src;
  try { src = await parent.getDirectoryHandle(oldName); } catch { await parent.getDirectoryHandle(newName, { create: true }); return; }
  if (typeof src.move === 'function') {
    try {
      if (oldName.toLowerCase() === newName.toLowerCase()) {
        const temp = `.rename_${Math.random().toString(16).slice(2, 10)}`;
        await src.move(temp);
        await src.move(newName);
      } else await src.move(newName);
      return;
    } catch { /* fall back to copying */ }
  }
  const temp = oldName.toLowerCase() === newName.toLowerCase() ? `.rename_${Math.random().toString(16).slice(2, 10)}` : newName;
  await copyDir(src, await parent.getDirectoryHandle(temp, { create: true }));
  await remove(parent, oldName, true);
  if (temp !== newName) {
    const t = await parent.getDirectoryHandle(temp);
    await copyDir(t, await parent.getDirectoryHandle(newName, { create: true }));
    await remove(parent, temp, true);
  }
}

// Writes a sample into the folder folderFn() gives, asking for the folder
// again (it is created if missing) and trying once more if it went away
export async function saveInto(folderFn, name, data) {
  try {
    await writeFile(await folderFn(), name, data);
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
    console.warn(`Saving ${name}: folder was missing, trying again`, e);
    await new Promise(r => setTimeout(r, 150));
    await writeFile(await folderFn(), name, data);
  }
}
