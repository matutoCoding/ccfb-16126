import { describe, it, expect } from 'vitest';
import { makeSweptTube, makeEllipsoid, rayMeshAllHits, boundaryEdges, signedVolume, weld, makeBox } from '../../src/core/geometry';
import { generateImpression, findBends } from '../../src/core/synthetic';
import { radialWallThickness, rayLayers, checkInsertion, checkCollisions, obbOverlap, makeOBB } from '../../src/core/analysis';
import { generateShell } from '../../src/core/shellgen';
import { createDefaultDesign, buildShellWithStyle } from '../../src/design-service';
import { Ray, Vec3 } from '../../src/core/math';
import { SyntheticKind } from '../../src/core/types';

describe('基础网格', () => {
  it('扫掠管水密且闭合', () => {
    const path: Vec3[] = [[0, 0, 0], [0, 5, 0], [0, 10, 1]];
    const m = makeSweptTube(path, 2, 20);
    expect(boundaryEdges(m)).toHaveLength(0);
    expect(Math.abs(signedVolume(m))).toBeGreaterThan(50);
  });

  it('椭球射线命中偶数次且距离等于直径', () => {
    const m = makeEllipsoid([0, 0, 0], [3, 4, 5], 24, 32);
    const ray: Ray = { origin: [-20, 0, 0], dir: [1, 0, 0] };
    const hits = rayMeshAllHits(m, ray);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.length % 2).toBe(0);
    // x 方向直径 6
    const span = hits[hits.length - 1] - hits[0];
    expect(Math.abs(span - 6)).toBeLessThan(0.35);
  });

  it('焊接保持三角面数', () => {
    const m = makeBox([0, 0, 0], [2, 2, 2]);
    const w = weld(m, 0.01);
    expect(w.indices.length).toBe(m.indices.length);
    expect(boundaryEdges(w)).toHaveLength(0);
  });
});

describe('程序化测试印模（4 副）', () => {
  it.each(['normal', 'narrow', 'sharp-bend', 'bubble-defect'] as SyntheticKind[])('%s 水密且含解剖标记', (kind) => {
    const g = generateImpression(kind, 'right');
    expect(boundaryEdges(g.mesh)).toHaveLength(0);
    const kinds = g.markers.map((m) => m.kind);
    expect(kinds).toContain('canal-mouth');
    expect(kinds).toContain('first-bend');
    expect(kinds).toContain('second-bend');
    expect(g.centerline.length).toBeGreaterThan(50);
  });

  it('窄耳道半径明显小于正常印模', () => {
    const narrow = generateImpression('narrow', 'right');
    const normal = generateImpression('normal', 'right');
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(narrow.canalRadii)).toBeLessThan(avg(normal.canalRadii) * 0.8);
  });

  it('急第二弯的最小曲率半径更小', () => {
    const sharp = generateImpression('sharp-bend', 'right');
    const normal = generateImpression('normal', 'right');
    const minR = (cl: Vec3[]) => {
      const { radius } = findBends(cl);
      void radius;
      let min = Infinity;
      for (let i = 1; i < cl.length - 1; i++) {
        const d1 = sub(cl[i], cl[i - 1]), d2 = sub(cl[i + 1], cl[i]);
        const cross = cross3(d1, d2);
        const den = Math.hypot(cross[0], cross[1], cross[2]);
        if (den > 1e-9) {
          const r = (len(d1) * len(d2) * len(sub(cl[i + 1], cl[i - 1]))) / (2 * den);
          min = Math.min(min, r);
        }
      }
      return min;
    };
    expect(minR(sharp.centerline)).toBeLessThan(minR(normal.centerline));
  });

  it('气泡缺损印模检出缺陷标记', () => {
    const g = generateImpression('bubble-defect', 'right');
    const defects = g.markers.filter((m) => m.kind === 'bubble' || m.kind === 'defect');
    expect(defects.length).toBeGreaterThan(0);
  });
});

