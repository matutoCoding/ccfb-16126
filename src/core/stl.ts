/** STL 二进制 / ASCII 解析与导出。单位约定 mm。 */
import { Mesh, MeshBuilder, weld } from './geometry';

export function parseSTL(buffer: ArrayBuffer): Mesh {
  const bytes = new Uint8Array(buffer);
  const isAscii = looksAscii(bytes);
  if (isAscii) return parseAsciiSTL(new TextDecoder().decode(bytes));
  return parseBinarySTL(buffer);
}

function looksAscii(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 512));
  const text = new TextDecoder().decode(head);
  return /^\s*solid[\s\S]*?facet/i.test(text) && !/^\s*solid\s*\0/.test(text);
}

function parseBinarySTL(buffer: ArrayBuffer): Mesh {
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (buffer.byteLength < expected - 1) {
    // 头部可能不是标准 80 字节，退化按 ASCII 尝试
    throw new Error('二进制 STL 长度与三角面数量不符，文件可能损坏');
  }
  const b = new MeshBuilder();
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    // 12 字节法向（忽略，重新计算）
    offset += 12;
    const base = b.pos.length / 3;
    for (let k = 0; k < 3; k++) {
      const x = dv.getFloat32(offset, true);
      const y = dv.getFloat32(offset + 4, true);
      const z = dv.getFloat32(offset + 8, true);
      offset += 12;
      b.vertex([x, y, z]);
    }
    b.tri(base, base + 1, base + 2);
    offset += 2; // attribute
  }
  return weld(b.build(), 0.005);
}

function parseAsciiSTL(text: string): Mesh {
  const b = new MeshBuilder();
  const facetRe = /facet\s+normal[^e]*?endfacet/gs;
  let m: RegExpExecArray | null;
  while ((m = facetRe.exec(text))) {
    const verts = [...m[0].matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g)];
    if (verts.length !== 3) continue;
    const base = b.pos.length / 3;
    for (const v of verts) b.vertex([parseFloat(v[1]), parseFloat(v[2]), parseFloat(v[3])]);
    b.tri(base, base + 1, base + 2);
  }
  if (b.idx.length === 0) throw new Error('ASCII STL 未解析出任何三角面');
  return weld(b.build(), 0.005);
}

/** 导出二进制 STL（调用方负责下载/入库） */
export function exportBinarySTL(mesh: Mesh): ArrayBuffer {
  const triCount = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // 80 字节头
  u8.set(new TextEncoder().encode('earmold-studio binary STL'), 0);
  dv.setUint32(80, triCount, true);
  let off = 84;
  const p = mesh.positions, n = mesh.normals, ix = mesh.indices;
  for (let i = 0; i < triCount; i++) {
    const ia = ix[i * 3], ib = ix[i * 3 + 1], ic = ix[i * 3 + 2];
    // 面法向
    const ux = p[ib * 3] - p[ia * 3], uy = p[ib * 3 + 1] - p[ia * 3 + 1], uz = p[ib * 3 + 2] - p[ia * 3 + 2];
    const vx = p[ic * 3] - p[ia * 3], vy = p[ic * 3 + 1] - p[ia * 3 + 1], vz = p[ic * 3 + 2] - p[ia * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    off += 12;
    for (const vi of [ia, ib, ic]) {
      dv.setFloat32(off, p[vi * 3], true);
      dv.setFloat32(off + 4, p[vi * 3 + 1], true);
      dv.setFloat32(off + 8, p[vi * 3 + 2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  void n;
  return buf;
}

export function downloadArrayBuffer(buf: ArrayBuffer, filename: string): void {
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
