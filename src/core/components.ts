// 内部排布：受话器/电池仓/面板/放大器芯片按真实尺寸建模，沿中心线摆放，碰撞检测
import { Vec3, v3 } from './math';
import { Centerline } from './centerline';
import { SDF, sdf } from './sdf';
import { Mesh } from './mesh';
import { marchingCubes, gridFromBounds } from './marchingCubes';

export type ComponentKind = 'receiver' | 'battery' | 'faceplate' | 'amplifier';

export interface ComponentSpec {
  kind: ComponentKind;
  label: string;
  // 包围盒半尺寸（mm）
  half: Vec3;
  // 局部 +Z 沿摆放方向
  color: [number, number, number];
}

// 常用器件真实尺寸（典型 ITC/CIC 规格，mm）
export const COMPONENT_LIB: ComponentSpec[] = [
  { kind: 'receiver', label: '受话器', half: [1.5, 1.5, 2.2], color: [0.95, 0.55, 0.2] },
  { kind: 'battery', label: '电池仓 10A', half: [2.0, 2.0, 1.4], color: [0.35, 0.65, 0.95] },
  { kind: 'battery', label: '电池仓 312', half: [2.3, 2.3, 1.7], color: [0.3, 0.55, 0.9] },
  { kind: 'faceplate', label: '面板', half: [3.4, 3.4, 0.5], color: [0.85, 0.85, 0.7] },
  { kind: 'amplifier', label: '放大器芯片', half: [1.3, 1.3, 0.5], color: [0.4, 0.85, 0.45] },
];

export interface PlacedComponent {
  id: string;
  specIndex: number;
  // 中心位置与朝向（局部 Z 轴指向耳道深处）
  center: Vec3;
  axis: Vec3;
  label: string;
}

export function defaultLayout(
  cl: Centerline,
  landmarks: { aperture: number; firstBend: number; secondBend: number },
  radiusAt: (s: number) => number,
): PlacedComponent[] {
  const place = (s: number, specIndex: number, id: string, label: string): PlacedComponent => {
    const ss = Math.max(0.5, Math.min(cl.totalLen - 0.5, s));
    return {
      id,
      specIndex,
      center: cl.pointAt(ss),
      axis: cl.tangentAt(ss),
      label,
    };
  };
  return [
    place(landmarks.firstBend + 1.5, 0, 'rcv', '受话器'),
    place(2.5, 1, 'bat', '电池仓 10A'),
    place(1.0, 3, 'fp', '面板'),
    place(4.5, 4, 'amp', '放大器芯片'),
  ];
}

// 器件 -> SDF（OBB 用圆柱+盒近似，胶囊化避免尖角刺穿检测）
export function componentSDF(c: PlacedComponent, specs: ComponentSpec[]): SDF {
  const spec = specs[c.specIndex];
  const ax = v3.normalize(c.axis);
  // 用轴向圆柱 + 两端半球近似 OBB，碰撞检测偏保守
  const radius = Math.max(spec.half[0], spec.half[1]) * 0.95;
  const halfLen = spec.half[2];
  return sdf.cylinder(c.center, ax, halfLen, radius);
}

export function componentMesh(c: PlacedComponent, specs: ComponentSpec[]): Mesh {
  const spec = specs[c.specIndex];
  const f = componentSDF(c, specs);
  const r = Math.max(spec.half[0], spec.half[1]) + 0.5;
  const min: Vec3 = [c.center[0] - r - spec.half[2], c.center[1] - r, c.center[2] - r];
  const max: Vec3 = [c.center[0] + r + spec.half[2], c.center[1] + r, c.center[2] + r];
  const { mesh } = marchingCubes(f, gridFromBounds(min, max, 24));
  mesh.name = c.id;
  return mesh;
}

export interface Collision {
  a: string;
  b: string;
  point: Vec3;
  penetration: number; // mm
}

// 器件两两碰撞：OBB 保守距离检测
export function detectCollisions(
  placed: PlacedComponent[],
  specs: ComponentSpec[],
): Collision[] {
  const out: Collision[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      const sa = specs[a.specIndex], sb = specs[b.specIndex];
      const ra = Math.max(sa.half[0], sa.half[1]) * 0.95 + sa.half[2];
      const rb = Math.max(sb.half[0], sb.half[1]) * 0.95 + sb.half[2];
      const d = v3.dist(a.center, b.center);
      // 胶囊-胶囊近似
      const ca = v3.scale(v3.normalize(a.axis), sa.half[2]);
      const cb = v3.scale(v3.normalize(b.axis), sb.half[2]);
      const minDist = capsuleDistance(a.center, ca, b.center, cb) +
        Math.max(sa.half[0], sa.half[1]) * 0.95 +
        Math.max(sb.half[0], sb.half[1]) * 0.95;
      if (minDist < 0) {
        out.push({
          a: a.id,
          b: b.id,
          point: v3.lerp(a.center, b.center, 0.5),
          penetration: -minDist,
        });
      }
      void d;
      void ra;
      void rb;
    }
  }
  return out;
}

// 两线段最近距离
function capsuleDistance(pa: Vec3, ha: Vec3, pb: Vec3, hb: Vec3): number {
  const a0 = v3.sub(pa, ha), a1 = v3.add(pa, ha);
  const b0 = v3.sub(pb, hb), b1 = v3.add(pb, hb);
  const u = v3.sub(a1, a0), v = v3.sub(b1, b0), w = v3.sub(a0, b0);
  const a = v3.dot(u, u), b = v3.dot(u, v), c = v3.dot(v, v), d = v3.dot(u, w), e = v3.dot(v, w);
  const denom = a * c - b * b;
  let s = denom ? Math.max(0, Math.min(1, (b * e - c * d) / denom)) : 0;
  let t = denom ? Math.max(0, Math.min(1, (a * e - b * d) / denom)) : 0;
  const p = v3.add(a0, v3.scale(u, s));
  const q = v3.add(b0, v3.scale(v, t));
  return v3.dist(p, q);
}

// 器件与外壳内腔干涉：器件采样点是否落在壳实体内部
export function componentShellCollisions(
  placed: PlacedComponent[],
  specs: ComponentSpec[],
  shellField: SDF,
): { component: string; point: Vec3; depth: number }[] {
  const out: { component: string; point: Vec3; depth: number }[] = [];
  for (const c of placed) {
    const spec = specs[c.specIndex];
    const ax = v3.normalize(c.axis);
    // 选两个近似正交方向
    const ref: Vec3 = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const u = v3.normalize(v3.cross(ax, ref));
    const w = v3.normalize(v3.cross(ax, u));
    const r = Math.max(spec.half[0], spec.half[1]);
    const samples: Vec3[] = [
      c.center,
      v3.add(c.center, v3.scale(ax, spec.half[2])),
      v3.sub(c.center, v3.scale(ax, spec.half[2])),
      v3.add(c.center, v3.scale(u, r)),
      v3.add(c.center, v3.scale(w, r)),
    ];
    for (const p of samples) {
      const d = shellField(p);
      if (d < 0) out.push({ component: c.id, point: p, depth: -d });
    }
  }
  return out;
}
