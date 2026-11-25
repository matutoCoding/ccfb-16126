import type { MeshData, Vec3 } from '../../types';
import { add, cross, normalize, scale, sub } from './vec3';

export function emptyMesh(): MeshData {
  return { positions: new Float32Array(0), indices: new Uint32Array(0) };
}

export function vertexCount(m: MeshData): number {
  return m.positions.length / 3;
}

export function triangleCount(m: MeshData): number {
  return m.indices.length / 3;
}

export function computeNormals(m: MeshData): Float32Array {
  const n = vertexCount(m);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < m.indices.length; i += 3) {
    const ia = m.indices[i] * 3;
    const ib = m.indices[i + 1] * 3;
    const ic = m.indices[i + 2] * 3;
    const a: Vec3 = [m.positions[ia], m.positions[ia + 1], m.positions[ia + 2]];
    const b: Vec3 = [m.positions[ib], m.positions[ib + 1], m.positions[ib + 2]];
    const c: Vec3 = [m.positions[ic], m.positions[ic + 1], m.positions[ic + 2]];
    const fn = cross(sub(b, a), sub(c, a));
    for (const idx of [ia, ib, ic]) {
      normals[idx] += fn[0];
      normals[idx + 1] += fn[1];
      normals[idx + 2] += fn[2];
    }
  }
  for (let i = 0; i < n; i++) {
    const nrm = normalize([normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]]);
    normals[i * 3] = nrm[0];
    normals[i * 3 + 1] = nrm[1];
    normals[i * 3 + 2] = nrm[2];
  }
  return normals;
}

export interface MeshBuilder {
  positions: number[];
  indices: number[];
}

export function meshBuilder(): MeshBuilder {
  return { positions: [], indices: [] };
}

export function addVertex(b: MeshBuilder, p: Vec3): number {
  b.positions.push(p[0], p[1], p[2]);
  return b.positions.length / 3 - 1;
}

export function buildMesh(b: MeshBuilder): MeshData {
  return {
    positions: new Float32Array(b.positions),
    indices: Uint32Array.from(b.indices),
  };
}

/** 沿中心线（站点 + 局部框架 + 每站点半径）扫掠生成封闭管网格，capStart/capEnd 封口 */
export interface SweepSection {
  center: Vec3;
  /** 框架两正交基向量 u,v（垂直于切线） */
  u: Vec3;
  v: Vec3;
  radius: number;
}

export function sweepMesh(
  sections: SweepSection[],
  radialSegments: number,
  capStart: boolean,
  capEnd: boolean,
  inward: boolean,
): MeshData {
  const b = meshBuilder();
  const rings: number[][] = [];
  for (const s of sections) {
    const ring: number[] = [];
    for (let j = 0; j < radialSegments; j++) {
      const ang = (2 * Math.PI * j) / radialSegments;
      const p = add(
        add(s.center, scale(s.u, Math.cos(ang) * s.radius)),
        scale(s.v, Math.sin(ang) * s.radius),
      );
      ring.push(addVertex(b, p));
    }
    rings.push(ring);
  }
  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const j2 = (j + 1) % radialSegments;
      const a = rings[i][j];
      const bb = rings[i][j2];
      const c = rings[i + 1][j];
      const d = rings[i + 1][j2];
      if (inward) {
        // 内表面：绕序翻转，保证法线朝腔内
        b.indices.push(a, c, bb, bb, c, d);
      } else {
        b.indices.push(a, bb, c, bb, d, c);
      }
    }
  }
  if (capStart) {
    const center = addVertex(b, sections[0].center);
    for (let j = 0; j < radialSegments; j++) {
      const j2 = (j + 1) % radialSegments;
      if (inward) b.indices.push(center, rings[0][j], rings[0][j2]);
      else b.indices.push(center, rings[0][j2], rings[0][j]);
    }
  }
  if (capEnd) {
    const last = sections.length - 1;
    const center = addVertex(b, sections[last].center);
    for (let j = 0; j < radialSegments; j++) {
      const j2 = (j + 1) % radialSegments;
      if (inward) b.indices.push(center, rings[last][j2], rings[last][j]);
      else b.indices.push(center, rings[last][j], rings[last][j2]);
    }
  }
  return buildMesh(b);
}

