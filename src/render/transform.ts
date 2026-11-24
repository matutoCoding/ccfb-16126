/** 欧拉角（yxz 视觉约定，这里统一 xyz）旋转矩阵 */
import { Mat4, identity4 } from '../core/math';
import { Vec3 } from '../core/math';

export function rotateEuler(e: Vec3): Mat4 {
  const [rx, ry, rz] = e;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const m = identity4();
  // Rz * Ry * Rx
  m[0] = cy * cz; m[4] = cz * sy * sx - sz * cx; m[8] = cz * sy * cx + sz * sx;
  m[1] = sz * cy; m[5] = sz * sy * sx + cz * cx; m[9] = sz * sy * cx - cz * sx;
  m[2] = -sy;     m[6] = cy * sx;                  m[10] = cy * cx;
  return m;
}
