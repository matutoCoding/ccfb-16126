import { Vec3, v3 } from './math';

// 耳道中心线：折线 + 弧长参数化 + 平行输运标架（避免 Frenet 突变）
export class Centerline {
  points: Vec3[];
  cumLen: number[] = []; // 累计弧长
  totalLen = 0;
  frames: { tangent: Vec3; normal: Vec3; binormal: Vec3 }[] = [];

  constructor(points: Vec3[]) {
    this.points = points.map((p) => v3.copy(p));
    this.build();
  }

  private build(): void {
    const n = this.points.length;
    this.cumLen = [0];
    for (let i = 1; i < n; i++) {
      this.totalLen += v3.dist(this.points[i - 1], this.points[i]);
      this.cumLen.push(this.totalLen);
    }
    // 切向
    const tangents: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = this.points[Math.max(0, i - 1)];
      const p1 = this.points[Math.min(n - 1, i + 1)];
      tangents.push(v3.normalize(v3.sub(p1, p0)));
    }
    // 平行输运标架
    let normal = pickPerpendicular(tangents[0]);
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const axis = v3.cross(this.frames[i - 1].tangent, tangents[i]);
        const axisLen = v3.len(axis);
        if (axisLen > 1e-6) {
          const angle = Math.acos(
            Math.max(-1, Math.min(1, v3.dot(this.frames[i - 1].tangent, tangents[i]))),
          );
          const ax = v3.scale(axis, 1 / axisLen);
          normal = rotateAround(normal, ax, angle);
        }
      }
      normal = v3.normalize(v3.sub(normal, v3.scale(tangents[i], v3.dot(normal, tangents[i]))));
      const binormal = v3.normalize(v3.cross(tangents[i], normal));
      this.frames.push({ tangent: tangents[i], normal, binormal });
    }
  }

  // 弧长 s -> 位置
  pointAt(s: number): Vec3 {
    const [i, t] = this.locate(s);
    return v3.lerp(this.points[i], this.points[i + 1], t);
  }

  tangentAt(s: number): Vec3 {
    const [i, t] = this.locate(s);
    return v3.normalize(v3.lerp(this.frames[i].tangent, this.frames[i + 1].tangent, t));
  }

  frameAt(s: number): { tangent: Vec3; normal: Vec3; binormal: Vec3 } {
    const [i, t] = this.locate(s);
    const a = this.frames[i], b = this.frames[i + 1];
    return {
      tangent: v3.normalize(v3.lerp(a.tangent, b.tangent, t)),
      normal: v3.normalize(v3.lerp(a.normal, b.normal, t)),
      binormal: v3.normalize(v3.lerp(a.binormal, b.binormal, t)),
    };
  }

  // 返回 [段索引, 段内插值 t]
  locate(s: number): [number, number] {
    const x = Math.max(0, Math.min(this.totalLen, s));
    let lo = 0, hi = this.cumLen.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumLen[mid] <= x) lo = mid;
      else hi = mid;
    }
    if (lo >= this.points.length - 1) return [this.points.length - 2, 1];
    const segLen = this.cumLen[lo + 1] - this.cumLen[lo] || 1;
    return [lo, (x - this.cumLen[lo]) / segLen];
  }

  // 点到中心线最近点：返回 {s, point, dist}
  project(p: Vec3): { s: number; point: Vec3; dist: number } {
    let best = { s: 0, point: v3.copy(this.points[0]), dist: Infinity };
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i], b = this.points[i + 1];
      const ab = v3.sub(b, a);
      const segLen2 = v3.dot(ab, ab) || 1e-9;
      const t = Math.max(0, Math.min(1, v3.dot(v3.sub(p, a), ab) / segLen2));
      const q = v3.lerp(a, b, t);
      const d = v3.dist(p, q);
      if (d < best.dist) {
        best = { s: this.cumLen[i] + Math.sqrt(segLen2) * t, point: q, dist: d };
      }
    }
    return best;
  }

  // 等弧长采样
  sampleStations(count: number): { s: number; point: Vec3; frame: Centerline['frames'][0] }[] {
    const out = [];
    for (let i = 0; i < count; i++) {
      const s = (this.totalLen * i) / (count - 1);
      out.push({ s, point: this.pointAt(s), frame: this.frameAt(s) });
    }
    return out;
  }

  // 累计转角（弧度）：相邻折线段切向夹角之和，衡量整体弯曲程度
  totalTurningAngle(): number {
    let sum = 0;
    for (let i = 0; i < this.points.length - 2; i++) {
      const t0 = v3.normalize(v3.sub(this.points[i + 1], this.points[i]));
      const t1 = v3.normalize(v3.sub(this.points[i + 2], this.points[i + 1]));
      sum += Math.acos(Math.max(-1, Math.min(1, v3.dot(t0, t1))));
    }
    return sum;
  }

  // 局部曲率（1/mm）：弧长 e 两侧切向夹角
  curvatureAt(s: number): number {
    const e = 0.5;
    const t0 = this.tangentAt(Math.max(0, s - e));
    const t1 = this.tangentAt(Math.min(this.totalLen, s + e));
    return Math.acos(Math.max(-1, Math.min(1, v3.dot(t0, t1)))) / (2 * e);
  }
}

function pickPerpendicular(t: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  return v3.normalize(v3.cross(t, ref));
}

function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dot = v3.dot(v, axis);
  const cross = v3.cross(axis, v);
  return v3.add(v3.add(v3.scale(v, c), v3.scale(cross, s)), v3.scale(axis, dot * (1 - c)));
}

// 中心线关键标记点（毫米弧长坐标）
export interface Landmark {
  aperture: number; // 耳道口
  firstBend: number; // 第一弯
  secondBend: number; // 第二弯
}

// 由曲率自动找两个弯。曲率常单调上升而无明显局部峰，
// 因此采用累积转角分段：第一弯、第二弯分别落在总转角约 1/3、2/3 所对应的弧长处，
// 并以高曲率区做修正。
export function detectBends(cl: Centerline): Landmark {
  const step = 0.25;
  const samples: { s: number; k: number }[] = [];
  for (let s = 1; s < cl.totalLen - 1; s += step) {
    samples.push({ s, k: cl.curvatureAt(s) });
  }
  // 平滑曲率
  const kSm = samples.map((_, i) => {
    const lo = Math.max(0, i - 2), hi = Math.min(samples.length, i + 3);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += samples[j].k;
    return sum / (hi - lo);
  });

  // 累积转角（曲率沿弧长积分）
  const cumTurn: number[] = new Array(samples.length);
  let acc = 0;
  for (let i = 0; i < samples.length; i++) {
    acc += kSm[i] * step;
    cumTurn[i] = acc;
  }
  const total = acc || 1;
  const sAtTurn = (ratio: number): number => {
    const target = total * ratio;
    for (let i = 0; i < cumTurn.length; i++) {
      if (cumTurn[i] >= target) return samples[i].s;
    }
    return samples[samples.length - 1].s;
  };

  const firstBend = Math.max(2, sAtTurn(1 / 3));
  const secondBend = Math.max(firstBend + 2, sAtTurn(2 / 3));
  return {
    aperture: 0,
    firstBend: Math.min(firstBend, cl.totalLen * 0.6),
    secondBend: Math.min(secondBend, cl.totalLen - 1),
  };
}
