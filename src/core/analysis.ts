/**
 * 工程分析：
 *  - 器件 / 通气孔 / 声管 / 壳体内壁碰撞
 *  - 第二弯插入通过性（刚性器件过弯几何）与建议截短量
 *  - CPU 射线壁厚参考实现（与 GPU 逐像素结果对标的 ground truth）
 */
import { Mesh, rayMeshAllHits } from './geometry';
import { Ray } from './math';
import {
  Vec3, add3, cross3, dist3, dot3, lerp3, norm3, scale3, sub3, transformPoint4, Mat4,
} from './math';
import { DeviceInstance, ShellDesign, VentSpec, SoundTubeSpec } from './types';
import { StationFrame } from './shellgen';

export interface CollisionReport {
  collisions: Array<{
    kind: 'device-wall' | 'device-device' | 'device-tube' | 'tube-tube';
    message: string;
    position: Vec3;
    gap: number; // 负=穿透 mm
  }>;
}

/** OBB（有向包围盒），由器件位置/欧拉角/尺寸生成 */
export interface OBB {
  center: Vec3;
  axes: Vec3[]; // 三个单位轴
  half: Vec3;   // 三轴半长
  corners: Vec3[];
}

function rotMatrix(euler: Vec3): Mat4 {
  const [rx, ry, rz] = euler;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rz * Ry * Rx，列主序 3x3 填入 4x4
  const m = new Float32Array(16);
  m[0] = cy * cz; m[4] = cz * sy * sx - sz * cx; m[8] = cz * sy * cx + sz * sx;
  m[1] = sz * cy; m[5] = sz * sy * sx + cz * cx; m[9] = sz * sy * cx - cz * sx;
  m[2] = -sy;     m[6] = cy * sx;                  m[10] = cy * cx;
  m[15] = 1;
  return m;
}

export function makeOBB(d: DeviceInstance): OBB {
  const r = rotMatrix(d.rotation);
  const axes: Vec3[] = [
    norm3([r[0], r[1], r[2]]),
    norm3([r[4], r[5], r[6]]),
    norm3([r[8], r[9], r[10]]),
  ];
  const half: Vec3 = [d.size[0] / 2, d.size[1] / 2, d.size[2] / 2];
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    let p: Vec3 = [0, 0, 0];
    const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1, sz = i & 4 ? 1 : -1;
    p = add3(p, scale3(axes[0], half[0] * sx));
    p = add3(p, scale3(axes[1], half[1] * sy));
    p = add3(p, scale3(axes[2], half[2] * sz));
    corners.push(add3(d.position, p));
  }
  return { center: d.position, axes, half, corners };
}

/** SAT 有向盒相交，返回穿透深度（0 表示分离） */
export function obbOverlap(a: OBB, b: OBB): number {
  const axes = [...a.axes, ...b.axes];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const c = cross3(a.axes[i], b.axes[j]);
    if (dot3(c, c) > 1e-10) axes.push(norm3(c));
  }
  let minOverlap = Infinity;
  for (const ax of axes) {
    let ra = 0, rb = 0;
    for (let k = 0; k < 3; k++) {
      ra += a.half[k] * Math.abs(dot3(a.axes[k], ax));
      rb += b.half[k] * Math.abs(dot3(b.axes[k], ax));
    }
    const sep = Math.abs(dot3(sub3(b.center, a.center), ax));
    const overlap = ra + rb - sep;
    if (overlap <= 0) return 0;
    minOverlap = Math.min(minOverlap, overlap);
  }
  return minOverlap;
}

function pointToPolyline(p: Vec3, path: Vec3[]): { d: number; nearest: Vec3 } {
  let best = Infinity, nearest: Vec3 = path[0];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], c = path[i + 1];
    const ac = sub3(c, a);
    const t = Math.max(0, Math.min(1, dot3(sub3(p, a), ac) / (dot3(ac, ac) || 1)));
    const q = lerp3(a, c, t);
    const d = dist3(p, q);
    if (d < best) { best = d; nearest = q; }
  }
  return { d: best, nearest };
}

function obbSamplePoints(obb: OBB, perEdge = 3): Vec3[] {
  // 8 角 + 每条棱上的内插点，用于与管路/内壁的距离检测
  const pts = [...obb.corners];
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      const diff = sub3(obb.corners[j], obb.corners[i]);
      const sameAxis = diff.filter((v) => Math.abs(v) < 1e-6).length === 2;
      if (!sameAxis) continue;
      for (let k = 1; k < perEdge; k++) pts.push(lerp3(obb.corners[i], obb.corners[j], k / perEdge));
    }
  }
  pts.push(obb.center);
  return pts;
}

