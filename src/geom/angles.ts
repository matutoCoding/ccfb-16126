import type { Vec3 } from '../types';
import { dot } from '../math/vec';

export function angleBetween(a: Vec3, b: Vec3): number {
  const cos = Math.max(-1, Math.min(1, dot(a, b)));
  return Math.acos(cos);
}
