/**
 * 三角网格数据结构 + 几何工具。
 * 所有长度单位 mm。网格约定：法线朝外，索引逆时针。
 */
import { Ray, Vec3, cross3, dot3, norm3, scale3, sub3, add3, dist3, v3 } from './math';

export interface Mesh {
  positions: Float32Array; // xyz 交错
  normals: Float32Array;
  indices: Uint32Array;
}

export interface BBox {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
}

export class MeshBuilder {
  pos: number[] = [];
  idx: number[] = [];

  vertex(p: Vec3): number {
    this.pos.push(p[0], p[1], p[2]);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  build(): Mesh {
    const mesh: Mesh = {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.pos.length),
      indices: Uint32Array.from(this.idx),
    };
    computeVertexNormals(mesh);
    return mesh;
  }
}

export function computeVertexNormals(m: Mesh): void {
  const { positions: p, normals: n, indices: ix } = m;
  n.fill(0);
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
}

export function bbox(m: Mesh): BBox {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return {
    min, max,
    center: scale3(add3(min, max), 0.5),
    size: sub3(max, min),
  };
}

/** 有符号体积；接近 0 且闭合时符号由绕序决定，闭合网格应明显非零 */
export function signedVolume(m: Mesh): number {
  const p = m.positions;
  let v = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i] * 3, b = m.indices[i + 1] * 3, c = m.indices[i + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** 统计只被一个三角形使用的边（开口边界） */
export function boundaryEdges(m: Mesh): Array<[number, number]> {
  const key = (a: number, b: number) => (a < b ? a * 1000003 + b : b * 1000003 + a);
  const count = new Map<number, [number, number]>();
  const usage = new Map<number, number>();
  for (let i = 0; i < m.indices.length; i += 3) {
    const tri = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
    for (let k = 0; k < 3; k++) {
      const kv = key(tri[k], tri[(k + 1) % 3]);
      usage.set(kv, (usage.get(kv) ?? 0) + 1);
      count.set(kv, [tri[k], tri[(k + 1) % 3]]);
    }
  }
  const out: Array<[number, number]> = [];
  for (const [kv, u] of usage) if (u === 1) out.push(count.get(kv)!);
  return out;
}

/** 网格焊接（空间哈希），用于 STL 导入后恢复共享顶点 */
export function weld(m: Mesh, tolerance = 0.01): Mesh {
  const cell = Math.max(tolerance, 1e-6);
  const grid = new Map<string, number[]>();
  const remap = new Int32Array(m.positions.length / 3);
  const out: number[] = [];
  const p = m.positions;
  const hash = (ix: number, iy: number, iz: number) => `${ix}|${iy}|${iz}`;
  for (let i = 0; i < p.length / 3; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const bucket = grid.get(hash(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (Math.abs(p[j * 3] - x) <= tolerance &&
                Math.abs(p[j * 3 + 1] - y) <= tolerance &&
                Math.abs(p[j * 3 + 2] - z) <= tolerance) {
              found = j;
              break;
            }
          }
        }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const k = hash(cx, cy, cz);
      const bucket = grid.get(k);
      if (bucket) bucket.push(found); else grid.set(k, [found]);
    }
    remap[i] = found;
  }
  const indices = new Uint32Array(m.indices.length);
  for (let i = 0; i < m.indices.length; i++) indices[i] = remap[m.indices[i]];
  const mesh: Mesh = {
    positions: Float32Array.from(out),
    normals: new Float32Array(out.length),
    indices,
  };
  computeVertexNormals(mesh);
  return mesh;
}

/** Möller–Trumbore，返回正向距离 t（不命中返回 null） */
export function rayTriangle(ray: Ray, a: Vec3, b: Vec3, c: Vec3): number | null {
  const EPS = 1e-9;
  const e1 = sub3(b, a);
  const e2 = sub3(c, a);
  const h = cross3(ray.dir, e2);
  const det = dot3(e1, h);
  if (Math.abs(det) < EPS) return null;
  const f = 1 / det;
  const s = sub3(ray.origin, a);
  const u = f * dot3(s, h);
  if (u < -EPS || u > 1 + EPS) return null;
  const q = cross3(s, e1);
  const v = f * dot3(ray.dir, q);
  if (v < -EPS || u + v > 1 + EPS) return null;
  const t = f * dot3(e2, q);
  return t > EPS ? t : null;
}

