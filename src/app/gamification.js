// The desktop's GamificationBar, BadgeToast and badge panel (ui/gamification.py),
// fitted to the app bar: a level chip with its XP bar, the badge count that
// opens the badge list, and a toast that slides in for each new badge. The
// Test tab reports its events through predictions.js.

import { GamificationManager, LEVELS, BADGES } from '../gamification/manager.js';
import { onGameEvent } from './predictions.js';

const $ = id => document.getElementById(id);
const TOAST_MS = 3600;

let mgr;
const toastQueue = [];
let toastShowing = false;

function renderXp(xp, levelIdx) {
  const [, name, color] = LEVELS[levelIdx];
  const [start, end] = mgr.levelXpRange;
  const progress = Math.max(0, Math.min(100, Math.trunc((xp - start) / Math.max(end - start, 1) * 100)));
  const lvl = $('gamiLevel');
  lvl.textContent = `Level ${levelIdx + 1} · ${name}`;
  lvl.style.setProperty('--level-color', color);
  lvl.classList.remove('level-up');
  $('gamiXpFill').style.width = `${progress}%`;
  $('gamiXpText').textContent = `XP: ${xp} / ${end}`;
  $('gamiChip').title = `${xp} XP. Level ${levelIdx + 1} (${name}). ${end - xp} XP to the next level.`;
}

function onLevelUp(levelIdx) {
  // Flash gold for 1.6 s, then back to the level's color
  const [, name] = LEVELS[levelIdx];
  const lvl = $('gamiLevel');
  lvl.textContent = `🎉 Level Up! Level ${levelIdx + 1} · ${name}`;
  lvl.classList.add('level-up');
  setTimeout(() => renderXp(mgr.xp, levelIdx), 1600);
}

function onBadgeEarned(key) {
  $('gamiBadgeCount').textContent = String(mgr.badges.size);
  toastQueue.push(key);
  if (!toastShowing) nextToast();
}

function nextToast() {
  const key = toastQueue.shift();
  if (!key) { toastShowing = false; return; }
  toastShowing = true;
  const [icon, name, desc] = BADGES[key];
  const t = $('badgeToast');
  $('toastIcon').textContent = icon;
  $('toastTitle').textContent = `🏅 Badge: ${name}`;
  $('toastDesc').textContent = desc;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => { t.hidden = true; nextToast(); }, 320);
  }, TOAST_MS);
}

function openPanel() {
  $('badgeXp').textContent = `⭐ ${mgr.xp} XP  ·  Level ${mgr.levelIdx + 1}`;
  const list = $('badgeList');
  list.replaceChildren();
  for (const [key, [icon, name, desc]] of Object.entries(BADGES)) {
    const earned = mgr.badges.has(key);
    const row = document.createElement('li');
    row.className = earned ? 'badge-row earned' : 'badge-row';
    row.innerHTML = '<span class="badge-icon"></span><span class="badge-text"><span class="badge-name"></span><span class="badge-desc"></span></span><span class="badge-check"></span>';
    row.querySelector('.badge-icon').textContent = earned ? icon : '🔒';
    row.querySelector('.badge-name').textContent = name;
    row.querySelector('.badge-desc').textContent = desc;
    row.querySelector('.badge-check').textContent = earned ? '✓  Earned' : '';
    list.append(row);
  }
  $('badgeDialog').showModal();
}

export function initGamification() {
  mgr = new GamificationManager({ xpChanged: renderXp, badgeEarned: onBadgeEarned, levelUp: onLevelUp });
  renderXp(0, 0);
  $('gamiChip').onclick = openPanel;
  $('badgeClose').onclick = () => $('badgeDialog').close();
  $('badgeDialog').addEventListener('click', e => { if (e.target === $('badgeDialog')) $('badgeDialog').close(); });
  onGameEvent(e => {
    if (e.type === 'prediction') mgr.onPrediction(e.gesture, e.confidence);
    else if (e.type === 'soccer') mgr.onSoccerGesture(e.gesture);
    else if (e.type === 'maze') mgr.onMazeSolved(e.stars, e.moves);
  });
}
