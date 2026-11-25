import type { MeshData, Vec3 } from '../../types';
import type { RayHit } from './raycast';
import { boundingBox } from './mesh';

/** 均匀空间网格：按三角形包围盒分桶，加速射线求交 */
export class MeshGrid {
  readonly mesh: MeshData;
  readonly cell: number;
  readonly min: Vec3;
  readonly dims: [number, number, number];
  private buckets: number[][] = [];
  private bucketCount: number;

  constructor(mesh: MeshData, cellSize?: number) {
    this.mesh = mesh;
    const bb = boundingBox(mesh);
    this.min = bb.min;
    const size = bb.size;
    const maxDim = Math.max(size[0], size[1], size[2]);
    this.cell = cellSize ?? Math.max(0.8, maxDim / 24);
    this.dims = [
      Math.max(1, Math.ceil(size[0] / this.cell)),
      Math.max(1, Math.ceil(size[1] / this.cell)),
      Math.max(1, Math.ceil(size[2] / this.cell)),
    ];
    this.bucketCount = this.dims[0] * this.dims[1] * this.dims[2];
    this.buckets = Array.from({ length: this.bucketCount }, () => []);
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      let mn: Vec3 = [Infinity, Infinity, Infinity];
      let mx: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        const vi = idx[t + k] * 3;
        for (let c = 0; c < 3; c++) {
          mn[c] = Math.min(mn[c], p[vi + c]);
          mx[c] = Math.max(mx[c], p[vi + c]);
        }
      }
      const i0 = this.coordIndex(mn, mx);
      for (let ix = i0[0][0]; ix <= i0[1][0]; ix++) {
        for (let iy = i0[0][1]; iy <= i0[1][1]; iy++) {
          for (let iz = i0[0][2]; iz <= i0[1][2]; iz++) {
            this.buckets[this.flat(ix, iy, iz)].push(t / 3);
          }
        }
      }
    }
  }

  private coordIndex(mn: Vec3, mx: Vec3): [[number, number, number], [number, number, number]] {
    const lo: Vec3 = [
      Math.floor((mn[0] - this.min[0]) / this.cell),
      Math.floor((mn[1] - this.min[1]) / this.cell),
      Math.floor((mn[2] - this.min[2]) / this.cell),
    ];
    const hi: Vec3 = [
      Math.floor((mx[0] - this.min[0]) / this.cell),
      Math.floor((mx[1] - this.min[1]) / this.cell),
      Math.floor((mx[2] - this.min[2]) / this.cell),
    ];
    const clampIdx = (v: number, d: number) => Math.max(0, Math.min(d - 1, v));
    return [
      [clampIdx(lo[0], this.dims[0]), clampIdx(lo[1], this.dims[1]), clampIdx(lo[2], this.dims[2])],
      [clampIdx(hi[0], this.dims[0]), clampIdx(hi[1], this.dims[1]), clampIdx(hi[2], this.dims[2])],
    ];
  }

  private flat(ix: number, iy: number, iz: number): number {
    return ix * this.dims[1] * this.dims[2] + iy * this.dims[2] + iz;
  }

  private cellOfPoint(p: Vec3): [number, number, number] {
    return [
      Math.max(0, Math.min(this.dims[0] - 1, Math.floor((p[0] - this.min[0]) / this.cell))),
      Math.max(0, Math.min(this.dims[1] - 1, Math.floor((p[1] - this.min[1]) / this.cell))),
      Math.max(0, Math.min(this.dims[2] - 1, Math.floor((p[2] - this.min[2]) / this.cell))),
    ];
  }

  /** 加速版射线求交，返回全部命中（升序） */
  raycast(origin: Vec3, dir: Vec3, maxT = 1e5): RayHit[] {
    const hits: RayHit[] = [];
    const [dx, dy, dz] = dir;
    const inv: Vec3 = [
      Math.abs(dx) < 1e-12 ? 1e12 : 1 / dx,
      Math.abs(dy) < 1e-12 ? 1e12 : 1 / dy,
      Math.abs(dz) < 1e-12 ? 1e12 : 1 / dz,
    ];
    let [cx, cy, cz] = this.cellOfPoint(origin);
    const step: [number, number, number] = [dx > 0 ? 1 : -1, dy > 0 ? 1 : -1, dz > 0 ? 1 : -1];
    const cellBound = (i: number, c: 0 | 1 | 2) =>
      this.min[c] + (i + (step[c] > 0 ? 1 : 0)) * this.cell;
    let tMax: Vec3 = [
      dx !== 0 ? (cellBound(cx, 0) - origin[0]) * inv[0] : Infinity,
      dy !== 0 ? (cellBound(cy, 1) - origin[1]) * inv[1] : Infinity,
      dz !== 0 ? (cellBound(cz, 2) - origin[2]) * inv[2] : Infinity,
    ];
    const tDelta: Vec3 = [
      Math.abs(this.cell * inv[0]),
      Math.abs(this.cell * inv[1]),
      Math.abs(this.cell * inv[2]),
    ];
    const tested = new Set<number>();
    const p = this.mesh.positions;
    const idx = this.mesh.indices;
    // 射线最多穿越的体素数（三轴维度之和的上界），避免长射线被过早截断漏交点
    const maxCells = (this.dims[0] + this.dims[1] + this.dims[2]) * 2 + 16;
    let guard = 0;
    while (guard++ < maxCells) {
      const bucket = this.buckets[this.flat(cx, cy, cz)];
      for (const tri of bucket) {
        if (tested.has(tri)) continue;
        tested.add(tri);
        const base = tri * 3;
        const ia = idx[base] * 3;
        const ib = idx[base + 1] * 3;
        const ic = idx[base + 2] * 3;
        const ax = p[ia];
        const ay = p[ia + 1];
        const az = p[ia + 2];
        const e1x = p[ib] - ax;
        const e1y = p[ib + 1] - ay;
        const e1z = p[ib + 2] - az;
        const e2x = p[ic] - ax;
        const e2y = p[ic + 1] - ay;
        const e2z = p[ic + 2] - az;
        const pvx = dy * e2z - dz * e2y;
        const pvy = dz * e2x - dx * e2z;
        const pvz = dx * e2y - dy * e2x;
        const det = e1x * pvx + e1y * pvy + e1z * pvz;
        if (Math.abs(det) < 1e-12) continue;
        const invDet = 1 / det;
        const tx = origin[0] - ax;
        const ty = origin[1] - ay;
        const tz = origin[2] - az;
        const u = (tx * pvx + ty * pvy + tz * pvz) * invDet;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (t > 1e-6 && t < maxT) hits.push({ t, triangle: tri });
      }
      if (tMax[0] < tMax[1] && tMax[0] < tMax[2]) {
        cx += step[0];
        if (cx < 0 || cx >= this.dims[0]) break;
        tMax[0] += tDelta[0];
      } else if (tMax[1] < tMax[2]) {
        cy += step[1];
        if (cy < 0 || cy >= this.dims[1]) break;
        tMax[1] += tDelta[1];
      } else {
        cz += step[2];
        if (cz < 0 || cz >= this.dims[2]) break;
        tMax[2] += tDelta[2];
      }
    }
    hits.sort((a, b) => a.t - b.t);
    return hits;
  }
}

