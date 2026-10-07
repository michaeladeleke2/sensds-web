// The Maze on SensAV's Test tab, the same game as SensDS's Test tab (the maze,
// moves and stars come from src/test/maze.js): each class is given a move
// (Move forward, Turn left, Turn right or Nothing), and live predictions steer
// the robot. A class moves it once it is the top prediction, at least 70 %
// sure, for a few predictions in a row; then the robot waits a moment
// (red dot) before it takes the next move (green dot).

import { $, setChip, segmented } from '../ui/ui.js';
import { celebrate } from '../ui/views.js';
import { Maze } from '../../test/maze.js';
import { BACKGROUND_CLASS_ID } from '../storage/project.js';
import { events } from '../logs/events.js';

export const MAZE_ACTIONS = [['forward', 'Move forward'], ['left', 'Turn left'], ['right', 'Turn right'], ['none', 'Nothing']];
const GESTURE = { forward: 'push', left: 'swipe_left', right: 'swipe_right' };
const SIZES = [[3, 4], [4, 5], [5, 7]];
const CONFIDENCE = 0.7;
const STEADY = { image: 3, audio: 2 };
const COOLDOWN_MS = 1500;
const STORE_KEY = 'sensav-web-maze';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function loadMaps() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; } }
function saveMaps(maps) { try { localStorage.setItem(STORE_KEY, JSON.stringify(maps)); } catch { /* this visit only */ } }

