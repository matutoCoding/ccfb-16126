// 程序化生成测试用耳印模：正常、耳道特别窄、第二弯很急、带气泡缺损
import { Vec3, v3 } from './math';
import { Centerline, Landmark, detectBends } from './centerline';
import { SDF, sdf, union, smoothUnion, subtract } from './sdf';
import { marchingCubes, gridFromBounds } from './marchingCubes';
import { Mesh } from './mesh';

export type ImpressionKind = 'normal' | 'narrow' | 'sharpBend' | 'bubbleDefect';

export interface ImpressionDefect {
  center: Vec3;
  radius: number;
  type: 'bubble' | 'missing';
}

export interface Impression {
  id: string;
  kind: ImpressionKind;
  label: string;
  centerline: Centerline;
  landmarks: Landmark; // 弧长坐标
  landmarkPoints: { aperture: Vec3; firstBend: Vec3; secondBend: Vec3 };
  radiusAt: (s: number) => number;
  defects: ImpressionDefect[];
  field: SDF;
  mesh: Mesh;
  bounds: { min: Vec3; max: Vec3 };
}

// 中心线构造：从耳甲腔（s=0）向耳道内延伸，先过第一弯再过第二弯。
// 引入 Y 向起伏，使两弯位于不同平面，管截面为真正的 3D 立体形状。
function buildCenterline(kind: ImpressionKind): Centerline {
  const pts: Vec3[] = [];
  const seg = kind === 'sharpBend'
    ? [
        [0, 0, 0], [0, 0.6, 4], [0.2, 1.4, 8], [0.8, 2.2, 11],
        [2.6, 2.6, 12.6], [5.2, 2.0, 12.2], [7.4, 0.8, 10.6], [8.6, -0.4, 9.2],
      ]
    : [
        [0, 0, 0], [0, 0.5, 4], [0.3, 1.1, 8], [0.9, 1.7, 11.5],
        [2.0, 2.0, 14], [3.6, 1.8, 15.4], [5.4, 1.2, 15.6], [7.0, 0.4, 14.8],
      ];
  for (const p of seg) pts.push(p as Vec3);
  return new Centerline(pts);
}

function radiusProfile(kind: ImpressionKind): (s: number) => number {
  if (kind === 'narrow') {
    return (s) => {
      // 耳甲腔 5.2mm，进入耳道后急剧收窄到 1.6mm
      if (s < 6) return 5.4 - 0.12 * s;
      return Math.max(1.55, 2.5 - 0.055 * (s - 6));
    };
  }
  return (s) => {
    if (s < 6) return 5.6 - 0.1 * s; // 耳甲腔段
    return Math.max(2.4, 3.6 - 0.05 * (s - 6)); // 耳道段
  };
}

export function generateImpression(kind: ImpressionKind, resolution = 88): Impression {
  const centerline = buildCenterline(kind);
  const radiusAt = radiusProfile(kind);
  const landmarks = detectBends(centerline);
  const id = `imp-${kind}`;

  // 主体：沿中心线变半径管 + 耳甲腔椭球
  let field: SDF = sdf.tubeAlong(centerline, radiusAt);
  const bowl: Vec3 = [0, 0, 1.2];
  field = smoothUnion(field, sdf.sphere(bowl, 5.8), 1.2);
  // 耳甲腔略压扁（解剖形态）
  const bowl2 = sdf.sphere([0.6, 0.4, 2.4], 4.6);
  field = smoothUnion(field, bowl2, 1.0);

  const defects: ImpressionDefect[] = [];
  if (kind === 'bubbleDefect') {
    // 耳道壁上两个气泡坑 + 耳甲腔一处取模缺损
    const s1 = landmarks.firstBend + 2.5;
    const f1 = centerline.frameAt(s1);
    const c1 = v3.add(centerline.pointAt(s1), v3.scale(f1.normal, radiusAt(s1) * 0.85));
    const bubble1: ImpressionDefect = { center: c1, radius: 0.9, type: 'bubble' };
    const s2 = landmarks.secondBend - 2;
    const f2 = centerline.frameAt(s2);
    const c2 = v3.add(centerline.pointAt(s2), v3.scale(f2.binormal, radiusAt(s2) * 0.9));
    const bubble2: ImpressionDefect = { center: c2, radius: 0.65, type: 'bubble' };
    const missing: ImpressionDefect = { center: [-3.4, 1.8, 3.6], radius: 2.1, type: 'missing' };
    defects.push(bubble1, bubble2, missing);
    for (const d of defects) field = subtract(field, sdf.sphere(d.center, d.radius));
  }

  // 末端圆头（管端封口）
  field = union(field, sdf.sphere(centerline.points[centerline.points.length - 1], radiusAt(centerline.totalLen)));

  const bounds = meshBounds(centerline, radiusAt);
  const grid = gridFromBounds(bounds.min, bounds.max, resolution);
  const { mesh } = marchingCubes(field, grid);
  mesh.name = id;

  return {
    id,
    kind,
    label: KIND_LABEL[kind],
    centerline,
    landmarks,
    landmarkPoints: {
      aperture: centerline.pointAt(landmarks.aperture),
      firstBend: centerline.pointAt(landmarks.firstBend),
      secondBend: centerline.pointAt(landmarks.secondBend),
    },
    radiusAt,
    defects,
    field,
    mesh,
    bounds,
  };
}

export const KIND_LABEL: Record<ImpressionKind, string> = {
  normal: '标准耳印模',
  narrow: '窄耳道耳印模',
  sharpBend: '急第二弯耳印模',
  bubbleDefect: '气泡缺损耳印模',
};

function meshBounds(cl: Centerline, radiusAt: (s: number) => number): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const consider = (p: Vec3, r: number) => {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k] - r);
      max[k] = Math.max(max[k], p[k] + r);
    }
  };
  for (let s = 0; s <= cl.totalLen; s += 0.5) consider(cl.pointAt(s), radiusAt(s) + 1);
  consider([0.3, 0.2, 1.8], 7.2); // 耳甲腔
  consider([-3.4, 1.8, 3.6], 2.4); // 缺损区
  return { min, max };
}

export const ALL_KINDS: ImpressionKind[] = ['normal', 'narrow', 'sharpBend', 'bubbleDefect'];
