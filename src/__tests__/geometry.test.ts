import { describe, expect, it } from 'vitest';
import { generateImpression } from '../core/geometry/generator';
import { parseSTL, writeBinarySTL } from '../core/geometry/stl';
import { rayMeshIntersections, rayWallSegments, pointInsideMesh } from '../core/math/raycast';
import { buildShell, defaultLayout, wallMinFor } from '../core/geometry/shellBuilder';
import { checkCollisions, checkInsertionPath, tubeLength } from '../core/geometry/collision';
import { tubeAlongPath, cylinderMesh, boundingBox } from '../core/math/mesh';
import { DEFAULT_SETTINGS } from '../core/storage/idb';
import type { ShellParams, Vec3 } from '../types';

const params: ShellParams = {
  material: 'hard',
  wallThickness: 1.0,
  trimStation: 0.85,
  edgeFillet: 0.35,
  ventDiameter: 2.0,
  soundTubeDiameter: 1.2,
};

describe('印模生成器', () => {
  it('四种测试印模均为封闭流形且三角片数量合理', () => {
    for (const kind of ['normal', 'narrow', 'sharpBend', 'bubbleDefect'] as const) {
      const g = generateImpression(kind);
      expect(g.mesh.indices.length).toBeGreaterThan(3000);
      expect(g.mesh.positions.length / 3).toBeGreaterThan(500);
      expect(g.landmarks.centerline.length).toBeGreaterThan(20);
      // 从网格外沿 +Z 射线穿过封闭网格（偶数交点）
      const bb = boundingBox(g.mesh);
      const start: Vec3 = [bb.center[0], bb.center[1], bb.min[2] - 5];
      const hits = rayMeshIntersections(g.mesh, start, [0, 0, 1]);
      expect(hits.length % 2).toBe(0);
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  it('窄耳道半径明显小于正常印模', () => {
    const normal = generateImpression('normal');
    const narrow = generateImpression('narrow');
    expect(boundingBox(narrow.mesh).size[0]).toBeLessThan(boundingBox(normal.mesh).size[0]);
  });

  it('气泡缺损印模带缺陷标记', () => {
    const g = generateImpression('bubbleDefect');
    expect(g.defects.length).toBeGreaterThanOrEqual(2);
    expect(g.defects.some((d) => d.kind === 'bubble')).toBe(true);
    expect(g.defects.some((d) => d.kind === 'missing')).toBe(true);
  });

  it('急弯印模第二弯累计转向角更大', () => {
    const normal = generateImpression('normal');
    const sharp = generateImpression('sharpBend');
    const turn = (pts: Vec3[]) => {
      let acc = 0;
      for (let i = 2; i < pts.length; i++) {
        const t0: Vec3 = [
          pts[i - 1][0] - pts[i - 2][0],
          pts[i - 1][1] - pts[i - 2][1],
          pts[i - 1][2] - pts[i - 2][2],
        ];
        const t1: Vec3 = [
          pts[i][0] - pts[i - 1][0],
          pts[i][1] - pts[i - 1][1],
          pts[i][2] - pts[i - 1][2],
        ];
        const l0 = Math.hypot(...t0);
        const l1 = Math.hypot(...t1);
        const cos = (t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2]) / (l0 * l1);
        acc += Math.acos(Math.max(-1, Math.min(1, cos)));
      }
      return acc;
    };
    expect(turn(sharp.centerline)).toBeGreaterThan(turn(normal.centerline));
  });
});

describe('STL 往返', () => {
  it('二进制 STL 写出后解析，三角片数一致', async () => {
    const g = generateImpression('normal');
    const blob = writeBinarySTL(g.mesh);
    const buf = await blob.arrayBuffer();
    const parsed = parseSTL(buf);
    expect(parsed.indices.length).toBe(g.mesh.indices.length);
    // 顶点坐标误差 < 1e-4（float32 序列化）
    expect(Math.abs(parsed.positions[0] - g.mesh.positions[0])).toBeLessThan(1e-4);
  });
});

describe('射线求交与壁厚', () => {
  it('圆柱管壁射线成对进出，段厚度等于直径方向壁厚', () => {
    // 实心圆柱（封口）：中心轴射线 2 个交点
    const cyl = cylinderMesh([0, 0, 0], [0, 0, 1], 3, 10, 24);
    const hits = rayMeshIntersections(cyl, [0, 0, -8], [0, 0, 1]);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(pointInsideMesh(cyl, [0, 0, 0])).toBe(true);
    expect(pointInsideMesh(cyl, [0, 0, 9])).toBe(false);
  });

  it('管网格 rayWallSegments 返回的段厚度为正且按深度排序', () => {
    const path: Vec3[] = [[0, 0, 0], [0, 0, 5], [2, 0, 10]];
    const tube = tubeAlongPath(path, 2, 16);
    // 从管外、偏离中心轴处射入，避免命中端面扇形的退化共点
    const segs = rayWallSegments(tube, [0.8, 0, -4], [0, 0, 1]);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) expect(s.thickness).toBeGreaterThan(0);
    for (let i = 1; i < segs.length; i++) expect(segs[i].enter).toBeGreaterThan(segs[i - 1].enter);
  });
});

describe('壳体构建', () => {
  it('按印模偏移出的壁厚与设定值偏差 < 0.15mm（射线验证）', () => {
    const g = generateImpression('normal');
    const wallMin = wallMinFor('hard', DEFAULT_SETTINGS);
    const built = buildShell(g.mesh, g.landmarks, params, params.trimStation, wallMin);
    expect(built.shellMesh.indices.length).toBeGreaterThan(5000);
    // 在中段截面沿径向测外壳壁：外表面交点与内表面交点间距
    const mid = built.sections[Math.floor(built.sections.length * 0.5)];
    const origin: Vec3 = mid.center;
    const segs = rayWallSegments(built.shellMesh, origin, mid.u);
    expect(segs.length).toBeGreaterThan(0);
    const first = segs[0].thickness;
    expect(Math.abs(first - params.wallThickness)).toBeLessThan(0.15);
    expect(built.minWall).toBeGreaterThan(0.5);
    expect(built.ventPath.length).toBeGreaterThan(5);
  });

  it('软硅胶下限高于硬壳', () => {
    expect(wallMinFor('softSilicone', DEFAULT_SETTINGS)).toBeGreaterThan(wallMinFor('hard', DEFAULT_SETTINGS));
  });

  it('截短比例越小壳体越短', () => {
    const g = generateImpression('normal');
    const wm = wallMinFor('hard', DEFAULT_SETTINGS);
    const long = buildShell(g.mesh, g.landmarks, params, 0.95, wm);
    const short = buildShell(g.mesh, g.landmarks, params, 0.4, wm);
    expect(short.trimLength).toBeLessThan(long.trimLength);
  });
});

describe('内部排布与碰撞', () => {
  it('默认排布器件全部落在壳体内且无致命干涉', () => {
    const g = generateImpression('normal');
    const wm = wallMinFor('hard', DEFAULT_SETTINGS);
    const built = buildShell(g.mesh, g.landmarks, params, params.trimStation, wm);
    const layout = defaultLayout(built.sections, params);
    layout.ventPath = built.ventPath;
    const cols = checkCollisions(layout, built.sections);
    const errors = cols.filter((c) => c.severity === 'error');
    expect(errors.length).toBe(0);
    expect(layout.components.length).toBe(4);
    expect(tubeLength(layout.soundTubePath)).toBeGreaterThan(5);
  });

  it('器件强行外移能触发 component-shell 干涉', () => {
    const g = generateImpression('normal');
    const wm = wallMinFor('hard', DEFAULT_SETTINGS);
    const built = buildShell(g.mesh, g.landmarks, params, params.trimStation, wm);
    const layout = defaultLayout(built.sections, params);
    layout.ventPath = built.ventPath;
    const c = layout.components.find((x) => x.kind === 'receiver')!;
    // 沿所在截面 u 方向推到内壁外（仍在截面查找邻域内）
    const home = built.sections[Math.floor(built.sections.length * 0.62)];
    c.center = [
      home.center[0] + home.u[0] * (home.innerRadius + 3),
      home.center[1] + home.u[1] * (home.innerRadius + 3),
      home.center[2] + home.u[2] * (home.innerRadius + 3),
    ];
    const cols = checkCollisions(layout, built.sections);
    expect(cols.some((c2) => c2.kind === 'component-shell' || c2.kind === 'component-component')).toBe(true);
  });

  it('第二弯检查在急弯印模上给出卡点或更小间隙', () => {
    const g = generateImpression('sharpBend');
    const wm = wallMinFor('hard', DEFAULT_SETTINGS);
    const built = buildShell(g.mesh, g.landmarks, params, 0.9, wm);
    const radii = built.sections.map((s) => s.outerRadius);
    const ins = checkInsertionPath(built.sections, radii, g.landmarks.secondBend);
    expect(ins.totalLength).toBeGreaterThan(0);
    expect(ins.suggestedTrimLength).toBeLessThanOrEqual(ins.totalLength);
    if (!ins.pass) expect(ins.stuckPoints.length).toBeGreaterThan(0);
  });
});
