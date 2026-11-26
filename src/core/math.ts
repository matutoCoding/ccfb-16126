// 基础数学库：Vec3 / Mat4（列主序，与 WebGL 一致），单位统一为毫米
export type Vec3 = [number, number, number];

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  dist: (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  normalize(a: Vec3): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  neg: (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]],
  copy: (a: Vec3): Vec3 => [a[0], a[1], a[2]],
  zero: (): Vec3 => [0, 0, 0],
};

// 4x4 列主序矩阵
export type Mat4 = Float32Array;

export const m4 = {
  identity(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  multiply(a: Mat4, b: Mat4): Mat4 {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  },
  translation(x: number, y: number, z: number): Mat4 {
    const m = m4.identity();
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m;
  },
  scaling(x: number, y: number, z: number): Mat4 {
    const m = m4.identity();
    m[0] = x;
    m[5] = y;
    m[10] = z;
    return m;
  },
  rotationX(a: number): Mat4 {
    const c = Math.cos(a), s = Math.sin(a), m = m4.identity();
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
  },
  rotationY(a: number): Mat4 {
    const c = Math.cos(a), s = Math.sin(a), m = m4.identity();
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
    return m;
  },
  rotationZ(a: number): Mat4 {
    const c = Math.cos(a), s = Math.sin(a), m = m4.identity();
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
  },
  // 绕任意轴
  axisAngle(axis: Vec3, angle: number): Mat4 {
    const [x, y, z] = v3.normalize(axis);
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    const m = m4.identity();
    m[0] = t * x * x + c;
    m[1] = t * x * y + s * z;
    m[2] = t * x * z - s * y;
    m[4] = t * x * y - s * z;
    m[5] = t * y * y + c;
    m[6] = t * y * z + s * x;
    m[8] = t * x * z + s * y;
    m[9] = t * y * z - s * x;
    m[10] = t * z * z + c;
    return m;
  },
  perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  },
  lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    const z = v3.normalize(v3.sub(eye, target));
    const x = v3.normalize(v3.cross(up, z));
    const y = v3.cross(z, x);
    const m = m4.identity();
    m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
    m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
    m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
    m[12] = -v3.dot(x, eye);
    m[13] = -v3.dot(y, eye);
    m[14] = -v3.dot(z, eye);
    return m;
  },
  transformPoint(m: Mat4, p: Vec3): Vec3 {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
  },
  transformDir(m: Mat4, d: Vec3): Vec3 {
    const x = d[0], y = d[1], z = d[2];
    return v3.normalize([
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z,
    ]);
  },
  invert(a: Mat4): Mat4 {
    // 高斯-约旦消元求逆，对任意可逆 4x4 矩阵稳健，避免 cofactor 列/行主序索引错误
    const n = 4;
    // 增广矩阵 [A | I]，行主序二维操作
    const m: number[][] = [];
    for (let r = 0; r < n; r++) {
      const row: number[] = [];
      for (let c = 0; c < n; c++) row.push(a[c * n + r]); // 列主序 -> 行主序
      for (let c = 0; c < n; c++) row.push(r === c ? 1 : 0);
      m.push(row);
    }
    for (let col = 0; col < n; col++) {
      // 选主元
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      if (Math.abs(m[pivot][col]) < 1e-12) return m4.identity();
      [m[col], m[pivot]] = [m[pivot], m[col]];
      const piv = m[col][col];
      for (let c = 0; c < 2 * n; c++) m[col][c] /= piv;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = m[r][col];
        for (let c = 0; c < 2 * n; c++) m[r][c] -= factor * m[col][c];
      }
    }
    // 右半即逆（行主序），转回列主序
    const o = new Float32Array(16);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        o[c * n + r] = m[r][n + c];
      }
    }
    return o;
  },
};

// 由投影+视图矩阵反推像素射线（用于 CPU 参考渲染与悬停查询）
export function pixelRay(
  invViewProj: Mat4,
  ndcX: number,
  ndcY: number,
): { origin: Vec3; dir: Vec3 } {
    const near = m4.transformPoint(invViewProj, [ndcX, ndcY, -1]);
    const far = m4.transformPoint(invViewProj, [ndcX, ndcY, 1]);
    return { origin: near, dir: v3.normalize(v3.sub(far, near)) };
  }

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// 平滑并集/差集常用的多项式平滑 min
export function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
}
