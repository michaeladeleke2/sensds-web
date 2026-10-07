// Page shell: the tab bar and the Connect Radar button, as SensDSv2's main
// window. The radar streams while connected; both tabs receive its frames.

import { initVisualize, showVisualize, onRadarConnected } from './visualize.js';
import { initCollect, showCollect } from './collect.js';
import { initAnalysis, showAnalysis } from './analysis.js';
import { initTrain, showTrain } from './train.js';
import { initTest, showTest, hideTest } from './test.js';
import { initResults, showResults } from './results.js';
import { initCurveFit, showCurveFit } from './curvefit.js';
import { initVex, showVex, hideVex } from './vex.js';
import { initGamification } from './gamification.js';
import { initAppSwitcher } from './app_switcher.js';
import { connectRadar, disconnectRadar, isConnected, onRadarState, hasWebSerial } from './radar_session.js';

const $ = id => document.getElementById(id);
// The status sits in a chip in the app bar; long messages are cut short there,
// so the full text is also its tooltip.
const setStatus = text => { $('status').textContent = text; $('radarChip').title = text; };

// ---------- tabs ----------
const TABS = {
  visualize: { pane: 'visualizePane', show: showVisualize },
  collect: { pane: 'collectPane', show: showCollect },
  analysis: { pane: 'analysisPane', show: showAnalysis },
  curvefit: { pane: 'curvefitPane', show: showCurveFit },
  train: { pane: 'trainPane', show: showTrain },
  test: { pane: 'testPane', show: showTest, hide: hideTest },
  results: { pane: 'resultsPane', show: showResults },
  vex: { pane: 'vexPane', show: showVex, hide: hideVex },
};
function selectTab(name) {
  // Leaving a tab can stop its work (the Test tab stops a running game)
  for (const [key, t] of Object.entries(TABS)) if (key !== name && t.hide && !$(t.pane).hidden) t.hide();
  for (const [key, t] of Object.entries(TABS)) {
    $(t.pane).hidden = key !== name;
    $(`tab-${key}`).setAttribute('aria-selected', String(key === name));
  }
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
onRadarState(({ connected, message, restarted }) => {
  connectBtn.textContent = connected ? 'Disconnect Radar' : 'Connect Radar';
  $('radarChip').classList.toggle('live', connected);
  if (message) setStatus(message);
  if (connected && !restarted) onRadarConnected();
});

initVisualize({ status: setStatus });
initAnalysis();
initTrain();
initTest();
initResults();
initCurveFit();
initVex();
initGamification();
initAppSwitcher();
initCollect();
let start = 'visualize';
try { start = localStorage.getItem('sensds-tab') || 'visualize'; } catch { /* default tab */ }
const hash = location.hash.slice(1);                 // #collect or #visualize opens that tab
if (TABS[hash]) start = hash;
selectTab(TABS[start] ? start : 'visualize');
