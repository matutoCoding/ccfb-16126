import type { MeshData } from '../../types';

/** 解析二进制或 ASCII STL（毫米单位原样返回） */
export function parseSTL(buffer: ArrayBuffer): MeshData {
  const bytes = new Uint8Array(buffer);
  const asText = () => new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 2048)));
  const head = asText();
  if (head.trimStart().toLowerCase().startsWith('solid') && /facet\s+normal/.test(head)) {
    return parseAsciiSTL(new TextDecoder().decode(bytes));
  }
  return parseBinarySTL(buffer);
}

function parseBinarySTL(buffer: ArrayBuffer): MeshData {
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (expected !== buffer.byteLength) {
    // 长度不匹配时尝试按 ASCII 兜底
    return parseAsciiSTL(new TextDecoder().decode(new Uint8Array(buffer)));
  }
  const positions: number[] = [];
  const indices: number[] = [];
  let offset = 84;
  const vertMap = new Map<string, number>();
  const key = (x: number, y: number, z: number) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
  for (let t = 0; t < triCount; t++) {
    offset += 12; // 法向量
    for (let k = 0; k < 3; k++) {
      const x = dv.getFloat32(offset, true);
      const y = dv.getFloat32(offset + 4, true);
      const z = dv.getFloat32(offset + 8, true);
      offset += 12;
      const id = key(x, y, z);
      let vi = vertMap.get(id);
      if (vi === undefined) {
        vi = positions.length / 3;
        vertMap.set(id, vi);
        positions.push(x, y, z);
      }
      indices.push(vi);
    }
    offset += 2; // 属性字节
  }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(indices) };
}

function parseAsciiSTL(text: string): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertMap = new Map<string, number>();
  const nums = text.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? [];
  // 跳过每个 facet 的法向量 3 个数，取其后 9 个顶点数
  let i = 0;
  while (i + 11 < nums.length) {
    i += 3; // normal
    for (let k = 0; k < 3; k++) {
      const x = parseFloat(nums[i++]);
      const y = parseFloat(nums[i++]);
      const z = parseFloat(nums[i++]);
      const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
      let vi = vertMap.get(key);
      if (vi === undefined) {
        vi = positions.length / 3;
        vertMap.set(key, vi);
        positions.push(x, y, z);
      }
      indices.push(vi);
    }
  }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(indices) };
}

/** 导出二进制 STL */
export function writeBinarySTL(mesh: MeshData, normals?: Float32Array): Blob {
  const triCount = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);
  dv.setUint32(80, triCount, true); // 头部 80 字节后写三角片计数
  const nrm = normals ?? new Float32Array(0);
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    const ia = mesh.indices[t * 3];
    const ib = mesh.indices[t * 3 + 1];
    const ic = mesh.indices[t * 3 + 2];
    const ax = mesh.positions[ia * 3];
    const ay = mesh.positions[ia * 3 + 1];
    const az = mesh.positions[ia * 3 + 2];
    const bx = mesh.positions[ib * 3];
    const by = mesh.positions[ib * 3 + 1];
    const bz = mesh.positions[ib * 3 + 2];
    const cx = mesh.positions[ic * 3];
    const cy = mesh.positions[ic * 3 + 1];
    const cz = mesh.positions[ic * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    if (nrm.length) {
      nx = nrm[ia * 3];
      ny = nrm[ia * 3 + 1];
      nz = nrm[ia * 3 + 2];
    } else {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    dv.setFloat32(offset, nx, true);
    dv.setFloat32(offset + 4, ny, true);
    dv.setFloat32(offset + 8, nz, true);
    offset += 12;
    const verts = [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ];
    for (const [x, y, z] of verts) {
      dv.setFloat32(offset, x, true);
      dv.setFloat32(offset + 4, y, true);
      dv.setFloat32(offset + 8, z, true);
      offset += 12;
    }
    dv.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'application/octet-stream' });
}
