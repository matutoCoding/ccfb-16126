// 沿中心线截面剖切：切出轮廓环，三角化封口，返回剖切后的网格 + 封口网格
import { Vec3, v3 } from './math';
import { Centerline } from './centerline';
import { Mesh, computeNormals, emptyMesh } from './mesh';

export interface SliceResult {
  cutMesh: Mesh; // 被切剩的网格
  capMesh: Mesh; // 切口封口（单独着色）
  contours: Vec3[][]; // 截面轮廓（外环 + 孔环）
  center: Vec3;
  normal: Vec3;
}

// 平面与三角形求交，返回线段端点
function triPlane(
  p: Float32Array,
  ia: number,
  ib: number,
  ic: number,
  planePoint: Vec3,
  planeNormal: Vec3,
): Vec3[] {
  const d = (vi: number) =>
    v3.dot(
      [p[vi], p[vi + 1], p[vi + 2]] as Vec3,
      planeNormal,
    ) - v3.dot(planePoint, planeNormal);
  const da = d(ia), db = d(ib), dc = d(ic);
  const pts: Vec3[] = [];
  const interp = (d0: number, d1: number, v0: number, v1: number) => {
    const t = d0 / (d0 - d1);
    return v3.lerp([p[v0], p[v0 + 1], p[v0 + 2]], [p[v1], p[v1 + 1], p[v1 + 2]], t);
  };
  if ((da > 0) !== (db > 0) && da !== 0 && db !== 0) pts.push(interp(da, db, ia, ib));
  if ((db > 0) !== (dc > 0) && db !== 0 && dc !== 0) pts.push(interp(db, dc, ib, ic));
  if ((dc > 0) !== (da > 0) && dc !== 0 && da !== 0) pts.push(interp(dc, da, ic, ia));
  return pts;
}

// 把无序交线段连成闭合环
function linkLoops(segments: [Vec3, Vec3][], tol = 1e-4): Vec3[][] {
  const loops: Vec3[][] = [];
  const used = new Array(segments.length).fill(false);
  const near = (a: Vec3, b: Vec3) => v3.dist(a, b) < tol;
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop = [segments[i][0], segments[i][1]];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = loop[loop.length - 1];
      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const [a, b] = segments[j];
        if (near(tail, a)) { loop.push(b); used[j] = true; extended = true; break; }
        if (near(tail, b)) { loop.push(a); used[j] = true; extended = true; break; }
      }
    }
    if (loop.length > 2 && near(loop[0], loop[loop.length - 1])) loop.pop();
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function sliceMesh(mesh: Mesh, cl: Centerline, s: number): SliceResult {
  const center = cl.pointAt(s);
  const normal = cl.tangentAt(s);
  const p = mesh.positions;

  // 1) 保留负侧三角形，跨平面三角形裁剪
  const keptPos: number[] = [];
  const keptIdx: number[] = [];
  const segments: [Vec3, Vec3][] = [];
  const side = (vi: number) =>
    v3.dot([p[vi], p[vi + 1], p[vi + 2]] as Vec3, normal) - v3.dot(center, normal);

  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const ia = mesh.indices[t * 3] * 3;
    const ib = mesh.indices[t * 3 + 1] * 3;
    const ic = mesh.indices[t * 3 + 2] * 3;
    const da = side(ia), db = side(ib), dc = side(ic);
    const inside = (d: number) => d <= 0;
    const inA = inside(da), inB = inside(db), inC = inside(dc);
    if (inA && inB && inC) {
      const base = keptPos.length / 3;
      keptPos.push(...p.slice(ia, ia + 3), ...p.slice(ib, ib + 3), ...p.slice(ic, ic + 3));
      keptIdx.push(base, base + 1, base + 2);
      continue;
    }
    if (!inA && !inB && !inC) continue;
    const seg = triPlane(p, ia, ib, ic, center, normal);
    if (seg.length === 2) segments.push([seg[0], seg[1]]);
    // 裁剪后的多边形（2~4 顶点），扇形化
    const poly: Vec3[] = [];
    const verts: [Vec3, boolean][] = [
      [[p[ia], p[ia + 1], p[ia + 2]], inA],
      [[p[ib], p[ib + 1], p[ib + 2]], inB],
      [[p[ic], p[ic + 1], p[ic + 2]], inC],
    ];
    for (let k = 0; k < 3; k++) {
      const v = verts[k], vNext = verts[(k + 1) % 3];
      if (v[1]) poly.push(v[0]);
      if (v[1] !== vNext[1]) {
        const vi = k === 0 ? ia : k === 1 ? ib : ic;
        const vj = (k + 1) === 0 ? ia : (k + 1) === 1 ? ib : ic;
        const d0 = side(vi), d1 = side(vj);
        const tt = d0 / (d0 - d1);
        poly.push(v3.lerp(v[0], vNext[0], tt));
      }
    }
    if (poly.length >= 3) {
      const base = keptPos.length / 3;
      for (const q of poly) keptPos.push(...q);
      for (let k = 1; k < poly.length - 1; k++) keptIdx.push(base, base + k, base + k + 1);
    }
  }

  // 2) 截面环 + 封口
  const loops = linkLoops(segments);
  const capPos: number[] = [];
  const capIdx: number[] = [];
  // 按面积排序，最大为外环
  const loopArea = (loop: Vec3[]) => {
    const c = loop.reduce((acc, q) => v3.add(acc, q), [0, 0, 0] as Vec3);
    const cen = v3.scale(c, 1 / loop.length);
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
      area += v3.dot(v3.cross(v3.sub(loop[i], cen), v3.sub(loop[(i + 1) % loop.length], cen)), normal) / 2;
    }
    return Math.abs(area);
  };
  loops.sort((a, b) => loopArea(b) - loopArea(a));
  loops.forEach((loop, li) => {
    const c = loop.reduce((acc, q) => v3.add(acc, q), [0, 0, 0] as Vec3);
    const cen = v3.scale(c, 1 / loop.length);
    const centerIdx = capPos.length / 3;
    capPos.push(...cen);
    const base = capPos.length / 3;
    for (const q of loop) capPos.push(...q);
    const reverse = li !== 0; // 孔环反向
    for (let i = 0; i < loop.length; i++) {
      const a = base + i;
      const b = base + ((i + 1) % loop.length);
      if (reverse) capIdx.push(centerIdx, b, a);
      else capIdx.push(centerIdx, a, b);
    }
  });

  const cutMesh: Mesh = {
    positions: Float32Array.from(keptPos),
    normals: new Float32Array(keptPos.length),
    indices: Uint32Array.from(keptIdx),
    name: `${mesh.name}-cut`,
  };
  cutMesh.normals = computeNormals(cutMesh);
  const capMesh: Mesh = loops.length
    ? {
        positions: Float32Array.from(capPos),
        normals: new Float32Array(capPos.length),
        indices: Uint32Array.from(capIdx),
        name: `${mesh.name}-cap`,
      }
    : emptyMesh('cap');
  if (loops.length) capMesh.normals = computeNormals(capMesh);

  return { cutMesh, capMesh, contours: loops, center, normal };
}
