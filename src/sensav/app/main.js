// SensAV in the browser: the window around the five tabs (app/ui/main_window.py
// and project_dialog.py). The header has the logo (which switches between
// SensDS and SensAV), the project menu, the Image / Audio switch, the robot
// status and the theme button. A data folder is chosen first; then a project
// is opened or created.

import { $, setChip, setIcon, segmented, showError, askText, confirm, friendlyDate, fillIcons, icon } from '../ui/ui.js';
import { AppState } from './state.js';
import { initCollect } from './collect.js';
import { initTrain } from './train.js';
import { initTest } from './test.js';
import { initRobot } from './robot.js';
import { initData } from './data.js';
import { initMazeTab } from './maze_tab.js';
import { thumbTile } from './collect.js';
import { events } from '../logs/events.js';
import * as fs from '../storage/fs.js';
import { MAX_NAME_LENGTH } from '../storage/project.js';

const TABS = ['collect', 'train', 'test', 'maze', 'robot', 'data'];
const NO_PROJECT_TEXT = {
  collect: 'Create or open a project to start collecting samples.',
  train: 'Create or open a project, then collect samples to train a model.',
  test: 'Create or open a project to test a model.',
  maze: 'Create or open a project, train a model, then steer a robot through a maze here.',
  robot: 'Create or open a project, then connect a VEX AIM robot here.',
  data: 'Create or open a project to manage its data.',
};

const state = new AppState();
let currentTab = 'collect';
const tabs = {};

fillIcons();
applyTheme(state.settings.theme);
events.start();
events.log('app_start', { version: '0.1.0', platform: navigator.userAgent, theme: state.settings.theme });

// ---------- menus ----------
let openMenu = null;
function closeMenus() {
  if (!openMenu) return;
  openMenu.el.hidden = true;
  openMenu.anchor?.setAttribute('aria-expanded', 'false');
  if (openMenu.temp) openMenu.el.remove();
  openMenu = null;
}
document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenus(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });

