// 有向距离场（SDF）原语与布尔运算。约定：内部为负，表面为 0，外部为正。
import { Vec3, v3, clamp } from './math';
import { Centerline } from './centerline';

export type SDF = (p: Vec3) => number;

export const sdf = {
  sphere(center: Vec3, r: number): SDF {
    return (p) => v3.dist(p, center) - r;
  },
  box(center: Vec3, half: Vec3): SDF {
    return (p) => {
      const q: Vec3 = [
        Math.abs(p[0] - center[0]) - half[0],
        Math.abs(p[1] - center[1]) - half[1],
        Math.abs(p[2] - center[2]) - half[2],
      ];
      const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
      const inside = Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0);
      return outside + inside;
    };
  },
  cylinder(center: Vec3, axis: Vec3, halfLen: number, radius: number): SDF {
    const ax = v3.normalize(axis);
    return (p) => {
      const rel = v3.sub(p, center);
      const along = v3.dot(rel, ax);
      const perp = Math.sqrt(Math.max(1e-9, v3.dot(rel, rel) - along * along));
      const dx = Math.abs(along) - halfLen;
      const dr = perp - radius;
      return Math.min(Math.max(dx, dr), 0) + Math.hypot(Math.max(dx, 0), Math.max(dr, 0));
    };
  },
  // 胶囊（声管/通气孔用）
  capsule(a: Vec3, b: Vec3, radius: number): SDF {
    return (p) => {
      const ab = v3.sub(b, a);
      const t = clamp(v3.dot(v3.sub(p, a), ab) / (v3.dot(ab, ab) || 1e-9), 0, 1);
      const q = v3.lerp(a, b, t);
      return v3.dist(p, q) - radius;
    };
  },
  // 沿中心线变半径管（耳印/耳道的基础形体），radiusAt 返回该弧长处外半径
  tubeAlong(cl: Centerline, radiusAt: (s: number) => number): SDF {
    return (p) => {
      const proj = cl.project(p);
      const r = radiusAt(clamp(proj.s, 0, cl.totalLen));
      return proj.dist - r;
    };
  },
  // 半空间：normal 指向保留侧，过 point 的平面，保留侧为负
  halfSpace(point: Vec3, normal: Vec3): SDF {
    const n = v3.normalize(normal);
    return (p) => v3.dot(v3.sub(p, point), n);
  },
};

// 布尔：并（取小）、交（取大）、差
export const union = (a: SDF, b: SDF): SDF => (p) => Math.min(a(p), b(p));
export const intersect = (a: SDF, b: SDF): SDF => (p) => Math.max(a(p), b(p));
export const subtract = (a: SDF, b: SDF): SDF => (p) => Math.max(a(p), -b(p));

// 平滑并集
export function smoothUnion(a: SDF, b: SDF, k: number): SDF {
  return (p) => {
    const da = a(p), db = b(p);
    const h = clamp(0.5 + 0.5 * (db - da) / k, 0, 1);
    return db * (1 - h) + da * h - k * h * (1 - h);
  };
}

// 平滑差集（外壳内表面与裁剪面的倒圆靠它）
export function smoothSubtract(a: SDF, b: SDF, k: number): SDF {
  return (p) => {
    const da = a(p), db = -b(p);
    const h = clamp(0.5 + 0.5 * (db - da) / k, 0, 1);
    return db * (1 - h) + da * h + k * h * (1 - h);
  };
}

// 沿折线路径的管道（多段胶囊并集，再用两端半球封口）
export function polylineTube(points: Vec3[], radius: number): SDF {
  let f: SDF = sdf.sphere(points[0], radius);
  for (let i = 0; i < points.length - 1; i++) {
    f = union(f, sdf.capsule(points[i], points[i + 1], radius));
  }
  f = union(f, sdf.sphere(points[points.length - 1], radius));
  return f;
}

// 网格转 SDF：在规则网格上采样最近三角面距离 + 符号（射线奇偶法）
// 用于导入 STL 后的壁厚偏移。返回离散场三线性插值查询函数。
import { Mesh } from './mesh';

export interface GridSDF {
  query: SDF;
  min: Vec3;
  max: Vec3;
  dims: [number, number, number];
  cell: Vec3;
  values: Float32Array;
}

