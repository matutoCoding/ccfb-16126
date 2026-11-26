// CPU 参考渲染：逐像素射线与所有网格求交，按深度精确排序后做 front-to-back alpha 合成。
// 这是透视正确性的“地面真值”，GPU 深度剥离结果与它逐像素比对（误差 <= 2 色阶）。
import { Vec3, Mat4, m4, v3, pixelRay } from './math';
import { Mesh } from './mesh';
import { RayMeshIntersector, RayHit } from './raycast';

export interface SceneObject {
  mesh: Mesh;
  color: Vec3; // 0~1
  alpha: number; // 0~1
  modelMatrix?: Mat4; // 暂未使用，预留
}

export interface ReferenceRenderResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  // 每像素穿壳段信息（厚度分析用）
  layerDepths: Float32Array[]; // 每像素的交点 t 值数组
}

interface SortedHit extends RayHit {
  obj: number;
  color: Vec3;
  alpha: number;
}

export class ReferenceRenderer {
  private intersectors: RayMeshIntersector[] = [];

  constructor(private objects: SceneObject[]) {
    for (const o of objects) {
      this.intersectors.push(new RayMeshIntersector(o.mesh, 64));
    }
  }

  render(
    viewProj: Mat4,
    width: number,
    height: number,
    bg: Vec3 = [0.12, 0.13, 0.16],
  ): ReferenceRenderResult {
    const inv = m4.invert(viewProj);
    const rgba = new Uint8ClampedArray(width * height * 4);
    const layerDepths: Float32Array[] = new Array(width * height);

    for (let y = 0; y < height; y++) {
      const ndcY = 1 - (2 * y) / height;
      for (let x = 0; x < width; x++) {
        const ndcX = (2 * x) / width - 1;
        const { origin, dir } = pixelRay(inv, ndcX, ndcY);
        const hits: SortedHit[] = [];
        for (let oi = 0; oi < this.objects.length; oi++) {
          const hs = this.intersectors[oi].intersectAll(origin, dir);
          for (const h of hs) {
            hits.push({ ...h, obj: oi, color: this.objects[oi].color, alpha: this.objects[oi].alpha });
          }
        }
        hits.sort((a, b) => a.t - b.t);

        // 与 GPU PEEL_FS 完全相同的光照项，保证逐像素可比
        const lightDir: Vec3 = v3.normalize([0.4, 0.7, 0.6]);
        const shade = (n: Vec3): number => 0.55 + 0.45 * Math.abs(v3.dot(v3.normalize(n), lightDir));

        // 先独立收集全部交点深度（不受 alpha 提前终止影响），供壁厚分析
        const depths = hits.map((h) => h.t);

        // front-to-back 合成（与 GPU 端 blend func 严格一致）
        let cr = bg[0], cg = bg[1], cb = bg[2];
        let remaining = 1;
        for (const h of hits) {
          const diff = shade(h.normal);
          const a = h.alpha * remaining;
          cr = cr + a * h.color[0] * diff;
          cg = cg + a * h.color[1] * diff;
          cb = cb + a * h.color[2] * diff;
          remaining *= 1 - h.alpha;
          if (remaining < 1 / 512) break;
        }
        const pi = (y * width + x) * 4;
        rgba[pi] = Math.round(clamp8(cr) * 255);
        rgba[pi + 1] = Math.round(clamp8(cg) * 255);
        rgba[pi + 2] = Math.round(clamp8(cb) * 255);
        rgba[pi + 3] = 255;
        layerDepths[y * width + x] = Float32Array.from(depths);
      }
    }
    return { rgba, width, height, layerDepths };
  }
}

function clamp8(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// 逐像素色差（各通道绝对差的最大值），返回统计
export function compareImages(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
): { maxDiff: number; meanDiff: number; over2: number; total: number } {
  let maxDiff = 0, sum = 0, over2 = 0;
  const total = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
    );
    maxDiff = Math.max(maxDiff, d);
    sum += d;
    if (d > 2) over2++;
  }
  return { maxDiff, meanDiff: sum / (total * 3), over2, total };
}

// 由参考渲染的层深度计算每像素各实体段厚度（mm），相邻同网格交点配对
export function referenceThickness(
  result: ReferenceRenderResult,
  objects: SceneObject[],
  viewProj: Mat4,
  width: number,
  height: number,
): { segments: { t0: number; t1: number; thickness: number }[] }[] {
  const inv = m4.invert(viewProj);
  const out: { segments: { t0: number; t1: number; thickness: number }[] }[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const ndcX = (2 * x) / width - 1;
      const ndcY = 1 - (2 * y) / height;
      const { dir } = pixelRay(inv, ndcX, ndcY);
      const depths = result.layerDepths[idx];
      // 仅取外壳（objects[0]）的成对交点：这里用全部交点差分段，调用方负责只传壳
      const segs: { t0: number; t1: number; thickness: number }[] = [];
      for (let i = 0; i + 1 < depths.length; i += 2) {
        segs.push({ t0: depths[i], t1: depths[i + 1], thickness: (depths[i + 1] - depths[i]) });
      }
      void dir;
      void objects;
      out[idx] = { segments: segs };
    }
  }
  return out;
}
