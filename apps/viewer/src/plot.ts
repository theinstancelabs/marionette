import { HISTORY_MS } from './store';
import { niceRange, signed, type Sample } from './motion';

export type SeriesId = 'forward' | 'left' | 'up';
export const SERIES: { id: SeriesId; axis: 'x' | 'y' | 'z'; color: string }[] = [
  { id: 'forward', axis: 'x', color: '#cf3f35' }, { id: 'left', axis: 'y', color: '#3f7d4e' }, { id: 'up', axis: 'z', color: '#2f53b5' },
];
/** The time ticks every strip shares, in seconds ago. */
export const TIME_TICKS = [20, 15, 10, 5, 0];

const INK = '#2e3033', INK2 = '#6b6f73', RULE = '#cfd3d6', GRID = '#e6ebf2', PAPER = '#fafaf6';
const FONT = '11.5px "IBM Plex Sans", -apple-system, system-ui, sans-serif';
/** Plot area inside each strip's canvas. The time axis row under the strips uses the same left and right. */
export const PAD = { left: 40, right: 92, top: 7, bottom: 7 };
/** Gap in the data that breaks a line, in ms. */
const GAP_MS = 300;
const STALE_MS = 1500;

/** Index of the sample nearest to time `t` (samples are in time order). */
function nearest(samples: Sample[], t: number): number {
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].t < t) lo = mid; else hi = mid; }
  return Math.abs(samples[lo].t - t) <= Math.abs(samples[hi].t - t) ? lo : hi;
}

type Range = { lo: number; hi: number; step: number };

/**
 * "Position over time" as small multiples: one strip per phone, forward, left
 * and up in mm over the last 20 s. The strips share one frame loop (up to
 * 30 fps), the time axis and the y range, so phones can be compared at a glance.
 */
export class PlotGroup {
  private readonly strips = new Set<PlotStrip>();
  private range: Range = { lo: -10, hi: 10, step: 5 }; private ticks = 4; private shrinkSince = 0;
  private raf = 0; private drawnAt = 0; private disposed = false;
  constructor(private readonly shown: (series: SeriesId) => boolean) {}

  add(strip: PlotStrip) {
    if (this.disposed) return;
    this.strips.add(strip);
    if (!this.raf) { const loop = (time: number) => { if (time - this.drawnAt >= 33) { this.drawnAt = time; this.draw(); } this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop); }
  }
  remove(strip: PlotStrip) {
    this.strips.delete(strip);
    if (!this.strips.size && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  }

  private draw() {
    const now = performance.now(); const series = SERIES.filter(s => this.shown(s.id));
    // y range: grow at once, shrink only after the data has stayed small for 2 s, so the axis does not jitter.
    let min = 0, max = 0, height = Infinity;
    for (const strip of this.strips) {
      height = Math.min(height, strip.plotHeight());
      for (const sample of strip.samples()) for (const s of series) { const v = sample.p[s.axis] * 1000; if (v < min) min = v; if (v > max) max = v; }
    }
    // Short strips get fewer gridlines, so their labels do not collide.
    const ticks = height < 90 ? 2 : 4; const wanted = niceRange(min, max, 20, ticks);
    if (ticks !== this.ticks || wanted.lo < this.range.lo || wanted.hi > this.range.hi) { this.ticks = ticks; this.range = wanted; this.shrinkSince = now; }
    else if (wanted.lo > this.range.lo || wanted.hi < this.range.hi) { if (now - this.shrinkSince > 2000) { this.range = wanted; this.shrinkSince = now; } }
    else this.shrinkSince = now;
    for (const strip of this.strips) strip.draw(now, this.range, series);
  }

  dispose() { this.disposed = true; cancelAnimationFrame(this.raf); this.raf = 0; this.strips.clear(); }
}

/** One phone's strip. Hover or focus it for a crosshair readout; arrow keys move the crosshair. */
export class PlotStrip {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1; private height = 1;
  private hoverX?: number; private cursorAgoMs?: number;
  private readonly resizeObserver: ResizeObserver;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: HTMLElement, private readonly tooltip: HTMLElement, readonly samples: () => Sample[], private readonly name: () => string) {
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.setAttribute('aria-hidden', 'true');
    host.prepend(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host); this.resize();
    const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void) => { host.addEventListener(type, handler); this.cleanup.push(() => host.removeEventListener(type, handler)); };
    on('pointermove', event => { const box = host.getBoundingClientRect(); this.hoverX = event.clientX - box.left; this.cursorAgoMs = undefined; });
    on('pointerleave', () => { this.hoverX = undefined; });
    on('focus', () => { this.cursorAgoMs = 0; });
    on('blur', () => { this.cursorAgoMs = undefined; });
    on('keydown', event => {
      if (this.cursorAgoMs === undefined || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 5000 : 1000;
      this.cursorAgoMs = event.key === 'Home' ? HISTORY_MS : event.key === 'End' ? 0 : Math.max(0, Math.min(HISTORY_MS, this.cursorAgoMs + (event.key === 'ArrowLeft' ? step : -step)));
    });
  }

  plotHeight() { return this.height - PAD.top - PAD.bottom; }

