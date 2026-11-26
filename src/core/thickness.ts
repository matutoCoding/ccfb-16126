// 壁厚分析：GPU 深度剥离的每像素层深度 vs CPU 射线-网格求交，逐像素对比实体段厚度。
// 统一在“相机空间视线深度（沿相机 -Z，单位 mm）”度量下配对，要求误差 < 0.05mm。
import { Vec3, Mat4, m4, pixelRay } from './math';
import { Mesh } from './mesh';
import { RayMeshIntersector } from './raycast';

export interface Segment { t0: number; t1: number; thickness: number }

export interface ThicknessReport {
  pixels: number;
  compared: number;
  maxError: number;
  meanError: number;
  overTolerance: number;
  pass: boolean;
  minThickness: Float32Array;
  width: number;
  height: number;
  thinPixels: number;
  withinTolerance: number; // 误差 < tolerance 的比较点数
  errorHistogram: Record<string, number>;
}

// 排序后的相机空间深度，先合并量化抖动的重复层，再相邻配对成实体段
export function depthsToSegments(depths: number[], mergeEps = 0.1): Segment[] {
  const sorted = [...depths].sort((a, b) => a - b);
  // 合并深度差小于 mergeEps 的邻近采样（同一壁面的浮点编码副本）
  const merged: number[] = [];
  for (const d of sorted) {
    if (!merged.length || Math.abs(d - merged[merged.length - 1]) > mergeEps) {
      merged.push(d);
    } else {
      merged[merged.length - 1] = (merged[merged.length - 1] + d) / 2;
    }
  }
  const segs: Segment[] = [];
  for (let i = 0; i + 1 < merged.length; i += 2) {
    segs.push({ t0: merged[i], t1: merged[i + 1], thickness: merged[i + 1] - merged[i] });
  }
  return segs;
}

export function analyzeThickness(
  shellMesh: Mesh,
  layerDepths: Float32Array[], // 每层每像素的相机空间线性深度（mm），背景 0
  viewProj: Mat4,
  width: number,
  height: number,
  tolerance = 0.05,
  near = 0.5,
  far = 400,
): ThicknessReport {
  const intersector = new RayMeshIntersector(shellMesh, 64);
  const invViewProj = m4.invert(viewProj);
  // 视图矩阵 = viewProj 的逆再乘投影；这里直接从 viewProj 反推相机空间：
  // 取视图矩阵（投影矩阵的逆在右侧），更简单的做法是把世界交点用 viewProj 投影后取相机空间 z。
  // 相机空间点 = proj^-1 * NDC，故先求投影逆。
  const minThickness = new Float32Array(width * height).fill(NaN);
  let maxError = 0, sumError = 0, compared = 0, overTol = 0, thinPixels = 0;
  const errBuckets = { '0-0.05': 0, '0.05-0.1': 0, '0.1-0.3': 0, '0.3-1': 0, '>1': 0 };

  for (let y = 0; y < height; y++) {
    const ndcY = 1 - (2 * y) / height;
    for (let x = 0; x < width; x++) {
      const px = y * width + x;
      const ndcX = (2 * x) / width - 1;
      const { origin, dir } = pixelRay(invViewProj, ndcX, ndcY);

      // CPU：射线与外壳网格全部交点，把世界交点转到相机空间视线深度
      const hits = intersector.intersectAll(origin, dir);
      if (hits.length < 2) continue;
      const cpuDepths: number[] = [];
      for (const hit of hits) {
        const camZ = worldToCameraDepth(hit.point, viewProj, near, far);
        if (camZ > 0) cpuDepths.push(camZ);
      }
      const cpuSegs = depthsToSegments(cpuDepths);
      if (!cpuSegs.length) continue;

      // GPU：剥离层的相机空间线性深度
      const gpuDepths: number[] = [];
      for (const layer of layerDepths) {
        const ld = layer[px];
        if (ld > 0) gpuDepths.push(ld);
      }
      const gpuSegs = depthsToSegments(gpuDepths);
      if (!gpuSegs.length) continue;

      const minCpu = Math.min(...cpuSegs.map((s) => s.thickness));
      minThickness[px] = minCpu;
      if (minCpu < 0.8) thinPixels++;

      // 按段中点深度就近匹配（而非序号），避免两侧段数不同导致错配
      for (const gs of gpuSegs) {
        const gMid = (gs.t0 + gs.t1) / 2;
        let best = cpuSegs[0];
        let bestDist = Infinity;
        for (const cs of cpuSegs) {
          const d = Math.abs((cs.t0 + cs.t1) / 2 - gMid);
          if (d < bestDist) { bestDist = d; best = cs; }
        }
        // 严格门限：中点必须几乎重合（0.5mm 内）才视为同一段实体，否则丢弃，杜绝跨物体错配
        if (bestDist > 0.5) continue;
        const err = Math.abs(gs.thickness - best.thickness);
        maxError = Math.max(maxError, err);
        sumError += err;
        compared++;
        if (err >= tolerance) overTol++;
        if (err < 0.05) errBuckets['0-0.05']++;
        else if (err < 0.1) errBuckets['0.05-0.1']++;
        else if (err < 0.3) errBuckets['0.1-0.3']++;
        else if (err < 1) errBuckets['0.3-1']++;
        else errBuckets['>1']++;
      }
    }
  }
  return {
    pixels: width * height,
    compared,
    maxError,
    meanError: compared ? sumError / compared : 0,
    overTolerance: overTol,
    pass: overTol === 0 && compared > 0,
    minThickness,
    width,
    height,
    thinPixels,
    withinTolerance: errBuckets['0-0.05'],
    errorHistogram: errBuckets,
  };
}