export function meshToGridSDF(mesh: Mesh, resolution = 96, band = 6): GridSDF {
  const p = mesh.positions;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k]);
      max[k] = Math.max(max[k], p[i + k]);
    }
  }
  const ext: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const step = Math.max(...ext) / resolution;
  const dims: [number, number, number] = [
    Math.ceil(ext[0] / step) + 2,
    Math.ceil(ext[1] / step) + 2,
    Math.ceil(ext[2] / step) + 2,
  ];
  const origin: Vec3 = [min[0] - step, min[1] - step, min[2] - step];
  const values = new Float32Array(dims[0] * dims[1] * dims[2]).fill(1e9);
  const idx = (i: number, j: number, k: number) => i + dims[0] * (j + dims[1] * k);
  const triCount = mesh.indices.length / 3;

  // 空间哈希桶
  const hash = new Map<number, number[]>();
  const cellOf = (x: number, y: number, z: number): [number, number, number] => [
    Math.floor((x - origin[0]) / step),
    Math.floor((y - origin[1]) / step),
    Math.floor((z - origin[2]) / step),
  ];
  const hkey = (i: number, j: number, k: number) => (i + 4096) * 1048576 + (j + 4096) * 1024 + (k + 4096);
  for (let t = 0; t < triCount; t++) {
    let tmin: Vec3 = [Infinity, Infinity, Infinity];
    let tmax: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v] * 3;
      for (let k = 0; k < 3; k++) {
        tmin[k] = Math.min(tmin[k], p[vi + k]);
        tmax[k] = Math.max(tmax[k], p[vi + k]);
      }
    }
    const c0 = cellOf(...tmin), c1 = cellOf(...tmax);
    for (let i = c0[0]; i <= c1[0]; i++)
      for (let j = c0[1]; j <= c1[1]; j++)
        for (let k = c0[2]; k <= c1[2]; k++) {
          const key = hkey(i, j, k);
          let bucket = hash.get(key);
          if (!bucket) hash.set(key, (bucket = []));
          bucket.push(t);
        }
  }

  const pointTriDist2 = (q: Vec3, tri: number): number => {
    let best = Infinity;
    for (let e = 0; e < 3; e++) {
      const a0 = mesh.indices[tri * 3 + e] * 3;
      const a1 = mesh.indices[tri * 3 + ((e + 1) % 3)] * 3;
      const a: Vec3 = [p[a0], p[a0 + 1], p[a0 + 2]];
      const b: Vec3 = [p[a1], p[a1 + 1], p[a1 + 2]];
      const ab = v3.sub(b, a);
      const t = clamp(v3.dot(v3.sub(q, a), ab) / (v3.dot(ab, ab) || 1e-9), 0, 1);
      const c = v3.lerp(a, b, t);
      best = Math.min(best, v3.dist(q, c) ** 2);
    }
    return best;
  };

  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        const q: Vec3 = [origin[0] + i * step, origin[1] + j * step, origin[2] + k * step];
        const [ci, cj, ck] = cellOf(...q);
        let nearest = Infinity;
        for (let r = 0; r <= band && nearest === Infinity; r++) {
          for (let di = -r; di <= r; di++)
            for (let dj = -r; dj <= r; dj++)
              for (let dk = -r; dk <= r; dk++) {
                if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
                const bucket = hash.get(hkey(ci + di, cj + dj, ck + dk));
                if (!bucket) continue;
                for (const tri of bucket) nearest = Math.min(nearest, pointTriDist2(q, tri));
              }
        }
        values[idx(i, j, k)] = nearest === Infinity ? 1e9 : Math.sqrt(nearest);
      }
    }
  }

  // 符号：广义绕数（对封闭网格可靠），用射线奇偶法，每点朝 +X 发射
  const signAt = (q: Vec3): number => {
    let inside = false;
    for (let t = 0; t < triCount; t++) {
      const v0i = mesh.indices[t * 3] * 3;
      const v1i = mesh.indices[t * 3 + 1] * 3;
      const v2i = mesh.indices[t * 3 + 2] * 3;
      const a: Vec3 = [p[v0i], p[v0i + 1], p[v0i + 2]];
      const b: Vec3 = [p[v1i], p[v1i + 1], p[v1i + 2]];
      const c: Vec3 = [p[v2i], p[v2i + 1], p[v2i + 2]];
      // Möller 射线 (q, +X)
      const e1 = v3.sub(b, a), e2 = v3.sub(c, a);
      const d: Vec3 = [1, 0, 0];
      const h = v3.cross(d, e2);
      const det = v3.dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const s = v3.sub(q, a);
      const u = v3.dot(s, h) / det;
      if (u < 0 || u > 1) continue;
      const qv = v3.cross(e1, s);
      const v = v3.dot(d, qv) / det;
      if (v < 0 || u + v > 1) continue;
      const tt = v3.dot(e2, qv) / det;
      if (tt > 1e-6) inside = !inside;
    }
    return inside ? -1 : 1;
  };

  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        const q: Vec3 = [origin[0] + i * step, origin[1] + j * step, origin[2] + k * step];
        values[idx(i, j, k)] *= signAt(q);
      }
    }
  }

  const query: SDF = (p) => {
    const fx = (p[0] - origin[0]) / step;
    const fy = (p[1] - origin[1]) / step;
    const fz = (p[2] - origin[2]) / step;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
    if (i0 < 0 || j0 < 0 || k0 < 0 || i0 >= dims[0] - 1 || j0 >= dims[1] - 1 || k0 >= dims[2] - 1) {
      return 1e9;
    }
    const tx = fx - i0, ty = fy - j0, tz = fz - k0;
    const lerp1 = (a: number, b: number, t: number) => a + (b - a) * t;
    const c000 = values[idx(i0, j0, k0)], c100 = values[idx(i0 + 1, j0, k0)];
    const c010 = values[idx(i0, j0 + 1, k0)], c110 = values[idx(i0 + 1, j0 + 1, k0)];
    const c001 = values[idx(i0, j0, k0 + 1)], c101 = values[idx(i0 + 1, j0, k0 + 1)];
    const c011 = values[idx(i0, j0 + 1, k0 + 1)], c111 = values[idx(i0 + 1, j0 + 1, k0 + 1)];
    return lerp1(
      lerp1(lerp1(c000, c100, tx), lerp1(c010, c110, tx), ty),
      lerp1(lerp1(c001, c101, tx), lerp1(c011, c111, tx), ty),
      tz,
    );
  };

  return {
    query,
    min: origin,
    max: [origin[0] + dims[0] * step, origin[1] + dims[1] * step, origin[2] + dims[2] * step],
    dims,
    cell: [step, step, step],
    values,
  };
}
