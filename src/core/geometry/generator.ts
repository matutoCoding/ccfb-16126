import type { DefectMark, Landmarks, MeshData, Vec3 } from '../../types';
import {
  parallelTransportFrames,
  sweepMesh,
  type SweepSection,
} from '../math/mesh';
import { clamp, dist, lerp, lerpV, normalize, resamplePolyline, sub } from '../math/vec3';
import { uid } from '../storage/idb';

export type ImpressionKind = 'normal' | 'narrow' | 'sharpBend' | 'bubbleDefect';

export const IMPRESSION_KIND_LABEL: Record<ImpressionKind, string> = {
  normal: '正常耳道',
  narrow: '耳道特别窄',
  sharpBend: '第二弯很急',
  bubbleDefect: '带气泡缺损',
};

export interface GeneratedImpression {
  kind: ImpressionKind;
  mesh: MeshData;
  landmarks: Landmarks;
  defects: DefectMark[];
  centerline: Vec3[];
}

interface GenParams {
  canalLength: number;
  conchaLength: number;
  canalRadius: number;
  conchaRadius: number;
  firstBendAngle: number; // 弧度
  firstBendStation: number;
  secondBendAngle: number;
  secondBendStation: number;
  secondBendAxis: Vec3;
  bubbles: { center: Vec3; radius: number; depth: number }[];
  missing?: { center: Vec3; radius: number };
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function rotateAxis(p: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2];
  const cx = axis[1] * p[2] - axis[2] * p[1];
  const cy = axis[2] * p[0] - axis[0] * p[2];
  const cz = axis[0] * p[1] - axis[1] * p[0];
  return [
    p[0] * c + cx * s + axis[0] * d * (1 - c),
    p[1] * c + cy * s + axis[1] * d * (1 - c),
    p[2] * c + cz * s + axis[2] * d * (1 - c),
  ];
}

/** 按弯折参数积分出中心线 */
function buildCenterline(p: GenParams, stationCount = 64): Vec3[] {
  const total = p.canalLength + p.conchaLength;
  const dz = total / (stationCount - 1);
  const pts: Vec3[] = [[0, 0, -p.conchaLength]];
  let pos: Vec3 = [0, 0, -p.conchaLength];
  for (let i = 1; i < stationCount; i++) {
    const z = -p.conchaLength + i * dz;
    const a1 = p.firstBendAngle * smoothstep((z - p.firstBendStation) / 3.5);
    const a2 = p.secondBendAngle * smoothstep((z - p.secondBendStation) / 2.5);
    let t: Vec3 = [0, 0, 1];
    t = rotateAxis(t, [0, 1, 0], a1);
    t = rotateAxis(t, p.secondBendAxis, a2);
    pos = [pos[0] + t[0] * dz, pos[1] + t[1] * dz, pos[2] + t[2] * dz];
    pts.push(pos);
  }
  return pts;
}

/** 站点半径：耳甲腔大、耳道收窄、向内渐细 */
function radiusAt(z: number, p: GenParams): number {
  if (z >= 0) {
    const t = clamp(z / p.canalLength, 0, 1);
    return p.canalRadius * (1 - 0.18 * t);
  }
  const t = clamp(1 + z / p.conchaLength, 0, 1); // 0 在耳道口, 1 在耳甲底
  return lerp(p.canalRadius * 1.05, p.conchaRadius, smoothstep(t));
}

function baseParams(kind: ImpressionKind): GenParams {
  const base: GenParams = {
    canalLength: 22,
    conchaLength: 6,
    canalRadius: 3.2,
    conchaRadius: 7.5,
    firstBendAngle: (28 * Math.PI) / 180,
    firstBendStation: 7,
    secondBendAngle: (38 * Math.PI) / 180,
    secondBendStation: 14,
    secondBendAxis: [1, 0, 0],
    bubbles: [],
  };
  switch (kind) {
    case 'narrow':
      return { ...base, canalRadius: 1.7, conchaRadius: 6.2 };
    case 'sharpBend':
      return {
        ...base,
        secondBendAngle: (72 * Math.PI) / 180,
        secondBendStation: 13,
        canalLength: 20,
      };
    case 'bubbleDefect':
      return {
        ...base,
        bubbles: [
          { center: [1.2, 0.6, 6.5], radius: 1.6, depth: 1.1 },
          { center: [-0.8, -1.0, 12.5], radius: 1.1, depth: 0.8 },
        ],
        missing: { center: [2.0, 1.5, -3.2], radius: 2.6 },
      };
    default:
      return base;
  }
}

