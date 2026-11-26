import type { DefectMark, Landmark, MeshData, Vec3 } from '../types';
import { computeFrames } from './procedural';

interface Slice { center: Vec3; radius: number; count: number }

export function analyzeImpression(mesh: MeshData): { centerline: Vec3[]; landmarks: Landmark[]; defects: DefectMark[] } {
  const p = mesh.positions;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k]);
      max[k] = Math.max(max[k], p[i + k]);
    }
  }
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axis = (size[0] >= size[1] && size[0] >= size[2]) ? 0 : size[1] >= size[2] ? 1 : 2;
  const lo = min[axis], hi = max[axis], span = Math.max(1e-6, hi - lo);

  const endRadius = (atHigh: boolean) => {
    let sx = 0, sy = 0, sz = 0, n = 0;
    const vals: number[] = [];
    for (let i = 0; i < p.length; i += 3) {
      const along = p[i + axis];
      const q = (along - lo) / span;
      if ((atHigh && q > 0.82) || (!atHigh && q < 0.18)) {
        sx += p[i]; sy += p[i + 1]; sz += p[i + 2]; n++;
      }
    }
    if (!n) return 0;
    const c: Vec3 = [sx / n, sy / n, sz / n];
    for (let i = 0; i < p.length; i += 3) {
      const q = (p[i + axis] - lo) / span;
      if ((atHigh && q > 0.82) || (!atHigh && q < 0.18)) {
        vals.push(Math.hypot(p[i] - c[0], p[i + 1] - c[1], p[i + 2] - c[2]));
      }
    }
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length * 0.9)] ?? 0;
  };
  const highBroad = endRadius(true) >= endRadius(false);
  const oriented = (coord: number) => highBroad ? 1 - (coord - lo) / span : (coord - lo) / span;
  const axisCoord = (s: number) => highBroad ? hi - s * span : lo + s * span;

  const K = 72;
  const slices: Slice[] = Array.from({ length: K }, (_, i) => ({ center: [0, 0, 0], radius: 4, count: 0 }));
  for (let v = 0; v < p.length; v += 3) {
    const s = oriented(p[v + axis]);
    const k = Math.max(0, Math.min(K - 1, Math.floor(s * K)));
    const sl = slices[k];
    sl.center[0] += p[v]; sl.center[1] += p[v + 1]; sl.center[2] += p[v + 2]; sl.count++;
  }
  for (let k = 0; k < K; k++) {
    const sl = slices[k];
    if (sl.count > 0) {
      sl.center[0] /= sl.count; sl.center[1] /= sl.count; sl.center[2] /= sl.count;
      sl.center[axis] = axisCoord(k / (K - 1));
    } else {
      const prev = slices[k - 1]?.center;
      const next = slices[k + 1]?.center;
      sl.center = prev && next ? [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2, (prev[2] + next[2]) / 2] : [0, 0, axisCoord(k / (K - 1))];
    }
  }
  for (let k = 0; k < K; k++) {
    const c = slices[k].center;
    const dists: number[] = [];
    for (let v = 0; v < p.length; v += 3) {
      const s = oriented(p[v + axis]);
      const vk = Math.max(0, Math.min(K - 1, Math.floor(s * K)));
      if (Math.abs(vk - k) <= 1) dists.push(Math.hypot(p[v] - c[0], p[v + 1] - c[1], p[v + 2] - c[2]));
    }
    dists.sort((a, b) => a - b);
    slices[k].radius = dists.length ? dists[Math.floor(dists.length * 0.88)] : 3.5;
  }

  const centerline = slices.map(s => s.center);
  const smoothRadius = slices.map((s, i) => {
    const ws = [slices[Math.max(0, i - 2)], slices[Math.max(0, i - 1)], s, slices[Math.min(K - 1, i + 1)], slices[Math.min(K - 1, i + 2)]];
    return ws.reduce((a, x) => a + x.radius, 0) / ws.length;
  });

  let openingT = 0.18;
  for (let k = 4; k < K * 0.45; k++) {
    if (smoothRadius[k] < 6.2 && smoothRadius[k + 2] < 5.8) { openingT = k / (K - 1); break; }
  }

  const frames = computeFrames(centerline);
  const curvature: number[] = [];
  for (let i = 1; i < centerline.length - 1; i++) {
    const a = frames.tangents[i - 1], b = frames.tangents[i + 1];
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    curvature[i] = Math.acos(dot);
  }
  const peakInRange = (a: number, b: number) => {
    let best = Math.floor((a + b) / 2 * K), score = -1;
    for (let i = Math.floor(a * K); i < Math.floor(b * K); i++) {
      const c = curvature[i] ?? 0;
      if (c > score) { score = c; best = i; }
    }
    return best / (K - 1);
  };
  const firstT = peakInRange(openingT + 0.08, 0.56);
  const secondT = peakInRange(0.56, 0.88);
  const at = (t: number) => centerline[Math.round(t * (centerline.length - 1))];

  const landmarks: Landmark[] = [
    { id: 'opening', name: '耳道口', position: at(openingT), t: openingT, editable: true },
    { id: 'first-bend', name: '第一弯', position: at(firstT), t: firstT, editable: true },
    { id: 'second-bend', name: '第二弯', position: at(secondT), t: secondT, editable: true },
    { id: 'tip', name: '印模顶端', position: at(1), t: 1, editable: true }
  ];

  const defects: DefectMark[] = [];
  for (let k = 6; k < K - 6 && defects.filter(d => d.type === 'bubble').length < 5; k++) {
    const baseline = (smoothRadius[k - 4] + smoothRadius[k + 4]) / 2;
    if (slices[k].radius < baseline - 0.75) {
      const center = slices[k].center;
      if (!defects.some(d => Math.hypot(d.center[0] - center[0], d.center[1] - center[1], d.center[2] - center[2]) < 4)) {
        defects.push({
          id: `pit-auto-${k}`, type: 'bubble', center: [...center] as Vec3,
          radius: 1.2, depth: baseline - slices[k].radius, note: `局部凹坑/气泡，半径缩小 ${(baseline - slices[k].radius).toFixed(1)} mm`
        });
      }
    }
  }

  // Boundary edges indicate an unscanned/open patch. Closed caps and watertight scans have none.
  const edgeCounts = new Map<string, { count: number; a: Vec3; b: Vec3 }>();
  const keyOf = (a: number, b: number) => a < b ? `${a}_${b}` : `${b}_${a}`;
  const ip = mesh.indices;
  for (let i = 0; i < ip.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const ia = ip[i + e], ib = ip[i + ((e + 1) % 3)];
      const key = keyOf(ia, ib);
      const cur = edgeCounts.get(key);
      if (cur) cur.count++;
      else edgeCounts.set(key, { count: 1, a: [p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2]], b: [p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2]] });
    }
  }
  const boundary = [...edgeCounts.values()].filter(e => e.count === 1);
  if (boundary.length > 24) {
    const c: Vec3 = [0, 0, 0];
    for (const e of boundary.slice(0, 500)) {
      c[0] += (e.a[0] + e.b[0]) / 2; c[1] += (e.a[1] + e.b[1]) / 2; c[2] += (e.a[2] + e.b[2]) / 2;
    }
    const n = Math.min(500, boundary.length);
    c[0] /= n; c[1] /= n; c[2] /= n;
    defects.push({ id: 'missing-boundary', type: 'missing', center: c, radius: Math.min(8, 2 + Math.sqrt(boundary.length) * 0.18), depth: 0, note: `检测到 ${boundary.length} 条开放边，可能为未取到区域` });
  }

  return { centerline, landmarks, defects };
}
