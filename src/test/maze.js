// The Maze game of SensDSv2's Test tab (_generate_maze and MazeWidget): a
// recursive-backtracker maze, a player that turns with swipes and moves
// forward with a push, 1-3 stars by move count.

export const N = 1, E = 2, S = 4, W = 8;
export const OPP = { [N]: S, [S]: N, [E]: W, [W]: E };
export const DR = { [N]: -1, [S]: 1, [E]: 0, [W]: 0 };
export const DC = { [N]: 0, [S]: 0, [E]: 1, [W]: -1 };
export const LABEL = { [N]: 'North ↑', [E]: 'East →', [S]: 'South ↓', [W]: 'West ←' };
export const TURN_L = { [N]: W, [W]: S, [S]: E, [E]: N };
export const TURN_R = { [N]: E, [E]: S, [S]: W, [W]: N };
export const ARROW = { [N]: '↑', [E]: '→', [S]: '↓', [W]: '←' };

// rng(): uniform [0, 1)
export function generateMaze(rows, cols, rng = Math.random) {
  const walls = Array.from({ length: rows }, () => Array(cols).fill(N | E | S | W));
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
  const carve = (r, c) => {
    visited[r][c] = true;
    const dirs = [N, E, S, W];
    for (let i = dirs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [dirs[i], dirs[j]] = [dirs[j], dirs[i]]; }
    for (const d of dirs) {
      const nr = r + DR[d], nc = c + DC[d];
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited[nr][nc]) {
        walls[r][c] &= ~d;
        walls[nr][nc] &= ~OPP[d];
        carve(nr, nc);
      }
    }
  };
  carve(0, 0);
  return walls;
}

export class Maze {
  constructor(rows = 3, cols = 4, rng = Math.random) {
    this.rng = rng;
    this.rows = rows; this.cols = cols;
    this.mazeNum = 1;
    this.walls = generateMaze(rows, cols, rng);
    this.resetPlayer();
  }
  // new_maze: new size, numbering restarts
  newMaze(rows, cols) { this.rows = rows; this.cols = cols; this.mazeNum = 1; this.walls = generateMaze(rows, cols, this.rng); this.resetPlayer(); }
  // reset: same size, next maze
  reset() { this.walls = generateMaze(this.rows, this.cols, this.rng); this.mazeNum += 1; this.resetPlayer(); }
  resetPlayer() { this.pr = 0; this.pc = 0; this.facing = E; this.path = [[0, 0]]; this.won = false; this.bump = false; this.moves = 0; }

  get starRating() {
    const minPath = this.rows + this.cols - 2;
    if (this.moves <= Math.trunc(minPath * 2.5)) return 3;
    if (this.moves <= Math.trunc(minPath * 4.5)) return 2;
    return 1;
  }
  get facingLabel() { return LABEL[this.facing] ?? 'East →'; }
  get facingArrow() { return ARROW[this.facing] ?? '→'; }

  // apply_gesture: returns the feedback text; sets this.bump on a wall hit
  applyGesture(gesture) {
    if (this.won) return 'You already won! Press Reset to play again. 🎉';
    if (gesture === 'swipe_left') { this.facing = TURN_L[this.facing]; this.moves += 1; return `Turned left! Now facing ${LABEL[this.facing]}`; }
    if (gesture === 'swipe_right') { this.facing = TURN_R[this.facing]; this.moves += 1; return `Turned right! Now facing ${LABEL[this.facing]}`; }
    if (gesture === 'push') {
      if (this.walls[this.pr][this.pc] & this.facing) { this.bump = true; return `Oops! There's a wall to the ${LABEL[this.facing].split(' ')[0]}. Try turning!`; }
      this.pr += DR[this.facing]; this.pc += DC[this.facing]; this.moves += 1;
      if (!this.path.some(([r, c]) => r === this.pr && c === this.pc)) this.path.push([this.pr, this.pc]);
      if (this.pr === this.rows - 1 && this.pc === this.cols - 1) { this.won = true; return `🎉 You reached the goal in ${this.moves} moves!`; }
      return `Moved ${LABEL[this.facing].split(' ')[0]}! Keep going!`;
    }
    if (gesture === 'idle') return 'Idle. No move made. Do a swipe or push!';
    return `Unknown gesture: ${gesture}`;
  }
}