export function initMaze(state) {
  const maze = new Maze(...SIZES[0]);
  let difficulty = 0, classes = [], streak = { id: null, n: 0 }, coolUntil = 0, bumpTimer = null, dotTimer = null, active = false, running = false;
  let maps = loadMaps();
  segmented($('mazeDifficulty'), v => { difficulty = Number(v); maze.newMaze(...SIZES[difficulty]); afterChange('New maze. Show a class to move the robot.'); });
  $('mazeNew').onclick = () => { maze.reset(); afterChange('New maze. Show a class to move the robot.'); };
  new ResizeObserver(() => draw()).observe($('mazeCanvas'));

  const key = () => `${state.project?.id}:${state.mode}`;
  const actionFor = id => maps[key()]?.[id] ?? 'none';

  // Classes of the trained model: [{ id, name, color }]
  function setClasses(list) {
    classes = list;
    const m = maps[key()] ?? {};
    const others = list.filter(c => c.id !== BACKGROUND_CLASS_ID);
    const defaults = ['forward', 'left', 'right'];
    for (const c of list) if (!(c.id in m)) m[c.id] = c.id === BACKGROUND_CLASS_ID ? 'none' : defaults[others.indexOf(c)] ?? 'none';
    maps[key()] = m; saveMaps(maps);
    const host = $('mazeActions');
    host.innerHTML = '';
    for (const c of list) {
      const row = document.createElement('div');
      row.className = 'maze-row'; row.dataset.id = c.id;
      row.innerHTML = `<span class="swatch" style="background:${c.color}"></span><span class="n"></span><select class="field"></select>`;
      row.querySelector('.n').textContent = c.name;
      const sel = row.querySelector('select');
      for (const [v, label] of MAZE_ACTIONS) sel.add(new Option(label, v));
      sel.value = m[c.id];
      sel.onchange = () => { maps[key()][c.id] = sel.value; saveMaps(maps); };
      host.append(row);
    }
  }

  function setStatus(text) { $('mazeStatus').textContent = text; }

  function afterChange(text) {
    streak = { id: null, n: 0 }; coolUntil = 0;
    setStatus(text);
    updateChip(); draw();
  }

  function updateChip() { setChip($('mazeChip'), `Maze #${maze.mazeNum} · ${maze.moves} ${maze.moves === 1 ? 'move' : 'moves'}`, maze.won ? 'success' : 'neutral'); }

  // A live prediction (see InferenceController)
  function onPrediction(p) {
    if (!active || !running || maze.won) return;
    for (const r of $('mazeActions').children) r.classList.toggle('active', r.dataset.id === p.classId);
    if (performance.now() < coolUntil) return;
    const action = actionFor(p.classId);
    if (p.confidence < CONFIDENCE || action === 'none') { streak = { id: null, n: 0 }; return; }
    streak = streak.id === p.classId ? { id: p.classId, n: streak.n + 1 } : { id: p.classId, n: 1 };
    if (streak.n < (STEADY[p.mode] ?? 3)) return;
    streak = { id: null, n: 0 };
    const text = maze.applyGesture(GESTURE[action]);
    setStatus(`${p.className}: ${text}`);
    events.log('maze_move', { mode: p.mode, class_id: p.classId, class_name: p.className, action, moves: maze.moves, bump: maze.bump, won: maze.won });
    if (maze.bump) { clearTimeout(bumpTimer); bumpTimer = setTimeout(() => { maze.bump = false; draw(); }, 600); }
    if (maze.won) {
      events.log('maze_solved', { mode: p.mode, rows: maze.rows, cols: maze.cols, moves: maze.moves, stars: maze.starRating });
      celebrate($('confettiMaze'), classes.map(c => c.color));
    } else {
      coolUntil = performance.now() + COOLDOWN_MS;
      clearTimeout(dotTimer); dotTimer = setTimeout(draw, COOLDOWN_MS + 20);
    }
    updateChip(); draw();
  }

  function draw() {
    const c = $('mazeCanvas');
    if (!active || !c.clientWidth) return;
    const dpr = Math.max(1, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cell = Math.floor(Math.min((w - 4) / maze.cols, (h - 4) / maze.rows));
    if (cell <= 4) return;
    const wall = Math.max(2, Math.floor(cell / 10)), gw = cell * maze.cols, gh = cell * maze.rows;
    const ox = Math.floor((w - gw) / 2), oy = Math.floor((h - gh) / 2);
    const onPath = (r, cc) => maze.path.some(([a, b]) => a === r && b === cc);
    const dark = document.documentElement.dataset.theme === 'dark';
    for (let r = 0; r < maze.rows; r++) for (let cc = 0; cc < maze.cols; cc++) {
      const goal = r === maze.rows - 1 && cc === maze.cols - 1, here = r === maze.pr && cc === maze.pc;
      ctx.fillStyle = goal ? (dark ? '#4a3d12' : '#ffeaa7') : here ? css('--accent-soft') : onPath(r, cc) ? (dark ? '#1d2a3d' : '#dbe8fb') : css('--bg');
      ctx.fillRect(ox + cc * cell + 1, oy + r * cell + 1, cell - 1, cell - 1);
    }
    ctx.strokeStyle = css('--text'); ctx.lineWidth = wall; ctx.lineCap = 'round';
    const line = (a, b, x2, y2) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(x2, y2); ctx.stroke(); };
    for (let r = 0; r < maze.rows; r++) for (let cc = 0; cc < maze.cols; cc++) {
      const x = ox + cc * cell, y = oy + r * cell, wf = maze.walls[r][cc];
      if (wf & 1) line(x, y, x + cell, y);
      if (wf & 4) line(x, y + cell, x + cell, y + cell);
      if (wf & 8) line(x, y, x, y + cell);
      if (wf & 2) line(x + cell, y, x + cell, y + cell);
    }
    ctx.lineWidth = wall + 1; ctx.strokeRect(ox, oy, gw, gh);
    const emoji = px => `${px}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = emoji(Math.max(10, Math.trunc(cell * 0.55)));
    ctx.fillText('⭐', ox + (maze.cols - 1) * cell + cell / 2, oy + (maze.rows - 1) * cell + cell / 2);
    const px = ox + maze.pc * cell, py = oy + maze.pr * cell;
    if (maze.bump) { ctx.fillStyle = 'rgba(229,72,77,0.55)'; ctx.fillRect(px + 2, py + 2, cell - 3, cell - 3); }
    const emojiH = Math.trunc(cell * 0.55), arrowH = cell - emojiH - 2, arrowW = Math.max(1, Math.trunc(cell * 0.65)), dotW = Math.max(1, cell - 2 - arrowW);
    ctx.font = emoji(Math.max(8, Math.trunc(cell * 0.48)));
    ctx.fillText('🤖', px + cell / 2, py + 2 + emojiH / 2);
    ctx.fillStyle = '#FF8C00'; ctx.font = `700 ${Math.max(10, Math.trunc(cell * 0.48))}px system-ui, sans-serif`;
    ctx.fillText(maze.facingArrow, px + 1 + arrowW / 2, py + emojiH + arrowH / 2);
    if (running && !maze.won) {
      ctx.fillStyle = performance.now() < coolUntil ? '#c0392b' : '#27ae60';
      ctx.beginPath(); ctx.arc(px + arrowW + Math.floor(dotW / 2), py + emojiH + Math.floor(arrowH / 2), Math.max(4, Math.trunc(cell * 0.11)), 0, 2 * Math.PI); ctx.fill();
    }
    if (maze.won) {
      ctx.fillStyle = 'rgba(31,157,85,0.62)'; ctx.fillRect(ox, oy, gw, gh);
      ctx.fillStyle = '#fff';
      ctx.font = `800 ${Math.max(14, Math.min(28, Math.floor(gw / 9)))}px system-ui, sans-serif`; ctx.fillText('🎉 You did it!', ox + gw / 2, oy + gh * 0.25);
      ctx.font = emoji(Math.max(12, Math.min(26, Math.floor(gw / 9)))); ctx.fillText('⭐'.repeat(maze.starRating), ox + gw / 2, oy + gh * 0.52);
      ctx.font = `600 ${Math.max(10, Math.min(16, Math.floor(gw / 13)))}px system-ui, sans-serif`; ctx.fillText(`${maze.moves} moves. Click New maze to play again.`, ox + gw / 2, oy + gh * 0.78);
    }
  }

  return {
    setClasses,
    onPrediction,
    // shown: the Maze mode is on; isRunning: live testing is on
    setActive(shown, isRunning) {
      const changed = isRunning !== running || shown !== active || !$('mazeStatus').textContent;
      active = shown; running = isRunning;
      if (!running) { streak = { id: null, n: 0 }; coolUntil = 0; for (const r of $('mazeActions').children) r.classList.remove('active'); }
      if (changed && !maze.won) setStatus(running ? 'Show a class to move the robot to the ⭐.' : 'Click Start testing, then show a class to move the robot to the ⭐.');
      updateChip();
      requestAnimationFrame(draw);
    },
    redraw: draw,
  };
}

