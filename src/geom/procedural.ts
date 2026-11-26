import type { DefectMark, Landmark, MeshData, ScanVariant, Vec3 } from '../types';
import { add, cross, normalize, scale, sub } from '../math/vec';
import { createMesh } from './mesh';

export interface Frames {
  tangents: Vec3[];
  normals: Vec3[];
  binormals: Vec3[];
}

export function computeFrames(points: Vec3[]): Frames {
  const tangents: Vec3[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    tangents.push(normalize(sub(b, a)));
  }
  const normals: Vec3[] = [];
  const binormals: Vec3[] = [];
  let n = normalize(cross([0, 1, 0], tangents[0]));
  if (Math.hypot(...n) < 0.1) n = normalize(cross([1, 0, 0], tangents[0]));
  for (let i = 0; i < points.length; i++) {
    const t = tangents[i];
    let projected = sub(n, scale(t, n[0] * t[0] + n[1] * t[1] + n[2] * t[2]));
    if (Math.hypot(...projected) < 1e-6) projected = normalize(cross([0, 1, 0], t));
    n = normalize(projected);
    const b = normalize(cross(t, n));
    normals.push(n);
    binormals.push(b);
  }
  return { tangents, normals, binormals };
}

function catmull(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1, 2].map(k =>
    0.5 * (
      2 * p1[k] +
      (-p0[k] + p2[k]) * t +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
      (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3
    )
  ) as Vec3;
}

export function controlPoints(variant: ScanVariant): Vec3[] {
  switch (variant) {
    case 'narrow':
      return [
        [0, 5, 19], [0.5, 0, 13], [1.2, -1.5, 8], [3.2, -2.8, 1],
        [2.4, -4.0, -7], [-0.8, -4.7, -14], [-1.8, -3.2, -22], [0, -1.2, -29]
      ];
    case 'sharp-bend':
      return [
        [0, 6, 20], [0, 1, 14], [1.8, -1, 8], [4.8, -2.2, 1],
        [4.2, -4.0, -6], [-7.5, -5.8, -13.5], [-5.2, -2.2, -22], [0.5, -0.8, -30]
      ];
    case 'bubble-damage':
      return [
        [0, 6, 20], [0, 1, 14], [1.2, -1, 8], [3.8, -2.4, 1],
        [3.0, -4.3, -7], [-1.8, -5.1, -15], [-2.8, -3.2, -23], [0, -1.4, -31]
      ];
    default:
      return [
        [0, 6, 20], [0, 1, 14], [1.5, -1, 8], [4.2, -2.5, 1],
        [3.2, -4.2, -7], [-1.5, -5.0, -15], [-2.5, -3.5, -23], [0, -1.5, -31]
      ];
  }
}

export function sampleCenterline(variant: ScanVariant, count = 81): Vec3[] {
  const cp = controlPoints(variant);
  const raw: Vec3[] = [];
  const spans = cp.length - 1;
  const perSpan = Math.ceil(count / spans) + 4;
  for (let i = 0; i < spans; i++) {
    for (let j = 0; j < perSpan; j++) {
      if (i > 0 && j === 0) continue;
      raw.push(catmull(cp[Math.max(0, i - 1)], cp[i], cp[i + 1], cp[Math.min(cp.length - 1, i + 2)], j / perSpan));
    }
  }
  // Resample by arc length to make t mean physical distance fraction.
  const cumulative = [0];
  for (let i = 1; i < raw.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(...sub(raw[i], raw[i - 1])));
  const total = cumulative[cumulative.length - 1];
  const out: Vec3[] = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / (count - 1)) * total;
    while (seg < cumulative.length - 2 && cumulative[seg + 1] < target) seg++;
    const a = cumulative[seg], b = cumulative[seg + 1] ?? total;
    const f = b > a ? (target - a) / (b - a) : 0;
    out.push(add(raw[seg], scale(sub(raw[seg + 1] ?? raw[seg], raw[seg]), f)));
  }
  return out;
}

export const LANDMARK_T = { opening: 0.18, firstBend: 0.405, secondBend: 0.69 };

export function canalRadii(variant: ScanVariant, t: number): { rx: number; ry: number } {
  const narrow = variant === 'narrow' ? 0.58 : 1;
  let rx: number, ry: number;
  if (t < LANDMARK_T.opening) {
    const q = 1 - t / LANDMARK_T.opening;
    rx = 4.8 + 13.5 * q * q;
    ry = 4.3 + 7.2 * q;
    if (variant === 'half-concha' as ScanVariant) rx *= 0.75;
  } else {
    const deep = Math.max(0, (t - 0.72) / 0.28);
    rx = (4.25 - 0.85 * deep + 0.22 * Math.sin(t * 31)) * narrow;
    ry = (3.75 - 0.55 * deep + 0.18 * Math.cos(t * 27)) * narrow;
  }
  const tipTaper = t > 0.91 ? Math.max(0.18, 1 - (t - 0.91) / 0.09 * 0.82) : 1;
  return { rx: rx * tipTaper, ry: ry * tipTaper };
}

interface Pit { t: number; angle: number; dt: number; da: number; depth: number }

function pitsFor(variant: ScanVariant): Pit[] {
  if (variant !== 'bubble-damage') return [];
  return [
    { t: 0.31, angle: 0.7, dt: 0.035, da: 0.28, depth: 1.1 },
    { t: 0.47, angle: 2.4, dt: 0.026, da: 0.22, depth: 0.8 },
    { t: 0.58, angle: 4.1, dt: 0.032, da: 0.25, depth: 1.35 },
    { t: 0.76, angle: 1.5, dt: 0.025, da: 0.2, depth: 0.7 },
    { t: 0.84, angle: 5.2, dt: 0.022, da: 0.18, depth: 0.6 }
  ];
}

function angleDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

export interface GeneratedImpression {
  mesh: MeshData;
  centerline: Vec3[];
  landmarks: Landmark[];
  defects: DefectMark[];
}

export function generateImpression(variant: ScanVariant): GeneratedImpression {
  const centerline = sampleCenterline(variant);
  const frames = computeFrames(centerline);
  const rings = 118;
  const sides = 64;
  const positions: number[] = [];
  const indices: number[] = [];
  const pits = pitsFor(variant);

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const ci = Math.round(t * (centerline.length - 1));
    const c = centerline[ci];
    const n = frames.normals[ci], b = frames.binormals[ci];
    const base = canalRadii(variant, t);
    for (let j = 0; j <= sides; j++) {
      const theta = (j / sides) * Math.PI * 2;
      let factor = 1;
      for (const p of pits) {
        const g = Math.exp(-((t - p.t) ** 2 / (2 * p.dt ** 2) + angleDelta(theta, p.angle) ** 2 / (2 * p.da ** 2)));
        factor -= (p.depth / Math.max(2, base.rx)) * g;
      }
      const irregular = 1 + 0.018 * Math.sin(17 * t + theta * 3) + 0.012 * Math.sin(41 * t - theta * 5);
      const rx = base.rx * factor * irregular;
      const ry = base.ry * factor * irregular;
      const x = c[0] + n[0] * Math.cos(theta) * rx + b[0] * Math.sin(theta) * ry;
      const y = c[1] + n[1] * Math.cos(theta) * rx + b[1] * Math.sin(theta) * ry;
      const z = c[2] + n[2] * Math.cos(theta) * rx + b[2] * Math.sin(theta) * ry;
      positions.push(x, y, z);
    }
  }

  const missingCenter = { t: 0.105, angle: 0.95 };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sides; j++) {
      const t = (i + 0.5) / rings;
      const theta = ((j + 0.5) / sides) * Math.PI * 2;
      const missing = variant === 'bubble-damage' &&
        ((t - missingCenter.t) ** 2 / 0.035 ** 2 + angleDelta(theta, missingCenter.angle) ** 2 / 0.55 ** 2 < 1);
      if (missing) continue;
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // End caps make ray intersection and re-import analysis deterministic.
  const startCenterIndex = positions.length / 3;
  positions.push(...centerline[0]);
  for (let j = 0; j < sides; j++) indices.push(startCenterIndex, j + 1, j);
  const endCenterIndex = positions.length / 3;
  positions.push(...centerline[centerline.length - 1]);
  const endRing = rings * (sides + 1);
  for (let j = 0; j < sides; j++) indices.push(endCenterIndex, endRing + j, endRing + j + 1);

  const mesh = createMesh(positions, indices);
  const pointAt = (t: number): Vec3 => centerline[Math.round(t * (centerline.length - 1))];
  const landmarks: Landmark[] = [
    { id: 'opening', name: '耳道口', position: pointAt(LANDMARK_T.opening), t: LANDMARK_T.opening, editable: true },
    { id: 'first-bend', name: '第一弯', position: pointAt(LANDMARK_T.firstBend), t: LANDMARK_T.firstBend, editable: true },
    { id: 'second-bend', name: '第二弯', position: pointAt(LANDMARK_T.secondBend), t: LANDMARK_T.secondBend, editable: true },
    { id: 'tip', name: '印模顶端', position: pointAt(1), t: 1, editable: true }
  ];

  const defects: DefectMark[] = [];
  if (variant === 'bubble-damage') {
    pits.forEach((p, i) => {
      const ci = Math.round(p.t * (centerline.length - 1));
      const radius = canalRadii(variant, p.t);
      const pos = add(centerline[ci], add(scale(frames.normals[ci], Math.cos(p.angle) * radius.rx), scale(frames.binormals[ci], Math.sin(p.angle) * radius.ry)));
      defects.push({ id: `bubble-${i + 1}`, type: 'bubble', center: pos, radius: 1.1 + i * 0.08, depth: p.depth, note: `气泡/凹坑 ${i + 1}，深 ${p.depth.toFixed(1)} mm` });
    });
    const ci = Math.round(missingCenter.t * (centerline.length - 1));
    const radius = canalRadii(variant, missingCenter.t);
    const pos = add(centerline[ci], add(scale(frames.normals[ci], Math.cos(missingCenter.angle) * radius.rx), scale(frames.binormals[ci], Math.sin(missingCenter.angle) * radius.ry)));
    defects.push({ id: 'missing-1', type: 'missing', center: pos, radius: 4.2, depth: 0, note: '耳甲边缘未取到/缺损区' });
  }

  return { mesh, centerline, landmarks, defects };
}

export const VARIANT_META: Record<ScanVariant, { label: string; description: string }> = {
  normal: { label: '正常耳', description: '耳道半径约 3.8 mm，双弯平滑' },
  narrow: { label: '极窄耳道', description: '全程半径缩小到约 2.2 mm' },
  'sharp-bend': { label: '第二弯很急', description: '第二弯横向急转，用于截短检查' },
  'bubble-damage': { label: '气泡与缺损', description: '五个气泡坑和一块未取到区域' },
  imported: { label: '导入 STL', description: '自动切片分析耳道中心线' }
};
