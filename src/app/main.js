// Page shell: the tab bar and the Connect Radar button, as SensDSv2's main
// window. The radar streams while connected; both tabs receive its frames.

import { initVisualize, showVisualize, onRadarConnected } from './visualize.js';
import { initCollect, showCollect } from './collect.js';
import { initAnalysis, showAnalysis } from './analysis.js';
import { initTrain, showTrain } from './train.js';
import { connectRadar, disconnectRadar, isConnected, onRadarState, hasWebSerial } from './radar_session.js';

const $ = id => document.getElementById(id);
const setStatus = text => { $('status').textContent = text; };

// ---------- tabs ----------
const TABS = {
  visualize: { pane: 'visualizePane', show: showVisualize },
  collect: { pane: 'collectPane', show: showCollect },
  analysis: { pane: 'analysisPane', show: showAnalysis },
  train: { pane: 'trainPane', show: showTrain },
};
function selectTab(name) {
  for (const [key, t] of Object.entries(TABS)) {
    $(t.pane).hidden = key !== name;
    $(`tab-${key}`).setAttribute('aria-selected', String(key === name));
  }
  // Recording playback belongs to the Visualize tab
  for (const id of ['openBtn', 'pauseBtn', 'loopLabel']) $(id).hidden = name !== 'visualize';
  TABS[name].show();
  try { localStorage.setItem('sensds-tab', name); } catch { /* per-viewer convenience only */ }
}
for (const key of Object.keys(TABS)) $(`tab-${key}`).onclick = () => selectTab(key);

// ---------- radar ----------
const connectBtn = $('connectBtn');
if (hasWebSerial()) {
  connectBtn.disabled = false;
  connectBtn.title = 'Connect to the Infineon radar board over USB.';
} else {
  connectBtn.title = 'This browser has no Web Serial. Use Chrome or Edge on a computer.';
}
connectBtn.onclick = async () => {
  connectBtn.disabled = true;
  if (isConnected()) await disconnectRadar();
  else await connectRadar();
  connectBtn.disabled = false;
};
onRadarState(({ connected, message }) => {
  connectBtn.textContent = connected ? 'Disconnect Radar' : 'Connect Radar';
  if (message) setStatus(message);
  if (connected) onRadarConnected();
});

initVisualize({ status: setStatus });
initAnalysis();
initTrain();
initCollect();
let start = 'visualize';
try { start = localStorage.getItem('sensds-tab') || 'visualize'; } catch { /* default tab */ }
const hash = location.hash.slice(1);                 // #collect or #visualize opens that tab
if (TABS[hash]) start = hash;
selectTab(TABS[start] ? start : 'visualize');
