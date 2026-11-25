import type { DefectMark, Landmarks, MeshData, Vec3 } from '../../types';
import { boundingBox } from '../math/mesh';
import {
  clamp,
  dist,
  normalize,
  pointSegmentDist,
  resamplePolyline,
  sub,
} from '../math/vec3';
import { cumulativeTurning } from './generator';
import { uid } from '../storage/idb';

/**
 * 通用中心线提取（导入 STL 用）：
 * 沿包围盒最长轴切片，每片求质心与平均半径，得到带半径的中心线。
 */
export function extractCenterline(mesh: MeshData, slices = 40): {
  centerline: Vec3[];
  radii: number[];
  axis: Vec3;
} {
  const bb = boundingBox(mesh);
  const size = bb.size;
  let axis: Vec3 = [0, 0, 1];
  if (size[0] >= size[1] && size[0] >= size[2]) axis = [1, 0, 0];
  else if (size[1] >= size[2]) axis = [0, 1, 0];
  const lo = bb.min[axis[0] ? 0 : axis[1] ? 1 : 2];
  const span = Math.max(size[0], size[1], size[2]);
  const sliceW = span / slices;
  const centerline: Vec3[] = [];
  const radii: number[] = [];
  for (let s = 0; s < slices; s++) {
    const base = lo + (s + 0.5) * sliceW;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let count = 0;
    const pts: Vec3[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const p: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      const coord = axis[0] ? p[0] : axis[1] ? p[1] : p[2];
      if (Math.abs(coord - base) <= sliceW * 0.75) {
        sx += p[0];
        sy += p[1];
        sz += p[2];
        count++;
        pts.push(p);
      }
    }
    if (count < 4) continue;
    const c: Vec3 = [sx / count, sy / count, sz / count];
    let r = 0;
    for (const p of pts) r += dist(p, c);
    r /= pts.length;
    centerline.push(c);
    radii.push(r);
  }
  const resampled = resamplePolyline(centerline, Math.max(24, centerline.length));
  // 重采样后半径按弧长插值
  const outRadii: number[] = [];
  for (let i = 0; i < resampled.length; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < centerline.length; j++) {
      const d = dist(resampled[i], centerline[j]);
      if (d < bestD) {
        bestD = d;
        best = radii[j];
      }
    }
    outRadii.push(best);
  }
  return { centerline: resampled, radii: outRadii, axis };
}

/**
 * 自动找耳道口/第一弯/第二弯：
 * - 耳道口：半径沿中心线变化率最大的收窄点（耳甲腔 -> 耳道）
 * - 第一弯、第二弯：累计转向角越过阈值的前两个位置
 */
export function detectLandmarks(mesh: MeshData): Landmarks {
  const { centerline, radii } = extractCenterline(mesh);
  const n = centerline.length;

  // 耳道口：半径下降最剧烈处
  let apertureIdx = Math.floor(n * 0.25);
  let maxDrop = -Infinity;
  for (let i = 2; i < n - 2; i++) {
    const drop = radii[i - 1] - radii[i + 1];
    if (drop > maxDrop && radii[i] > Math.min(...radii) * 1.1) {
      maxDrop = drop;
      apertureIdx = i;
    }
  }

  const turning = cumulativeTurning(centerline);
  const totalTurn = turning[n - 1];
  let firstIdx = -1;
  let secondIdx = -1;
  if (totalTurn > 0.05) {
    const t1 = totalTurn * 0.33;
    const t2 = totalTurn * 0.66;
    for (let i = apertureIdx; i < n; i++) {
      if (firstIdx < 0 && turning[i] >= t1) firstIdx = i;
      if (firstIdx >= 0 && turning[i] - turning[firstIdx] >= (t2 - t1)) {
        secondIdx = i;
        break;
      }
    }
  }
  if (firstIdx < 0) firstIdx = clamp(apertureIdx + Math.floor((n - apertureIdx) * 0.35), 0, n - 1);
  if (secondIdx < 0) secondIdx = clamp(apertureIdx + Math.floor((n - apertureIdx) * 0.7), 0, n - 1);

  return {
    aperture: centerline[apertureIdx],
    firstBend: centerline[firstIdx],
    secondBend: centerline[secondIdx],
    centerline,
  };
}

