// Pick a trained model folder for inference (the Test and VEX AIM tabs, as the
// desktop's "Select Model Folder" dialog). Accepts models/<name>_vN or its
// model/ folder. Returns null when the picker is closed; throws with a message
// a student can act on.

import { currentFolder, readText, listNames } from '../io/folder.js';

export async function chooseModelFolder() {
  let dir;
  try {
    let startIn;
    try { startIn = await currentFolder()?.getDirectoryHandle('models'); } catch { startIn = undefined; }
    dir = await window.showDirectoryPicker({ id: 'sensds-models', startIn, mode: 'read' });
  } catch { return null; }                                              // closed the picker
  return { dir, read: () => readModelFolder(dir) };
}

async function readModelFolder(dir) {
  // The model folder itself, or a <name>_vN folder holding model/
  let folder = dir;
  if (!(await readText(dir, 'config.json'))) { try { folder = await dir.getDirectoryHandle('model'); } catch { /* reported below */ } }
  const configText = await readText(folder, 'config.json');
  const preprocessorText = await readText(folder, 'preprocessor_config.json');
  if (!configText) throw new Error(`No config.json in ${dir.name}. Pick the model folder (models/<name>_vN or its model/ folder).`);
  if (!preprocessorText) throw new Error(`No preprocessor_config.json in ${folder.name}.`);
  const { files } = await listNames(folder);
  if (!files.includes('model.safetensors')) {
    throw new Error(files.includes('pytorch_model.bin') ? 'This model was saved in the older PyTorch .bin format, which the browser cannot read. Retrain it (or re-save it with safetensors).' : `No model.safetensors in ${folder.name}.`);
  }
  const weights = await (await (await folder.getFileHandle('model.safetensors')).getFile()).arrayBuffer();
  const name = folder.name === 'model' && dir.name !== 'model' ? dir.name : folder.name;
  return { name, files: { configText, preprocessorText, weights } };
}
