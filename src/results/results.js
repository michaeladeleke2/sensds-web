// The state behind SensDSv2's Results tab (ui/results_tab.py): prediction
// history, confusion matrix (rows = actual, columns = predicted) and accuracy
// per gesture, updated for every prediction that has an actual gesture, and
// the CSV export.

const pad = n => String(n).padStart(2, '0');
export const hms = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
export const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms(d)}`;
export const fileStamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
export const pct = (v, digits) => `${(v * 100).toFixed(digits)}%`;

export class Results {
  constructor() { this.setClasses([]); this.modelName = null; }

  // set_model_info: new model, new classes, history cleared
  setModel(name, classes) { this.modelName = name; this.setClasses(classes); }
  setClasses(classes) {
    this.classes = [...classes];
    this.history = [];
    this.reset();
  }
  reset() {
    const n = this.classes.length;
    this.matrix = Array.from({ length: n }, () => Array(n).fill(0));
    this.correct = Object.fromEntries(this.classes.map(c => [c, 0]));
    this.total = Object.fromEntries(this.classes.map(c => [c, 0]));
  }
  clear() { this.history = []; this.reset(); }

  // add_prediction
  add({ time, gesture, confidence, threshold, actual, source }) {
    this.history.push({ time, gesture, confidence, threshold, actual, source });
    if (actual !== null && actual !== undefined) {
      const a = this.classes.indexOf(actual), p = this.classes.indexOf(gesture);
      if (a >= 0 && p >= 0) this.matrix[a][p] += 1;                 // ConfusionMatrixWidget.record
      if (a >= 0) {                                                  // AccuracyBarsWidget.record
        this.total[actual] += 1;
        if (actual === gesture) this.correct[actual] += 1;
      }
    }
  }

  summary() {
    const n = this.history.length;
    if (!n) return '';
    const above = this.history.filter(h => h.confidence >= h.threshold).length;
    return `${n} prediction${n !== 1 ? 's' : ''}  ·  ${above} confident  (${pct(above / n, 0)})`;
  }

  // _export_csv: csv.writer (CRLF, minimal quoting)
  csv() {
    const field = v => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const row = cells => cells.map(field).join(',') + '\r\n';
    let out = row(['timestamp', 'mode', 'predicted', 'confidence', 'actual', 'above_threshold']);
    for (const h of this.history)
      out += row([stamp(h.time), h.source, h.gesture, h.confidence.toFixed(4), h.actual || '', h.confidence >= h.threshold ? 'yes' : 'no']);
    return out;
  }
}