/** 点相对内腔：到中心线最近站的内半径余量（负=穿墙） */
function wallClearance(p: Vec3, frames: StationFrame[], innerRadii: number[][]): { gap: number; station: number } {
  let best = Infinity, bi = 0;
  for (let s = 0; s < frames.length; s++) {
    const d = dist3(p, frames[s].center);
    if (d < best) { best = d; bi = s; }
  }
  const f = frames[bi];
  const dVec = sub3(p, f.center);
  const ang = Math.atan2(dot3(dVec, f.binormal), dot3(dVec, f.normal));
  const j = ((Math.round((ang / (Math.PI * 2)) * innerRadii[bi].length) % innerRadii[bi].length) + innerRadii[bi].length) % innerRadii[bi].length;
  return { gap: innerRadii[bi][j] - best, station: bi };
}

export function checkCollisions(
  design: ShellDesign,
  frames: StationFrame[],
  innerRadii: number[][],
): CollisionReport {
  const report: CollisionReport = { collisions: [] };
  const obbs = design.devices.map((d) => ({ d, obb: makeOBB(d) }));

  // 器件-内壁
  for (const { d, obb } of obbs) {
    let worst: { gap: number; station: number; p: Vec3 } | null = null;
    for (const p of obbSamplePoints(obb)) {
      const c = wallClearance(p, frames, innerRadii);
      if (!worst || c.gap < worst.gap) worst = { ...c, p };
    }
    if (worst && worst.gap < 0.15) {
      report.collisions.push({
        kind: 'device-wall',
        message: `「${d.name}」${worst.gap < 0 ? `穿透壳壁 ${(-worst.gap).toFixed(2)}mm` : `距内壁仅 ${worst.gap.toFixed(2)}mm`}`,
        position: worst.p,
        gap: worst.gap,
      });
    }
  }

  // 器件-器件
  for (let i = 0; i < obbs.length; i++) {
    for (let j = i + 1; j < obbs.length; j++) {
      const overlap = obbOverlap(obbs[i].obb, obbs[j].obb);
      if (overlap > 0) {
        report.collisions.push({
          kind: 'device-device',
          message: `「${obbs[i].d.name}」与「${obbs[j].d.name}」碰撞，穿透 ${overlap.toFixed(2)}mm`,
          position: scale3(add3(obbs[i].obb.center, obbs[j].obb.center), 0.5),
          gap: -overlap,
        });
      }
    }
  }

  // 器件-管路（通气孔/声管）
  const tubes: Array<{ spec: VentSpec | SoundTubeSpec; label: string }> = [];
  if (design.vent) tubes.push({ spec: design.vent, label: '通气孔' });
  if (design.soundTube) tubes.push({ spec: design.soundTube, label: '声管' });
  for (const { d, obb } of obbs) {
    for (const t of tubes) {
      const tr = t.spec.diameterMm / 2;
      let worst: { d: number; nearest: Vec3 } | null = null;
      for (const p of obbSamplePoints(obb, 2)) {
        const q = pointToPolyline(p, t.spec.path);
        if (!worst || q.d < worst.d) worst = q;
      }
      if (worst && worst.d < tr + 0.1) {
        report.collisions.push({
          kind: 'device-tube',
          message: `「${d.name}」与${t.label}${worst.d < tr ? '相交' : '间距不足'}（间距 ${Math.max(0, worst.d - tr).toFixed(2)}mm）`,
          position: worst.nearest,
          gap: worst.d - tr,
        });
      }
    }
  }
  return report;
}

/** 中心线离散曲率半径 */
export function bendRadii(centerline: Vec3[]): Array<{ station: number; radius: number; point: Vec3 }> {
  const out: Array<{ station: number; radius: number; point: Vec3 }> = [];
  for (let i = 1; i < centerline.length - 1; i++) {
    const p0 = centerline[i - 1], p1 = centerline[i], p2 = centerline[i + 1];
    const d1 = sub3(p1, p0), d2 = sub3(p2, p1);
    const cross = cross3(d1, d2);
    const denom = Math.hypot(cross[0], cross[1], cross[2]);
    if (denom < 1e-9) { out.push({ station: i, radius: Infinity, point: p1 }); continue; }
    const r = (len(d1) * len(d2) * len(sub3(p2, p0))) / (2 * denom);
    out.push({ station: i, radius: r, point: p1 });
  }
  return out;
}

