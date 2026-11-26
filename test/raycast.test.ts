// 验证 RayMeshIntersector 在多视角下与暴力求交的命中率一致性
import { describe, it, expect } from 'vitest';
import { generateImpression } from '../src/core/impression';
import { designShell, defaultParams } from '../src/core/shell';
import { RayMeshIntersector } from '../src/core/raycast';
import { m4, pixelRay, Vec3, Mat4 } from '../src/core/math';

describe('射线求交视角覆盖率', () => {
  it('加速结构与暴力求交在多个视角命中率一致', () => {
    const imp = generateImpression('normal', 40);
    const params = { ...defaultParams(imp), ventPath: [], soundPath: [] };
    const res = designShell(imp.field, imp, params, 40);
    const mesh = res.mesh;
    const inter = new RayMeshIntersector(mesh, 48);

    // 构造一个俯视外壳的透视矩阵
    const fovy = Math.PI / 4, near = 0.5, far = 400, aspect = 1;
    const f = 1 / Math.tan(fovy / 2);
    const proj: Mat4 = new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0,
    ]);
    // 视图：相机在 (0, 0, 30) 看原点
    const view: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -30, 1]);
    const vp = m4.multiply(proj, view);
    const inv = m4.invert(vp);

    let gridHits = 0, bruteHits = 0, total = 0;
    const W = 48, H = 48;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ndcX = (2 * x) / W - 1;
        const ndcY = 1 - (2 * y) / H;
        const { origin, dir } = pixelRay(inv, ndcX, ndcY);
        const g = inter.intersectAll(origin, dir).length;
        const b = brute(mesh, origin, dir);
        if (g > 0) gridHits++;
        if (b > 0) bruteHits++;
        total++;
      }
    }
    console.log(`网格加速命中 ${gridHits}/${total}, 暴力命中 ${bruteHits}/${total}`);
    // 该视角下外壳约占 76% 像素；网格量化导致少量边界差异，容差 5%
    expect(gridHits).toBeGreaterThan(total * 0.6);
    expect(Math.abs(gridHits - bruteHits) / total).toBeLessThan(0.05);
  });
});

function brute(mesh: ReturnType<typeof designShell>['mesh'], origin: Vec3, dir: Vec3): number {
  const p = mesh.positions, idx = mesh.indices;
  let count = 0;
  for (let tri = 0; tri < idx.length / 3; tri++) {
    const ia = idx[tri * 3] * 3, ib = idx[tri * 3 + 1] * 3, ic = idx[tri * 3 + 2] * 3;
    const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
    const e1x = p[ib] - ax, e1y = p[ib + 1] - ay, e1z = p[ib + 2] - az;
    const e2x = p[ic] - ax, e2y = p[ic + 1] - ay, e2z = p[ic + 2] - az;
    const hx = dir[1] * e2z - dir[2] * e2y, hy = dir[2] * e2x - dir[0] * e2z, hz = dir[0] * e2y - dir[1] * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) continue;
    const invd = 1 / det;
    const sx = origin[0] - ax, sy = origin[1] - ay, sz = origin[2] - az;
    const u = (sx * hx + sy * hy + sz * hz) * invd;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invd;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * invd;
    if (t > 1e-6) count++;
  }
  return count;
}
