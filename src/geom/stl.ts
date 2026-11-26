import type { MeshData, Vec3 } from '../types';
import { computeNormals, createMesh } from './mesh';

export function parseSTL(buffer: ArrayBuffer): MeshData {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 84) {
    const view = new DataView(buffer);
    const triangleCount = view.getUint32(80, true);
    if (84 + triangleCount * 50 === bytes.length) return parseBinarySTL(buffer, triangleCount);
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  if (/^\s*solid/i.test(text) && text.includes('facet')) return parseAsciiSTL(text);
  // Some binary files have inaccurate counts/header; try binary if size structurally plausible.
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  if (triangleCount > 0 && 84 + Math.min(triangleCount, 50_000_000) * 50 <= bytes.length + 500) {
    return parseBinarySTL(buffer, Math.min(triangleCount, Math.floor((bytes.length - 84) / 50)));
  }
  throw new Error('无法识别 STL：既不是合法 ASCII STL，也不是长度匹配的二进制 STL。');
}

function parseBinarySTL(buffer: ArrayBuffer, triangleCount: number): MeshData {
  const view = new DataView(buffer);
  const positions = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  let po = 0;
  for (let i = 0; i < triangleCount; i++) {
    const offset = 84 + i * 50;
    // normal at offset..11 is ignored; compute smooth normals after welding.
    for (let v = 0; v < 3; v++) {
      const o = offset + 12 + v * 12;
      positions[po++] = view.getFloat32(o, true);
      positions[po++] = view.getFloat32(o + 4, true);
      positions[po++] = view.getFloat32(o + 8, true);
    }
    indices[i * 3] = i * 3;
    indices[i * 3 + 1] = i * 3 + 1;
    indices[i * 3 + 2] = i * 3 + 2;
  }
  const welded = weldVertices(positions, indices);
  computeNormals(welded);
  return welded;
}

function parseAsciiSTL(text: string): MeshData {
  const verts: Vec3[] = [];
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(text))) verts.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  if (verts.length < 3 || verts.length % 3 !== 0) throw new Error('ASCII STL 中没有找到完整三角形顶点。');
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => positions.set(v, i * 3));
  const indices = new Uint32Array(verts.length);
  for (let i = 0; i < verts.length; i++) indices[i] = i;
  const welded = weldVertices(positions, indices);
  computeNormals(welded);
  return welded;
}

/** Quantized welding removes the three independent vertices per STL triangle. */
export function weldVertices(positions: Float32Array, indices: Uint32Array, precisionMm = 1e-4): MeshData {
  const scale = 1 / precisionMm;
  const map = new Map<string, number>();
  const outPositions: number[] = [];
  const outIndices = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const src = indices[i] * 3;
    const x = positions[src], y = positions[src + 1], z = positions[src + 2];
    const key = `${Math.round(x * scale)},${Math.round(y * scale)},${Math.round(z * scale)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = outPositions.length / 3;
      map.set(key, id);
      outPositions.push(x, y, z);
    }
    outIndices[i] = id;
  }
  return createMesh(new Float32Array(outPositions), outIndices);
}

export function writeBinarySTL(mesh: MeshData, name = 'ear-shell'): Blob {
  const triangles = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < Math.min(name.length, 80); i++) bytes[i] = name.charCodeAt(i);
  view.setUint32(80, triangles, true);
  const p = mesh.positions;
  for (let t = 0; t < triangles; t++) {
    const o = 84 + t * 50;
    const ia = mesh.indices[t * 3] * 3;
    const ib = mesh.indices[t * 3 + 1] * 3;
    const ic = mesh.indices[t * 3 + 2] * 3;
    const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
    const bx = p[ib] - ax, by = p[ib + 1] - ay, bz = p[ib + 2] - az;
    const cx = p[ic] - ax, cy = p[ic + 1] - ay, cz = p[ic + 2] - az;
    let nx = by * cz - bz * cy;
    let ny = bz * cx - bx * cz;
    let nz = bx * cy - by * cx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    const verts = [ia, ib, ic];
    for (let v = 0; v < 3; v++) {
      const k = verts[v];
      view.setFloat32(o + 12 + v * 12, p[k], true);
      view.setFloat32(o + 16 + v * 12, p[k + 1], true);
      view.setFloat32(o + 20 + v * 12, p[k + 2], true);
    }
    view.setUint16(o + 48, 0, true);
  }
  return new Blob([buffer], { type: 'model/stl' });
}
