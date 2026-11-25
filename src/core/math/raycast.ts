import type { MeshData, Vec3 } from '../../types';
import { dot, sub } from './vec3';

export interface RayHit {
  t: number;
  triangle: number;
}

/** Möller–Trumbore 射线-三角形求交，返回沿射线全部交点（按 t 升序） */
export function rayMeshIntersections(mesh: MeshData, origin: Vec3, dir: Vec3): RayHit[] {
  const hits: RayHit[] = [];
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const ax = p[a];
    const ay = p[a + 1];
    const az = p[a + 2];
    const e1x = p[b] - ax;
    const e1y = p[b + 1] - ay;
    const e1z = p[b + 2] - az;
    const e2x = p[c] - ax;
    const e2y = p[c + 1] - ay;
    const e2z = p[c + 2] - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - ax;
    const ty = oy - ay;
    const tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const vv = (dx * qx + dy * qy + dz * qz) * inv;
    if (vv < 0 || u + vv > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-6) hits.push({ t, triangle: i / 3 });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

/** 视线穿过网格的层数（进出配对）与每段厚度(mm) */
export interface RaySegment {
  enter: number;
  exit: number;
  thickness: number;
}

export function rayWallSegments(mesh: MeshData, origin: Vec3, dir: Vec3): RaySegment[] {
  const hits = rayMeshIntersections(mesh, origin, dir);
  const segs: RaySegment[] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) {
    const thickness = hits[i + 1].t - hits[i].t;
    segs.push({ enter: hits[i].t, exit: hits[i + 1].t, thickness });
  }
  return segs;
}

/** 点是否在封闭网格内部（射线奇偶法） */
export function pointInsideMesh(mesh: MeshData, point: Vec3): boolean {
  const dir: Vec3 = [0.37, 0.81, 0.45]; // 固定方向，结果稳定可复现
  const hits = rayMeshIntersections(mesh, point, dir);
  return hits.length % 2 === 1;
}

/** 射线与球相交（标记点/缺陷拾取） */
export function raySphereHit(origin: Vec3, dir: Vec3, center: Vec3, radius: number): number {
  const oc = sub(center, origin);
  const tca = dot(oc, dir);
  const d2 = dot(oc, oc) - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  return t0 > 1e-6 ? t0 : tca + thc > 1e-6 ? tca + thc : -1;
}
