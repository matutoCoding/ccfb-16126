import type { LayerStyle, MeshData, Vec3 } from '../../types';
import { MeshGrid } from './grid';
import { rayMeshIntersections } from './raycast';
import { mat4LookAt, mat4Perspective, mat4Multiply, mat4Invert, transformPoint } from '../render/mat4';
import { viewDirection } from '../render/OrbitControls';

export interface ReferenceFragment {
  depthNdc: number;
  depthMm: number;
  layerId: number;
  color: Vec3;
  alpha: number;
}

export interface ReferencePixel {
  fragments: ReferenceFragment[];
  color: Vec3; // 0..255
  shellSegments: number[]; // 沿射线 t 距离壁厚 mm
  shellLinearSegments: number[]; // 相机空间线性深度壁厚 mm（与 GPU 同度量）
}

/** CPU 参考实现：逐像素对所有层网格做射线求交，按深度精确排序后 F2B 合成 */
export class ReferenceRenderer {
  private grids: { layerId: number; mesh: MeshData; grid: MeshGrid; color: Vec3; alpha: number }[] = [];
  private width: number;
  private height: number;
  near = 1;
  far = 150;
  fov = (42 * Math.PI) / 180;

  constructor(
    meshes: { layerId: number; mesh: MeshData; color: Vec3; alpha: number }[],
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
    this.grids = meshes
      .filter((m) => m.mesh.indices.length > 0)
      .map((m) => ({ ...m, grid: new MeshGrid(m.mesh) }));
  }

  private linearize(d: number): number {
    const z = d * 2 - 1;
    return (2 * this.near * this.far) / (this.far + this.near - z * (this.far - this.near));
  }

  /** 用外部（GPU）相机矩阵反投影出的射线渲染单个像素，保证与 GPU 逐像素对齐 */
  renderPixelWithRay(
    px: number,
    py: number,
    eye: Vec3,
    target: Vec3,
    ray?: { origin: Vec3; dir: Vec3 },
  ): ReferencePixel {
    let nearP: Vec3;
    let dir: Vec3;
    if (ray) {
      // 射线方向复用 GPU 反投影，但起点移到相机光心：与光栅化视锥同源，
      // 避免近平面横向偏移在掠射角下漏掉表面
      nearP = eye;
      dir = ray.dir;
    } else {
      const aspect = this.width / this.height;
      const proj = mat4Perspective(this.fov, aspect, this.near, this.far);
      const view = mat4LookAt(eye, target, [0, 0, 1]);
      const inv = mat4Invert(mat4Multiply(proj, view));
      const ndcX = (px / this.width) * 2 - 1;
      const ndcY = (py / this.height) * 2 - 1;
      nearP = transformPoint(inv, [ndcX, ndcY, -1]);
      const farP = transformPoint(inv, [ndcX, ndcY, 1]);
      dir = viewDirection(nearP, farP);
    }
    const proj = mat4Perspective(this.fov, this.width / this.height, this.near, this.far);
    const view = mat4LookAt(eye, target, [0, 0, 1]);
    const mvp = mat4Multiply(proj, view);
    const fragments: ReferenceFragment[] = [];
    for (const g of this.grids) {
      const hits = g.grid.raycast(nearP, dir);
      for (const h of hits) {
        // 交点的 NDC 深度：重新投影
        const hitPoint: Vec3 = [
          nearP[0] + dir[0] * h.t,
          nearP[1] + dir[1] * h.t,
          nearP[2] + dir[2] * h.t,
        ];
        const cz = mvp[2] * hitPoint[0] + mvp[6] * hitPoint[1] + mvp[10] * hitPoint[2] + mvp[14];
        const cw = mvp[3] * hitPoint[0] + mvp[7] * hitPoint[1] + mvp[11] * hitPoint[2] + mvp[15];
        const ndcZ = cz / cw;
        const depthNdc = ndcZ * 0.5 + 0.5;
        fragments.push({
          depthNdc,
          depthMm: h.t,
          layerId: g.layerId,
          color: g.color,
          alpha: g.alpha,
        });
      }
    }
    fragments.sort((a, b) => a.depthNdc - b.depthNdc);
    // F2B 合成（与 GPU blend shader 完全相同的公式）
    let accR = 0;
    let accG = 0;
    let accB = 0;
    let accA = 0;
    for (const f of fragments) {
      const remaining = 1 - accA;
      accR += f.alpha * remaining * f.color[0];
      accG += f.alpha * remaining * f.color[1];
      accB += f.alpha * remaining * f.color[2];
      accA += f.alpha * remaining;
    }
    // 背景混入（与 GPU analysis shader 完全一致：预乘累加色 + 背景×(1-累计不透明度)）
    const bg: Vec3 = [0.07, 0.08, 0.1];
    const a = Math.min(1, accA);
    const finalColor: Vec3 = [
      (accR + bg[0] * (1 - a)) * 255,
      (accG + bg[1] * (1 - a)) * 255,
      (accB + bg[2] * (1 - a)) * 255,
    ];
    const shellSegments: number[] = [];
    const shellLinearSegments: number[] = [];
    const lin = (ndc: number) => {
      const z = ndc * 2 - 1;
      return (2 * this.near * this.far) / (this.far + this.near - z * (this.far - this.near));
    };
    for (let i = 0; i + 1 < fragments.length; i++) {
      if (fragments[i].layerId === 0 && fragments[i + 1].layerId === 0) {
        shellSegments.push(fragments[i + 1].depthMm - fragments[i].depthMm);
        // 与 GPU 完全相同的相机空间线性深度度量，消除视线夹角 cos 因子
        shellLinearSegments.push(lin(fragments[i + 1].depthNdc) - lin(fragments[i].depthNdc));
        i++;
      }
    }
    return { fragments, color: finalColor, shellSegments, shellLinearSegments };
  }

  /** 兼容包装：用内部重建矩阵渲染 */
  renderPixel(px: number, py: number, eye: Vec3, target: Vec3): ReferencePixel {
    return this.renderPixelWithRay(px, py, eye, target, undefined);
  }

  /** 对一批像素做参考渲染（自检抽样用），可注入 GPU 反投影射线保证对齐 */
  renderSamples(
    samples: { px: number; py: number }[],
    eye: Vec3,
    target: Vec3,
    rayProvider?: (px: number, py: number) => { origin: Vec3; dir: Vec3 },
  ): Map<string, ReferencePixel> {
    const out = new Map<string, ReferencePixel>();
    for (const s of samples) {
      const ray = rayProvider?.(s.px, s.py);
      out.set(`${s.px},${s.py}`, this.renderPixelWithRay(s.px, s.py, eye, target, ray));
    }
    return out;
  }
}

/** 直接射线求交版壁厚（不经过投影，独立交叉验证 GPU 线性深度结果） */
export function cpuWallThicknessAt(
  meshes: MeshData[],
  origin: Vec3,
  dir: Vec3,
): { segments: number[]; minWall: number } {
  const all: { t: number; layerId: number }[] = [];
  meshes.forEach((mesh, layerId) => {
    for (const h of rayMeshIntersections(mesh, origin, dir)) {
      all.push({ t: h.t, layerId });
    }
  });
  all.sort((a, b) => a.t - b.t);
  const segments: number[] = [];
  let minWall = Infinity;
  for (let i = 0; i + 1 < all.length; i++) {
    if (all[i].layerId === 0 && all[i + 1].layerId === 0) {
      const thick = all[i + 1].t - all[i].t;
      segments.push(thick);
      minWall = Math.min(minWall, thick);
      i++;
    }
  }
  return { segments, minWall: Number.isFinite(minWall) ? minWall : -1 };
}
