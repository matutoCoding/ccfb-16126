import { Mesh } from './mesh';
import { Vec3, v3 } from './math';

export interface RayHit {
  t: number; // 射线参数
  point: Vec3;
  normal: Vec3; // 交点所在三角形法向
  triangle: number;
}

// 均匀网格加速结构，支持射线-网格全部交点查询（封闭网格成对出现 -> 壁厚）
export class RayMeshIntersector {
  private min: Vec3;
  private max: Vec3;
  private cellSize: Vec3;
  private dims: [number, number, number];
  private cells: Int32Array[] = [];
  private cellCount: number;

  constructor(private mesh: Mesh, maxCellsPerAxis = 64) {
    const p = mesh.positions;
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        this.min[k] = Math.min(this.min[k], p[i + k]);
        this.max[k] = Math.max(this.max[k], p[i + k]);
      }
    }
    const extent: Vec3 = [
      this.max[0] - this.min[0] || 1,
      this.max[1] - this.min[1] || 1,
      this.max[2] - this.min[2] || 1,
    ];
    const triCount = mesh.indices.length / 3;
    const target = Math.cbrt(triCount * 2);
    const n = Math.max(4, Math.min(maxCellsPerAxis, Math.round(target)));
    this.dims = [
      Math.max(1, Math.round(n * extent[0] / Math.max(...extent))),
      Math.max(1, Math.round(n * extent[1] / Math.max(...extent))),
      Math.max(1, Math.round(n * extent[2] / Math.max(...extent))),
    ];
    this.cellCount = this.dims[0] * this.dims[1] * this.dims[2];
    this.cellSize = [
      extent[0] / this.dims[0],
      extent[1] / this.dims[1],
      extent[2] / this.dims[2],
    ];
    for (let i = 0; i < this.cellCount; i++) this.cells.push(new Int32Array(0));
    const buckets: number[][] = Array.from({ length: this.cellCount }, () => []);
    for (let tri = 0; tri < triCount; tri++) {
      const visited = new Set<number>();
      for (let v = 0; v < 3; v++) {
        const vi = mesh.indices[tri * 3 + v] * 3;
        const cell = this.cellIndexOf([p[vi], p[vi + 1], p[vi + 2]]);
        if (cell >= 0) visited.add(cell);
      }
      // 对大三角形再补一遍包围盒覆盖
      const triMin: Vec3 = [Infinity, Infinity, Infinity];
      const triMax: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < 3; v++) {
        const vi = mesh.indices[tri * 3 + v] * 3;
        for (let k = 0; k < 3; k++) {
          triMin[k] = Math.min(triMin[k], p[vi + k]);
          triMax[k] = Math.max(triMax[k], p[vi + k]);
        }
      }
      const c0 = this.cellIndexOf(triMin);
      const c1 = this.cellIndexOf(triMax);
      if (c0 >= 0 && c1 >= 0) {
        const [ix0, iy0, iz0] = this.cellCoords(c0);
        const [ix1, iy1, iz1] = this.cellCoords(c1);
        for (let ix = ix0; ix <= ix1; ix++)
          for (let iy = iy0; iy <= iy1; iy++)
            for (let iz = iz0; iz <= iz1; iz++) visited.add(ix + iy * this.dims[0] + iz * this.dims[0] * this.dims[1]);
      }
      visited.forEach((c) => buckets[c].push(tri));
    }
    this.cells = buckets.map((b) => Int32Array.from(b));
  }

  private cellIndexOf(p: Vec3): number {
    const ix = Math.floor((p[0] - this.min[0]) / this.cellSize[0]);
    const iy = Math.floor((p[1] - this.min[1]) / this.cellSize[1]);
    const iz = Math.floor((p[2] - this.min[2]) / this.cellSize[2]);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.dims[0] || iy >= this.dims[1] || iz >= this.dims[2]) return -1;
    return ix + iy * this.dims[0] + iz * this.dims[0] * this.dims[1];
  }

  private cellCoords(idx: number): [number, number, number] {
    const ix = idx % this.dims[0];
    const iy = Math.floor(idx / this.dims[0]) % this.dims[1];
    const iz = Math.floor(idx / (this.dims[0] * this.dims[1]));
    return [ix, iy, iz];
  }

  // 射线与全部三角形求交，按 t 排序；tMin 剔除近点。经典 Amanatides-Woo 网格遍历。
  intersectAll(origin: Vec3, dir: Vec3, tMin = 1e-4): RayHit[] {
    const hits: RayHit[] = [];
    const p = this.mesh.positions, idx = this.mesh.indices;
    const [nx, ny, nz] = this.dims;
    const cs = this.cellSize;

    // 1) 射线与轴对齐包围盒求交，得到进/出参数 t0/t1
    let t0 = 0;
    let t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dir[k]) < 1e-12) {
        if (origin[k] < this.min[k] || origin[k] > this.max[k]) return hits;
      } else {
        let ta = (this.min[k] - origin[k]) / dir[k];
        let tb = (this.max[k] - origin[k]) / dir[k];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
    }
    if (t0 > t1) return hits;

    // 2) 入口点（向内偏移一个极小量，避免落在网格面上）
    const entry: Vec3 = [
      origin[0] + dir[0] * (t0 + 1e-6),
      origin[1] + dir[1] * (t0 + 1e-6),
      origin[2] + dir[2] * (t0 + 1e-6),
    ];
    let ix = clampInt(Math.floor((entry[0] - this.min[0]) / cs[0]), 0, nx - 1);
    let iy = clampInt(Math.floor((entry[1] - this.min[1]) / cs[1]), 0, ny - 1);
    let iz = clampInt(Math.floor((entry[2] - this.min[2]) / cs[2]), 0, nz - 1);

    const stepX = dir[0] > 0 ? 1 : dir[0] < 0 ? -1 : 0;
    const stepY = dir[1] > 0 ? 1 : dir[1] < 0 ? -1 : 0;
    const stepZ = dir[2] > 0 ? 1 : dir[2] < 0 ? -1 : 0;

    // 3) 到下一个垂直面的距离参数
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(cs[0] / dir[0]);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(cs[1] / dir[1]);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(cs[2] / dir[2]);
    const nextMax = (i: number, step: number, k: number): number => {
      if (step === 0) return Infinity;
      const boundary = this.min[k] + (step > 0 ? i + 1 : i) * cs[k];
      return (boundary - entry[k]) / dir[k];
    };
    let mx = nextMax(ix, stepX, 0);
    let my = nextMax(iy, stepY, 1);
    let mz = nextMax(iz, stepZ, 2);

    const tested = new Set<number>();
    for (let guard = 0; guard < nx * ny * nz + 8; guard++) {
      const cell = ix + iy * nx + iz * nx * ny;
      for (const tri of this.cells[cell]) {
        if (tested.has(tri)) continue;
        tested.add(tri);
        const hit = rayTri(origin, dir, p, idx, tri);
        if (hit !== null && hit.t >= tMin) {
          hits.push({ t: hit.t, point: v3.add(origin, v3.scale(dir, hit.t)), normal: hit.normal, triangle: tri });
        }
      }
      if (mx < my && mx < mz) {
        ix += stepX; mx += tDeltaX;
        if (ix < 0 || ix >= nx) break;
      } else if (my < mz) {
        iy += stepY; my += tDeltaY;
        if (iy < 0 || iy >= ny) break;
      } else {
        iz += stepZ; mz += tDeltaZ;
        if (iz < 0 || iz >= nz) break;
      }
    }
    hits.sort((a, b) => a.t - b.t);
    return hits;
  }
}