function len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export interface InsertionCheck {
  pass: boolean;
  stuckPoints: Array<{ station: number; point: Vec3; required: number; available: number }>;
  /** 建议新的 medial 端站号与对应截短长度 mm */
  suggestedTrimStation: number;
  suggestedTrimLengthMm: number;
  minBendRadiusMm: number;
}

/**
 * 过弯检查：把最长刚性器件（受话器/电池）视为长度 L、半径 r 的圆柱。
 * 弦长 L 的刚性段沿曲率半径 R 的曲线运动时，中部外扫量 ≈ L²/(8R)，
 * 所需通道半径 = r + 外扫量；与各站实际内腔半径比较。
 */
export function checkInsertion(
  centerline: Vec3[],
  _frames: StationFrame[],
  innerRadii: number[][],
  design: ShellDesign,
  stationRange: [number, number],
): InsertionCheck {
  const rigid = design.devices
    .filter((d) => d.kind === 'receiver' || d.kind === 'battery')
    .sort((a, b) => Math.max(...b.size) - Math.max(...a.size))[0];
  const radii = bendRadii(centerline);
  const minBend = Math.min(...radii.filter((r) => isFinite(r.radius)).map((r) => r.radius));

  const stuck: InsertionCheck['stuckPoints'] = [];
  if (rigid) {
    const L = Math.max(...rigid.size);
    const r = Math.min(...rigid.size) / 2;
    const [lo, hi] = stationRange;
    for (const br of radii) {
      if (br.station < lo || br.station > hi) continue;
      const sweep = isFinite(br.radius) ? (L * L) / (8 * br.radius) : 0;
      const required = r + sweep;
      const available = Math.min(...innerRadii[br.station]);
      if (available < required) {
        stuck.push({ station: br.station, point: centerline[br.station], required, available });
      }
    }
  }
  let suggestedStation = stationRange[1];
  let trimLen = 0;
  if (stuck.length) {
    // 截到最早卡点之前一站
    suggestedStation = Math.max(stationRange[0] + 2, Math.min(...stuck.map((s) => s.station)) - 1);
    for (let s = suggestedStation; s < stationRange[1]; s++) trimLen += dist3(centerline[s], centerline[s + 1]);
  }
  return {
    pass: stuck.length === 0,
    stuckPoints: stuck,
    suggestedTrimStation: suggestedStation,
    suggestedTrimLengthMm: trimLen,
    minBendRadiusMm: minBend,
  };
}

// ---------------- CPU 射线壁厚参考 ----------------

export interface WallSample {
  station: number;
  angle: number;
  thicknessMm: number;
  point: Vec3;
}

/**
 * 从中心线各站沿径向发射射线穿过壳体网格，
 * 命中点两两配对得到每段壁厚（与 GPU 逐像素方法同源但独立实现）。
 */
export function radialWallThickness(
  shell: Mesh,
  frames: StationFrame[],
  stationRange: [number, number],
  anglesPerStation = 24,
): WallSample[] {
  const [lo, hi] = stationRange;
  const out: WallSample[] = [];
  for (let s = lo; s <= hi; s++) {
    const f = frames[s];
    for (let j = 0; j < anglesPerStation; j++) {
      const ang = (Math.PI * 2 * j) / anglesPerStation;
      const dir = norm3(add3(scale3(f.normal, Math.cos(ang)), scale3(f.binormal, Math.sin(ang))));
      const origin = add3(f.center, scale3(dir, 0.05));
      const ray: Ray = { origin, dir };
      const hits = rayMeshAllHits(shell, ray);
      // 命中应为偶数：外入-内出-内入-外出 → 配对 (0,1) 与 (2,3)
      for (let k = 0; k + 1 < hits.length; k += 2) {
        const thickness = hits[k + 1] - hits[k];
        if (thickness > 0.05 && thickness < 8) {
          out.push({
            station: s,
            angle: ang,
            thicknessMm: thickness,
            point: add3(origin, scale3(dir, hits[k])),
          });
        }
      }
    }
  }
  return out;
}

/** 单像素视线的完整层段（供 GPU 对标测试直接调用） */
export function rayLayers(shell: Mesh, ray: Ray): Array<{ t0: number; t1: number; thickness: number }> {
  const hits = rayMeshAllHits(shell, ray);
  const layers = [];
  for (let k = 0; k + 1 < hits.length; k += 2) {
    layers.push({ t0: hits[k], t1: hits[k + 1], thickness: hits[k + 1] - hits[k] });
  }
  return layers;
}

/** 把局部坐标点用模型矩阵变换（管路/器件坐标与壳同一局部系，预留用） */
export function applyModel(m: Mat4, p: Vec3): Vec3 {
  return transformPoint4(m, p);
}
