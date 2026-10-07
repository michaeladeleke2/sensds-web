// Minimal event emitter, standing in for the desktop's Qt signals

export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
    return () => this.handlers.get(name)?.delete(fn);
  }
  emit(name, ...args) {
    for (const fn of [...(this.handlers.get(name) ?? [])]) {
      try { fn(...args); } catch (e) { console.error(`${name} handler failed`, e); }
    }
  }
}