/** 在表面顶点上压出气泡坑（向坑心内陷），并切出缺损开口 */
function applyDefects(mesh: MeshData, p: GenParams): void {
  for (const bubble of p.bubbles) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const v: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      const d = dist(v, bubble.center);
      if (d < bubble.radius) {
        const falloff = 0.5 * (1 + Math.cos((Math.PI * d) / bubble.radius));
        const dir = normalize(sub(bubble.center, v));
        const shift = bubble.depth * falloff;
        mesh.positions[i] += dir[0] * shift;
        mesh.positions[i + 1] += dir[1] * shift;
        mesh.positions[i + 2] += dir[2] * shift;
      }
    }
  }
  if (p.missing) {
    cutSphere(mesh, p.missing.center, p.missing.radius);
  }
}

/** 删除球心范围内的三角片，制造开放边界（印模未取到的部分） */
function cutSphere(mesh: MeshData, center: Vec3, radius: number): void {
  const keep: boolean[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      const vi = mesh.indices[i + k] * 3;
      cx += mesh.positions[vi];
      cy += mesh.positions[vi + 1];
      cz += mesh.positions[vi + 2];
    }
    const centroid: Vec3 = [cx / 3, cy / 3, cz / 3];
    keep.push(dist(centroid, center) > radius);
  }
  const newIndices: number[] = [];
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) {
      newIndices.push(mesh.indices[i * 3], mesh.indices[i * 3 + 1], mesh.indices[i * 3 + 2]);
    }
  }
  mesh.indices = Uint32Array.from(newIndices);
}

export function generateImpression(kind: ImpressionKind): GeneratedImpression {
  const params = baseParams(kind);
  const centerline = buildCenterline(params);
  const frames = parallelTransportFrames(centerline);
  const sections: SweepSection[] = centerline.map((c, i) => {
    const z = -params.conchaLength + (i * (params.canalLength + params.conchaLength)) / (centerline.length - 1);
    return { center: c, u: frames[i].u, v: frames[i].v, radius: radiusAt(z, params) };
  });
  const mesh = sweepMesh(sections, 28, true, true, false);
  applyDefects(mesh, params);

  // 真值标志点：按生成参数从中心线上取
  const stationPoint = (z: number): Vec3 => {
    const idx = clamp(
      Math.round(((z + params.conchaLength) / (params.canalLength + params.conchaLength)) * (centerline.length - 1)),
      0,
      centerline.length - 1,
    );
    return centerline[idx];
  };
  const landmarks: Landmarks = {
    aperture: stationPoint(0),
    firstBend: stationPoint(params.firstBendStation + 1.5),
    secondBend: stationPoint(params.secondBendStation + 1.2),
    centerline: resamplePolyline(centerline, 48),
  };
  const defects: DefectMark[] = [
    ...params.bubbles.map((b) => ({
      id: uid('def'),
      kind: 'bubble' as const,
      position: b.center,
      radius: b.radius,
      note: '气泡坑（表面内陷）',
    })),
  ];
  if (params.missing) {
    defects.push({
      id: uid('def'),
      kind: 'missing',
      position: params.missing.center,
      radius: params.missing.radius,
      note: '印模未取到的缺损开口',
    });
  }
  return { kind, mesh, landmarks, defects, centerline };
}

/** 沿中心线参数返回切线（弯折走向检查用） */
export function centerlineTangents(points: Vec3[]): Vec3[] {
  return points.map((p, i) => {
    if (i === 0) return normalize(sub(points[1], p));
    if (i === points.length - 1) return normalize(sub(p, points[i - 1]));
    return normalize(sub(points[i + 1], points[i - 1]));
  });
}

/** 折线累计转向角，返回每站点累计角度(弧度) */
export function cumulativeTurning(points: Vec3[]): number[] {
  const tans = centerlineTangents(points);
  const out = new Array<number>(points.length).fill(0);
  let acc = 0;
  for (let i = 1; i < tans.length; i++) {
    const d = clamp(tans[i - 1][0] * tans[i][0] + tans[i - 1][1] * tans[i][1] + tans[i - 1][2] * tans[i][2], -1, 1);
    acc += Math.acos(d);
    out[i] = acc;
  }
  return out;
}

/** 中心线两点间弧长 */
export function arcLength(points: Vec3[], from = 0, to = points.length - 1): number {
  let total = 0;
  for (let i = from + 1; i <= to; i++) total += dist(points[i - 1], points[i]);
  return total;
}

export function stationAtDistance(points: Vec3[], distance: number): { index: number; point: Vec3 } {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const d = dist(points[i - 1], points[i]);
    if (acc + d >= distance) {
      const t = d > 1e-9 ? (distance - acc) / d : 0;
      return { index: i, point: lerpV(points[i - 1], points[i], t) };
    }
    acc += d;
  }
  return { index: points.length - 1, point: points[points.length - 1] };
}
