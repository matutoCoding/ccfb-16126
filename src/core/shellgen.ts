/**
 * 外壳生成：沿印模表面向内偏置出等壁厚，沿中心线截短，截面边缘倒圆，
 * 内/外表面 + 两端环形封口构成严格水密的壳体（射线壁厚测量的前提）。
 */
import { Mesh, MeshBuilder, computeVertexNormals } from './geometry';
import { Vec3, add3, cross3, dist3, dot3, lerp3, norm3, scale3, sub3 } from './math';
import { ShellStyle } from './types';

const RADIAL = 28;

export interface StationFrame {
  center: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

export function buildFrames(centerline: Vec3[]): StationFrame[] {
  const n = centerline.length;
  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = centerline[Math.max(0, i - 1)];
    const c = centerline[Math.min(n - 1, i + 1)];
    tangents.push(norm3(sub3(c, a)));
  }
  const ref: Vec3 = Math.abs(tangents[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let normal = norm3(cross3(tangents[0], ref));
  const frames: StationFrame[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) normal = norm3(sub3(normal, scale3(tangents[i], dot3(normal, tangents[i]))));
    const binormal = norm3(cross3(tangents[i], normal));
    frames.push({ center: centerline[i], tangent: tangents[i], normal, binormal });
  }
  return frames;
}

/** 把印模表面顶点投影到最近中心线站，得到每站的椭圆环（极角排序） */
function extractRings(
  impression: Mesh,
  frames: StationFrame[],
): Array<Array<{ pos: Vec3; radial: Vec3; r: number }>> {
  const p = impression.positions;
  const nSt = frames.length;
  const nearest = new Int32Array(p.length / 3);
  for (let vi = 0; vi < p.length / 3; vi++) {
    const v: Vec3 = [p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]];
    let best = Infinity, bi = 0;
    for (let s = 0; s < nSt; s++) {
      const d = dist3(v, frames[s].center);
      if (d < best) { best = d; bi = s; }
    }
    nearest[vi] = bi;
  }
  const rings: Array<Array<{ pos: Vec3; radial: Vec3; r: number }>> = Array.from({ length: nSt }, () => []);
  for (let vi = 0; vi < p.length / 3; vi++) {
    const s = nearest[vi];
    const v: Vec3 = [p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]];
    const f = frames[s];
    const radial = norm3(sub3(v, f.center));
    rings[s].push({ pos: v, radial, r: dist3(v, f.center) });
  }
  // 每站按极角排序并取 RADIAL 个代表点（角度分箱取平均半径）
  return rings.map((ring, s) => {
    if (ring.length === 0) return [];
    const bins = new Array(RADIAL).fill(0).map(() => [] as number[]);
    const f = frames[s];
    for (const pt of ring) {
      let ang = Math.atan2(dot3(pt.pos, f.binormal), dot3(pt.pos, f.normal));
      if (ang < 0) ang += Math.PI * 2;
      const bin = Math.min(RADIAL - 1, Math.floor((ang / (Math.PI * 2)) * RADIAL));
      bins[bin].push(pt.r);
    }
    const out: Array<{ pos: Vec3; radial: Vec3; r: number }> = [];
    for (let j = 0; j < RADIAL; j++) {
      const arr = bins[j].length ? bins[j] : [ring[0].r];
      const r = arr.reduce((a, b) => a + b, 0) / arr.length;
      const ang = (Math.PI * 2 * (j + 0.5)) / RADIAL;
      const radial = norm3(add3(scale3(f.normal, Math.cos(ang)), scale3(f.binormal, Math.sin(ang))));
      out.push({ pos: add3(f.center, scale3(radial, r)), radial, r });
    }
    return out;
  });
}

/** 不同机型保留的耳甲区比例（1=全耳甲，深耳道几乎不保留耳甲） */
const STYLE_CONCHA_KEEP: Record<ShellStyle, number> = {
  'full-concha': 1,
  'half-concha': 0.45,
  canal: 0.08,
  CIC: 0,
};

export interface GeneratedShell {
  mesh: Mesh;
  /** 外/内表面顶点到中心线的径向半径，用于壁厚分析与截面 */
  frames: StationFrame[];
  outerRadii: number[][];
  innerRadii: number[][];
  /** 壳体实际覆盖的站范围 */
  stationRange: [number, number];
  /** 建议信息 */
  trimLengthMm: number;
}