  private resize() {
    const ratio = Math.min(devicePixelRatio, 2);
    this.width = Math.max(1, this.host.clientWidth); this.height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(this.width * ratio); this.canvas.height = Math.round(this.height * ratio);
    this.canvas.style.width = `${this.width}px`; this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  draw(now: number, range: Range, series: typeof SERIES) {
    const { ctx, width, height } = this; const samples = this.samples();
    const x0 = PAD.left, x1 = width - PAD.right, y0 = PAD.top, y1 = height - PAD.bottom;
    const start = now - HISTORY_MS;
    const xOf = (t: number) => x0 + (t - start) / HISTORY_MS * (x1 - x0);
    const { lo, hi, step } = range;
    const yOf = (mm: number) => y1 - (mm - lo) / (hi - lo) * (y1 - y0);

    ctx.clearRect(0, 0, width, height);
    ctx.font = FONT; ctx.lineWidth = 1;
    // Recessive hairline grid; zero is one step darker. Strips too short to label every line label only zero.
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = INK2;
    const labelAll = step / (hi - lo) * (y1 - y0) >= 13;
    for (let v = lo; v <= hi + step / 2; v += step) {
      const y = Math.round(yOf(v)) + 0.5; const zero = Math.abs(v) < step / 2;
      ctx.strokeStyle = zero ? RULE : GRID; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      if (zero || labelAll) ctx.fillText(zero ? '0' : signed(v, step % 1 ? 1 : 0), x0 - 6, y);
    }
    for (const ago of TIME_TICKS.slice(1, -1)) {
      const x = Math.round(x1 - ago / 20 * (x1 - x0)) + 0.5;
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }

    // Series: 2px lines, broken where the frame changes or data stops.
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 4, x1 - x0 + 4, y1 - y0 + 8); ctx.clip();
    ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const s of series) {
      ctx.strokeStyle = s.color; ctx.beginPath(); let previous: Sample | undefined;
      for (const sample of samples) {
        const x = xOf(sample.t), y = yOf(sample.p[s.axis] * 1000);
        if (!previous || previous.key !== sample.key || sample.t - previous.t > GAP_MS) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        previous = sample;
      }
      ctx.stroke();
    }
    ctx.restore();

    // End dots with a paper ring, and direct labels in the gutter (leader lines when they had to move apart).
    const last = samples.at(-1);
    if (last && now - last.t < 1000) {
      const ends = series.map(s => ({ s, value: last.p[s.axis] * 1000, y: yOf(last.p[s.axis] * 1000), labelY: 0 })).sort((a, b) => a.y - b.y);
      const gap = 14; ends.forEach((end, i) => { end.labelY = Math.max(end.y, i ? ends[i - 1].labelY + gap : y0 + 3); });
      for (let i = ends.length - 1; i >= 0; i--) ends[i].labelY = Math.min(ends[i].labelY, i < ends.length - 1 ? ends[i + 1].labelY - gap : y1 - 1);
      const x = xOf(last.t);
      for (const end of ends) {
        this.dot(x, end.y, end.s.color);
        if (Math.abs(end.labelY - end.y) > 2) { ctx.strokeStyle = RULE; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 6, end.y); ctx.lineTo(x1 + 12, end.labelY); ctx.stroke(); }
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = INK2; ctx.fillText(end.s.id, x1 + 14, end.labelY);
        const nameWidth = ctx.measureText(`${end.s.id} `).width;
        ctx.fillStyle = INK; ctx.font = `500 ${FONT}`; ctx.fillText(signed(end.value), x1 + 14 + nameWidth, end.labelY); ctx.font = FONT;
      }
    } else {
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = INK2;
      ctx.fillText(!last ? 'no pose yet' : now - last.t > STALE_MS ? `no pose for ${Math.round((now - last.t) / 1000)} s` : '', x1 + 14, (y0 + y1) / 2);
    }

    // Crosshair: a hairline that snaps to the nearest sample, with every series' value in the tooltip.
    let cursorT: number | undefined;
    if (this.hoverX !== undefined && this.hoverX >= x0 && this.hoverX <= x1) cursorT = start + (this.hoverX - x0) / (x1 - x0) * HISTORY_MS;
    else if (this.cursorAgoMs !== undefined) cursorT = now - this.cursorAgoMs;
    const hit = cursorT !== undefined && samples.length ? samples[nearest(samples, cursorT)] : undefined;
    if (!hit || Math.abs(hit.t - cursorT!) > 500 || !series.length) { this.tooltip.hidden = true; return; }
    const x = Math.round(xOf(hit.t)) + 0.5;
    ctx.strokeStyle = INK2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    for (const s of series) this.dot(x, yOf(hit.p[s.axis] * 1000), s.color);
    this.showTooltip(hit, series, now, x, x0, x1);
  }

  private dot(x: number, y: number, color: string) {
    const { ctx } = this; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = PAPER; ctx.stroke();
  }

  private showTooltip(sample: Sample, series: typeof SERIES, now: number, x: number, x0: number, x1: number) {
    const tip = this.tooltip; tip.hidden = false; tip.replaceChildren();
    const head = document.createElement('div'); head.className = 'tip-head'; head.textContent = `${this.name()}, ${((now - sample.t) / 1000).toFixed(1)} s ago`; tip.append(head);
    for (const s of series) {
      const row = document.createElement('div'); row.className = 'tip-row';
      const key = document.createElement('i'); key.style.background = s.color;
      const value = document.createElement('b'); value.textContent = `${signed(sample.p[s.axis] * 1000, 1)} mm`;
      const name = document.createElement('span'); name.textContent = s.id;
      row.append(key, value, name); tip.append(row);
    }
    const left = x > (x0 + x1) / 2 ? x - tip.offsetWidth - 12 : x + 12;
    // Keep the card inside the plot panel, even from the bottom strip.
    const panel = this.host.closest('.plot') as HTMLElement | null;
    let top = 0;
    if (panel) {
      const offset = this.host.getBoundingClientRect().top - panel.getBoundingClientRect().top;
      top = Math.max(4 - offset, Math.min(0, panel.clientHeight - 4 - offset - tip.offsetHeight));
    }
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  dispose() { this.resizeObserver.disconnect(); this.cleanup.forEach(fn => fn()); this.canvas.remove(); }
}
