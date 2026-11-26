import type { MeshData, Vec3 } from '../types';

export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}

export function computeNormals(mesh: MeshData): Float32Array {
  const n = vertexCount(mesh);
  const normals = new Float32Array(n * 3);
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
    const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
    const bx = p[ib] - ax, by = p[ib + 1] - ay, bz = p[ib + 2] - az;
    const cx = p[ic] - ax, cy = p[ic + 1] - ay, cz = p[ic + 2] - az;
    const nx = by * cz - bz * cy;
    const ny = bz * cx - bx * cz;
    const nz = bx * cy - by * cx;
    for (const k of [ia, ib, ic]) {
      normals[k] += nx; normals[k + 1] += ny; normals[k + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (l > 1e-12) {
      normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
    } else {
      normals[i] = 0; normals[i + 1] = 0; normals[i + 2] = 1;
    }
  }
  mesh.normals = normals;
  return normals;
}

export function ensureNormals(mesh: MeshData): Float32Array {
  if (!mesh.normals || mesh.normals.length !== mesh.positions.length) computeNormals(mesh);
  return mesh.normals!;
}

export function createMesh(positions: number[] | Float32Array, indices: number[] | Uint32Array, surface?: number[] | Uint8Array): MeshData {
  const mesh: MeshData = {
    positions: positions instanceof Float32Array ? positions : new Float32Array(positions),
    indices: indices instanceof Uint32Array ? indices : new Uint32Array(indices)
  };
  if (surface) mesh.surface = surface instanceof Uint8Array ? surface : Uint8Array.from(surface);
  computeNormals(mesh);
  return mesh;
}

export function createBoxMesh(size: Vec3): MeshData {
  const [sx, sy, sz] = size.map(v => v / 2);
  const faces: Array<{ n: Vec3; c: Vec3[] }> = [
    { n: [1, 0, 0], c: [[sx, -sy, -sz], [sx, sy, -sz], [sx, sy, sz], [sx, -sy, sz]] },
    { n: [-1, 0, 0], c: [[-sx, -sy, sz], [-sx, sy, sz], [-sx, sy, -sz], [-sx, -sy, -sz]] },
    { n: [0, 1, 0], c: [[-sx, sy, -sz], [-sx, sy, sz], [sx, sy, sz], [sx, sy, -sz]] },
    { n: [0, -1, 0], c: [[-sx, -sy, sz], [-sx, -sy, -sz], [sx, -sy, -sz], [sx, -sy, sz]] },
    { n: [0, 0, 1], c: [[-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz]] },
    { n: [0, 0, -1], c: [[sx, -sy, -sz], [-sx, -sy, -sz], [-sx, sy, -sz], [sx, sy, -sz]] }
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (const c of f.c) positions.push(...c);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return createMesh(positions, indices);
}

/** Cylinder whose axis is Z, centered at origin. */
export function createCylinderMesh(radiusTop: number, radiusBottom: number, length: number, segments = 32, caps = true): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const z0 = -length / 2, z1 = length / 2;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    positions.push(radiusBottom * c, radiusBottom * s, z0);
    positions.push(radiusTop * c, radiusTop * s, z1);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  if (caps) {
    const bottomCenter = positions.length / 3;
    positions.push(0, 0, z0);
    const bottomBase = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(radiusBottom * Math.cos(a), radiusBottom * Math.sin(a), z0);
    }
    for (let i = 0; i < segments; i++) indices.push(bottomCenter, bottomBase + i + 1, bottomBase + i);

    const topCenter = positions.length / 3;
    positions.push(0, 0, z1);
    const topBase = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(radiusTop * Math.cos(a), radiusTop * Math.sin(a), z1);
    }
    for (let i = 0; i < segments; i++) indices.push(topCenter, topBase + i, topBase + i + 1);
  }
  return createMesh(positions, indices);
}

export function createSphereMesh(radius: number, lat = 16, lon = 24): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= lat; y++) {
    const v = y / lat;
    const theta = v * Math.PI;
    for (let x = 0; x <= lon; x++) {
      const u = x / lon;
      const phi = u * Math.PI * 2;
      positions.push(
        radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.cos(theta),
        radius * Math.sin(theta) * Math.sin(phi)
      );
    }
  }
  for (let y = 0; y < lat; y++) {
    for (let x = 0; x < lon; x++) {
      const a = y * (lon + 1) + x;
      const b = a + lon + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return createMesh(positions, indices);
}

export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3; center: Vec3; size: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    min[0] = Math.min(min[0], p[i]); min[1] = Math.min(min[1], p[i + 1]); min[2] = Math.min(min[2], p[i + 2]);
    max[0] = Math.max(max[0], p[i]); max[1] = Math.max(max[1], p[i + 1]); max[2] = Math.max(max[2], p[i + 2]);
  }
  return {
    min, max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  };
}

export function cloneMesh(mesh: MeshData): MeshData {
  return {
    positions: new Float32Array(mesh.positions),
    indices: new Uint32Array(mesh.indices),
    normals: mesh.normals ? new Float32Array(mesh.normals) : undefined,
    surface: mesh.surface ? new Uint8Array(mesh.surface) : undefined
  };
}
