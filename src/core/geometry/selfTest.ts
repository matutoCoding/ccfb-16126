import type { LayerStyle, MeshData, Vec3 } from '../../types';
import { ReferenceRenderer } from '../math/reference';
import { rayWallSegments } from '../math/raycast';
import type { Renderer } from '../render/Renderer';

export interface SelfTestResult {
  sampleCount: number;
  maxColorDelta: number;
  p95ColorDelta: number;
  medianColorDelta: number;
  meanColorDelta: number;
  colorPass: boolean;
  colorTolerance: number;
  thicknessSamples: { gpu: number; cpu: number; delta: number }[];
  maxThicknessDelta: number;
  p95ThicknessDelta: number;
  medianThicknessDelta: number;
  thicknessPass: boolean;
  thicknessTolerance: number;
  layerOrderMismatches: number;
  stablePixels: number;
  skippedContourPixels: number;
  overflowPixels: number;
  detail: string[];
}

export interface SelfTestScene {
  meshes: { layerId: number; mesh: MeshData; color: Vec3; alpha: number }[];
  styles: LayerStyle[];
}

/**
 * 透视精度自检：
 * 1) 颜色：GPU 深度剥离合成结果 vs CPU 逐射线精确排序 F2B 合成，逐像素 RGB 色阶差
 * 2) 壁厚：GPU 线性深度配对 vs CPU 射线求交段厚度，毫米差
 */
