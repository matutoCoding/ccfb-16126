// Marching Cubes 主算法
import { Mesh, computeNormals } from './mesh';
import { Vec3 } from './math';
import { EDGE_TABLE, TRI_TABLE } from './mcTables';

const TRI_ROW = 16;

export interface GridSpec {
  min: Vec3;
  max: Vec3;
  dims: [number, number, number];
}

export function gridFromBounds(min: Vec3, max: Vec3, resolution: number): GridSpec {
  const ext: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longest = Math.max(...ext);
  const step = longest / resolution;
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
    dims: [
      Math.max(8, Math.ceil(ext[0] / step)),
      Math.max(8, Math.ceil(ext[1] / step)),
      Math.max(8, Math.ceil(ext[2] / step)),
    ],
  };
}

const CORNER_OFFSET: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const EDGE_VERTS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export interface MarchResult {
  mesh: Mesh;
  grid: GridSpec;
  field: Float32Array; // 完整标量场（调试/可视化用）
}

// 对 f 做 marching cubes，f<=0 为内部。进度回调用于大网格不卡 UI。
export function marchingCubes(
  f: (p: Vec3) => number,
  grid: GridSpec,
  onProgress?: (ratio: number) => void,
): MarchResult {
  const [nx, ny, nz] = grid.dims;
  const cell: Vec3 = [
    (grid.max[0] - grid.min[0]) / nx,
    (grid.max[1] - grid.min[1]) / ny,
    (grid.max[2] - grid.min[2]) / nz,
  ];
  const field = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  const idx3 = (i: number, j: number, k: number) => i + (nx + 1) * (j + (ny + 1) * k);
  const pointAt = (i: number, j: number, k: number): Vec3 => [
    grid.min[0] + i * cell[0],
    grid.min[1] + j * cell[1],
    grid.min[2] + k * cell[2],
  ];
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        field[idx3(i, j, k)] = f(pointAt(i, j, k));
      }
    }
    onProgress?.((k + 1) / (nz + 1) * 0.5);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  // 边交点缓存：数值键 = 轴 * 层大小 + 低角点线性索引，跨单元共享
  const sx = nx + 2, sy = ny + 2;
  const layerSize = sx * sy;
  const vertCache = new Map<number, number>();
  const edgeKey = (i: number, j: number, k: number, edge: number): number => {
    const [a, b] = EDGE_VERTS[edge];
    const p0 = CORNER_OFFSET[a], p1 = CORNER_OFFSET[b];
    const v0: [number, number, number] = [i + p0[0], j + p0[1], k + p0[2]];
    const v1: [number, number, number] = [i + p1[0], j + p1[1], k + p1[2]];
    const lo = [Math.min(v0[0], v1[0]), Math.min(v0[1], v1[1]), Math.min(v0[2], v1[2])];
    const axis = edge <= 3 ? 0 : edge <= 7 ? 1 : 2;
    return axis * 3 * layerSize + lo[2] * layerSize + lo[1] * sx + lo[0];
  };

  const cornerVertex = (i: number, j: number, k: number, c: number) => {
    const o = CORNER_OFFSET[c];
    return idx3(i + o[0], j + o[1], k + o[2]);
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cv = new Array<number>(8);
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const vi = cornerVertex(i, j, k, c);
          cv[c] = vi;
          if (field[vi] <= 0) cubeIndex |= 1 << c;
        }
        let edges = EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;
        const edgeVert = new Array<number>(12).fill(-1);
        for (let e = 0; e < 12; e++) {
          if (!(edges & (1 << e))) continue;
          const key = edgeKey(i, j, k, e);
          let vi = vertCache.get(key);
          if (vi === undefined) {
            const [a, b] = EDGE_VERTS[e];
            const ia = cv[a], ib = cv[b];
            const va = field[ia], vb = field[ib];
            const t = va - vb === 0 ? 0.5 : va / (va - vb);
            const pa = pointAt(
              i + CORNER_OFFSET[a][0],
              j + CORNER_OFFSET[a][1],
              k + CORNER_OFFSET[a][2],
            );
            const pb = pointAt(
              i + CORNER_OFFSET[b][0],
              j + CORNER_OFFSET[b][1],
              k + CORNER_OFFSET[b][2],
            );
            vi = positions.length / 3;
            positions.push(
              pa[0] + t * (pb[0] - pa[0]),
              pa[1] + t * (pb[1] - pa[1]),
              pa[2] + t * (pb[2] - pa[2]),
            );
            vertCache.set(key, vi);
          }
          edgeVert[e] = vi;
        }
        const base = cubeIndex * TRI_ROW;
        for (let t = 0; TRI_TABLE[base + t] !== -1; t += 3) {
          const e0 = edgeVert[TRI_TABLE[base + t]];
          const e1 = edgeVert[TRI_TABLE[base + t + 1]];
          const e2 = edgeVert[TRI_TABLE[base + t + 2]];
          if (e0 < 0 || e1 < 0 || e2 < 0) continue;
          indices.push(e0, e1, e2);
        }
      }
    }
    onProgress?.(0.5 + (k + 1) / nz * 0.5);
  }

  const mesh: Mesh = {
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length),
    indices: Uint32Array.from(indices),
  };
  mesh.normals = computeNormals(mesh);
  return { mesh, grid, field };
}
