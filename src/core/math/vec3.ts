import type { Vec3 } from '../../types';

export const v = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const clone = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 1];
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** 折线按累计弧长重采样为等间距点 */
export function resamplePolyline(points: Vec3[], count: number): Vec3[] {
  if (points.length < 2) return points.map(clone);
  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = dist(points[i - 1], points[i]);
    segLen.push(d);
    total += d;
  }
  const out: Vec3[] = [];
  let seg = 0;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (seg < segLen.length - 1 && acc + segLen[seg] < target) {
      acc += segLen[seg];
      seg++;
    }
    const t = segLen[seg] > 1e-9 ? (target - acc) / segLen[seg] : 0;
    out.push(lerpV(points[seg], points[seg + 1], clamp(t, 0, 1)));
  }
  return out;
}

/** 折线切线 */
export function polylineTangents(points: Vec3[]): Vec3[] {
  return points.map((p, i) => {
    if (i === 0) return normalize(sub(points[1], p));
    if (i === points.length - 1) return normalize(sub(p, points[i - 1]));
    return normalize(sub(points[i + 1], points[i - 1]));
  });
}

/** 点到线段距离 */
export function pointSegmentDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-12), 0, 1);
  return dist(p, add(a, scale(ab, t)));
}

export function pointToPolylineDist(p: Vec3, path: Vec3[]): { dist: number; station: number } {
  let best = Infinity;
  let bestStation = 0;
  let walked = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const ab = sub(path[i + 1], path[i]);
    const segL = length(ab);
    const t = clamp(dot(sub(p, path[i]), ab) / Math.max(dot(ab, ab), 1e-12), 0, 1);
    const d = dist(p, add(path[i], scale(ab, t)));
    if (d < best) {
      best = d;
      bestStation = walked + t * segL;
    }
    walked += segL;
  }
  return { dist: best, station: bestStation };
}