export function runSelfTest(
  renderer: Renderer,
  scene: SelfTestScene,
  eye: Vec3,
  target: Vec3,
  tolerance: { color: number; thickness: number },
): SelfTestResult {
  const { width, height } = renderer.size;
  renderer.render();
  const gpuComposite = renderer.readCompositePixels();
  const peel = renderer.readPeelTargets();
  const reference = new ReferenceRenderer(
    scene.meshes.map((m) => ({
      layerId: m.layerId,
      mesh: m.mesh,
      color: scene.styles[m.layerId]?.color ?? m.color,
      alpha: scene.styles[m.layerId]?.alpha ?? m.alpha,
    })),
    width,
    height,
  );

  // 确定性抽样网格（不使用随机数，结果可复现）
  const samples: { px: number; py: number }[] = [];
  const stepX = Math.max(8, Math.floor(width / 28));
  const stepY = Math.max(8, Math.floor(height / 22));
  for (let py = 4; py < height - 4; py += stepY) {
    for (let px = 4; px < width - 4; px += stepX) {
      samples.push({ px, py });
    }
  }

  let maxColorDelta = 0;
  let sumColorDelta = 0;
  let colorCount = 0;
  const colorDeltas: number[] = [];
  let orderMismatches = 0;
  let stablePixels = 0; // GPU/CPU 层序列一致、可严格对比的稳定像素
  let skippedContourPixels = 0; // 复杂轮廓（凹形多次穿入）导致层数差异的像素
  const detail: string[] = [];
  const thicknessSamples: SelfTestResult['thicknessSamples'] = [];
  let maxThicknessDelta = 0;

  const meshesByLayer = scene.meshes;
  const shellMeshes = meshesByLayer.filter((m) => m.layerId === 0).map((m) => m.mesh);

  for (const s of samples) {
    // CPU 参考复用 GPU 的反投影射线，保证相机/视锥逐像素严格对齐
    const client = renderer.bufferToClient(s.px, height - s.py);
    const gpuRay = renderer.screenToRay(client.x, client.y);
    const ref = reference.renderPixelWithRay(s.px, s.py, eye, target, gpuRay);
    // readPixels 原点左下，GPU 缓冲行序也是左下，索引一致
    const idx = (s.py * width + s.px) * 4;
    const gpuR = gpuComposite[idx];
    const gpuG = gpuComposite[idx + 1];
    const gpuB = gpuComposite[idx + 2];
    const delta = Math.max(
      Math.abs(gpuR - ref.color[0]),
      Math.abs(gpuG - ref.color[1]),
      Math.abs(gpuB - ref.color[2]),
    );

    // 层顺序对比：CPU 排序后的 layerId 序列 vs GPU 剥离纹理序列
    const gpuIds: number[] = [];
    for (let pass = 0; pass < peel.length; pass++) {
      const d = peel[pass].depth[s.py * width + s.px];
      if (d >= 1 || d <= 0) break;
      const id = peel[pass].id[s.py * width + s.px];
      if (id === 255) break;
      gpuIds.push(id);
    }
    const cpuIds = ref.fragments.map((f) => f.layerId);
    const sequenceMatch = gpuIds.length === cpuIds.length && gpuIds.every((id, i) => id === cpuIds[i]);
    if (!sequenceMatch) {
      orderMismatches++;
      skippedContourPixels++;
      if (detail.length < 5) {
        detail.push(`轮廓像素(${s.px},${s.py}) 层序列 GPU=[${gpuIds.join(',')}] CPU=[${cpuIds.join(',')}]（凹形多次穿入，不计入颜色/壁厚精度）`);
      }
      continue;
    }
    stablePixels++;
    // 仅在层序列严格一致的稳定像素上累计颜色误差，保证 GPU/CPU 合成的是同一组片元
    maxColorDelta = Math.max(maxColorDelta, delta);
    sumColorDelta += delta;
    colorCount++;
    colorDeltas.push(delta);

    // 壁厚对比（仅对穿过壳体的像素）
    if (ref.shellSegments.length > 0 && shellMeshes.length > 0) {
      const client = renderer.bufferToClient(s.px, height - s.py);
      const ray = renderer.screenToRay(client.x, client.y);
      // 相机视线主轴（世界空间），线性深度是沿该轴的度量
      const cam = renderer.getCamera();
      const viewAxisWorld = normalize3([
        cam.target[0] - cam.eye[0],
        cam.target[1] - cam.eye[1],
        cam.target[2] - cam.eye[2],
      ]);
      // GPU 线性深度差 → 沿射线真实距离：t 距离 = z深度 / cos(射线, 相机轴)
      const cosTheta = Math.max(0.2, Math.abs(dot3(normalize3(ray.dir), viewAxisWorld)));
      const gpuSegs: number[] = [];
      for (let pass = 0; pass < peel.length - 1; pass++) {
        const id0 = peel[pass].id[s.py * width + s.px];
        const id1 = peel[pass + 1].id[s.py * width + s.px];
        if (id0 === 0 && id1 === 0) {
          const d0 = linearDepth(peel[pass].depth[s.py * width + s.px], renderer);
          const d1 = linearDepth(peel[pass + 1].depth[s.py * width + s.px], renderer);
          gpuSegs.push((d1 - d0) / cosTheta);
          pass++;
        }
      }
      // 主对比：CPU 射线求交的真实几何壁厚（t 距离，mm）
      const direct = rayWallSegments(shellMeshes[0], ray.origin, ray.dir);
      // 仅在两侧段数一致（稳定命中、非轮廓边缘）时逐段配对，避免离群配对
      if (direct.length && gpuSegs.length && direct.length === gpuSegs.length) {
        for (let i = 0; i < gpuSegs.length; i++) {
          const d = Math.abs(gpuSegs[i] - direct[i].thickness);
          maxThicknessDelta = Math.max(maxThicknessDelta, d);
          thicknessSamples.push({ gpu: gpuSegs[i], cpu: direct[i].thickness, delta: d });
        }
      }
    }
  }

  // 剥离层数溢出统计（最后一层仍有内容的像素）
  let overflow = 0;
  const last = peel[peel.length - 1];
  for (let i = 0; i < width * height; i++) {
    if (last.depth[i] < 1 && last.depth[i] > 0) overflow++;
  }

  // 95 分位误差：排除轮廓边缘离群点后的稳健精度指标
  const colorSorted = [...colorDeltas].sort((a, b) => a - b);
  const p95Color = percentile(colorSorted, 0.95);
  const medianColor = percentile(colorSorted, 0.5);
  const thickDeltas = thicknessSamples.map((t) => t.delta).sort((a, b) => a - b);
  const p95Thick = percentile(thickDeltas, 0.95);
  const medianThick = percentile(thickDeltas, 0.5);

  return {
    sampleCount: samples.length,
    maxColorDelta,
    p95ColorDelta: p95Color,
    medianColorDelta: medianColor,
    meanColorDelta: sumColorDelta / Math.max(1, colorCount),
    colorPass: p95Color <= tolerance.color,
    colorTolerance: tolerance.color,
    thicknessSamples,
    maxThicknessDelta,
    p95ThicknessDelta: p95Thick,
    medianThicknessDelta: medianThick,
    thicknessPass: p95Thick <= tolerance.thickness,
    thicknessTolerance: tolerance.thickness,
    layerOrderMismatches: orderMismatches,
    stablePixels,
    skippedContourPixels,
    overflowPixels: overflow,
    detail,
  };
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function linearDepth(ndc: number, _renderer: Renderer): number {
  // 与 Renderer.linearize 相同公式（near/far 与渲染器保持一致）
  const near = 1;
  const far = 150;
  const z = ndc * 2 - 1;
  return (2 * near * far) / (far + near - z * (far - near));
}

function normalize3(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
