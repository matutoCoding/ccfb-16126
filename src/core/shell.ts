// 外壳设计：在耳印 SDF 上向内偏移出壁厚，沿中心线截短，截面边缘倒圆，
// 声管/通气孔按路径做布尔减。硬壳与软硅胶壁厚下限不同。
import { Vec3, v3, clamp } from './math';
import { Centerline, Landmark } from './centerline';
import {
  SDF, sdf, union, intersect, subtract, smoothSubtract, smoothUnion, polylineTube,
  GridSDF,
} from './sdf';
import { marchingCubes, gridFromBounds, GridSpec } from './marchingCubes';
import { Mesh } from './mesh';
import { Impression } from './impression';

export type ShellMaterial = 'hard' | 'soft';

// 行业经验壁厚下限（mm）：硬壳 0.8，软硅胶 1.2
export const WALL_LIMIT: Record<ShellMaterial, number> = {
  hard: 0.8,
  soft: 1.2,
};

export const MATERIAL_LABEL: Record<ShellMaterial, string> = {
  hard: '硬壳（亚克力）',
  soft: '软硅胶',
};

export interface ShellDesignParams {
  material: ShellMaterial;
  wallThickness: number; // 名义壁厚 mm
  trimS: number; // 沿中心线截短位置（弧长 mm，从耳道口向内）
  edgeRadius: number; // 截面边缘倒圆半径 mm
  ventDiameter: number; // 通气孔直径 mm（1~3）
  soundTubeDiameter: number; // 声管外径 mm
  faceplateS: number; // 面板位置（弧长 mm）
  ventPath: Vec3[]; // 通气孔路径（世界坐标折线）
  soundPath: Vec3[]; // 声管路径
}

export interface ShellDesignResult {
  mesh: Mesh;
  innerMesh: Mesh; // 内腔参考网格
  params: ShellDesignParams;
  grid: GridSpec;
  field: SDF;
  wallLimit: number;
}

export function defaultParams(imp: Impression): ShellDesignParams {
  const lm = imp.landmarks;
  const cl = imp.centerline;
  // 默认在第二弯稍前截短；并保证至少在第一弯之后 2.5mm、距末端至少 2mm
  const upper = cl.totalLen - 2;
  const lower = lm.firstBend + 2.5;
  const trimS = clamp(Math.min(lm.secondBend - 1, upper), lower, Math.max(lower, upper));
  const ventPath = buildDefaultVent(imp, 1.6);
  const soundPath = buildDefaultSoundTube(imp);
  return {
    material: 'hard',
    wallThickness: 1.2,
    trimS,
    edgeRadius: 0.6,
    ventDiameter: 1.6,
    soundTubeDiameter: 1.4,
    faceplateS: 2.0,
    ventPath,
    soundPath,
  };
}

// 通气孔默认路径：沿中心线偏一侧，从面板到受话器附近
export function buildDefaultVent(imp: Impression, diameter: number): Vec3[] {
  const cl = imp.centerline;
  const end = clamp(imp.landmarks.firstBend + 2, 0, cl.totalLen - 1);
  const pts: Vec3[] = [];
  const count = 8;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const s = 1.5 + (end - 1.5) * t;
    const fr = cl.frameAt(s);
    const off = v3.scale(fr.normal, imp.radiusAt(s) * 0.45);
    pts.push(v3.add(cl.pointAt(s), off));
  }
  return pts;
}

// 声管默认路径：沿中心走，从面板到近尖端
export function buildDefaultSoundTube(imp: Impression): Vec3[] {
  const cl = imp.centerline;
  const end = clamp(cl.totalLen - 2.5, 0, cl.totalLen);
  const pts: Vec3[] = [];
  const count = 10;
  for (let i = 0; i < count; i++) {
    const s = 1.0 + (end - 1.0) * (i / (count - 1));
    pts.push(cl.pointAt(s));
  }
  return pts;
}

