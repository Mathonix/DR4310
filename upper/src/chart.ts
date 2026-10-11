/** Lightweight canvas strip chart with min/max decimation (no dependencies). */
export type Series = { name: string; color: string; visible: boolean; t: Float64Array; y: Float32Array; head: number; count: number };

export const PALETTE = Array.from({ length: 16 }, (_, i) => `var(--series-${i})`);

/** Canvas does not resolve CSS variables, unlike the legend's inline styles. */
export function chartColor(color: string, css: Pick<CSSStyleDeclaration, "getPropertyValue">): string {
  const variable = /^var\((--[\w-]+)\)$/.exec(color);
  return variable ? css.getPropertyValue(variable[1]).trim() || "#64748B" : color;
}

export class StripChart {
  series: Series[] = [];
  windowSec = 10;
  paused = false;
  private ctx: CanvasRenderingContext2D;
  private dirty = true;
  private pauseAt = 0;

  constructor(private canvas: HTMLCanvasElement, private unit = "", private capacity = 40000) {
    this.ctx = canvas.getContext("2d")!;
  }

  addSeries(name: string, color: string, visible = true): number {
    this.series.push({
      name, color, visible,
      t: new Float64Array(this.capacity), y: new Float32Array(this.capacity), head: 0, count: 0,
    });
    return this.series.length - 1;
  }

  push(idx: number, t: number, y: number): void {
    const s = this.series[idx];
    if (!s || !Number.isFinite(y)) return;
    s.t[s.head] = t;
    s.y[s.head] = y;
    s.head = (s.head + 1) % this.capacity;
    if (s.count < this.capacity) s.count++;
    this.dirty = true;
  }

  clear(): void {
    for (const s of this.series) { s.head = 0; s.count = 0; }
    this.dirty = true;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.pauseAt = performance.now();
    this.dirty = true;
  }

  markDirty(): void { this.dirty = true; }

  draw(now = performance.now()): void {
    if (!this.dirty && this.paused) return;
    this.dirty = false;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(50, Math.floor(c.clientWidth * dpr));
    const ch = Math.max(50, Math.floor(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const ctx = this.ctx;
    const css = getComputedStyle(document.documentElement);
    const textCol = css.getPropertyValue("--muted").trim() || "#8e8e93";
    const gridCol = css.getPropertyValue("--border-soft").trim() || "rgba(60,60,67,.12)";
    ctx.clearRect(0, 0, cw, ch);
    const tEnd = this.paused ? this.pauseAt : now;
    const tStart = tEnd - this.windowSec * 1000;
    const padL = 54 * dpr, padR = 8 * dpr, padT = 8 * dpr, padB = 18 * dpr;
    const W = cw - padL - padR, H = ch - padT - padB;

    // y range
    let lo = Infinity, hi = -Infinity;
    for (const s of this.series) {
      if (!s.visible) continue;
      for (let k = 0; k < s.count; k++) {
        const i = (s.head - 1 - k + this.capacity) % this.capacity;
        const t = s.t[i]!;
        if (t < tStart) break;
        if (t > tEnd) continue;
        const v = s.y[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    if (hi - lo < 1e-6) { const m = Math.abs(hi) * 0.1 + 0.1; lo -= m; hi += m; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const yOf = (v: number) => padT + H - ((v - lo) / (hi - lo)) * H;

    // grid
    ctx.font = `${11 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillStyle = textCol;
    ctx.strokeStyle = gridCol;
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const v = lo + ((hi - lo) * g) / 4;
      const y = yOf(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(fmt(v), padL - 4 * dpr, y);
    }
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(`${this.windowSec}s ${this.unit}`, padL, ch - 2 * dpr);
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = textCol; ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(padL, yOf(0)); ctx.lineTo(padL + W, yOf(0)); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // series: per-pixel-column min/max
    const cols = Math.max(1, Math.floor(W));
    const mn = new Float32Array(cols), mx = new Float32Array(cols), has = new Uint8Array(cols);
    for (const s of this.series) {
      if (!s.visible || s.count === 0) continue;
      mn.fill(Infinity); mx.fill(-Infinity); has.fill(0);
      for (let k = 0; k < s.count; k++) {
        const i = (s.head - 1 - k + this.capacity) % this.capacity;
        const t = s.t[i]!;
        if (t < tStart) break;
        if (t > tEnd) continue;
        const col = Math.min(cols - 1, Math.floor(((t - tStart) / (tEnd - tStart)) * cols));
        const v = s.y[i]!;
        if (v < mn[col]!) mn[col] = v;
        if (v > mx[col]!) mx[col] = v;
        has[col] = 1;
      }
      ctx.strokeStyle = chartColor(s.color, css);
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      let started = false;
      for (let x = 0; x < cols; x++) {
        if (!has[x]) continue;
        const px = padL + x;
        if (!started) { ctx.moveTo(px, yOf(mn[x]!)); started = true; } else ctx.lineTo(px, yOf(mn[x]!));
        if (mx[x] !== mn[x]) ctx.lineTo(px, yOf(mx[x]!));
      }
      ctx.stroke();
    }
  }
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