/** 平行传输框架：给定中心线与切线，生成无扭转的 u/v 基 */
export function parallelTransportFrames(points: Vec3[], tangents?: Vec3[]): { u: Vec3; v: Vec3 }[] {
  const tans = tangents ?? points.map((p, i) => {
    if (i === 0) return normalize(sub(points[1], p));
    if (i === points.length - 1) return normalize(sub(p, points[i - 1]));
    return normalize(sub(points[i + 1], points[i - 1]));
  });
  const frames: { u: Vec3; v: Vec3 }[] = [];
  // 初始 u：选与首切线最不平行的世界轴叉乘
  const t0 = tans[0];
  const ref: Vec3 = Math.abs(t0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u = normalize(cross(ref, t0));
  for (let i = 0; i < points.length; i++) {
    const t = tans[i];
    if (i > 0) {
      const prevT = tans[i - 1];
      const axis = cross(prevT, t);
      const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
      if (axisLen > 1e-8) {
        const ang = Math.acos(Math.max(-1, Math.min(1, (prevT[0] * t[0] + prevT[1] * t[1] + prevT[2] * t[2]))));
        u = rotateAroundAxis(u, normalize(axis), ang);
      }
      u = normalize(sub(u, scale(t, u[0] * t[0] + u[1] * t[1] + u[2] * t[2])));
    }
    const vv = normalize(cross(t, u));
    frames.push({ u, v: vv });
  }
  return frames;
}

export function rotateAroundAxis(p: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2];
  const cr = cross(axis, p);
  return [
    p[0] * c + cr[0] * s + axis[0] * d * (1 - c),
    p[1] * c + cr[1] * s + axis[1] * d * (1 - c),
    p[2] * c + cr[2] * s + axis[2] * d * (1 - c),
  ];
}

/** 轴对齐盒体网格（真实尺寸器件用），center 为盒中心，axis 为局部 +Z 朝向 */
export function boxMesh(center: Vec3, axis: Vec3, size: { width: number; height: number; depth: number }): MeshData {
  const b = meshBuilder();
  const z = normalize(axis);
  const ref: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = normalize(cross(ref, z));
  const y = cross(z, x);
  const hx = size.width / 2;
  const hy = size.height / 2;
  const hz = size.depth / 2;
  const local: Vec3[] = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const world = local.map((p) =>
    add(center, add(add(scale(x, p[0]), scale(y, p[1])), scale(z, p[2]))),
  );
  for (const p of world) addVertex(b, p);
  const faces = [
    [0, 3, 2], [0, 2, 1],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [2, 3, 7], [2, 7, 6],
    [1, 2, 6], [1, 6, 5],
    [0, 4, 7], [0, 7, 3],
  ];
  for (const f of faces) b.indices.push(f[0], f[1], f[2]);
  return buildMesh(b);
}

/** 圆柱网格（受话器/电池/声管），两端封口 */
export function cylinderMesh(center: Vec3, axis: Vec3, radius: number, length: number, radial = 24): MeshData {
  const z = normalize(axis);
  const ref: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(ref, z));
  const vv = cross(z, u);
  const c0 = sub(center, scale(z, length / 2));
  const c1 = add(center, scale(z, length / 2));
  const sections: SweepSection[] = [
    { center: c0, u, v: vv, radius },
    { center: c1, u, v: vv, radius },
  ];
  return sweepMesh(sections, radial, true, true, false);
}

/** 沿折线路径扫掠圆管（声管/通气孔），可指定每段半径 */
export function tubeAlongPath(path: Vec3[], radius: number, radial = 16, inward = false): MeshData {
  const frames = parallelTransportFrames(path);
  const sections: SweepSection[] = path.map((center, i) => ({
    center,
    u: frames[i].u,
    v: frames[i].v,
    radius,
  }));
  return sweepMesh(sections, radial, true, true, inward);
}

/** 网格合并（多器件合成渲染批次用） */
export function mergeMeshes(meshes: MeshData[]): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const m of meshes) {
    positions.push(...m.positions);
    for (const idx of m.indices) indices.push(idx + offset);
    offset += m.positions.length / 3;
  }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(indices) };
}

/** 包围盒 */
export function boundingBox(m: MeshData): { min: Vec3; max: Vec3; center: Vec3; size: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], m.positions[i + k]);
      max[k] = Math.max(max[k], m.positions[i + k]);
    }
  }
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}
