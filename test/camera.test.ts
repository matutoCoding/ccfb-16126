// 验证 CPU pixelRay 反推的射线是否与 GPU 光栅化的光线方向一致
import { describe, it, expect } from 'vitest';
import { m4, v3, pixelRay } from '../src/core/math';
import { OrbitCamera } from '../src/render/camera';

describe('pixelRay 相机约定', () => {
  it('用真实 OrbitCamera 时中心射线穿过注视目标、方向朝视线方向', () => {
    const cam = new OrbitCamera();
    cam.target = [0, 0, 0];
    cam.distance = 30;
    const vp = cam.viewProj(1);
    const inv = m4.invert(vp);

    const center = pixelRay(inv, 0, 0);
    const eye = cam.eye();
    expect(Math.abs(center.origin[0] - eye[0])).toBeLessThan(0.5);
    expect(Math.abs(center.origin[1] - eye[1])).toBeLessThan(0.5);
    expect(Math.abs(center.origin[2] - eye[2])).toBeLessThan(0.5);

    const toTarget = v3.normalize(v3.sub([0, 0, 0], eye));
    const dot = center.dir[0] * toTarget[0] + center.dir[1] * toTarget[1] + center.dir[2] * toTarget[2];
    expect(dot).toBeGreaterThan(0.99);
  });
});
