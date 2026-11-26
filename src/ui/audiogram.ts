import type { Audiogram } from '../types';

export function audiogramSVG(a: Audiogram): string {
  const W = 560, H = 280, L = 54, R = 20, T = 20, B = 42;
  const iw = W - L - R, ih = H - T - B;
  const yMin = -10, yMax = 110;
  const x = (i: number) => L + iw * (i / (a.frequencies.length - 1));
  const y = (v: number) => T + ih * ((v - yMin) / (yMax - yMin));
  const gridVals = [-10, 0, 20, 40, 60, 80, 100];
  const path = (vals: (number | null)[]) => vals.map((v, i) => v === null ? '' : `${vals.slice(0, i).some(z => z !== null) ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const points = (vals: (number | null)[], color: string, shape: 'circle' | 'cross') => vals.map((v, i) => {
    if (v === null) return '';
    if (shape === 'circle') return `<circle cx="${x(i)}" cy="${y(v)}" r="5" fill="#07111e" stroke="${color}" stroke-width="2.5"/>`;
    return `<path d="M${x(i) - 5},${y(v) - 5} L${x(i) + 5},${y(v) + 5} M${x(i) + 5},${y(v) - 5} L${x(i) - 5},${y(v) + 5}" stroke="${color}" stroke-width="2.5"/>`;
  }).join('');
  return `<svg class="audiogram" viewBox="0 0 ${W} ${H}" role="img" aria-label="听力图">
    ${gridVals.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis-text" x="${L - 9}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${a.frequencies.map((f, i) => `<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${T + ih}"/>
      <text class="axis-text" x="${x(i)}" y="${H - 16}" text-anchor="middle">${f >= 1000 ? `${f / 1000}k` : f}</text>`).join('')}
    <text class="axis-text" transform="translate(15 ${T + ih / 2}) rotate(-90)" text-anchor="middle">dB HL</text>
    <path class="left-line" d="${path(a.left)}"/>${points(a.left, '#38bdf8', 'cross')}
    <path class="right-line" d="${path(a.right)}"/>${points(a.right, '#fb7185', 'circle')}
    <g transform="translate(${L + 8},${T + 8})">
      <line x1="0" x2="24" y1="0" y2="0" stroke="#38bdf8" stroke-width="3"/><text class="axis-text" x="31" y="4">左耳</text>
      <line x1="78" x2="102" y1="0" y2="0" stroke="#fb7185" stroke-width="3"/><text class="axis-text" x="109" y="4">右耳</text>
    </g>
  </svg>`;
}
