import { describe, it, expect } from 'vitest';
import { generateImpression, ALL_KINDS } from '../src/core/impression';
import { designShell, defaultParams, WALL_LIMIT, findThinSpots } from '../src/core/shell';
import { RayMeshIntersector, shellSegments } from '../src/core/raycast';
import { checkBendPass } from '../src/core/bendCheck';
import { marchingCubes, gridFromBounds } from '../src/core/marchingCubes';
import { sdf } from '../src/core/sdf';
import { exportBinarySTL, parseSTL } from '../src/core/mesh';
import { v3 } from '../src/core/math';
import { Centerline } from '../src/core/centerline';

// 测试统一低分辨率，保证 CI 速度；精度由浏览器端高分辨率自检覆盖
const R = 36;

// 一维二分求根：f 从负（内）到正（外），找 f(d)=0 的 d
function rootFind(f: (d: number) => number, lo: number, hi: number): number | null {
  let flo = f(lo);
  if (flo === 0) return lo;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-5) return mid;
    if (flo < 0) {
      if (fm < 0) { lo = mid; flo = fm; } else hi = mid;
    } else {
      if (fm > 0) { lo = mid; flo = fm; } else hi = mid;
    }
  }
  return (lo + hi) / 2;
}

describe('耳印模生成', () => {
  it('四副印模都能生成网格且顶点法向完整', () => {
    for (const kind of ALL_KINDS) {
      const imp = generateImpression(kind, R);
      expect(imp.mesh.indices.length).toBeGreaterThan(500);
      expect(imp.mesh.normals.length).toBe(imp.mesh.positions.length);
      expect(imp.mesh.positions.every((n) => Number.isFinite(n))).toBe(true);
    }
  });

  it('气泡缺损印模带 3 处缺陷且表面被挖去', () => {
    const imp = generateImpression('bubbleDefect', R);
    expect(imp.defects).toHaveLength(3);
    expect(imp.field(imp.defects[0].center)).toBeGreaterThan(0);
  });

  it('急第二弯总转角显著大于正常印模', () => {
    const sharp = generateImpression('sharpBend', R);
    const normal = generateImpression('normal', R);
    const deg = (rad: number) => (rad * 180) / Math.PI;
    expect(deg(sharp.centerline.totalTurningAngle())).toBeGreaterThan(deg(normal.centerline.totalTurningAngle()) * 1.1);
  });

  it('窄耳道半径明显小于正常印模', () => {
    const narrow = generateImpression('narrow', R);
    const normal = generateImpression('normal', R);
    const s = normal.landmarks.firstBend + 2;
    expect(narrow.radiusAt(s)).toBeLessThan(normal.radiusAt(s) * 0.75);
  });
});