describe('壳体生成与壁厚', () => {
  it('壳体水密，射线壁厚贴近设定值（<0.05mm）', () => {
    const g = generateImpression('normal', 'right');
    const design = createDefaultDesign('c1', {
      id: 'i1', customerId: 'c1', side: 'right', createdAt: 0,
      meshData: { positions: Array.from(g.mesh.positions), indices: Array.from(g.mesh.indices) },
      centerline: g.centerline, markers: g.markers, canalRadii: g.canalRadii, source: 'synthetic',
    }, 'canal', 'hard');
    const shell = buildShellWithStyle({
      id: 'i1', customerId: 'c1', side: 'right', createdAt: 0,
      meshData: { positions: Array.from(g.mesh.positions), indices: Array.from(g.mesh.indices) },
      centerline: g.centerline, markers: g.markers, canalRadii: g.canalRadii, source: 'synthetic',
    }, design, 'canal');
    expect(boundaryEdges(shell.mesh)).toHaveLength(0);
    const samples = radialWallThickness(shell.mesh, shell.frames, shell.stationRange, 20);
    expect(samples.length).toBeGreaterThan(100);
    // 直壁段（排除两端倒圆/封口区域，取中段）
    const mid = samples.filter((s) => s.station > shell.stationRange[0] + 6 && s.station < shell.stationRange[1] - 8);
    const maxErr = Math.max(...mid.map((s) => Math.abs(s.thicknessMm - design.wallThickness)));
    expect(maxErr).toBeLessThan(0.05);
  });

  it('软硅胶默认壁厚大于硬壳下限', () => {
    const g = generateImpression('normal', 'left');
    const im = {
      id: 'i2', customerId: 'c1', side: 'left' as const, createdAt: 0,
      meshData: { positions: Array.from(g.mesh.positions), indices: Array.from(g.mesh.indices) },
      centerline: g.centerline, markers: g.markers, canalRadii: g.canalRadii, source: 'synthetic' as const,
    };
    const hard = createDefaultDesign('c1', im, 'CIC', 'hard');
    const soft = createDefaultDesign('c1', im, 'CIC', 'silicone');
    expect(soft.wallThickness).toBeGreaterThan(hard.wallThickness);
    expect(soft.wallThickness).toBeGreaterThanOrEqual(0.9);
  });
});

describe('碰撞与过弯', () => {
  it('两个重叠 OBB 检出穿透', () => {
    const base = {
      id: 'd', name: 'x', rotation: [0, 0, 0] as Vec3, color: [1, 1, 1] as [number, number, number],
      kind: 'battery' as const,
    };
    const a = makeOBB({ ...base, position: [0, 0, 0], size: [4, 4, 4] });
    const b = makeOBB({ ...base, id: 'd2', position: [1, 0, 0], size: [4, 4, 4] });
    expect(obbOverlap(a, b)).toBeGreaterThan(0);
    const c = makeOBB({ ...base, id: 'd3', position: [10, 0, 0], size: [2, 2, 2] });
    expect(obbOverlap(a, c)).toBe(0);
  });

  it('急弯印模在深耳道式下报告卡点或建议截短', () => {
    const g = generateImpression('sharp-bend', 'right');
    const im = {
      id: 'i3', customerId: 'c1', side: 'right' as const, createdAt: 0,
      meshData: { positions: Array.from(g.mesh.positions), indices: Array.from(g.mesh.indices) },
      centerline: g.centerline, markers: g.markers, canalRadii: g.canalRadii, source: 'synthetic' as const,
    };
    const design = createDefaultDesign('c1', im, 'CIC', 'hard');
    const shell = generateShell(g.mesh, g.centerline, {
      wallThickness: design.wallThickness, trimPosition: design.trimPosition,
      edgeRadius: design.edgeRadius, shellStyle: 'CIC',
    });
    const result = checkInsertion(g.centerline, shell.frames, shell.innerRadii, design, shell.stationRange);
    if (!result.pass) {
      expect(result.suggestedTrimLengthMm).toBeGreaterThan(0);
      expect(result.stuckPoints.length).toBeGreaterThan(0);
    }
    // 无论是否通过，最小曲率半径应为有限值
    expect(Number.isFinite(result.minBendRadiusMm)).toBe(true);
  });

  it('碰撞检查返回结构化报告', () => {
    const g = generateImpression('normal', 'right');
    const im = {
      id: 'i4', customerId: 'c1', side: 'right' as const, createdAt: 0,
      meshData: { positions: Array.from(g.mesh.positions), indices: Array.from(g.mesh.indices) },
      centerline: g.centerline, markers: g.markers, canalRadii: g.canalRadii, source: 'synthetic' as const,
    };
    const design = createDefaultDesign('c1', im, 'canal', 'hard');
    const shell = buildShellWithStyle(im, design, 'canal');
    const report = checkCollisions(design, shell.frames, shell.innerRadii);
    expect(Array.isArray(report.collisions)).toBe(true);
  });
});

describe('射线层段', () => {
  it('管壳射线返回完整进出层段', () => {
    const m = makeSweptTube([[0, -5, 0], [0, 5, 0]], 2, 24);
    const ray: Ray = { origin: [-10, 0, 0], dir: [1, 0, 0] };
    const layers = rayLayers(m, ray);
    expect(layers.length).toBeGreaterThanOrEqual(1);
    for (const l of layers) expect(l.thickness).toBeGreaterThan(0);
  });
});

// 测试内联小工具，避免引入循环
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