/** 射线与网格的全部命中距离，按近到远排序；合并共享边处的近重复命中 */
export function rayMeshAllHits(m: Mesh, ray: Ray): number[] {
  const p = m.positions;
  const raw: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const ia = m.indices[i] * 3, ib = m.indices[i + 1] * 3, ic = m.indices[i + 2] * 3;
    const t = rayTriangle(
      ray,
      [p[ia], p[ia + 1], p[ia + 2]],
      [p[ib], p[ib + 1], p[ib + 2]],
      [p[ic], p[ic + 1], p[ic + 2]],
    );
    if (t !== null) raw.push(t);
  }
  raw.sort((a, b) => a - b);
  // 合并 1e-4mm 内的重复命中（射线擦过三角共享边时相邻片元会各报一次）
  const hits: number[] = [];
  for (const t of raw) {
    if (!hits.length || Math.abs(t - hits[hits.length - 1]) > 1e-4) hits.push(t);
  }
  return hits;
}

/** 最近命中（拾取用） */
export function rayMeshFirstHit(m: Mesh, ray: Ray): { t: number; triIndex: number } | null {
  const p = m.positions;
  let best = Infinity;
  let bestTri = -1;
  for (let i = 0; i < m.indices.length; i += 3) {
    const ia = m.indices[i] * 3, ib = m.indices[i + 1] * 3, ic = m.indices[i + 2] * 3;
    const t = rayTriangle(
      ray,
      [p[ia], p[ia + 1], p[ia + 2]],
      [p[ib], p[ib + 1], p[ib + 2]],
      [p[ic], p[ic + 1], p[ic + 2]],
    );
    if (t !== null && t < best) {
      best = t;
      bestTri = i / 3;
    }
  }
  return bestTri >= 0 ? { t: best, triIndex: bestTri } : null;
}

/** 平行输运框架沿路径扫掠圆管（半径可逐站变化），两端封口，保证水密 */
export function makeSweptTube(
  path: Vec3[],
  radius: number | number[],
  radialSegments = 20,
  capStart = true,
  capEnd = true,
): Mesh {
  const n = path.length;
  const radii = typeof radius === 'number' ? new Array(n).fill(radius) : radius;
  const b = new MeshBuilder();
  const rings: number[][] = [];

  // 切向
  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const c = path[Math.min(n - 1, i + 1)];
    tangents.push(norm3(sub3(c, a)));
  }
  // 初始法向：取与首切向最不平行的轴做叉积
  const t0 = tangents[0];
  const ref: Vec3 = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let normal = norm3(cross3(t0, ref));
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // 平行输运：把上一帧法向投影到新切向法平面
      const t = tangents[i];
      normal = norm3(sub3(normal, scale3(t, dot3(normal, t))));
    }
    const binormal = norm3(cross3(tangents[i], normal));
    const ring: number[] = [];
    for (let j = 0; j < radialSegments; j++) {
      const ang = (Math.PI * 2 * j) / radialSegments;
      const off = add3(scale3(normal, Math.cos(ang) * radii[i]), scale3(binormal, Math.sin(ang) * radii[i]));
      ring.push(b.vertex(add3(path[i], off)));
    }
    rings.push(ring);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const j2 = (j + 1) % radialSegments;
      b.quad(rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]);
    }
  }
  if (capStart) {
    const c = b.vertex(path[0]);
    for (let j = 0; j < radialSegments; j++) b.tri(c, rings[0][(j + 1) % radialSegments], rings[0][j]);
  }
  if (capEnd) {
    const c = b.vertex(path[n - 1]);
    for (let j = 0; j < radialSegments; j++) b.tri(c, rings[n - 1][j], rings[n - 1][(j + 1) % radialSegments]);
  }
  return b.build();
}