/**
 * 缺陷自动检测：
 * 1) 开放边界边 -> 印模未取到的部分（missing）
 * 2) 顶点到中心线距离显著小于局部半径 -> 气泡坑（bubble）
 */
export function detectDefects(mesh: MeshData, landmarks: Landmarks): DefectMark[] {
  const defects: DefectMark[] = [];
  const boundary = findBoundaryEdges(mesh);
  if (boundary.vertices.length > 0) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const vi of boundary.vertices) {
      cx += mesh.positions[vi * 3];
      cy += mesh.positions[vi * 3 + 1];
      cz += mesh.positions[vi * 3 + 2];
    }
    const k = boundary.vertices.length;
    let maxR = 0;
    const center: Vec3 = [cx / k, cy / k, cz / k];
    for (const vi of boundary.vertices) {
      maxR = Math.max(
        maxR,
        dist(center, [mesh.positions[vi * 3], mesh.positions[vi * 3 + 1], mesh.positions[vi * 3 + 2]]),
      );
    }
    defects.push({
      id: uid('def'),
      kind: 'missing',
      position: center,
      radius: maxR,
      note: `开放边界 ${boundary.edges} 条边，疑似印模未取到`,
    });
  }

  // 气泡坑：表面点到中心线距离比局部平均明显偏小
  const cl = landmarks.centerline;
  const localRadius = new Map<number, number>();
  const flagged: { p: Vec3; depth: number }[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    let bestD = Infinity;
    let bestSeg = 0;
    for (let j = 0; j < cl.length - 1; j++) {
      const d = pointSegmentDist(p, cl[j], cl[j + 1]);
      if (d < bestD) {
        bestD = d;
        bestSeg = j;
      }
    }
    if (!localRadius.has(bestSeg)) localRadius.set(bestSeg, bestD);
    else localRadius.set(bestSeg, Math.max(localRadius.get(bestSeg)!, bestD));
  }
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    let bestD = Infinity;
    let bestSeg = 0;
    for (let j = 0; j < cl.length - 1; j++) {
      const d = pointSegmentDist(p, cl[j], cl[j + 1]);
      if (d < bestD) {
        bestD = d;
        bestSeg = j;
      }
    }
    const expected = localRadius.get(bestSeg) ?? bestD;
    if (expected - bestD > 0.5 && expected > 1.5) {
      flagged.push({ p, depth: expected - bestD });
    }
  }
  // 聚类：相近的标记点合并成一个气泡
  const used = new Array(flagged.length).fill(false);
  for (let i = 0; i < flagged.length; i++) {
    if (used[i]) continue;
    const group: Vec3[] = [flagged[i].p];
    used[i] = true;
    for (let j = i + 1; j < flagged.length; j++) {
      if (!used[j] && dist(flagged[j].p, flagged[i].p) < 2.0) {
        group.push(flagged[j].p);
        used[j] = true;
      }
    }
    if (group.length < 3) continue;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of group) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    const center: Vec3 = [cx / group.length, cy / group.length, cz / group.length];
    let r = 0;
    for (const p of group) r = Math.max(r, dist(p, center));
    defects.push({
      id: uid('def'),
      kind: 'bubble',
      position: center,
      radius: Math.max(0.8, r + 0.4),
      note: `表面内陷，约 ${group.length} 个顶点，疑似气泡坑`,
    });
  }
  return defects;
}

function findBoundaryEdges(mesh: MeshData): { edges: number; vertices: number[] } {
  const edgeCount = new Map<string, number>();
  const edgeVerts = new Map<string, [number, number]>();
  const keyOf = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      const key = keyOf(a, b);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      edgeVerts.set(key, [a, b]);
    }
  }
  const verts = new Set<number>();
  let edges = 0;
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      edges++;
      const [a, b] = edgeVerts.get(key)!;
      verts.add(a);
      verts.add(b);
    }
  }
  return { edges, vertices: [...verts] };
}

/** 把标志点吸附到最近的中心线站点（手动拖拽后规整） */
export function snapToCenterline(point: Vec3, centerline: Vec3[]): Vec3 {
  let best = centerline[0];
  let bestD = Infinity;
  for (const c of centerline) {
    const d = dist(point, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export function directionOf(a: Vec3, b: Vec3): Vec3 {
  return normalize(sub(b, a));
}