function showMenu(el, anchor, temp = false) {
  if (openMenu?.el === el) { closeMenus(); return; }
  closeMenus();
  const r = anchor.getBoundingClientRect();
  el.hidden = false;
  el.style.top = `${r.bottom + 6 + window.scrollY}px`;
  el.style.left = `${Math.min(r.left, window.innerWidth - el.offsetWidth - 12)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, anchor, temp };
}

// items: [iconName, text, fn] or null for a separator
function popupMenu(anchor, items) {
  const el = document.createElement('div');
  el.className = 'menu';
  el.style.minWidth = '180px';
  for (const item of items) {
    if (!item) { el.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.innerHTML = `${icon(item[0], 16)}<span></span>`;
    b.querySelector('span').textContent = item[1];
    b.onclick = () => { closeMenus(); item[2](); };
    el.append(b);
  }
  document.body.append(el);
  showMenu(el, anchor, true);
}

$('brandButton').onclick = () => showMenu($('appMenu'), $('brandButton'));
$('projectButton').onclick = () => {
  for (const b of $('projectMenu').querySelectorAll('.needs-project')) b.disabled = !state.project;
  showMenu($('projectMenu'), $('projectButton'));
};
$('projectMenu').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  closeMenus();
  ({ open: showProjectDialog, rename: renameProject, save: saveProject, folder: changeFolder })[b.dataset.act]?.();
});

// ---------- header ----------
const modeSwitch = segmented($('modeSwitch'), m => state.setMode(m));
$('robotPill').onclick = () => setTab('robot');
$('themeButton').onclick = () => {
  const previous = state.settings.theme;
  state.settings.theme = previous === 'dark' ? 'light' : 'dark';
  state.saveSettings();
  applyTheme(state.settings.theme);
  events.log('theme_changed', { from_theme: previous, to_theme: state.settings.theme });
  for (const t of Object.values(tabs)) t.refresh?.();
};
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  const dark = name === 'dark';
  setIcon($('themeButton').firstElementChild, dark ? 'sun' : 'moon');
  $('themeButton').title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}

const ROBOT_STATES = { disconnected: ['', 'Robot offline'], connecting: ['warning', 'Connecting'], connected: ['success', 'Robot connected'], lost: ['danger', 'Connection lost'] };
state.robot.on('state', s => {
  const [kind, text] = ROBOT_STATES[s] ?? ROBOT_STATES.disconnected;
  $('robotDot').className = `dot ${kind}`;
  $('robotPillText').textContent = text;
  $('robotPill').title = `${text}. Open the Robot tab to connect.`;
});

$('tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[1-6]$/.test(e.key)) { e.preventDefault(); setTab(TABS[Number(e.key) - 1]); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); showProjectDialog(); }
});

// ---------- status bar ----------
let statusTimer = null;
state.on('status', (message, ms) => {
  $('statusText').textContent = message;
  clearTimeout(statusTimer);
  if (ms > 0) statusTimer = setTimeout(() => { $('statusText').textContent = ''; }, ms);
});
let workTimer = null;
state.embeddings.on('pending', n => {
  clearTimeout(workTimer);
  if (n) $('workText').textContent = `Preparing ${n} ${n === 1 ? 'sample' : 'samples'} for training`;
  else if ($('workText').textContent.startsWith('Preparing')) {
    $('workText').textContent = 'All samples ready for training';
    workTimer = setTimeout(() => { if (state.embeddings.pending === 0) $('workText').textContent = ''; }, 3000);
  }
});
state.embeddings.on('error', message => { $('workText').textContent = message; });
state.training.on('busy', busy => {
  modeSwitch.setEnabled(!busy && Boolean(state.project));
  $('modeSwitch').title = busy ? 'Wait for training to finish' : 'Switch between the image model and the audio model';
  $('projectButton').disabled = busy;
});

// ---------- tabs ----------
const shell = {
  setTab, popupMenu, showProjectDialog, renameProject,
  isTab: t => currentTab === t,
  showSamples,
};
tabs.collect = initCollect(state, shell);
tabs.train = initTrain(state, shell);
tabs.test = initTest(state, shell);
tabs.maze = initMazeTab(state, shell);
tabs.robot = initRobot(state, shell);
tabs.data = initData(state, shell);

function showPage() {
  for (const t of TABS) $(`page-${t}`).hidden = true;
  $('noFolder').hidden = true; $('reconnectFolder').hidden = true; $('noProject').hidden = true;
  if (!state.dataRoot) { $(pendingFolder ? 'reconnectFolder' : 'noFolder').hidden = false; return false; }
  if (!state.project) { $('noProjectText').textContent = NO_PROJECT_TEXT[currentTab]; $('noProject').hidden = false; return false; }
  $(`page-${currentTab}`).hidden = false;
  return true;
}

function setTab(name) {
  if (!TABS.includes(name)) return;
  if (name !== currentTab) {
    tabs[currentTab].onLeave?.();
    events.log('tab_changed', { from_tab: currentTab, to_tab: name });
    currentTab = name;
  }
  for (const b of $('tabs').querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  if (showPage()) tabs[name].onEnter?.();
}

state.on('project', p => {
  $('projectName').textContent = p ? p.name : 'No project';
  modeSwitch.setEnabled(Boolean(p));
  document.title = p ? `${p.name}  ·  SensAV` : 'SensAV Web';
  setTab(currentTab);
});
state.on('projectRenamed', p => { $('projectName').textContent = p.name; document.title = `${p.name}  ·  SensAV`; });
state.on('mode', m => modeSwitch.set(m));
modeSwitch.setEnabled(false);

// ---------- data folder ----------
let pendingFolder = null;

async function useFolder(handle) {
  pendingFolder = null;
  await state.setDataRoot(handle);
  const last = state.settings.last_project;
  if (last) {
    try { await state.openProject(last); return; } catch (e) { console.warn('Could not reopen the last project', e); state.settings.last_project = null; state.saveSettings(); }
  }
  setTab(currentTab);
  showProjectDialog(true);
}

$('chooseFolderButton').onclick = async () => { try { await useFolder(await fs.chooseFolder()); } catch (e) { if (e.name !== 'AbortError') showError('Could not use that folder', e.message); } };
$('browserStorageButton').onclick = async () => { try { await useFolder(await fs.browserStorageFolder()); } catch (e) { showError('This browser cannot store projects', e.message); } };
$('reconnectButton').onclick = async () => { if (pendingFolder && await fs.requestAccess(pendingFolder)) await useFolder(pendingFolder); };
$('otherFolderButton').onclick = () => changeFolder();

async function changeFolder() {
  if (!fs.canChooseFolder()) { showError('Folders are not available here', 'This browser can only keep projects in its own storage. Use Chrome or Edge to keep them in a folder.'); return; }
  let handle;
  try { handle = await fs.chooseFolder(); } catch (e) { if (e.name !== 'AbortError') showError('Could not use that folder', e.message); return; }
  if (state.training.busy) { showError('Training is running', 'Wait for training to finish first.'); return; }
  state.stopCapture();
  state.project = null;
  await state.embeddings.setProject(null);
  state.emit('project', null);
  state.settings.last_project = null; state.saveSettings();
  await useFolder(handle);
}

// ---------- project dialog ----------
let selectedProject = null;

async function showProjectDialog(firstRun = false) {
  if (!state.dataRoot) { setTab(currentTab); return; }
  const d = $('projectDialog');
  $('projectDialogTitle').textContent = firstRun ? 'Welcome to SensAV' : 'Projects';
  $('newProjectName').value = '';
  $('createProjectButton').disabled = true;
  $('dialogFolderText').textContent = `Projects are kept in ${state.dataRoot.name}/projects`;
  $('dialogChangeFolder').hidden = !fs.canChooseFolder();
  await reloadProjects();
  if (!d.open) d.showModal();
  $('newProjectName').focus();
}

async function reloadProjects() {
  const list = $('projectList');
  const summaries = await state.listProjects();
  list.innerHTML = '';
  for (const s of summaries) {
    const b = document.createElement('button');
    b.className = 'project-item';
    b.dataset.folder = s.folder;
    const audio = Math.max(0, s.audio_classes - 1);
    b.innerHTML = '<div class="top"><span class="heading"></span><span class="caption open-now"></span></div><span class="caption"></span>';
    b.querySelector('.heading').textContent = s.name;
    b.querySelector('.open-now').textContent = state.project?.folder === s.folder ? 'Open now' : '';
    b.lastChild.textContent = `Updated ${friendlyDate(s.modified)}  ·  ${s.image_classes} image ${s.image_classes === 1 ? 'class' : 'classes'}  ·  ${audio} audio ${audio === 1 ? 'class' : 'classes'}`;
    b.onclick = () => selectProject(s.folder, s.name);
    b.ondblclick = () => { selectProject(s.folder, s.name); openSelected(); };
    list.append(b);
  }
  setChip($('projectCount'), String(summaries.length));
  list.hidden = !summaries.length;
  $('noProjects').hidden = Boolean(summaries.length);
  selectedProject = null;
  if (summaries.length) selectProject(summaries[0].folder, summaries[0].name);
  $('openProjectButton').disabled = !selectedProject; $('deleteListedProject').disabled = !selectedProject;
}

function selectProject(folder, name) {
  selectedProject = { folder, name };
  for (const b of $('projectList').children) b.setAttribute('aria-selected', String(b.dataset.folder === folder));
  $('openProjectButton').disabled = false; $('deleteListedProject').disabled = false;
}

async function openSelected() {
  if (!selectedProject) return;
  try { await state.openProject(selectedProject.folder); $('projectDialog').close(); }
  catch (e) { showError('Could not open project', e.message); reloadProjects(); }
}

$('newProjectName').maxLength = MAX_NAME_LENGTH;
$('newProjectName').oninput = () => { $('createProjectButton').disabled = !$('newProjectName').value.trim(); };
$('newProjectName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('createProjectButton').click(); } };
$('createProjectButton').onclick = async () => {
  const name = $('newProjectName').value.trim();
  if (!name) return;
  try { await state.createProject(name); $('projectDialog').close(); } catch (e) { showError('Could not create project', e.message); }
};
$('openProjectButton').onclick = openSelected;
$('deleteListedProject').onclick = async () => {
  if (!selectedProject) return;
  const ok = await confirm('Delete project?', `This permanently deletes “${selectedProject.name}”, including every image, sound, and trained model in it. This cannot be undone.`, 'Delete project', true);
  if (!ok) return;
  try { await state.deleteProject(selectedProject.folder); } catch (e) { showError('Could not delete project', e.message); }
  reloadProjects();
};
$('closeProjectDialog').onclick = () => $('projectDialog').close();
$('dialogChangeFolder').onclick = () => { $('projectDialog').close(); changeFolder(); };

async function renameProject() {
  const p = state.project;
  if (!p) return;
  const name = await askText('Rename project', 'Choose a new name for this project.', p.name, 'Rename');
  if (!name || name === p.name) return;
  try { await state.renameProject(name); } catch (e) { showError('Could not rename project', e.message); }
}

async function saveProject() {
  if (!state.project) return;
  try { await state.saveProject(); } catch (e) { showError('Could not save project', e.message); }
}

// ---------- every sample of a class ----------
function showSamples(mode, cls, onDelete) {
  const d = $('samplesDialog'), grid = $('samplesGrid');
  $('samplesTitle').textContent = cls.name;
  setIcon($('samplesIcon'), mode === 'image' ? 'image' : 'wave', 22);
  const unit = mode === 'image' ? 'sample' : 'clip';
  const reload = () => {
    const names = [...state.project.sampleNames(mode, cls.id)].reverse();
    $('samplesSubtitle').textContent = `${names.length} ${names.length === 1 ? unit : `${unit}s`}. Click one to delete it.`;
    grid.innerHTML = '';
    for (const n of names) grid.append(thumbTile(state, mode, cls, n, 96, async name => { await onDelete(name); reload(); }));
  };
  reload();
  $('samplesClose').onclick = () => d.close();
  d.showModal();
}

// ---------- start ----------
async function askParticipant() {
  if (!state.settings.ask_participant) return;
  const id = await askText('Session ID', 'If your teacher gave you a session ID, type it here so this session can be matched with the class notes. Never use your name. You can skip this.', '', 'Start', 'For example: P07');
  events.setParticipant(id || null);
}

async function start() {
  if (!fs.canChooseFolder()) {
    $('chooseFolderButton').hidden = true;
    $('noFolderText').textContent = 'This browser keeps your projects in its own storage. Use Chrome or Edge to keep them in a folder you can open, or to share them with the SensAV desktop app.';
  } else $('noFolderNote').textContent = 'You can change this later from the project menu.';
  await askParticipant();
  const remembered = await fs.rememberedFolder();
  if (remembered && await fs.hasAccess(remembered)) { await useFolder(remembered); return; }
  if (remembered) { pendingFolder = remembered; $('reconnectName').textContent = remembered.name; }
  setTab(currentTab);
}

addEventListener('pagehide', () => {
  tabs[currentTab].onLeave?.();
  state.project?.save().catch(() => {});
  state.embeddings.flush();
  events.log('app_close', {});
  events.flush();
});

start();

// Offline cache for the robot's WiFi (dist/sw.js, made by the build; the
// development server has none, so this quietly does nothing there)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => {});