/** 采样中心线上某点沿框架方向到网格表面的距离（最小值即该截面可用半径） */
export function radialClearance(
  grid: MeshGrid,
  center: Vec3,
  frameU: Vec3,
  frameV: Vec3,
  directions = 16,
): number {
  let minR = Infinity;
  for (let j = 0; j < directions; j++) {
    const ang = (2 * Math.PI * j) / directions;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const dir: Vec3 = [
      frameU[0] * c + frameV[0] * s,
      frameU[1] * c + frameV[1] * s,
      frameU[2] * c + frameV[2] * s,
    ];
    const hits = grid.raycast(center, dir);
    if (hits.length > 0) minR = Math.min(minR, hits[0].t);
  }
  return Number.isFinite(minR) ? minR : 0;
}

/** 最近表面距离（点在网格外时） */
export function nearestSurfaceDistance(grid: MeshGrid, point: Vec3): number {
  const p = grid.mesh.positions;
  const idx = grid.mesh.indices;
  let best = Infinity;
  // 只测当前点所在邻域桶
  const [cx, cy, cz] = (grid as unknown as { cellOfPoint: (q: Vec3) => [number, number, number] }).cellOfPoint(point);
  const flat = (grid as unknown as { flat: (x: number, y: number, z: number) => number }).flat(cx, cy, cz);
  const bucket = (grid as unknown as { buckets: number[][] }).buckets[flat] ?? [];
  for (const tri of bucket) {
    const base = tri * 3;
    for (let k = 0; k < 3; k++) {
      const vi = idx[base + k] * 3;
      const d = Math.hypot(p[vi] - point[0], p[vi + 1] - point[1], p[vi + 2] - point[2]);
      best = Math.min(best, d);
    }
  }
  if (!Number.isFinite(best)) {
    for (let i = 0; i < p.length; i += 3) {
      const d = Math.hypot(p[i] - point[0], p[i + 1] - point[1], p[i + 2] - point[2]);
      best = Math.min(best, d);
    }
  }
  return best;
}
