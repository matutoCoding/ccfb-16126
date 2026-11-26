import type { MeshData, Vec3 } from '../types';
import type { Ray } from '../math/vec';
import { mat4Invert, transformPoint, type Mat4 } from '../math/vec';

export interface RayHit {
  distance: number;
  point: Vec3;
  triangle: number;
  barycentric: [number, number];
}

/** Transform a world ray into mesh-local coordinates when a model matrix is supplied. */
export function rayToLocal(ray: Ray, model?: Mat4): Ray {
  if (!model) return ray;
  const inv = mat4Invert(model);
  const o = transformPoint(inv, ray.origin);
  const end = transformPoint(inv, [
    ray.origin[0] + ray.dir[0],
    ray.origin[1] + ray.dir[1],
    ray.origin[2] + ray.dir[2]
  ]);
  const dir: Vec3 = [end[0] - o[0], end[1] - o[1], end[2] - o[2]];
  const l = Math.hypot(...dir) || 1;
  return { origin: o, dir: [dir[0] / l, dir[1] / l, dir[2] / l] };
}

export function rayMeshIntersections(ray: Ray, mesh: MeshData, model?: Mat4): RayHit[] {
  const localRay = rayToLocal(ray, model);
  const { origin: o, dir: d } = localRay;
  const p = mesh.positions, idx = mesh.indices;
  const hits: RayHit[] = [];
  const eps = 1e-7;
  for (let tri = 0; tri < idx.length; tri += 3) {
    const ia = idx[tri] * 3, ib = idx[tri + 1] * 3, ic = idx[tri + 2] * 3;
    const v0: Vec3 = [p[ia], p[ia + 1], p[ia + 2]];
    const e1: Vec3 = [p[ib] - p[ia], p[ib + 1] - p[ia + 1], p[ib + 2] - p[ia + 2]];
    const e2: Vec3 = [p[ic] - p[ia], p[ic + 1] - p[ia + 1], p[ic + 2] - p[ia + 2]];
    const pvec: Vec3 = [
      d[1] * e2[2] - d[2] * e2[1],
      d[2] * e2[0] - d[0] * e2[2],
      d[0] * e2[1] - d[1] * e2[0]
    ];
    const det = e1[0] * pvec[0] + e1[1] * pvec[1] + e1[2] * pvec[2];
    if (Math.abs(det) < eps) continue;
    const invDet = 1 / det;
    const tvec: Vec3 = [o[0] - v0[0], o[1] - v0[1], o[2] - v0[2]];
    const u = (tvec[0] * pvec[0] + tvec[1] * pvec[1] + tvec[2] * pvec[2]) * invDet;
    if (u < -eps || u > 1 + eps) continue;
    const qvec: Vec3 = [
      tvec[1] * e1[2] - tvec[2] * e1[1],
      tvec[2] * e1[0] - tvec[0] * e1[2],
      tvec[0] * e1[1] - tvec[1] * e1[0]
    ];
    const v = (d[0] * qvec[0] + d[1] * qvec[1] + d[2] * qvec[2]) * invDet;
    if (v < -eps || u + v > 1 + eps) continue;
    const t = (e2[0] * qvec[0] + e2[1] * qvec[1] + e2[2] * qvec[2]) * invDet;
    if (t > eps) {
      hits.push({
        distance: t,
        point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t],
        triangle: tri / 3,
        barycentric: [u, v]
      });
    }
  }
  hits.sort((a, b) => a.distance - b.distance);
  // Merge exact duplicate intersections shared by welded triangles/caps.
  const merged: RayHit[] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (!last || Math.abs(last.distance - h.distance) > 1e-4) merged.push(h);
  }
  return merged;
}

export interface WallSegment {
  near: number;
  far: number;
  thickness: number;
}

/** A closed thin shell alternates solid/empty: (0,1), (2,3)... are wall segments. */
export function pairWallSegments(depths: number[], maxLayers = 12): WallSegment[] {
  const d = depths.filter(x => Number.isFinite(x) && x > 0.0001).sort((a, b) => a - b).slice(0, maxLayers);
  const segments: WallSegment[] = [];
  for (let i = 0; i + 1 < d.length; i += 2) {
    segments.push({ near: d[i], far: d[i + 1], thickness: d[i + 1] - d[i] });
  }
  return segments;
}
