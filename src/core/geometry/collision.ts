import type {
  CollisionReport,
  LayoutState,
  PlacedComponent,
  Vec3,
} from '../../types';
import type { ShellSectionData } from './shellBuilder';
import {
  add,
  clamp,
  dist,
  lerpV,
  normalize,
  pointToPolylineDist,
  scale,
  sub,
} from '../math/vec3';
import { uid } from '../storage/idb';

/** 器件在站点处的等效外伸半径（圆柱取 radius，盒体取半对角线） */
function componentRadius(c: PlacedComponent): number {
  if (c.size.radius !== undefined) return c.size.radius;
  const { width = 0, height = 0 } = c.size;
  return Math.hypot(width, height) / 2;
}

/** 内部排布碰撞检查：器件-壳体、器件-器件、管路-器件 */
export function checkCollisions(layout: LayoutState, sections: ShellSectionData[]): CollisionReport[] {
  const reports: CollisionReport[] = [];
  const sectionAt = (p: Vec3): ShellSectionData | null => {
    let best = sections[0];
    let bd = Infinity;
    for (const s of sections) {
      const d = dist(s.center, p);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return bd < best.outerRadius * 3 ? best : null;
  };

  // 器件 vs 壳体内壁（内半径即允许空间）
  for (const c of layout.components) {
    if (c.kind === 'faceplate') continue; // 面板在耳道口，允许外露
    const s = sectionAt(c.center);
    if (!s) continue;
    const r = componentRadius(c);
    const lateral = dist(s.center, c.center);
    const available = s.innerRadius - 0.05;
    if (lateral + r > available) {
      reports.push({
        id: uid('col'),
        kind: 'component-shell',
        message: `${c.label} 与壳体内壁干涉 ${(lateral + r - available).toFixed(2)}mm`,
        position: c.center,
        severity: 'error',
      });
    }
  }

  // 器件两两相交（先做外接球快速剔除，再用轴向胶囊体收紧判定）
  for (let i = 0; i < layout.components.length; i++) {
    for (let j = i + 1; j < layout.components.length; j++) {
      const a = layout.components[i];
      const b = layout.components[j];
      if (a.kind === 'faceplate' || b.kind === 'faceplate') continue; // 面板在耳道口与器件邻接属正常
      const ra = componentRadius(a);
      const rb = componentRadius(b);
      const centerDist = dist(a.center, b.center);
      if (centerDist >= ra + rb) continue; // 外接球不相交则无碰撞
      // 收紧：沿各自轴向的胶囊距离
      const axisGap = Math.abs(centerDist * 0) + Math.max(
        0,
        centerDist - ((a.size.length ?? 0) + (b.size.length ?? 0)) / 2 * 0.35,
      );
      if (axisGap < ra + rb) {
        reports.push({
          id: uid('col'),
          kind: 'component-component',
          message: `${a.label} 与 ${b.label} 空间重叠`,
          position: lerpV(a.center, b.center, 0.5),
          severity: 'error',
        });
      }
    }
  }

  // 声管/通气孔 vs 器件
  const tubeCheck = (path: Vec3[], label: string, kind: CollisionReport['kind']) => {
    if (path.length < 2) return;
    for (const c of layout.components) {
      if (c.kind === 'faceplate') continue; // 管路穿过面板属正常结构
      const { dist: d, station } = pointToPolylineDist(c.center, path);
      if (d < componentRadius(c) + 0.55) {
        const p = pathPointAt(path, station);
        reports.push({
          id: uid('col'),
          kind,
          message: `${label} 与 ${c.label} 间距仅 ${d.toFixed(2)}mm`,
          position: p,
          severity: d < componentRadius(c) ? 'error' : 'warning',
        });
      }
    }
  };
  tubeCheck(layout.soundTubePath, '声管', 'tube-component');
  tubeCheck(layout.ventPath, '通气孔', 'tube-component');
  if (layout.soundTubePath.length >= 2 && layout.ventPath.length >= 2) {
    for (const p of layout.ventPath) {
      const r = pointToPolylineDist(p, layout.soundTubePath);
      if (r.dist < 1.0) {
        reports.push({
          id: uid('col'),
          kind: 'tube-vent',
          message: `通气孔与声管间距 ${r.dist.toFixed(2)}mm（建议 ≥1mm）`,
          position: p,
          severity: r.dist < 0.6 ? 'error' : 'warning',
        });
        break;
      }
    }
  }
  return reports;
}

function pathPointAt(path: Vec3[], distance: number): Vec3 {
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const d = dist(path[i - 1], path[i]);
    if (acc + d >= distance) return lerpV(path[i - 1], path[i], (distance - acc) / Math.max(d, 1e-9));
    acc += d;
  }
  return path[path.length - 1];
}

