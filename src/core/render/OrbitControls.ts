import type { Vec3 } from '../../types';
import { add, scale, sub } from '../math/vec3';
import type { Renderer } from './Renderer';

/** 鼠标轨道相机：左键旋转、右键平移、滚轮缩放 */
export class OrbitControls {
  azimuth = -0.7;
  polar = 1.05;
  distance = 46;
  target: Vec3 = [0, 0, 6];
  private dragging: 'rotate' | 'pan' | null = null;
  private lastX = 0;
  private lastY = 0;
  private el: HTMLElement;
  private renderer: Renderer;
  private onChange: () => void;

  constructor(el: HTMLElement, renderer: Renderer, onChange: () => void) {
    this.el = el;
    this.renderer = renderer;
    this.onChange = onChange;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = e.button === 2 ? 'pan' : 'rotate';
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.dragging === 'rotate') {
      this.azimuth -= dx * 0.008;
      this.polar = Math.max(0.12, Math.min(Math.PI - 0.12, this.polar - dy * 0.008));
    } else {
      const panScale = this.distance * 0.0012;
      const right: Vec3 = [Math.cos(this.azimuth), -Math.sin(this.azimuth), 0];
      const up: Vec3 = [
        -Math.sin(this.azimuth) * Math.cos(this.polar),
        -Math.cos(this.azimuth) * Math.cos(this.polar),
        Math.sin(this.polar),
      ];
      this.target = add(this.target, add(scale(right, -dx * panScale), scale(up, dy * panScale)));
    }
    this.apply();
    this.onChange();
  };

  private onUp = (): void => {
    this.dragging = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.distance = Math.max(8, Math.min(140, this.distance * (1 + Math.sign(e.deltaY) * 0.08)));
    this.apply();
    this.onChange();
  };

  eyePosition(): Vec3 {
    const sp = Math.sin(this.polar);
    return [
      this.target[0] + this.distance * sp * Math.sin(this.azimuth),
      this.target[1] + this.distance * sp * Math.cos(this.azimuth),
      this.target[2] + this.distance * Math.cos(this.polar),
    ];
  }

  apply(): void {
    this.renderer.setCamera(this.eyePosition(), this.target);
  }

  lookAt(target: Vec3, distance?: number): void {
    this.target = target;
    if (distance) this.distance = distance;
    this.apply();
  }

  resetView(): void {
    this.azimuth = -0.7;
    this.polar = 1.05;
    this.distance = 46;
    this.target = [0, 0, 6];
    this.apply();
    this.onChange();
  }
}

export function viewDirection(eye: Vec3, target: Vec3): Vec3 {
  const d = sub(target, eye);
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}
