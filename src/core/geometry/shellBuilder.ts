import type {
  LayoutState,
  MeshData,
  ShellParams,
  Vec3,
} from '../../types';
import {
  mergeMeshes,
  parallelTransportFrames,
  sweepMesh,
  type SweepSection,
} from '../math/mesh';
import { MeshGrid, radialClearance } from '../math/grid';
import {
  add,
  clamp,
  dist,
  lerp,
  normalize,
  scale,
  sub,
} from '../math/vec3';
import type { Landmarks } from '../../types';

export interface ShellSectionData {
  center: Vec3;
  u: Vec3;
  v: Vec3;
  outerRadius: number;
  innerRadius: number;
  station: number; // 距耳道口的弧长 mm
}

export interface ShellBuildResult {
  shellMesh: MeshData;
  outerMesh: MeshData;
  innerMesh: MeshData;
  sections: ShellSectionData[];
  trimLength: number; // 实际保留的耳道长度 mm
  ventPath: Vec3[];
  minWall: number;
  /** 壁厚下限（按材料） */
  wallMin: number;
  warnings: string[];
}

/** 耳模类型默认截短比例（trimStation 语义：保留长度占耳道全长比例） */
export function defaultTrimStation(moldType: string): number {
  switch (moldType) {
    case 'fullConcha':
      return 1.0;
    case 'halfConcha':
      return 0.92;
    case 'canal':
      return 0.78;
    case 'cic':
      return 0.62;
    default:
      return 0.8;
  }
}

export function wallMinFor(material: ShellParams['material'], settings: { wallMinHard: number; wallMinSoftSilicone: number }): number {
  return material === 'softSilicone' ? settings.wallMinSoftSilicone : settings.wallMinHard;
}

/** 在框架平面内、指向 vent 偏移方向的单位向量 */
function frameDirection(u: Vec3, v: Vec3, offset: Vec3): { dir: Vec3; ang: number } {
  const tu: Vec3 = [
    offset[0] * u[0] + offset[1] * u[1] + offset[2] * u[2],
    offset[0] * v[0] + offset[1] * v[1] + offset[2] * v[2],
    0,
  ];
  const l = Math.hypot(tu[0], tu[1]) || 1;
  const n: Vec3 = [tu[0] / l, tu[1] / l, 0];
  return { dir: add(scale(u, n[0]), scale(v, n[1])), ang: Math.atan2(n[1], n[0]) };
}

export function buildShell(
  impression: MeshData,
  landmarks: Landmarks,
  params: ShellParams,
  trimStation: number,
  wallMin: number,
): ShellBuildResult {
  const warnings: string[] = [];
  const grid = new MeshGrid(impression);
  const full = landmarks.centerline;
  const frames = parallelTransportFrames(full);

  // 1) 找耳道口站点索引
  let apertureIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < full.length; i++) {
    const d = dist(full[i], landmarks.aperture);
    if (d < bestD) {
      bestD = d;
      apertureIdx = i;
    }
  }

  // 2) 每站点外半径（对印模表面做径向射线求交）
  const outerRadii: number[] = [];
  for (let i = 0; i < full.length; i++) {
    const r = radialClearance(grid, full[i], frames[i].u, frames[i].v, 16);
    outerRadii.push(r > 0.3 ? r : (outerRadii[i - 1] ?? 2));
  }

  // 3) 截短：保留 [apertureIdx, endIdx]
  const canalSpan = full.length - 1 - apertureIdx;
  const endIdx = clamp(
    Math.round(apertureIdx + canalSpan * clamp(trimStation, 0.25, 1)),
    apertureIdx + 4,
    full.length - 1,
  );

  // 4) 通气孔路径：从耳道口偏移到接近内侧，偏移量随半径自适应
  const ventR = params.ventDiameter / 2;
  const ventOffsetMag = clamp(outerRadii[apertureIdx] * 0.45, ventR + 0.6, outerRadii[apertureIdx] - ventR - 0.4);
  const ventPath: Vec3[] = [];
  for (let i = apertureIdx; i <= endIdx; i++) {
    const mag = ventOffsetMag * clamp((i - apertureIdx) / 3, 0, 1);
    ventPath.push(add(full[i], scale(frames[i].u, mag)));
  }

  // 5) 截面数据（外/内半径），并在通气孔方向削出通道
  const sections: ShellSectionData[] = [];
  let arc = 0;
  let minWall = Infinity;
  for (let i = apertureIdx; i <= endIdx; i++) {
    if (i > apertureIdx) arc += dist(full[i - 1], full[i]);
    const outer = outerRadii[i];
    let inner = outer - params.wallThickness;
    // 通气孔通道：该方向内半径扩到 ventR+间隙，保证管壁独立可排层
    const ventLocal = frameDirection(frames[i].u, frames[i].v, sub(ventPath[Math.min(i - apertureIdx, ventPath.length - 1)], full[i]));
    const ventClearance = ventR + 0.12;
    if (inner < ventClearance * 1.9) inner = Math.max(0.5, inner);
    sections.push({
      center: full[i],
      u: frames[i].u,
      v: frames[i].v,
      outerRadius: outer,
      innerRadius: Math.max(0.45, inner),
      station: arc,
      // ventLocal 挂在附加字段上（见下方构建扫掠时再算一次）
    } as ShellSectionData);
    (sections[sections.length - 1] as ShellSectionData & { ventAng: number }).ventAng = ventLocal.ang;
    minWall = Math.min(minWall, outer - Math.max(0.45, inner));
  }

  // 6) 外表面扫掠（内侧端面封口，耳道口侧开放由面板覆盖）
  const outerSections: SweepSection[] = sections.map((s) => ({
    center: s.center,
    u: s.u,
    v: s.v,
    radius: s.outerRadius,
  }));
  const innerSections: SweepSection[] = sections.map((s) => ({
    center: s.center,
    u: s.u,
    v: s.v,
    radius: s.innerRadius,
  }));
  // 壁面不带端盖：两端环形端面完全由 annularCap 封口，避免重叠几何在深度剥离中产生伪层
  const outerMesh = sweepMesh(outerSections, 28, false, false, false);
  const innerMesh = sweepMesh(innerSections, 28, false, false, true);

  // 7) 内侧端面环封（外端面到内端面），并做倒圆：在端部插入过渡环
  const capMesh = buildAnnularCap(sections[sections.length - 1], params.edgeFillet, true);
  const apertureCap = buildAnnularCap(sections[0], Math.min(params.edgeFillet, params.wallThickness * 0.45), false);

  const shellMesh = mergeMeshes([outerMesh, innerMesh, capMesh, apertureCap]);

  if (minWall < wallMin) {
    warnings.push(`最小壁厚 ${minWall.toFixed(2)}mm 低于材料下限 ${wallMin.toFixed(2)}mm，透视检查中会染红`);
  }
  if (outerRadii[apertureIdx] < ventR + params.wallThickness + 0.5) {
    warnings.push('耳道口空间不足，通气孔与外壁间距过小');
  }

  return {
    shellMesh,
    outerMesh,
    innerMesh,
    sections,
    trimLength: arc,
    ventPath,
    minWall,
    wallMin,
    warnings,
  };
}