/** 椭球（含两极），水密 */
export function makeEllipsoid(center: Vec3, radii: Vec3, latSeg = 18, lonSeg = 28): Mesh {
  const b = new MeshBuilder();
  const grid: number[][] = [];
  for (let i = 0; i <= latSeg; i++) {
    const phi = (Math.PI * i) / latSeg; // 0..PI
    const row: number[] = [];
    for (let j = 0; j <= lonSeg; j++) {
      const theta = (Math.PI * 2 * j) / lonSeg;
      row.push(b.vertex([
        center[0] + radii[0] * Math.sin(phi) * Math.cos(theta),
        center[1] + radii[1] * Math.cos(phi),
        center[2] + radii[2] * Math.sin(phi) * Math.sin(theta),
      ]));
    }
    grid.push(row);
  }
  for (let i = 0; i < latSeg; i++) {
    for (let j = 0; j < lonSeg; j++) {
      b.quad(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
    }
  }
  return b.build();
}

export function makeBox(center: Vec3, size: Vec3): Mesh {
  const h = scale3(size, 0.5);
  const b = new MeshBuilder();
  const pts: Vec3[] = [
    [-h[0], -h[1], -h[2]], [h[0], -h[1], -h[2]], [h[0], h[1], -h[2]], [-h[0], h[1], -h[2]],
    [-h[0], -h[1], h[2]], [h[0], -h[1], h[2]], [h[0], h[1], h[2]], [-h[0], h[1], h[2]],
  ].map((p): Vec3 => [p[0] + center[0], p[1] + center[1], p[2] + center[2]]);
  const v = pts.map((p) => b.vertex(p));
  const faces: Array<[number, number, number, number]> = [
    [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1],
    [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
  ];
  for (const [a, c, d, e] of faces) b.quad(v[a], v[c], v[d], v[e]);
  return b.build();
}

export function makeCylinder(p0: Vec3, p1: Vec3, radius: number, seg = 20): Mesh {
  const axis = norm3(sub3(p1, p0));
  const ref: Vec3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const n = norm3(cross3(axis, ref));
  const b2 = norm3(cross3(axis, n));
  const b = new MeshBuilder();
  const r0: number[] = [], r1: number[] = [];
  for (let j = 0; j < seg; j++) {
    const ang = (Math.PI * 2 * j) / seg;
    const off = add3(scale3(n, Math.cos(ang) * radius), scale3(b2, Math.sin(ang) * radius));
    r0.push(b.vertex(add3(p0, off)));
    r1.push(b.vertex(add3(p1, off)));
  }
  for (let j = 0; j < seg; j++) {
    const k = (j + 1) % seg;
    b.quad(r0[j], r0[k], r1[k], r1[j]);
  }
  const c0 = b.vertex(p0), c1 = b.vertex(p1);
  for (let j = 0; j < seg; j++) {
    const k = (j + 1) % seg;
    b.tri(c0, r0[k], r0[j]);
    b.tri(c1, r1[j], r1[k]);
  }
  return b.build();
}

export function combineMeshes(meshes: Mesh[]): Mesh {
  const b = new MeshBuilder();
  let offset = 0;
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      b.vertex([m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
    }
    for (let i = 0; i < m.indices.length; i++) b.idx.push(m.indices[i] + offset);
    offset += m.positions.length / 3;
  }
  return b.build();
}

/** 点到线段最近距离 */
export function pointSegmentDistance(p: Vec3, a: Vec3, c: Vec3): number {
  const ac = sub3(c, a);
  const t = Math.max(0, Math.min(1, dot3(sub3(p, a), ac) / (dot3(ac, ac) || 1)));
  return dist3(p, add3(a, scale3(ac, t)));
}

export function meshVertex(m: Mesh, i: number): Vec3 {
  return v3(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
}
