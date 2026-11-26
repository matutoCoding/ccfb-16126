// CPU 参考渲染自检（无 GL）：验证逐像素射线求交 + 深度排序的参考实现正确
import { describe, it, expect } from 'vitest';
import { marchingCubes, gridFromBounds } from '../src/core/marchingCubes';
import { sdf } from '../src/core/sdf';
import { ReferenceRenderer } from '../src/core/referenceRenderer';
import { OrbitCamera } from '../src/render/camera';

describe('CPU 参考渲染自检', () => {
  it('球体在透视投影下正确着色并产生成对交点（穿入/穿出）', () => {
    // 居中球体 + 真实 OrbitCamera，保证视图/投影约定与生产代码一致
    const { mesh } = marchingCubes(
      sdf.sphere([0, 0, 0], 3),
      gridFromBounds([-5, -5, -5], [5, 5, 5], 40),
    );
    const cam = new OrbitCamera();
    cam.target = [0, 0, 0];
    cam.distance = 12;
    const viewProj = cam.viewProj(1);

    const ref = new ReferenceRenderer([{ mesh, color: [0.6, 0.7, 0.9], alpha: 1 }]);
    const result = ref.render(viewProj, 48, 48);

    let lit = 0;
    for (let i = 0; i < 48 * 48; i++) {
      const k = i * 4;
      if (result.rgba[k] + result.rgba[k + 1] + result.rgba[k + 2] > 120) lit++;
    }
    expect(lit).toBeGreaterThan(120);
    expect(lit).toBeLessThan(48 * 48 * 0.5);

    // 命中球的像素都应有成对交点（封闭网格穿入+穿出）
    let paired = 0;
    let anyHits = 0;
    for (let i = 0; i < result.layerDepths.length; i++) {
      if (result.layerDepths[i].length > 0) anyHits++;
      if (result.layerDepths[i].length >= 2) paired++;
    }
    console.log('anyHits=', anyHits, 'paired=', paired, 'lit=', lit);
    expect(anyHits).toBeGreaterThan(100);
    expect(paired).toBeGreaterThan(100);
  });
});
