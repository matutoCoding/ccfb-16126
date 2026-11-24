/**
 * 程序化测试耳印模生成：正常 / 窄耳道 / 急第二弯 / 气泡缺损 各一副。
 * 单根椭圆变截面扫掠体保证水密，坐标约定：+y 朝耳外（面板侧），耳道向 -y 延伸。
 */
import { Mesh, MeshBuilder, computeVertexNormals, pointSegmentDistance } from './geometry';
import { Vec3, catmullRom, cross3, dist3, norm3, resamplePolyline, scale3, sub3, add3, dot3 } from './math';
import { AnnoMarker, Side, SyntheticKind } from './types';

export interface GeneratedImpression {
  mesh: Mesh;
  centerline: Vec3[];
  canalRadii: number[];
  markers: AnnoMarker[];
}

interface GenProfile {
  controls: Vec3[];
  /** 各站椭圆半径（rx, rz），长度与采样站数一致 */
  radii: Array<[number, number]>;
  defects: Array<{ center: Vec3; radius: number; depth: number; kind: 'bubble' | 'defect' }>;
}

const STATIONS = 96;
const RADIAL = 28;

function baseControls(kind: SyntheticKind): Vec3[] {
  switch (kind) {
    case 'sharp-bend':
      return [
        [0, 12, 0], [0, 6, 0], [0, 0, 0], [2.6, -6, 1.6],
        [3.0, -11, 4.2], [-3.8, -14.5, 7.6], [-6.2, -17.5, 8.4],
      ];
    case 'narrow':
    case 'bubble-defect':
    case 'normal':
    default:
      return [
        [0, 12, 0], [0, 6, 0], [0, 0, 0], [2.8, -6, 1.4],
        [2.4, -12, 4.0], [0.2, -17, 6.0], [-1.6, -21, 7.2],
      ];
  }
}

function buildProfile(kind: SyntheticKind): GenProfile {
  const controls = baseControls(kind);
  const dense: Vec3[] = [];
  for (let i = 0; i < 200; i++) dense.push(catmullRom(controls, i / 199));
  const path = resamplePolyline(dense, STATIONS);

  const radii: Array<[number, number]> = [];
  const narrow = kind === 'narrow';
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1);
    let rx: number, rz: number;
    if (t < 0.18) {
      // 耳甲区：大而扁的椭圆腔
      const k = t / 0.18;
      rx = 9.5 - 3.2 * k * k;
      rz = 7.2 - 2.6 * k * k;
    } else {
      const k = (t - 0.18) / 0.82;
      const base = narrow ? 2.6 : 4.1;
      const tip = narrow ? 1.9 : 3.0;
      rx = base - (base - tip) * k * k;
      rz = rx * 0.92;
    }
    // 轻微不规则，模拟真实印模
    const wobble = 1 + 0.035 * Math.sin(t * 26 + 1.7) * Math.sin(t * 9);
    radii.push([rx * wobble, rz * wobble]);
  }

  const defects: GenProfile['defects'] = [];
  if (kind === 'bubble-defect') {
    // 两个气泡坑（耳道中段）+ 末端材料缺损
    defects.push({ center: sampleAt(path, 0.42), radius: 1.5, depth: 1.3, kind: 'bubble' });
    defects.push({ center: sampleAt(path, 0.55), radius: 1.0, depth: 0.9, kind: 'bubble' });
    defects.push({ center: sampleAt(path, 0.97), radius: 3.2, depth: 2.6, kind: 'defect' });
  }
  return { controls: path, radii, defects };
}

function sampleAt(path: Vec3[], t: number): Vec3 {
  const f = Math.max(0, Math.min(1, t)) * (path.length - 1);
  const i = Math.floor(f);
  const k = f - i;
  const a = path[i];
  const b = path[Math.min(path.length - 1, i + 1)];
  return add3(a, scale3(sub3(b, a), k));
}

/** 椭圆变截面平行输运扫掠，两端封口（水密） */
function sweepEllipse(path: Vec3[], radii: Array<[number, number]>, radial: number): Mesh {
  const n = path.length;
  const b = new MeshBuilder();
  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const c = path[Math.min(n - 1, i + 1)];
    tangents.push(norm3(sub3(c, a)));
  }
  const t0 = tangents[0];
  const ref: Vec3 = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let normal = norm3(cross3(t0, ref));
  const rings: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) normal = norm3(sub3(normal, scale3(tangents[i], dot3(normal, tangents[i]))));
    const binormal = norm3(cross3(tangents[i], normal));
    const [rx, rz] = radii[i];
    const ring: number[] = [];
    for (let j = 0; j < radial; j++) {
      const ang = (Math.PI * 2 * j) / radial;
      const off = add3(scale3(normal, Math.cos(ang) * rx), scale3(binormal, Math.sin(ang) * rz));
      ring.push(b.vertex(add3(path[i], off)));
    }
    rings.push(ring);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      b.quad(rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]);
    }
  }
  const c0 = b.vertex(path[0]);
  const c1 = b.vertex(path[n - 1]);
  for (let j = 0; j < radial; j++) {
    b.tri(c0, rings[0][(j + 1) % radial], rings[0][j]);
    b.tri(c1, rings[n - 1][j], rings[n - 1][(j + 1) % radial]);
  }
  const mesh = b.build();
  return mesh;
}

