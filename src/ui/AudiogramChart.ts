import type { Audiogram } from '../types';
import { h } from './dom';

const FREQS = [125, 250, 500, 1000, 2000, 4000, 8000];
const DB_MIN = -10;
const DB_MAX = 120;

/** 纯 Canvas 听力图：气导(红○)/骨导(蓝[)，可点击或拖动修改 */
export class AudiogramChart {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private data: Audiogram;
  private editing: 'ac' | 'bc' = 'ac';
  private onChange: (a: Audiogram) => void;

  constructor(data: Audiogram, onChange: (a: Audiogram) => void) {
    this.data = structuredClone(data);
    this.onChange = onChange;
    this.el = h('div', { class: 'audiogram' });
    this.canvas = h('canvas', { width: '520', height: '320' }) as HTMLCanvasElement;
    const toolbar = h('div', { class: 'audiogram-toolbar' },
      h('button', {
        class: `btn ${this.editing === 'ac' ? 'btn-primary' : 'btn-ghost'}`,
        onclick: () => { this.editing = 'ac'; this.syncButtons(); },
      }, '气导 AC（红○）'),
      h('button', {
        class: `btn ${this.editing === 'bc' ? 'btn-primary' : 'btn-ghost'}`,
        onclick: () => { this.editing = 'bc'; this.syncButtons(); },
      }, '骨导 BC（蓝[）'),
    );
    this.el.append(toolbar, this.canvas);
    this.canvas.addEventListener('pointerdown', this.onPointer);
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons === 1) this.onPointer(e);
    });
    this.draw();
  }

  private syncButtons(): void {
    const btns = this.el.querySelectorAll('button');
    btns[0].className = `btn ${this.editing === 'ac' ? 'btn-primary' : 'btn-ghost'}`;
    btns[1].className = `btn ${this.editing === 'bc' ? 'btn-primary' : 'btn-ghost'}`;
  }

  private xOf(freq: number): number {
    const idx = FREQS.indexOf(freq);
    const padL = 48;
    const padR = 16;
    const w = this.canvas.width - padL - padR;
    return padL + (idx / (FREQS.length - 1)) * w;
  }

  private yOf(db: number): number {
    const padT = 18;
    const padB = 34;
    const h = this.canvas.height - padT - padB;
    return padT + ((db - DB_MIN) / (DB_MAX - DB_MIN)) * h;
  }

  private onPointer = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    let nearestFreq = FREQS[0];
    let nearestX = Infinity;
    for (const f of FREQS) {
      const d = Math.abs(this.xOf(f) - x);
      if (d < nearestX) {
        nearestX = d;
        nearestFreq = f;
      }
    }
    const padT = 18;
    const padB = 34;
    const h = this.canvas.height - padT - padB;
    const db = Math.round(((y - padT) / h) * (DB_MAX - DB_MIN) + DB_MIN / 1) ;
    const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db));
    const series = this.editing === 'ac' ? this.data.ac : this.data.bc;
    const existing = series.find((p) => p.freqHz === nearestFreq);
    if (existing) existing.dbHL = clamped;
    else series.push({ freqHz: nearestFreq, dbHL: clamped });
    series.sort((a, b) => a.freqHz - b.freqHz);
    this.draw();
    this.onChange(structuredClone(this.data));
  };

  private draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#141a22';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = '#2a3340';
    ctx.fillStyle = '#8fa0b3';
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    // 网格
    for (let db = DB_MIN; db <= DB_MAX; db += 10) {
      const y = this.yOf(db);
      ctx.beginPath();
      ctx.moveTo(48, y);
      ctx.lineTo(this.canvas.width - 16, y);
      ctx.stroke();
      ctx.fillText(String(db), 8, y + 4);
    }
    for (const f of FREQS) {
      const x = this.xOf(f);
      ctx.beginPath();
      ctx.moveTo(x, 18);
      ctx.lineTo(x, this.canvas.height - 34);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x - 10, this.canvas.height - 14);
    }
    this.plotSeries(this.data.ac, '#ff6b6b', 'circle');
    this.plotSeries(this.data.bc, '#5aa9ff', 'bracket');
  }

  private plotSeries(series: Audiogram['ac'], color: string, shape: 'circle' | 'bracket'): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    const pts = series.filter((p) => FREQS.includes(p.freqHz)).sort((a, b) => a.freqHz - b.freqHz);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = this.xOf(p.freqHz);
      const y = this.yOf(p.dbHL);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (const p of pts) {
      const x = this.xOf(p.freqHz);
      const y = this.yOf(p.dbHL);
      ctx.beginPath();
      if (shape === 'circle') {
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.moveTo(x - 5, y - 5);
        ctx.lineTo(x - 5, y + 5);
        ctx.moveTo(x - 5, y);
        ctx.lineTo(x + 3, y);
        ctx.stroke();
      }
    }
  }
}

export function emptyAudiogram(): Audiogram {
  return {
    ac: FREQS.map((freqHz) => ({ freqHz, dbHL: 40 })),
    bc: FREQS.map((freqHz) => ({ freqHz, dbHL: 35 })),
  };
}
