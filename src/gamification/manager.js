// XP, levels and badges, as SensDSv2 ui/gamification.py GamificationManager:
//   single prediction +10 XP, RoboSoccer gesture +15 XP, maze solved +25 XP
//   (+15 for three stars, +5 for two). Like the desktop, progress lasts for
//   the session only.

// [min_xp, display name, accent color]
export const LEVELS = [
  [0, 'Beginner', '#95a5a6'],
  [100, 'Explorer', '#3498db'],
  [300, 'Intermediate', '#2ecc71'],
  [600, 'Advanced', '#f39c12'],
  [1000, 'Expert', '#9b59b6'],
];

// key -> [emoji, short name, description]
export const BADGES = {
  first_prediction: ['🔍', 'First Look', 'Made your first gesture prediction!'],
  high_five: ['🖐️', 'High Five', 'Made 5 predictions!'],
  confident_one: ['🎯', 'Sharp Eye', 'Got 80 %+ confidence on a prediction!'],
  on_fire: ['🔥', 'On Fire', 'Made 20 predictions!'],
  soccer_rookie: ['⚽', 'Soccer Rookie', 'First RoboSoccer gesture!'],
  soccer_pro: ['🥅', 'Soccer Pro', '10 RoboSoccer gestures!'],
  maze_rookie: ['🌀', 'Maze Rookie', 'Solved your first maze!'],
  maze_explorer: ['🗺️', 'Maze Explorer', 'Solved 3 mazes!'],
  maze_master: ['🏆', 'Maze Master', 'Solved 5 mazes!'],
  three_stars: ['⭐', 'Perfect Run', 'Solved a maze with 3 stars!'],
  speed_run: ['⚡', 'Speed Runner', 'Solved a maze in ≤ 10 moves!'],
};

export class GamificationManager {
  // on: { xpChanged(xp, levelIdx), badgeEarned(key), levelUp(levelIdx) }
  constructor(on = {}) {
    this.on = on;
    this.xp = 0;
    this.levelIdx = 0;
    this.badges = new Set();
    this.predictionCount = 0;
    this.soccerCount = 0;
    this.mazesSolved = 0;
  }

  static levelForXp(xp) {
    let idx = 0;
    LEVELS.forEach(([threshold], i) => { if (xp >= threshold) idx = i; });
    return idx;
  }

  addXp(amount) {
    const old = this.levelIdx;
    this.xp += amount;
    this.levelIdx = GamificationManager.levelForXp(this.xp);
    this.on.xpChanged?.(this.xp, this.levelIdx);
    if (this.levelIdx > old) this.on.levelUp?.(this.levelIdx);
  }

  award(key) {
    if (!this.badges.has(key) && key in BADGES) {
      this.badges.add(key);
      this.on.badgeEarned?.(key);
    }
  }

  onPrediction(gesture, confidence) {
    this.predictionCount += 1;
    this.addXp(10);
    if (this.predictionCount === 1) this.award('first_prediction');
    if (this.predictionCount >= 5) this.award('high_five');
    if (this.predictionCount >= 20) this.award('on_fire');
    if (confidence >= 0.80) this.award('confident_one');
  }

  onSoccerGesture() {
    this.soccerCount += 1;
    this.addXp(15);
    if (this.soccerCount === 1) this.award('soccer_rookie');
    if (this.soccerCount >= 10) this.award('soccer_pro');
  }

  onMazeSolved(stars, moves) {
    this.mazesSolved += 1;
    this.addXp(25 + ({ 3: 15, 2: 5, 1: 0 }[stars] ?? 0));
    if (this.mazesSolved === 1) this.award('maze_rookie');
    if (this.mazesSolved >= 3) this.award('maze_explorer');
    if (this.mazesSolved >= 5) this.award('maze_master');
    if (stars === 3) this.award('three_stars');
    if (moves <= 10) this.award('speed_run');
  }

  // [xp_start, xp_end] for the current level band
  get levelXpRange() {
    const start = LEVELS[this.levelIdx][0];
    const end = this.levelIdx + 1 < LEVELS.length ? LEVELS[this.levelIdx + 1][0] : LEVELS[LEVELS.length - 1][0] + 500;
    return [start, end];
  }
}