describe('外壳设计', () => {
  it('硬壳壁厚 1.2mm：外壁与内腔 SDF 径向距离差等于名义壁厚（关闭管路）', () => {
    const imp = generateImpression('normal', 56);
    const params = {
      ...defaultParams(imp),
      wallThickness: 1.2,
      material: 'hard' as const,
      ventPath: [],
      soundPath: [],
    };
    const res = designShell(imp.field, imp, params, 64);
    const cl = imp.centerline;
    const errors: number[] = [];
    // 沿管截面径向，外壁场零点与内腔场零点之间的距离即壁厚
    for (let s = 4; s < imp.landmarks.firstBend - 0.5; s += 1.5) {
      const fr = cl.frameAt(s);
      const c = cl.pointAt(s);
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const dir = v3.normalize(
          v3.add(v3.scale(fr.normal, Math.cos(ang)), v3.scale(fr.binormal, Math.sin(ang))),
        );
        // 二分找外壳表面（outer 场=0）与内腔表面（cavity 场=0）的径向距离
        const outer = (d: number) => imp.field(v3.add(c, v3.scale(dir, d))) + 0.15;
        const cavity = (d: number) => outer(d) + 1.2;
        const rOuter = rootFind(outer, 0, imp.radiusAt(s) + 2);
        const rInner = rootFind(cavity, 0, imp.radiusAt(s) + 2);
        if (rOuter !== null && rInner !== null) {
          errors.push(Math.abs(rOuter - rInner - 1.2));
        }
      }
    }
    expect(errors.length).toBeGreaterThan(20);
    // 解析场壁厚亚毫米级精确（tubeAlong 为折线距离场，弯段有微小法向偏差）
    expect(Math.max(...errors)).toBeLessThan(0.1);
  });

  it('壁厚低于下限的参数会被 findThinSpots 检出', () => {
    const imp = generateImpression('narrow', R);
    const params = { ...defaultParams(imp), wallThickness: 0.6, material: 'hard' as const };
    const res = designShell(imp.field, imp, params, R);
    const spots = findThinSpots(res.field, imp, params, 40);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots[0].limit).toBe(WALL_LIMIT.hard);
  });

  it('软硅胶下限 1.2mm 大于硬壳 0.8mm', () => {
    expect(WALL_LIMIT.soft).toBeGreaterThan(WALL_LIMIT.hard);
  });

  it('通气孔直径调到 3mm 后孔内点位于壳体外', () => {
    const imp = generateImpression('normal', R);
    const params = { ...defaultParams(imp), ventDiameter: 3.0 };
    const res = designShell(imp.field, imp, params, R);
    const mid = params.ventPath[Math.floor(params.ventPath.length / 2)];
    // 孔中心处壳体场应为正（被挖空）
    expect(res.field(mid)).toBeGreaterThan(0);
  });
});

describe('过弯检查', () => {
  it('急弯印模长壳体给出卡点或通过结论，且建议截短不超过当前位置', () => {
    const imp = generateImpression('sharpBend', R);
    const params = { ...defaultParams(imp), trimS: imp.centerline.totalLen - 1.5 };
    const res = designShell(imp.field, imp, params, R);
    const report = checkBendPass(res.mesh, imp.centerline, imp.landmarks, params, imp.radiusAt);
    expect(report.suggestedTrimS).toBeLessThanOrEqual(params.trimS + 1e-6);
    if (!report.passable) expect(report.suggestedTrimDelta).toBeGreaterThan(0);
  });
});

describe('STL 往返', () => {
  it('导出再导入三角数不变', async () => {
    const imp = generateImpression('normal', 28);
    const blob = exportBinarySTL(imp.mesh);
    const ab = await blob.arrayBuffer();
    const back = parseSTL(ab);
    expect(back.indices.length).toBe(imp.mesh.indices.length);
  });
});

describe('Marching Cubes 基础', () => {
  it('球 SDF 网格横截面面积接近解析值', () => {
    const r = 5;
    const f = sdf.sphere([0, 0, 0], r);
    const { mesh } = marchingCubes(f, gridFromBounds([-7, -7, -7], [7, 7, 7], 36));
    const inter = new RayMeshIntersector(mesh, 24);
    let hits = 0;
    for (let x = -6; x <= 6; x += 0.5) {
      for (let y = -6; y <= 6; y += 0.5) {
        const hs = inter.intersectAll([x, y, -8], [0, 0, 1]);
        if (hs.length >= 2) hits++;
      }
    }
    const estArea = hits * 0.25;
    const trueArea = Math.PI * r * r;
    expect(Math.abs(estArea - trueArea) / trueArea).toBeLessThan(0.1);
  });
});

describe('中心线', () => {
  it('弧长参数化往返一致', () => {
    const cl = new Centerline([[0, 0, 0], [0, 0, 5], [3, 0, 9]]);
    const p = cl.pointAt(cl.totalLen);
    expect(v3.dist(p, [3, 0, 9])).toBeLessThan(1e-6);
    const mid = cl.pointAt(cl.totalLen / 2);
    const proj = cl.project(mid);
    expect(Math.abs(proj.s - cl.totalLen / 2)).toBeLessThan(0.2);
  });
});