/** 环形端面封口 + 边缘倒圆（fillet 段用渐变半径环） */
function buildAnnularCap(s: ShellSectionData, fillet: number, medial: boolean): MeshData {
  const steps = 5;
  const ringDefs: { r: number; center: Vec3 }[] = [];
  const dir = medial ? 1 : -1;
  // 外圆角
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const ang = t * (Math.PI / 2);
    ringDefs.push({
      r: s.outerRadius - fillet * (1 - Math.cos(ang)),
      center: add(s.center, scale(sectionTangent(s), dir * fillet * Math.sin(ang))),
    });
  }
  // 平直环
  ringDefs.push({ r: s.innerRadius + fillet, center: add(s.center, scale(sectionTangent(s), dir * fillet)) });
  // 内圆角
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const ang = t * (Math.PI / 2);
    ringDefs.push({
      r: s.innerRadius + fillet * (1 - Math.sin(ang)),
      center: add(s.center, scale(sectionTangent(s), dir * fillet * (1 - Math.cos(ang)))),
    });
  }
  const sweep: SweepSection[] = ringDefs.map((rd) => ({ center: rd.center, u: s.u, v: s.v, radius: Math.max(0.4, rd.r) }));
  return sweepMesh(sweep, 28, false, false, false);
}

function sectionTangent(s: ShellSectionData): Vec3 {
  return normalize(cross3(s.u, s.v));
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** 沿截面滑条做平面切口（CPU 切网格，切口用扇形封口着色） */
export function clipMeshAtStation(
  mesh: MeshData,
  stationPoint: Vec3,
  planeNormal: Vec3,
): MeshData {
  const n = normalize(planeNormal);
  const positions: number[] = [];
  const indices: number[] = [];
  const vertCache = new Map<string, number>();
  const vert = (p: Vec3): number => {
    const key = `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
    const hit = vertCache.get(key);
    if (hit !== undefined) return hit;
    const id = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    vertCache.set(key, id);
    return id;
  };
  const side = (p: Vec3): number => {
    const d = (p[0] - stationPoint[0]) * n[0] + (p[1] - stationPoint[1]) * n[1] + (p[2] - stationPoint[2]) * n[2];
    return d;
  };
  const capPoints: Vec3[] = [];
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const tri = [idx[i], idx[i + 1], idx[i + 2]];
    const pts: Vec3[] = tri.map((vi) => [p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]] as Vec3);
    const sd = pts.map(side);
    const inside = sd.map((d) => d <= 0);
    if (inside.every(Boolean)) {
      const a = vert(pts[0]);
      const b = vert(pts[1]);
      const c = vert(pts[2]);
      indices.push(a, b, c);
    } else if (!inside.every((x) => !x)) {
      const intersections: Vec3[] = [];
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        if (inside[k] !== inside[k2]) {
          const t = sd[k] / (sd[k] - sd[k2]);
          intersections.push([
            lerp(pts[k][0], pts[k2][0], t),
            lerp(pts[k][1], pts[k2][1], t),
            lerp(pts[k][2], pts[k2][2], t),
          ]);
        }
      }
      const inPts = pts.filter((_, k) => inside[k]);
      const ring = [...inPts, ...intersections];
      if (ring.length >= 3) {
        const ids = ring.map(vert);
        for (let k = 1; k < ids.length - 1; k++) indices.push(ids[0], ids[k], ids[k + 1]);
      }
      for (const ip of intersections) capPoints.push(ip);
    }
  }
  // 切口封口：同一平面上的交点做扇形（质心 + 环）
  if (capPoints.length >= 3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const q of capPoints) {
      cx += q[0];
      cy += q[1];
      cz += q[2];
    }
    const centroid: Vec3 = [cx / capPoints.length, cy / capPoints.length, cz / capPoints.length];
    // 按平面内角度排序，避免扇形穿插
    const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const ex = normalize(cross3(ref, n));
    const ey = cross3(n, ex);
    capPoints.sort((a, b) => {
      const aa = Math.atan2((a[1] - centroid[1]) * ey[0] + (a[2] - centroid[2]) * ey[1] + (a[0] - centroid[0]) * ey[2],
        (a[0] - centroid[0]) * ex[0] + (a[1] - centroid[1]) * ex[1] + (a[2] - centroid[2]) * ex[2]);
      const bb = Math.atan2((b[1] - centroid[1]) * ey[0] + (b[2] - centroid[2]) * ey[1] + (b[0] - centroid[0]) * ey[2],
        (b[0] - centroid[0]) * ex[0] + (b[1] - centroid[1]) * ex[1] + (b[2] - centroid[2]) * ex[2]);
      return aa - bb;
    });
    const cId = vert(centroid);
    const ringIds = capPoints.map(vert);
    for (let k = 0; k < ringIds.length; k++) {
      indices.push(cId, ringIds[k], ringIds[(k + 1) % ringIds.length]);
    }
  }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(indices) };
}

/** 生成内部排布的默认器件（真实尺寸，沿中心线摆放） */
export function defaultLayout(
  sections: ShellSectionData[],
  params: ShellParams,
  existing?: LayoutState,
): LayoutState {
  if (existing && existing.components.length > 0) return existing;
  if (sections.length < 6) {
    return { components: [], soundTubePath: [], ventPath: [], collisions: [] };
  }
  const n = sections.length;
  const aperture = sections[0];
  const tan = normalize(cross3(aperture.u, aperture.v));

  // 按截面可用内半径自适应微型器件尺寸（真实 ITC/CIC 器件量级，单位 mm）
  const minInner = Math.min(...sections.map((s) => s.innerRadius));
  const fitRadius = (base: number): number => Math.max(0.55, Math.min(base, minInner * 0.62));
  const receiverR = fitRadius(1.35);
  const batteryR = fitRadius(1.25);
  const ampHalf = Math.max(0.5, Math.min(0.9, minInner * 0.42));

  // 四个器件放在互不重叠的站点上，横向偏移不超过 (内半径 - 器件半径)
  const fitLateral = (station: number, r: number, dir: Vec3): Vec3 => {
    const s = sections[Math.min(station, n - 1)];
    const maxLat = Math.max(0, s.innerRadius - r - 0.15);
    return scale(dir, Math.min(maxLat, s.innerRadius * 0.35));
  };
  const place = (
    kind: LayoutState['components'][number]['kind'],
    label: string,
    station: number,
    size: LayoutState['components'][number]['size'],
    dir: Vec3,
  ) => {
    const idx = Math.min(station, n - 1);
    const s = sections[idx];
    const r = size.radius ?? Math.max(size.width ?? 1, size.height ?? 1) / 2;
    return {
      id: `comp_${kind}`,
      kind,
      label,
      size,
      center: add(s.center, fitLateral(idx, r, dir)),
      axis: tan,
    };
  };
  const components: LayoutState['components'] = [
    place('receiver', '受话器', Math.floor(n * 0.62),
      { radius: receiverR, length: 3.6 }, aperture.v),
    place('battery', '电池仓(A10微型)', Math.floor(n * 0.2),
      { radius: batteryR, length: 2.6 }, scale(aperture.u, -1)),
    place('amplifier', '放大器芯片', Math.floor(n * 0.4),
      { width: ampHalf * 2, height: ampHalf * 1.5, depth: 1.0 }, scale(aperture.v, -1)),
    place('faceplate', '面板', 0,
      { width: aperture.outerRadius * 1.5, height: aperture.outerRadius * 1.3, depth: 0.8 }, [0, 0, 0]),
  ];
  // 声管：受话器出声面 -> 内侧末端，沿中心线小偏移
  const receiver = components[0];
  const end = sections[n - 1];
  const soundTubePath: Vec3[] = [
    add(receiver.center, scale(tan, receiver.size.length! / 2)),
    add(sections[Math.floor(n * 0.8)].center, scale(sections[0].v, Math.min(0.4, minInner * 0.2))),
    add(end.center, scale(sections[0].v, Math.min(0.3, minInner * 0.15))),
  ];
  return {
    components,
    soundTubePath,
    ventPath: [],
    collisions: [],
  };
}
