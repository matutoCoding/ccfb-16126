import { describe, it, expect } from 'vitest';
import { m4, Mat4 } from '../src/core/math';
import { OrbitCamera } from '../src/render/camera';

describe('矩阵求逆', () => {
  it('M * invert(M) = 单位矩阵（随机仿射矩阵）', () => {
    const cam = new OrbitCamera();
    cam.target = [1, 2, 3];
    cam.distance = 25;
    const m = cam.viewProj(1.5);
    const inv = m4.invert(m);
    const prod = m4.multiply(m, inv);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(Math.abs(prod[i] - expected)).toBeLessThan(1e-4);
    }
  });

  it('简单平移矩阵求逆后反推原点', () => {
    // 列主序平移 (tx,ty,tz)=(10,20,30)
    const m: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
    const inv = m4.invert(m);
    const p = m4.transformPoint(inv, [10, 20, 30]);
    expect(p[0]).toBeCloseTo(0, 4);
    expect(p[1]).toBeCloseTo(0, 4);
    expect(p[2]).toBeCloseTo(0, 4);
  });
});