export function generateShell(
  impression: Mesh,
  centerline: Vec3[],
  design: { wallThickness: number; trimPosition: number; edgeRadius: number; shellStyle: ShellStyle },
): GeneratedShell {
  const frames = buildFrames(centerline);
  const rings = extractRings(impression, frames);
  const nSt = frames.length;
  const wall = design.wallThickness;

  // 截短：medial 末端（耳道深处）按 trimPosition；lateral 端按机型保留耳甲
  const conchaKeep = STYLE_CONCHA_KEEP[design.shellStyle];
  const mouthStation = Math.floor(nSt * 0.18);
  const lateralStart = Math.max(0, Math.floor(mouthStation * (1 - conchaKeep)));
  const medialEnd = Math.min(nSt - 2, Math.max(lateralStart + 3, Math.floor(design.trimPosition * (nSt - 1))));

  const outerR: number[][] = [];
  const innerR: number[][] = [];
  for (let s = 0; s < nSt; s++) {
    const ring = rings[s];
    const o: number[] = [], inn: number[] = [];
    for (let j = 0; j < RADIAL; j++) {
      const r = ring.length ? ring[j].r : 3;
      o.push(r);
      inn.push(Math.max(0.4, r - wall));
    }
    outerR.push(o);
    innerR.push(inn);
  }

  const b = new MeshBuilder();
  const outerIdx: number[][] = [];
  const innerIdx: number[][] = [];
  const ringPoint = (s: number, j: number, r: number): Vec3 => {
    const f = frames[s];
    const ang = (Math.PI * 2 * (j + 0.5)) / RADIAL;
    const radial = norm3(add3(scale3(f.normal, Math.cos(ang)), scale3(f.binormal, Math.sin(ang))));
    return add3(f.center, scale3(radial, r));
  };

  for (let s = lateralStart; s <= medialEnd; s++) {
    const oRow: number[] = [], iRow: number[] = [];
    for (let j = 0; j < RADIAL; j++) {
      oRow.push(b.vertex(ringPoint(s, j, outerR[s][j])));
      iRow.push(b.vertex(ringPoint(s, j, innerR[s][j])));
    }
    outerIdx.push(oRow);
    innerIdx.push(iRow);
  }
  const rows = outerIdx.length;
  // 外壁与内壁
  for (let k = 0; k < rows - 1; k++) {
    for (let j = 0; j < RADIAL; j++) {
      const j2 = (j + 1) % RADIAL;
      b.quad(outerIdx[k][j], outerIdx[k][j2], outerIdx[k + 1][j2], outerIdx[k + 1][j]);
      // 内壁反向，保证法线朝内腔（仍朝外表面法向约定：内壁法线指向中心）
      b.quad(innerIdx[k][j], innerIdx[k + 1][j], innerIdx[k + 1][j2], innerIdx[k][j2]);
    }
  }

  // lateral 端：面板开口环形封口（外-内直接连接）
  for (let j = 0; j < RADIAL; j++) {
    const j2 = (j + 1) % RADIAL;
    b.quad(outerIdx[0][j], innerIdx[0][j], innerIdx[0][j2], outerIdx[0][j2]);
  }

  // medial 端：倒圆封口。用若干过渡环把外半径平滑收束到内半径
  const edge = Math.min(design.edgeRadius, wall * 0.95, 1.2);
  const capRingsOuter: number[][] = [outerIdx[rows - 1]];
  const capRingsInner: number[][] = [innerIdx[rows - 1]];
  const capSteps = 5;
  const endFrame = frames[medialEnd];
  const tipCenter = add3(endFrame.center, scale3(endFrame.tangent, edge));
  for (let q = 1; q <= capSteps; q++) {
    const t = q / capSteps; // 0 在外环平面，1 收束
    const shrink = Math.sin(t * Math.PI * 0.5); // 平滑
    const oRow: number[] = [], iRow: number[] = [];
    for (let j = 0; j < RADIAL; j++) {
      const ro = outerR[medialEnd][j] * (1 - shrink) + innerR[medialEnd][j] * shrink;
      const ri = innerR[medialEnd][j] * (1 - shrink * 0.4);
      const c = lerp3(endFrame.center, tipCenter, t);
      const ang = (Math.PI * 2 * (j + 0.5)) / RADIAL;
      const radial = norm3(add3(scale3(endFrame.normal, Math.cos(ang)), scale3(endFrame.binormal, Math.sin(ang))));
      oRow.push(b.vertex(add3(c, scale3(radial, ro))));
      iRow.push(b.vertex(add3(c, scale3(radial, ri))));
    }
    capRingsOuter.push(oRow);
    capRingsInner.push(iRow);
  }
  for (let q = 0; q < capSteps; q++) {
    for (let j = 0; j < RADIAL; j++) {
      const j2 = (j + 1) % RADIAL;
      b.quad(capRingsOuter[q][j], capRingsOuter[q][j2], capRingsOuter[q + 1][j2], capRingsOuter[q + 1][j]);
      b.quad(capRingsInner[q][j], capRingsInner[q + 1][j], capRingsInner[q + 1][j2], capRingsInner[q][j2]);
    }
  }
  // 末端外/内收成一个顶点封口
  const tip = b.vertex(tipCenter);
  const lastO = capRingsOuter[capSteps], lastI = capRingsInner[capSteps];
  for (let j = 0; j < RADIAL; j++) {
    const j2 = (j + 1) % RADIAL;
    b.tri(tip, lastO[j2], lastO[j]);
    b.tri(tip, lastI[j], lastI[j2]);
  }

  const mesh = b.build();
  computeVertexNormals(mesh);

  // 截掉的长度（mm）
  let trimLen = 0;
  for (let s = medialEnd; s < nSt - 1; s++) trimLen += dist3(centerline[s], centerline[s + 1]);

  return {
    mesh,
    frames,
    outerRadii: outerR,
    innerRadii: innerR,
    stationRange: [lateralStart, medialEnd],
    trimLengthMm: trimLen,
  };
}
