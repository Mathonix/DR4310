/**
 * SVG dial gauge in the spirit of 电机精灵's dashboard: 270° scale, coloured target needle,
 * grey measured needle, measured-value arc. Click / drag on the dial picks a target.
 */
const NS = "http://www.w3.org/2000/svg";
const START = 135, SWEEP = 270; // degrees, screen coords (clockwise, 0 = +x)

export type GaugeOpts = { min: number; max: number; unit: string; decimals?: number; interactive?: boolean; mini?: boolean; label?: string };
export type PickPhase = "start" | "move" | "end";

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (a1 < a0) [a0, a1] = [a1, a0];
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function niceStep(span: number, n: number): number {
  const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
export function fmtNum(v: number, d: number): string {
  if (!Number.isFinite(v)) return "—";
  const s = v.toFixed(d);
  return s === "-0" || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

export class Gauge {
  readonly svg: SVGSVGElement;
  min: number; max: number; unit: string; decimals: number;
  target: number | null = null;
  measured: number | null = null;
  onPick: ((v: number, phase: PickPhase) => void) | null = null;
  private ticks: SVGGElement;
  private valArc: SVGPathElement;
  private tgtNeedle: SVGGElement;
  private mesNeedle: SVGGElement;
  private readout: HTMLElement | null;
  private lbl: HTMLElement | null;
  private dragging = false;
  private R: number;

  constructor(private host: HTMLElement, o: GaugeOpts) {
    this.min = o.min; this.max = o.max; this.unit = o.unit; this.decimals = o.decimals ?? 1;
    const mini = !!o.mini;
    const S = 300, C = 150, R = mini ? 128 : 124;
    this.R = R;
    host.classList.add("gauge-host");
    if (mini) host.classList.add("mini");
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${S} ${S}`);
    svg.setAttribute("class", "gauge-svg");
    svg.setAttribute("role", o.interactive ? "slider" : "img");
    if (o.label) svg.setAttribute("aria-label", o.label);
    const track = document.createElementNS(NS, "path");
    track.setAttribute("d", arcPath(C, C, R, START, START + SWEEP));
    track.setAttribute("class", "g-track");
    track.setAttribute("stroke-width", mini ? "16" : "12");
    svg.appendChild(track);
    this.valArc = document.createElementNS(NS, "path");
    this.valArc.setAttribute("class", "g-val");
    this.valArc.setAttribute("stroke-width", mini ? "16" : "12");
    svg.appendChild(this.valArc);
    this.ticks = document.createElementNS(NS, "g");
    this.ticks.setAttribute("class", "g-ticks");
    svg.appendChild(this.ticks);
    // needles live in the ring between the centre disc and the scale (never over the readout / button)
    const rIn = mini ? 66 : 74;
    if (!mini) {
      const disc = document.createElementNS(NS, "circle");
      disc.setAttribute("cx", String(C)); disc.setAttribute("cy", String(C)); disc.setAttribute("r", String(rIn - 6));
      disc.setAttribute("class", "g-disc");
      svg.appendChild(disc);
    }
    const mk = (cls: string, len: number, w: number) => {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", cls);
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", `M${C + rIn} ${C - 1.5}L${C + len} ${C - w / 2}L${C + len + 9} ${C}L${C + len} ${C + w / 2}L${C + rIn} ${C + 1.5}Z`);
      g.appendChild(p);
      return g;
    };
    this.mesNeedle = mk("g-mes", mini ? R - 30 : R - 34, 6);
    this.tgtNeedle = mk("g-tgt", mini ? R - 22 : R - 18, 8);
    svg.appendChild(this.mesNeedle);
    svg.appendChild(this.tgtNeedle);
    host.prepend(svg);
    this.svg = svg;
    this.readout = host.querySelector(".g-readout");
    this.lbl = host.querySelector(".g-unit");
    if (o.interactive) this.bindPointer();
    this.drawTicks();
    this.render();
  }

  setRange(min: number, max: number, unit: string, decimals = this.decimals): void {
    if (!(max > min)) return;
    this.min = min; this.max = max; this.unit = unit; this.decimals = decimals;
    this.drawTicks();
    this.render();
  }
  setTarget(v: number | null): void { this.target = v; this.render(); }
  setMeasured(v: number | null): void { this.measured = v; this.render(); }

  valueToDeg(v: number): number {
    const u = Math.min(1, Math.max(0, (v - this.min) / (this.max - this.min)));
    return START + u * SWEEP;
  }
  /** Value at an angle (deg, screen coords); the bottom gap snaps to the nearest end. */
  degToValue(deg: number): number {
    let d = ((deg % 360) + 360) % 360;
    if (d < START) d += 360; // 0..135 → 360..495
    let u = (d - START) / SWEEP;
    if (u > 1) u = u - 1 < (360 - SWEEP) / SWEEP / 2 ? 1 : 0; // gap: nearest end
    return this.min + u * (this.max - this.min);
  }

  private drawTicks(): void {
    const C = 150, R = this.R, mini = this.host.classList.contains("mini");
    const span = this.max - this.min;
    const step = niceStep(span, mini ? 4 : 8);
    let html = "";
    const first = Math.ceil(this.min / step) * step;
    for (let v = first; v <= this.max + step * 1e-6; v += step) {
      const a = this.valueToDeg(v);
      const [x0, y0] = polar(C, C, R - (mini ? 12 : 10), a), [x1, y1] = polar(C, C, R - (mini ? 22 : 22), a);
      html += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="maj"/>`;
      if (!mini) {
        const [tx, ty] = polar(C, C, R - 40, a);
        const lab = Math.abs(v) < step * 1e-6 ? "0" : String(+v.toPrecision(4));
        html += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}">${lab}</text>`;
      }
      // minor ticks
      if (!mini) for (let k = 1; k < 5; k++) {
        const vm = v + (step * k) / 5;
        if (vm > this.max) break;
        const am = this.valueToDeg(vm);
        const [a0, b0] = polar(C, C, R - 10, am), [a1, b1] = polar(C, C, R - 16, am);
        html += `<line x1="${a0.toFixed(1)}" y1="${b0.toFixed(1)}" x2="${a1.toFixed(1)}" y2="${b1.toFixed(1)}"/>`;
      }
    }
    this.ticks.innerHTML = html;
  }

  private render(): void {
    const C = 150, R = this.R;
    const zero = this.min <= 0 && this.max >= 0 ? 0 : this.min;
    if (this.measured !== null && Number.isFinite(this.measured)) {
      this.valArc.setAttribute("d", arcPath(C, C, R, this.valueToDeg(zero), this.valueToDeg(this.measured)));
      this.mesNeedle.style.display = "";
      this.mesNeedle.setAttribute("transform", `rotate(${this.valueToDeg(this.measured).toFixed(2)} ${C} ${C})`);
    } else {
      this.valArc.setAttribute("d", "");
      this.mesNeedle.style.display = "none";
    }
    if (this.target !== null && Number.isFinite(this.target)) {
      this.tgtNeedle.style.display = "";
      this.tgtNeedle.setAttribute("transform", `rotate(${this.valueToDeg(this.target).toFixed(2)} ${C} ${C})`);
    } else this.tgtNeedle.style.display = "none";
    this.svg.setAttribute("aria-valuenow", String(this.target ?? ""));
    this.svg.setAttribute("aria-valuemin", String(this.min));
    this.svg.setAttribute("aria-valuemax", String(this.max));
    this.svg.setAttribute("aria-valuetext", `${fmtNum(this.target ?? NaN, this.decimals)} ${this.unit}`);
    if (this.readout) this.readout.textContent = fmtNum(this.measured ?? NaN, this.decimals);
    if (this.lbl) this.lbl.textContent = this.unit;
  }

  private bindPointer(): void {
    const svg = this.svg;
    svg.setAttribute("tabindex", "0");
    const pick = (e: PointerEvent, phase: PickPhase) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 300 - 150, y = ((e.clientY - r.top) / r.height) * 300 - 150;
      if (phase === "start" && Math.hypot(x, y) < 70) return false; // centre: start/stop button area
      const v = this.degToValue((Math.atan2(y, x) * 180) / Math.PI);
      this.onPick?.(v, phase);
      return true;
    };
    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (!pick(e, "start")) return;
      this.dragging = true;
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => { if (this.dragging) pick(e, "move"); });
    const end = (e: PointerEvent) => { if (!this.dragging) return; this.dragging = false; pick(e, "end"); };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", () => { this.dragging = false; });
    svg.addEventListener("keydown", (e) => {
      const step = niceStep(this.max - this.min, 40);
      const cur = this.target ?? 0;
      let v: number | null = null;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") v = cur + step;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") v = cur - step;
      else if (e.key === "Home") v = 0;
      if (v === null) return;
      e.preventDefault();
      this.onPick?.(Math.min(this.max, Math.max(this.min, v)), "end");
    });
  }
}
