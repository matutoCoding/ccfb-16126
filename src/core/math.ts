/**
 * 向量 / 矩阵基础数学（mm 单位，右手系）。
 * 全部是纯函数 + Float32Array / number[]，渲染层与几何层共用。
 */

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array; // 列主序，与 WebGL uniform 一致

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const clone3 = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const dist3 = (a: Vec3, b: Vec3): number => len3(sub3(a, b));
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const neg3 = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

/**  Catmull-Rom 采样，闭合/开放曲线通用 */
export function catmullRom(points: Vec3[], t: number): Vec3 {
  const n = points.length;
  if (n < 2) return clone3(points[0]);
  const p = t * (n - 1);
  const i = Math.min(n - 2, Math.max(0, Math.floor(p)));
  const f = p - i;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(n - 1, i + 2)];
  const f2 = f * f;
  const f3 = f2 * f;
  const c0 = -0.5 * f3 + f2 - 0.5 * f;
  const c1 = 1.5 * f3 - 2.5 * f2 + 1;
  const c2 = -1.5 * f3 + 2 * f2 + 0.5 * f;
  const c3 = 0.5 * f3 - 0.5 * f2;
  return [
    p0[0] * c0 + p1[0] * c1 + p2[0] * c2 + p3[0] * c3,
    p0[1] * c0 + p1[1] * c1 + p2[1] * c2 + p3[1] * c3,
    p0[2] * c0 + p1[2] * c1 + p2[2] * c2 + p3[2] * c3,
  ];
}

/** 重采样为等弧长折线，samples 为总点数 */
export function resamplePolyline(points: Vec3[], samples: number): Vec3[] {
  const seg: number[] = [0];
  for (let i = 1; i < points.length; i++) seg.push(seg[i - 1] + dist3(points[i - 1], points[i]));
  const total = seg[seg.length - 1];
  if (total < 1e-9) return points.map(clone3);
  const out: Vec3[] = [];
  let j = 0;
  for (let k = 0; k < samples; k++) {
    const d = (total * k) / (samples - 1);
    while (j < seg.length - 2 && seg[j + 1] < d) j++;
    const span = seg[j + 1] - seg[j] || 1;
    out.push(lerp3(points[j], points[j + 1], (d - seg[j]) / span));
  }
  return out;
}

export function identity4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply4(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function translate4(x: number, y: number, z: number): Mat4 {
  const m = identity4();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function scale4(sx: number, sy: number, sz: number): Mat4 {
  const m = identity4();
  m[0] = sx; m[5] = sy; m[10] = sz;
  return m;
}

export function perspective4(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

/** lookAt，right-handed，相机看向 -z */
export function lookAt4(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = norm3(sub3(eye, target));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  const m = identity4();
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -dot3(x, eye);
  m[13] = -dot3(y, eye);
  m[14] = -dot3(z, eye);
  return m;
}

export function transformPoint4(m: Mat4, p: Vec3): Vec3 {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w];
}

/** 射线（世界空间） */
export interface Ray {
  origin: Vec3;
  dir: Vec3; // 单位向量
}