function clampInt(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Möller–Trumbore，返回 t 与三角形几何法向
function rayTri(o: Vec3, d: Vec3, p: Float32Array, idx: Uint32Array, tri: number): { t: number; normal: Vec3 } | null {
  const ia = idx[tri * 3] * 3, ib = idx[tri * 3 + 1] * 3, ic = idx[tri * 3 + 2] * 3;
  const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
  const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
  const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const hx = d[1] * e2z - d[2] * e2y;
  const hy = d[2] * e2x - d[0] * e2z;
  const hz = d[0] * e2y - d[1] * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t <= 0) return null;
  const n = v3.normalize(v3.cross([e1x, e1y, e1z], [e2x, e2y, e2z]));
  return { t, normal: n };
}

// 沿射线统计穿壳段：封闭网格交点成对，相邻 (t0,t1) 之间为实体段，厚度 = (t1-t0)（沿射线）
export interface ShellSegment {
  t0: number;
  t1: number;
  thickness: number; // 沿射线距离
  point0: Vec3;
  point1: Vec3;
}

export function shellSegments(origin: Vec3, dir: Vec3, intersector: RayMeshIntersector): ShellSegment[] {
  const hits = intersector.intersectAll(origin, dir);
  const out: ShellSegment[] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) {
    const h0 = hits[i], h1 = hits[i + 1];
    out.push({
      t0: h0.t,
      t1: h1.t,
      thickness: h1.t - h0.t,
      point0: h0.point,
      point1: h1.point,
    });
  }
  return out;
}
