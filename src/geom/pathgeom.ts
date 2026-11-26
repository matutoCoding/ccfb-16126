import type { Vec3 } from '../types';
import { add, scale, sub } from '../math/vec';
import { computeFrames } from './procedural';
import { createMesh } from './mesh';

function catmull(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1, 2].map(k => 0.5 * (
    2 * p1[k] + (-p0[k] + p2[k]) * t +
    (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
    (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3
  )) as Vec3;
}

export function smoothPath(points: Vec3[], samplesPerSpan = 10): Vec3[] {
  if (points.length < 3) return points;
  const out: Vec3[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let j = 0; j < samplesPerSpan; j++) out.push(catmull(p0, p1, p2, p3, j / samplesPerSpan));
  }
  out.push(points[points.length - 1]);
  return out;
}

export function createTubeMesh(pathPoints: Vec3[], radius: number, radialSegments = 18, smooth = true) {
  const points = smooth ? smoothPath(pathPoints, 9) : pathPoints;
  if (points.length < 2) return createMesh([], []);
  const frames = computeFrames(points);
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j <= radialSegments; j++) {
      const a = j / radialSegments * Math.PI * 2;
      const p = points[i];
      const n = frames.normals[i], b = frames.binormals[i];
      positions.push(
        p[0] + radius * (Math.cos(a) * n[0] + Math.sin(a) * b[0]),
        p[1] + radius * (Math.cos(a) * n[1] + Math.sin(a) * b[1]),
        p[2] + radius * (Math.cos(a) * n[2] + Math.sin(a) * b[2])
      );
    }
  }
  const stride = radialSegments + 1;
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * stride + j, b = a + stride;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Caps.
  const startCenter = positions.length / 3;
  positions.push(...points[0]);
  for (let j = 0; j < radialSegments; j++) indices.push(startCenter, j + 1, j);
  const endCenter = positions.length / 3;
  positions.push(...points[points.length - 1]);
  const endBase = (points.length - 1) * stride;
  for (let j = 0; j < radialSegments; j++) indices.push(endCenter, endBase + j, endBase + j + 1);
  return createMesh(positions, indices);
}

export function pathLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(...sub(points[i], points[i - 1]));
  return total;
}

export function samplePath(points: Vec3[], count: number): Vec3[] {
  if (points.length < 2) return points;
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(...sub(points[i], points[i - 1])));
  const total = lengths[lengths.length - 1];
  const out: Vec3[] = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = i / (count - 1) * total;
    while (seg < lengths.length - 2 && lengths[seg + 1] < target) seg++;
    const f = (target - lengths[seg]) / Math.max(1e-6, lengths[seg + 1] - lengths[seg]);
    out.push(add(points[seg], scale(sub(points[seg + 1], points[seg]), f)));
  }
  return out;
}
