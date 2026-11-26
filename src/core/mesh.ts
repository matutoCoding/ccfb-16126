import { Vec3, v3 } from './math';

// 三角网格：位置 + 法向 + 可选每顶点标量场（用于薄壁厚染红等）
export interface Mesh {
  positions: Float32Array; // vec3 展开
  normals: Float32Array;
  indices: Uint32Array;
  scalar?: Float32Array; // 每顶点标量（如厚度 mm）
  name?: string;
}

export function emptyMesh(name = ''): Mesh {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    name,
  };
}

export function meshStats(m: Mesh): { vertices: number; triangles: number } {
  return { vertices: m.positions.length / 3, triangles: m.indices.length / 3 };
}

export function computeNormals(m: Mesh): Float32Array {
  const n = new Float32Array(m.positions.length);
  for (let i = 0; i < m.indices.length; i += 3) {
    const ia = m.indices[i] * 3, ib = m.indices[i + 1] * 3, ic = m.indices[i + 2] * 3;
    const a: Vec3 = [m.positions[ia], m.positions[ia + 1], m.positions[ia + 2]];
    const b: Vec3 = [m.positions[ib], m.positions[ib + 1], m.positions[ib + 2]];
    const c: Vec3 = [m.positions[ic], m.positions[ic + 1], m.positions[ic + 2]];
    const fn = v3.cross(v3.sub(b, a), v3.sub(c, a));
    n[ia] += fn[0]; n[ia + 1] += fn[1]; n[ia + 2] += fn[2];
    n[ib] += fn[0]; n[ib + 1] += fn[1]; n[ib + 2] += fn[2];
    n[ic] += fn[0]; n[ic + 1] += fn[1]; n[ic + 2] += fn[2];
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// 焊接重复顶点（量化到 1e-5 mm），返回新网格与旧顶点->新顶点映射
export function weldVertices(m: Mesh, quant = 1e5): { mesh: Mesh; remap: Int32Array } {
  const map = new Map<string, number>();
  const remap = new Int32Array(m.positions.length / 3);
  const out: number[] = [];
  const keyOf = (x: number, y: number, z: number) =>
    `${Math.round(x * quant)},${Math.round(y * quant)},${Math.round(z * quant)}`;
  for (let i = 0; i < m.positions.length / 3; i++) {
    const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
    const k = keyOf(x, y, z);
    let id = map.get(k);
    if (id === undefined) {
      id = out.length / 3;
      map.set(k, id);
      out.push(x, y, z);
    }
    remap[i] = id;
  }
  const indices = new Uint32Array(m.indices.length);
  for (let i = 0; i < m.indices.length; i++) indices[i] = remap[m.indices[i]];
  const welded: Mesh = {
    positions: Float32Array.from(out),
    normals: new Float32Array(out.length),
    indices,
    name: m.name,
  };
  welded.normals = computeNormals(welded);
  return { mesh: welded, remap };
}

// ---------- STL 解析 ----------
export function parseSTL(buffer: ArrayBuffer): Mesh {
  const bytes = new Uint8Array(buffer);
  const isAscii = bytes.length > 5 && stlStartsAscii(bytes);
  if (isAscii) return parseAsciiSTL(new TextDecoder().decode(bytes));
  return parseBinarySTL(buffer);
}

function stlStartsAscii(b: Uint8Array): boolean {
  const head = new TextDecoder().decode(b.subarray(0, 80)).trimStart().toLowerCase();
  return head.startsWith('solid') && !looksBinary(b);
}
function looksBinary(b: Uint8Array): boolean {
  if (b.length < 84) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const triCount = dv.getUint32(80, true);
  return 84 + triCount * 50 === b.byteLength;
}

function parseBinarySTL(buffer: ArrayBuffer): Mesh {
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const indices = new Uint32Array(triCount * 3);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const nx = dv.getFloat32(off, true), ny = dv.getFloat32(off + 4, true), nz = dv.getFloat32(off + 8, true);
    off += 12;
    const base = t * 9;
    for (let k = 0; k < 3; k++) {
      positions[base + k * 3] = dv.getFloat32(off, true);
      positions[base + k * 3 + 1] = dv.getFloat32(off + 4, true);
      positions[base + k * 3 + 2] = dv.getFloat32(off + 8, true);
      normals[base + k * 3] = nx;
      normals[base + k * 3 + 1] = ny;
      normals[base + k * 3 + 2] = nz;
      indices[t * 3 + k] = t * 3 + k;
      off += 12;
    }
    off += 2; // attribute byte count
  }
  const { mesh } = weldVertices({ positions, normals, indices });
  return mesh;
}

function parseAsciiSTL(text: string): Mesh {
  const verts: number[] = [];
  const idx: number[] = [];
  const lines = text.split(/\r?\n/);
  let counter = 0;
  for (const line of lines) {
    const m = line.trim().match(/^vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/);
    if (m) {
      verts.push(Number(m[1]), Number(m[2]), Number(m[3]));
      idx.push(counter++);
    }
  }
  const mesh: Mesh = {
    positions: Float32Array.from(verts),
    normals: new Float32Array(verts.length),
    indices: Uint32Array.from(idx),
  };
  const welded = weldVertices(mesh);
  return welded.mesh;
}

// ---------- STL 导出（二进制） ----------
export function exportBinarySTL(m: Mesh): Blob {
  const triCount = m.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  // 80 字节头，写入名称
  const nameBytes = new TextEncoder().encode(m.name ?? 'earmold');
  u8.set(nameBytes.subarray(0, 79), 0);
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const ia = m.indices[t * 3], ib = m.indices[t * 3 + 1], ic = m.indices[t * 3 + 2];
    const a: Vec3 = [m.positions[ia * 3], m.positions[ia * 3 + 1], m.positions[ia * 3 + 2]];
    const b: Vec3 = [m.positions[ib * 3], m.positions[ib * 3 + 1], m.positions[ib * 3 + 2]];
    const c: Vec3 = [m.positions[ic * 3], m.positions[ic * 3 + 1], m.positions[ic * 3 + 2]];
    const n = v3.normalize(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    dv.setFloat32(off, n[0], true); dv.setFloat32(off + 4, n[1], true); dv.setFloat32(off + 8, n[2], true);
    off += 12;
    const tri = [a, b, c];
    for (const p of tri) {
      dv.setFloat32(off, p[0], true);
      dv.setFloat32(off + 4, p[1], true);
      dv.setFloat32(off + 8, p[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'application/octet-stream' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
