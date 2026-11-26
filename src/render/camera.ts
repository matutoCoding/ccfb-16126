// 轨道相机：球机模型，鼠标拖拽旋转、滚轮缩放
import { Vec3, Mat4, m4, v3 } from '../core/math';
import { Mesh } from '../core/mesh';

export class OrbitCamera {
  target: Vec3 = [0, 0, 8];
  distance = 34;
  yaw = 0.6;
  pitch = 0.35;
  fovy = Math.PI / 4;
  near = 0.5;
  far = 400;

  eye(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  viewMatrix(): Mat4 {
    return m4.lookAt(this.eye(), this.target, [0, 1, 0]);
  }

  projMatrix(aspect: number): Mat4 {
    return m4.perspective(this.fovy, aspect, this.near, this.far);
  }

  viewProj(aspect: number): Mat4 {
    return m4.multiply(this.projMatrix(aspect), this.viewMatrix());
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * 0.008;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.008));
  }

  zoom(factor: number): void {
    this.distance = Math.max(4, Math.min(200, this.distance * factor));
  }

  fit(meshes: Mesh[]): void {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) {
      for (let i = 0; i < m.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], m.positions[i + k]);
          max[k] = Math.max(max[k], m.positions[i + k]);
        }
      }
    }
    if (!isFinite(min[0])) return;
    this.target = v3.scale(v3.add(min, max), 0.5);
    const radius = Math.max(...v3.sub(max, min).map((e) => e / 2), 1);
    this.distance = radius / Math.sin(this.fovy / 2) * 1.25;
  }
}

// 绑定鼠标/触摸交互
export function attachOrbit(canvas: HTMLCanvasElement, camera: OrbitCamera): () => void {
  let dragging = false;
  let lastX = 0, lastY = 0;
  const down = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!dragging) return;
    camera.rotate(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const up = () => { dragging = false; };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    camera.zoom(1 + Math.sign(e.deltaY) * 0.08);
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    canvas.removeEventListener('wheel', wheel);
  };
}
