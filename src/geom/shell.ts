import type { MaterialType, MeshData, MoldType, ScanRecord, ShellParams, Vec3 } from '../types';
import { add, scale, sub } from '../math/vec';
import { computeFrames, type Frames } from './procedural';
import { createMesh } from './mesh';

export const WALL_LIMITS: Record<MaterialType, { min: number; recommended: number; label: string }> = {
  'hard-acrylic': { min: 1.0, recommended: 1.35, label: '硬壳丙烯酸' },
  'soft-silicone': { min: 2.0, recommended: 2.35, label: '软硅胶' }
};

export const MOLD_LABELS: Record<MoldType, string> = {
  'full-concha': '全耳甲腔式',
  'half-concha': '半耳甲腔式',
  canal: '耳道式 ITE',
  'deep-canal': '深耳道式 CIC'
};

interface RadiusSample { t: number; rx: number; ry: number }

export class RadiusSampler {
  readonly centerline: Vec3[];
  readonly frames: Frames;
  readonly lengths: number[];
  readonly totalLength: number;
  private samples: RadiusSample[] = [];

  constructor(public scan: ScanRecord, sampleCount = 72) {
    this.centerline = scan.centerline?.length ? scan.centerline : [[0, 0, 15], [0, 0, -30]];
    this.frames = computeFrames(this.centerline);
    this.lengths = [0];
    for (let i = 1; i < this.centerline.length; i++) {
      this.lengths.push(this.lengths[i - 1] + Math.hypot(...sub(this.centerline[i], this.centerline[i - 1])));
    }
    this.totalLength = this.lengths[this.lengths.length - 1] || 1;
    this.build(sampleCount);
  }