// 主设计函数。impressionField 为耳印外形 SDF（生成印模为解析场，导入 STL 为网格 SDF）
export function designShell(
  impressionField: SDF,
  imp: Impression,
  params: ShellDesignParams,
  resolution = 96,
  onProgress?: (r: number) => void,
): ShellDesignResult {
  const wallLimit = WALL_LIMIT[params.material];
  const cl = imp.centerline;

  // 1) 外壁 = 耳印面（向内留一点打磨余量 0.15mm）
  const outer: SDF = (p) => impressionField(p) + 0.15;

  // 2) 内腔 = 外壁再向内偏移一个壁厚
  const cavity: SDF = (p) => outer(p) + params.wallThickness;

  // 3) 沿中心线截短：trimS 处的法平面，保留 s <= trimS 一侧
  const trimPoint = cl.pointAt(params.trimS);
  const trimNormal = cl.tangentAt(params.trimS); // 指向耳道深处
  const keepTrim: SDF = sdf.halfSpace(trimPoint, v3.neg(trimNormal)); // 负侧保留
  // 面板侧裁剪
  const facePoint = cl.pointAt(params.faceplateS);
  const faceNormal = cl.tangentAt(params.faceplateS);
  const keepFace: SDF = sdf.halfSpace(facePoint, faceNormal);

  // 4) 壳体 = 外壁实体 减去 内腔，再被两个裁剪面夹住
  let shell: SDF = intersect(subtract(outer, cavity), keepTrim);
  shell = intersect(shell, keepFace);

  // 5) 截面边缘倒圆：把内腔与裁剪面做平滑差，让内边圆顺
  const trimRound: SDF = smoothSubtract(shell, sdf.halfSpace(trimPoint, trimNormal), params.edgeRadius);
  const faceRound: SDF = smoothSubtract(trimRound, sdf.halfSpace(facePoint, v3.neg(faceNormal)), params.edgeRadius);
  shell = faceRound;

  // 6) 声管与通气孔布尔减（带端帽，保证是封闭实体）
  if (params.soundPath.length >= 2) {
    const tube = polylineTube(params.soundPath, params.soundTubeDiameter / 2);
    shell = subtract(shell, tube);
  }
  if (params.ventPath.length >= 2 && params.ventDiameter >= 1) {
    const vent = polylineTube(params.ventPath, params.ventDiameter / 2);
    shell = subtract(shell, vent);
  }

  // 出网格
  const b = imp.bounds;
  const pad = 1.5;
  const gridMin: Vec3 = [b.min[0] - pad, b.min[1] - pad, b.min[2] - pad];
  const gridMax: Vec3 = [b.max[0] + pad, b.max[1] + pad, b.max[2] + pad];
  const grid = gridFromBounds(gridMin, gridMax, resolution);
  const { mesh } = marchingCubes(shell, grid, onProgress);
  mesh.name = `shell-${params.material}`;

  // 内腔参考网格（薄一点的分辨率，供透视对照）
  const cavityField: SDF = intersect(cavity, keepTrim);
  const { mesh: innerMesh } = marchingCubes(cavityField, gridFromBounds(gridMin, gridMax, resolution * 0.6));
  innerMesh.name = 'cavity';

  return { mesh, innerMesh, params, grid, field: shell, wallLimit };
}

// 壁厚下限校验：在外壳外表面采样点，沿中心线径向测到内腔的距离
export interface ThinSpot {
  point: Vec3;
  thickness: number;
  limit: number;
}

export function findThinSpots(
  shellField: SDF,
  imp: Impression,
  params: ShellDesignParams,
  samples = 240,
): ThinSpot[] {
  const cl = imp.centerline;
  const limit = WALL_LIMIT[params.material];
  const spots: ThinSpot[] = [];
  const sStart = params.faceplateS + 1;
  const sEnd = params.trimS - 1;
  for (let i = 0; i < samples; i++) {
    const s = sStart + (sEnd - sStart) * (i / (samples - 1));
    const fr = cl.frameAt(s);
    const center = cl.pointAt(s);
    // 8 个径向
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const dir = v3.normalize(v3.add(v3.scale(fr.normal, Math.cos(ang)), v3.scale(fr.binormal, Math.sin(ang))));
      // 向外走到壳外表面
      let outerR = imp.radiusAt(s);
      for (let r = imp.radiusAt(s) + 1.5; r > 0.2; r -= 0.15) {
        const p = v3.add(center, v3.scale(dir, r));
        if (shellField(p) > 0) {
          outerR = r;
          break;
        }
      }
      // 向内走到内腔表面
      let innerR = outerR - params.wallThickness;
      for (let r = outerR - 0.2; r > 0.2; r -= 0.1) {
        const p = v3.add(center, v3.scale(dir, r));
        if (shellField(p) > 0) {
          innerR = r;
          break;
        }
      }
      const thickness = outerR - innerR;
      if (thickness < limit - 1e-3) {
        spots.push({ point: v3.add(center, v3.scale(dir, outerR)), thickness, limit });
      }
    }
  }
  return spots;
}

// 网格 SDF 包装（导入 STL 时用）
export function wrapGridSDF(g: GridSDF): SDF {
  return (p) => g.query(p);
}
