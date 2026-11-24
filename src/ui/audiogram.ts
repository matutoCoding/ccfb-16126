/** 纯 Canvas 听力图（气导，左右耳标记） */
import { AudiogramPoint } from '../core/types';
import { Side } from '../core/types';

const FREQS = [250, 500, 1000, 2000, 4000, 8000];
const DBS = [-10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110];

export function renderAudiogram(
  canvas: HTMLCanvasElement,
  points: AudiogramPoint[],
  side: Side,
  editable: boolean,
  onChange?: (points: AudiogramPoint[]) => void,
): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 420;
  const h = canvas.clientHeight || 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const padL = 44, padR = 14, padT = 16, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const xOf = (i: number) => padL + (plotW * i) / (FREQS.length - 1);
  const yOf = (db: number) => padT + (plotH * (db - DBS[0])) / (DBS[DBS.length - 1] - DBS[0]);

  ctx.strokeStyle = '#2b3444';
  ctx.fillStyle = '#93a0b4';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i < DBS.length; i++) {
    const y = yOf(DBS[i]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(String(DBS[i]), 8, y + 3);
  }
  for (let i = 0; i < FREQS.length; i++) {
    const x = xOf(i);
    ctx.fillText(FREQS[i] >= 1000 ? `${FREQS[i] / 1000}k` : String(FREQS[i]), x - 8, h - 10);
  }
  ctx.fillStyle = '#e6ebf3';
  ctx.fillText('dB HL', 6, 12);

  const map = new Map(points.map((p) => [p.freqHz, p.db]));
  const series = FREQS.map((f) => map.get(f) ?? 25);
  const color = side === 'right' ? '#ef5b5b' : '#4f9cf9';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((db, i) => {
    const x = xOf(i), y = yOf(db);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  series.forEach((db, i) => {
    const x = xOf(i), y = yOf(db);
    if (side === 'right') {
      // 红圈 O
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
    } else {
      // 蓝叉 X
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
    }
  });

  if (editable && onChange) {
    let dragIdx = -1;
    canvas.onpointerdown = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let best = 0, bd = Infinity;
      series.forEach((db, i) => {
        const d = Math.hypot(xOf(i) - mx, yOf(db) - my);
        if (d < bd) { bd = d; best = i; }
      });
      dragIdx = bd < 20 ? best : -1;
    };
    canvas.onpointermove = (e) => {
      if (dragIdx < 0) return;
      const rect = canvas.getBoundingClientRect();
      const my = e.clientY - rect.top;
      const db = Math.max(DBS[0], Math.min(DBS[DBS.length - 1],
        Math.round((DBS[DBS.length - 1] - DBS[0]) * ((my - padT) / plotH) + DBS[0])));
      series[dragIdx] = db;
      onChange(FREQS.map((f, i) => ({ freqHz: f, db: series[i] })));
    };
    window.addEventListener('pointerup', () => { dragIdx = -1; }, { once: true });
  }
}