  private build(count: number) {
    const bins: Array<{ x: number[]; y: number[] }> = Array.from({ length: count }, () => ({ x: [], y: [] }));
    const p = this.scan.mesh.positions;
    for (let v = 0; v < p.length; v += 3) {
      const point: Vec3 = [p[v], p[v + 1], p[v + 2]];
      let best = 0, bestD = Infinity;
      for (let i = 0; i < this.centerline.length; i++) {
        const d = (point[0] - this.centerline[i][0]) ** 2 + (point[1] - this.centerline[i][1]) ** 2 + (point[2] - this.centerline[i][2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      const t = best / (this.centerline.length - 1);
      const bin = Math.min(count - 1, Math.floor(t * count));
      const delta = sub(point, this.centerline[best]);
      bins[bin].x.push(Math.abs(delta[0] * this.frames.normals[best][0] + delta[1] * this.frames.normals[best][1] + delta[2] * this.frames.normals[best][2]));
      bins[bin].y.push(Math.abs(delta[0] * this.frames.binormals[best][0] + delta[1] * this.frames.binormals[best][1] + delta[2] * this.frames.binormals[best][2]));
    }
    const quantile = (arr: number[], q: number) => {
      if (!arr.length) return 3.5;
      arr.sort((a, b) => a - b);
      return arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    };
    const raw: RadiusSample[] = bins.map((bin, i) => ({
      t: i / (count - 1),
      rx: Math.max(1.1, quantile(bin.x, 0.94) * 1.015),
      ry: Math.max(1.1, quantile(bin.y, 0.94) * 1.015)
    }));
    // Smooth while retaining narrow passages.
    this.samples = raw.map((s, i) => {
      const window = [raw[Math.max(0, i - 1)], s, raw[Math.min(raw.length - 1, i + 1)]];
      return {
        t: s.t,
        rx: window.reduce((a, x) => a + x.rx, 0) / window.length,
        ry: window.reduce((a, x) => a + x.ry, 0) / window.length
      };
    });
  }

  radiiAt(t: number): { rx: number; ry: number } {
    const x = Math.max(0, Math.min(1, t)) * (this.samples.length - 1);
    const i = Math.floor(x), f = x - i;
    const a = this.samples[i], b = this.samples[Math.min(this.samples.length - 1, i + 1)];
    return { rx: a.rx + (b.rx - a.rx) * f, ry: a.ry + (b.ry - a.ry) * f };
  }

  pointAt(t: number): Vec3 {
    const x = Math.max(0, Math.min(1, t)) * (this.centerline.length - 1);
    const i = Math.floor(x), f = x - i;
    const a = this.centerline[i], b = this.centerline[Math.min(this.centerline.length - 1, i + 1)];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  frameAt(t: number) {
    const x = Math.max(0, Math.min(1, t)) * (this.centerline.length - 1);
    const i = Math.floor(x), f = x - i;
    const mix = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    return {
      center: this.pointAt(t),
      tangent: mix(this.frames.tangents[i], this.frames.tangents[Math.min(this.frames.tangents.length - 1, i + 1)]),
      normal: mix(this.frames.normals[i], this.frames.normals[Math.min(this.frames.normals.length - 1, i + 1)]),
      binormal: mix(this.frames.binormals[i], this.frames.binormals[Math.min(this.frames.binormals.length - 1, i + 1)])
    };
  }

  tAtLength(lengthMm: number): number {
    const L = Math.max(0, Math.min(this.totalLength, lengthMm));
    let i = 1;
    while (i < this.lengths.length - 1 && this.lengths[i] < L) i++;
    const a = this.lengths[i - 1], b = this.lengths[i] || a + 1;
    const f = (L - a) / Math.max(1e-6, b - a);
    return ((i - 1) + f) / (this.centerline.length - 1);
  }

  lengthAtT(t: number): number {
    const x = Math.max(0, Math.min(1, t)) * (this.centerline.length - 1);
    const i = Math.floor(x), f = x - i;
    return this.lengths[i] + ((this.lengths[Math.min(this.lengths.length - 1, i + 1)] - this.lengths[i]) * f);
  }
}

interface Ring { center: Vec3; rx: number; ry: number; surface: 0 | 1 | 2 }

export interface ShellBuildResult {
  mesh: MeshData;
  tStart: number;
  tEnd: number;
  actualWall: number;
  minRadius: number;
  warning?: string;
  sampler: RadiusSampler;
}

export function defaultShellParams(moldType: MoldType = 'full-concha', material: MaterialType = 'hard-acrylic'): ShellParams {
  return {
    moldType,
    material,
    nominalWall: WALL_LIMITS[material].recommended,
    trimMmFromTip: 1.5,
    edgeRadius: 0.55,
    ventDiameter: 1.6,
    soundTubeDiameter: 2.0,
    sectionT: 0.52,
    sectionEnabled: true
  };
}

export function moldRange(scan: ScanRecord, moldType: MoldType): { tStart: number; tEnd: number } {
  const lm = (id: string, fallback: number) => scan.landmarks.find(l => l.id === id)?.t ?? fallback;
  const opening = lm('opening', 0.18);
  const first = lm('first-bend', 0.405);
  const second = lm('second-bend', 0.69);
  switch (moldType) {
    case 'full-concha': return { tStart: 0.015, tEnd: first + 0.205 };
    case 'half-concha': return { tStart: Math.max(0.04, opening - 0.11), tEnd: first + 0.205 };
    case 'canal': return { tStart: opening - 0.015, tEnd: second + 0.035 };
    case 'deep-canal': return { tStart: opening - 0.01, tEnd: Math.min(0.965, second + 0.265) };
  }
}

export function buildShellMesh(scan: ScanRecord, params: ShellParams, sampler?: RadiusSampler): ShellBuildResult {
  const rs = sampler ?? new RadiusSampler(scan);
  const range = moldRange(scan, params.moldType);
  const endLength = rs.lengthAtT(range.tEnd) - Math.max(0, params.trimMmFromTip);
  const tEnd = Math.max(range.tStart + 0.18, rs.tAtLength(endLength));
  const tStart = range.tStart;
  const ringCount = 82;
  const sides = 56;
  const firstRadii = rs.radiiAt(tStart);
  const endRadii = rs.radiiAt(tEnd);
  const minRadius = Math.min(endRadii.rx, endRadii.ry, firstRadii.rx, firstRadii.ry);
  const actualWall = Math.max(0.35, Math.min(params.nominalWall, minRadius - 0.45));
  let warning: string | undefined;
  if (actualWall + 0.05 < params.nominalWall) warning = `耳道半径过小，壁厚已被几何约束限制为 ${actualWall.toFixed(2)} mm`;
  if (actualWall < WALL_LIMITS[params.material].min) warning = `实际壁厚 ${actualWall.toFixed(2)} mm 低于${WALL_LIMITS[params.material].label}下限 ${WALL_LIMITS[params.material].min.toFixed(1)} mm`;

  const rings: Ring[] = [];
  const ringAt = (t: number, radialInset = 0, axialOffset = 0, surface: 0 | 1 | 2 = 0): Ring => {
    const f = rs.frameAt(t);
    const center = axialOffset ? add(f.center, scale(f.tangent, axialOffset)) : f.center;
    const r = rs.radiiAt(t);
    return { center, rx: Math.max(0.45, r.rx - radialInset), ry: Math.max(0.45, r.ry - radialInset), surface };
  };

  // Outer impression-matching surface.
  for (let i = 0; i <= ringCount; i++) {
    const t = tStart + (tEnd - tStart) * (i / ringCount);
    rings.push(ringAt(t, 0, 0, 0));
  }

  const er = Math.max(0.12, Math.min(params.edgeRadius, actualWall * 0.38));
  const endFrame = rs.frameAt(tEnd);
  const endR = rs.radiiAt(tEnd);
  const endCenter = endFrame.center;
  const shiftedRing = (offset: number, rx: number, ry: number, surface: 0 | 1 | 2): Ring => ({
    center: add(endCenter, scale(endFrame.tangent, offset)), rx, ry, surface
  });

  // Rounded distal edge: outer surface -> cut annulus.
  const bevelSeg = 5;
  for (let k = 1; k <= bevelSeg; k++) {
    const q = k / bevelSeg;
    const beta = q * Math.PI / 2;
    rings.push(shiftedRing(-er + er * Math.sin(beta), endR.rx - er * (1 - Math.cos(beta)), endR.ry - er * (1 - Math.cos(beta)), 2));
  }
  // Sealed cut face/annulus.
  const capSteps = 4;
  const outerCapRx = endR.rx - er, outerCapRy = endR.ry - er;
  const innerEndRx = Math.max(0.45, endR.rx - actualWall);
  const innerEndRy = Math.max(0.45, endR.ry - actualWall);
  for (let k = 1; k <= capSteps; k++) {
    const q = k / (capSteps + 1);
    rings.push(shiftedRing(0, outerCapRx + (innerEndRx + er - outerCapRx) * q, outerCapRy + (innerEndRy + er - outerCapRy) * q, 2));
  }
  rings.push(shiftedRing(0, innerEndRx + er, innerEndRy + er, 2));
  // Inner edge round.
  for (let k = 1; k <= bevelSeg; k++) {
    const q = k / bevelSeg;
    const beta = q * Math.PI / 2;
    rings.push(shiftedRing(-er * (1 - Math.cos(beta)), innerEndRx + er * Math.cos(beta), innerEndRy + er * Math.cos(beta), 1));
  }

  // Inner cavity surface, travelling back toward the outer/faceplate side.
  const innerEndT = rs.tAtLength(rs.lengthAtT(tEnd) - er);
  for (let i = ringCount - 1; i >= 0; i--) {
    const t = tStart + (innerEndT - tStart) * (i / ringCount);
    rings.push(ringAt(t, actualWall, 0, 1));
  }

  // Outer-side annulus closes the thin solid. It is normally under the faceplate.
  const startR = rs.radiiAt(tStart);
  const startInnerRx = Math.max(0.45, startR.rx - actualWall);
  const startInnerRy = Math.max(0.45, startR.ry - actualWall);
  for (let k = 1; k <= capSteps; k++) {
    const q = k / (capSteps + 1);
    rings.push({
      center: rs.pointAt(tStart),
      rx: startInnerRx + (startR.rx - startInnerRx) * q,
      ry: startInnerRy + (startR.ry - startInnerRy) * q,
      surface: 2
    });
  }

  const positions: number[] = [];
  const surfaceAttr: number[] = [];
  for (const ring of rings) {
    const tForFrame = 0; // Ring centers/axes are generated below using a stable frame approximation from center offsets.
    void tForFrame;
  }
  // Rebuild orientation from the nearest sampler frame for each ring center is awkward after axial shifts.
  // Instead each ring stores only radii/center; derive axes by interpolating t encoded via nearest point.
  for (const ring of rings) {
    let nearest = 0, nd = Infinity;
    for (let i = 0; i < rs.centerline.length; i++) {
      const d = (rs.centerline[i][0] - ring.center[0]) ** 2 + (rs.centerline[i][1] - ring.center[1]) ** 2 + (rs.centerline[i][2] - ring.center[2]) ** 2;
      if (d < nd) { nd = d; nearest = i; }
    }
    const n = rs.frames.normals[nearest], b = rs.frames.binormals[nearest];
    for (let j = 0; j < sides; j++) {
      const theta = (j / sides) * Math.PI * 2;
      positions.push(
        ring.center[0] + n[0] * Math.cos(theta) * ring.rx + b[0] * Math.sin(theta) * ring.ry,
        ring.center[1] + n[1] * Math.cos(theta) * ring.rx + b[1] * Math.sin(theta) * ring.ry,
        ring.center[2] + n[2] * Math.cos(theta) * ring.rx + b[2] * Math.sin(theta) * ring.ry
      );
      surfaceAttr.push(ring.surface);
    }
  }

  const indices: number[] = [];
  const stride = sides;
  for (let i = 0; i < rings.length; i++) {
    const next = (i + 1) % rings.length;
    for (let j = 0; j < sides; j++) {
      const jn = (j + 1) % sides;
      const a = i * stride + j;
      const b = next * stride + j;
      const c = i * stride + jn;
      const d = next * stride + jn;
      // Double-sided rendering is enabled; winding still gives mostly outward normals.
      indices.push(a, b, c, c, b, d);
    }
  }

  const mesh = createMesh(positions, indices, surfaceAttr);
  return { mesh, tStart, tEnd, actualWall, minRadius, warning, sampler: rs };
}

export function sectionCapMesh(sampler: RadiusSampler, t: number, wall: number, edgeRadius = 0.5): MeshData {
  const sides = 64;
  const f = sampler.frameAt(t);
  const r = sampler.radiiAt(t);
  const innerRx = Math.max(0.4, r.rx - wall), innerRy = Math.max(0.4, r.ry - wall);
  const positions: number[] = [];
  const indices: number[] = [];
  const surface: number[] = [];
  const rings = [
    { rx: r.rx - edgeRadius, ry: r.ry - edgeRadius, z: -edgeRadius },
    { rx: r.rx, ry: r.ry, z: -edgeRadius * 1.8 },
    { rx: innerRx, ry: innerRy, z: -edgeRadius * 1.8 },
    { rx: innerRx + edgeRadius, ry: innerRy + edgeRadius, z: 0 }
  ];
  // Annulus as radial strips with a slight bevel; both inner and outer boundaries are present.
  for (const ring of rings) {
    const center = add(f.center, scale(f.tangent, ring.z));
    for (let j = 0; j <= sides; j++) {
      const a = j / sides * Math.PI * 2;
      positions.push(
        center[0] + f.normal[0] * Math.cos(a) * ring.rx + f.binormal[0] * Math.sin(a) * ring.ry,
        center[1] + f.normal[1] * Math.cos(a) * ring.rx + f.binormal[1] * Math.sin(a) * ring.ry,
        center[2] + f.normal[2] * Math.cos(a) * ring.rx + f.binormal[2] * Math.sin(a) * ring.ry
      );
      surface.push(2);
    }
  }
  const stride = sides + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * stride + j, b = (i + 1) * stride + j;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return createMesh(positions, indices, surface);
}