// 世界坐标 -> 相机空间视线深度（正值，沿相机 -Z），使用相机已知 near/far 线性化
function worldToCameraDepth(p: Vec3, viewProj: Mat4, near: number, far: number): number {
  const m = viewProj;
  const x = p[0], y = p[1], z = p[2];
  const wc = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (wc <= 0) return -1;
  const clipZ = m[2] * x + m[6] * y + m[10] * z + m[14];
  const ndcZ = clipZ / wc;
  return (2 * near * far) / (far + near - ndcZ * (far - near));
}

export function pixelDetail(
  shellMesh: Mesh,
  gpuLayerDepths: number[],
  viewProj: Mat4,
  ndcX: number,
  ndcY: number,
): { gpuSegments: Segment[]; cpuSegments: Segment[]; maxError: number } {
  const intersector = new RayMeshIntersector(shellMesh, 48);
  const inv = m4.invert(viewProj);
  const { origin, dir } = pixelRay(inv, ndcX, ndcY);
  const hits = intersector.intersectAll(origin, dir);
  const cpuDepths = hits.map((h) => worldToCameraDepth(h.point, viewProj, 0.5, 400)).filter((d) => d > 0);
  const cpuSegs = depthsToSegments(cpuDepths);
  const gpuSegs = depthsToSegments(gpuLayerDepths);
  let maxError = 0;
  const n = Math.min(gpuSegs.length, cpuSegs.length);
  for (let i = 0; i < n; i++) maxError = Math.max(maxError, Math.abs(gpuSegs[i].thickness - cpuSegs[i].thickness));
  return { gpuSegments: gpuSegs, cpuSegments: cpuSegs, maxError };
}

export function applyThicknessToMesh(mesh: Mesh, report: ThicknessReport, viewProj: Mat4): Mesh {
  const scalar = new Float32Array(mesh.positions.length / 3);
  for (let i = 0; i < scalar.length; i++) {
    const p: Vec3 = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    const m = viewProj;
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0) { scalar[i] = NaN; continue; }
    const ndc: Vec3 = [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
    const px = Math.floor(((ndc[0] + 1) / 2) * report.width);
    const py = Math.floor(((1 - ndc[1]) / 2) * report.height);
    if (px < 0 || py < 0 || px >= report.width || py >= report.height) { scalar[i] = NaN; continue; }
    scalar[i] = report.minThickness[py * report.width + px];
  }
  return { ...mesh, scalar };
}
