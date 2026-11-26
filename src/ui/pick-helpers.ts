import { mat4Invert, screenRay, type Mat4, type Ray } from '../math/vec';

export function screenRayHelper(viewProj: Mat4, x: number, y: number, width: number, height: number): Ray {
  return screenRay(mat4Invert(viewProj), x, y, width, height);
}