export interface InsertionCheckResult {
  pass: boolean;
  /** 卡住的点（中心线站点） */
  stuckPoints: { position: Vec3; station: number; clearance: number; required: number; message: string }[];
  /** 建议截短后的保留长度 mm */
  suggestedTrimLength: number;
  totalLength: number;
  /** 第二弯处最小通过间隙 */
  minClearance: number;
  requiredDiameter: number;
}

/**
 * 第二弯通过性检查（耳道式/深耳道式重点）：
 * 把壳体视为沿中心线滑动的刚体，逐站点检查截面外轮廓是否能通过后续弯道。
 */
export function checkInsertionPath(
  sections: ShellSectionData[],
  shellRadiusProfile: number[],
  secondBendPoint: Vec3,
): InsertionCheckResult {
  const total = sections.length;
  let bendIdx = 0;
  let bd = Infinity;
  for (let i = 0; i < total; i++) {
    const d = dist(sections[i].center, secondBendPoint);
    if (d < bd) {
      bd = d;
      bendIdx = i;
    }
  }

  // 切线转向
  const tangentAt = (i: number): Vec3 => {
    const a = sections[Math.max(0, i - 1)].center;
    const b = sections[Math.min(total - 1, i + 1)].center;
    return normalize(sub(b, a));
  };

  const stuck: InsertionCheckResult['stuckPoints'] = [];
  let minClearance = Infinity;
  // 刚体最大半径（壳前段，进入弯道的部分）
  const rigidRadius = Math.max(...shellRadiusProfile.slice(0, Math.max(2, bendIdx + 1)));
  const requiredDiameter = rigidRadius * 2;

  for (let i = Math.max(2, bendIdx - 3); i < total - 1; i++) {
    const t0 = tangentAt(i - 1);
    const t1 = tangentAt(i + 1);
    const cosA = clamp(t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2], -1, 1);
    const bendAngle = Math.acos(cosA);
    // 弯道处几何通过条件：外半径 + 刚体在弯内侧的侵占量 <= 该处印模可用半径
    // 侵占量近似 rigidRadius * (1 - cos(bendAngle))
    const intrusion = rigidRadius * (1 - Math.cos(bendAngle));
    const required = rigidRadius + intrusion + 0.15; // 0.15mm 安全间隙
    const available = sections[i].outerRadius;
    minClearance = Math.min(minClearance, available - rigidRadius);
    if (required > available) {
      stuck.push({
        position: sections[i].center,
        station: sections[i].station,
        clearance: available,
        required,
        message: `第二弯区段通过需 ${required.toFixed(2)}mm，实际间隙 ${available.toFixed(2)}mm`,
      });
    }
  }

  let suggested = sections[total - 1].station;
  if (stuck.length > 0) {
    // 建议：截到第一个卡点前 2mm
    const firstStation = stuck[0].station;
    suggested = Math.max(sections[0].station + 4, firstStation - 2);
  }
  return {
    pass: stuck.length === 0,
    stuckPoints: stuck,
    suggestedTrimLength: suggested,
    totalLength: sections[total - 1].station,
    minClearance,
    requiredDiameter,
  };
}

/** 声管理论长度（订单用） */
export function tubeLength(path: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += dist(path[i - 1], path[i]);
  return total;
}

export function offsetPath(path: Vec3[], dir: Vec3, amount: number): Vec3[] {
  return path.map((p) => add(p, scale(normalize(dir), amount)));
}