/** 在已生成的网格上压出气泡坑/缺损：把球内顶点向缺陷中心拉 */
function applyDefects(mesh: Mesh, defects: GenProfile['defects']): void {
  const p = mesh.positions;
  for (const d of defects) {
    for (let i = 0; i < p.length; i += 3) {
      const v: Vec3 = [p[i], p[i + 1], p[i + 2]];
      const dd = dist3(v, d.center);
      if (dd < d.radius) {
        const k = 0.5 + 0.5 * (dd / d.radius); // 中心压得最深
        const pull = scale3(sub3(d.center, v), (1 - k) * (d.depth / Math.max(dd, 0.4)));
        p[i] += pull[0]; p[i + 1] += pull[1]; p[i + 2] += pull[2];
      }
    }
  }
  computeVertexNormals(mesh);
}

/** 曲率峰值找两个弯：切向夹角的平滑序列 */
export function findBends(centerline: Vec3[]): { first: number; second: number } {
  const n = centerline.length;
  const curve: number[] = new Array(n).fill(0);
  for (let i = 2; i < n - 2; i++) {
    const t1 = norm3(sub3(centerline[i], centerline[i - 2]));
    const t2 = norm3(sub3(centerline[i + 2], centerline[i]));
    // 相邻切向转角（弧度）
    curve[i] = Math.acos(Math.max(-1, Math.min(1, dot3(t1, t2))));
  }
  const peak = (lo: number, hi: number): number => {
    let best = lo, bestV = -1;
    for (let i = lo; i <= hi; i++) if (curve[i] > bestV) { bestV = curve[i]; best = i; }
    return best;
  };
  const first = peak(Math.floor(n * 0.2), Math.floor(n * 0.55));
  const second = peak(first + Math.floor(n * 0.12), n - 3);
  return { first, second };
}

/** 耳道口：半径从耳甲区收窄到 60% 以下的第一站 */
export function findCanalMouth(radii: Array<[number, number]>): number {
  const maxR = Math.max(...radii.map((r) => r[0]));
  for (let i = 1; i < radii.length; i++) {
    if (radii[i][0] < maxR * 0.62) return i;
  }
  return Math.floor(radii.length * 0.18);
}

/** 缺陷检测：顶点到中心线实际距离明显小于该站期望半径 → 凹坑，聚类成标记 */
export function detectDefects(mesh: Mesh, centerline: Vec3[], radii: Array<[number, number]>): AnnoMarker[] {
  const p = mesh.positions;
  const hits: Array<{ pos: Vec3; gap: number }> = [];
  for (let i = 0; i < p.length; i += 3) {
    const v: Vec3 = [p[i], p[i + 1], p[i + 2]];
    let bestD = Infinity, bestSeg = 0;
    for (let s = 0; s < centerline.length - 1; s++) {
      const d = pointSegmentDistance(v, centerline[s], centerline[s + 1]);
      if (d < bestD) { bestD = d; bestSeg = s; }
    }
    const expected = Math.max(radii[bestSeg][0], radii[bestSeg][1]);
    if (expected - bestD > 0.55) hits.push({ pos: v, gap: expected - bestD });
  }
  // 聚类：间距 < 2.5mm 归为同一个坑
  const clusters: Array<{ pos: Vec3; r: number; maxGap: number }> = [];
  for (const h of hits) {
    const c = clusters.find((c) => dist3(c.pos, h.pos) < 2.5);
    if (c) {
      c.pos = scale3(add3(c.pos, h.pos), 0.5);
      c.r = Math.max(c.r, dist3(c.pos, h.pos) + 0.6);
      c.maxGap = Math.max(c.maxGap, h.gap);
    } else {
      clusters.push({ pos: h.pos, r: 0.9, maxGap: h.gap });
    }
  }
  return clusters.map((c, i) => ({
    id: `auto-defect-${i}`,
    kind: c.maxGap > 1.8 ? 'defect' : 'bubble',
    position: c.pos,
    radius: Math.min(3.5, c.r + 0.4),
    label: c.maxGap > 1.8 ? '材料缺损' : '气泡坑',
  }));
}

export function generateImpression(kind: SyntheticKind, side: Side): GeneratedImpression {
  const profile = buildProfile(kind);
  const mesh = sweepEllipse(profile.controls, profile.radii, RADIAL);
  applyDefects(mesh, profile.defects);

  // 左耳镜像 x，使左右耳几何真正成镜面对称
  if (side === 'left') {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) p[i] = -p[i];
    for (const c of profile.controls) c[0] = -c[0];
    computeVertexNormals(mesh);
  }

  const mouth = findCanalMouth(profile.radii);
  const { first, second } = findBends(profile.controls);
  const markers: AnnoMarker[] = [
    { id: 'mk-mouth', kind: 'canal-mouth', position: profile.controls[mouth], label: '耳道口' },
    { id: 'mk-bend1', kind: 'first-bend', position: profile.controls[first], label: '第一弯' },
    { id: 'mk-bend2', kind: 'second-bend', position: profile.controls[second], label: '第二弯' },
    ...detectDefects(mesh, profile.controls, profile.radii),
  ];
  const canalRadii = profile.radii.slice(mouth).map((r) => (r[0] + r[1]) * 0.5);
  return { mesh, centerline: profile.controls, canalRadii, markers };
}
