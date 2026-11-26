import type { Vec3 } from '../types';
import { clamp, mat4LookAt, mat4Perspective, mat4Multiply, type Mat4 } from '../math/vec';

export class OrbitCamera {
  target: Vec3 = [0, -1.5, -4];
  yaw = 0.34;
  pitch = 0.22;
  distance = 92;
  fov = 38 * Math.PI / 180;
  near = 0.5;
  far = 500;
  aspect = 1;
  position: Vec3 = [0, 0, 90];
  view: Mat4 = mat4LookAt(this.position, this.target, [0, 1, 0]);
  proj: Mat4 = mat4Perspective(this.fov, 1, this.near, this.far);
  viewProj: Mat4 = mat4Multiply(this.proj, this.view);

  updateAspect(width: number, height: number) {
    this.aspect = width / Math.max(1, height);
    this.proj = mat4Perspective(this.fov, this.aspect, this.near, this.far);
    this.update();
  }

  update() {
    const cp = Math.cos(this.pitch);
    this.position = [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw)
    ];
    this.view = mat4LookAt(this.position, this.target, [0, 1, 0]);
    this.proj = mat4Perspective(this.fov, this.aspect, this.near, this.far);
    this.viewProj = mat4Multiply(this.proj, this.view);
  }

  rotate(dx: number, dy: number) {
    this.yaw -= dx * 0.008;
    this.pitch = clamp(this.pitch + dy * 0.008, -1.45, 1.45);
    this.update();
  }

  zoom(delta: number) {
    this.distance = clamp(this.distance * Math.exp(delta * 0.0012), 18, 220);
    this.update();
  }

  pan(dx: number, dy: number) {
    const scale = this.distance * 0.0012;
    this.target[0] -= dx * scale * Math.cos(this.yaw);
    this.target[2] += dx * scale * Math.sin(this.yaw);
    this.target[1] += dy * scale;
    this.update();
  }
}

export class PointerOrbitControls {
  enabled = true;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private button = 0;
  private cleanupFns: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement, private camera: OrbitCamera, private onAfterChange?: () => void) {
    const down = (e: PointerEvent) => {
      if (!this.enabled) return;
      this.dragging = true;
      this.button = e.button;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!this.dragging || !this.enabled) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      if (this.button === 2 || e.shiftKey) camera.pan(dx, dy);
      else camera.rotate(dx, dy);
      this.onAfterChange?.();
    };
    const up = (e: PointerEvent) => {
      this.dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };
    const wheel = (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      camera.zoom(e.deltaY);
      this.onAfterChange?.();
    };
    const context = (e: Event) => e.preventDefault();
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('contextmenu', context);
    this.cleanupFns.push(() => canvas.removeEventListener('pointerdown', down));
    this.cleanupFns.push(() => canvas.removeEventListener('pointermove', move));
    this.cleanupFns.push(() => canvas.removeEventListener('pointerup', up));
    this.cleanupFns.push(() => canvas.removeEventListener('pointercancel', up));
    this.cleanupFns.push(() => canvas.removeEventListener('wheel', wheel));
    this.cleanupFns.push(() => canvas.removeEventListener('contextmenu', context));
  }

  dispose() { this.cleanupFns.forEach(fn => fn()); }
}
