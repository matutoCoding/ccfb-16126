import type { CollisionIssue, LayoutComponent, TubePath, Vec3 } from '../types';
import { cross, dot, sub } from '../math/vec';
import { samplePath } from './pathgeom';
import type { RadiusSampler } from './shell';

export function defaultComponents(): LayoutComponent[] {
  return [
    {
      id: 'receiver-1', kind: 'receiver', name: '受话器 (6.2×4.0×3.4 mm)',
      size: [3.4, 4.0, 6.2], position: [3.4, -2.6, 1.5], rotationZ: -0.18,
      color: '#38bdf8', opacity: 0.72, enabled: true
    },
    {
      id: 'battery-1', kind: 'battery', name: 'A10 电池仓 (⌀5.8×3.6)',
      size: [6.4, 6.4, 4.2], position: [-4.2, -0.8, 12.2], rotationZ: 0.12,
      color: '#fbbf24', opacity: 0.68, enabled: true
    },
    {
      id: 'amp-1', kind: 'amplifier', name: '放大器芯片 (3.6×3.6×1.2)',
      size: [3.8, 3.8, 1.3], position: [4.6, 1.4, 11.0], rotationZ: 0.35,
      color: '#a78bfa', opacity: 0.72, enabled: true
    },
    {
      id: 'plate-1', kind: 'faceplate', name: '面板 (20×14×1.4 mm)',
      size: [20, 14, 1.4], position: [0, 1.2, 18.2], rotationZ: 0,
      color: '#e2e8f0', opacity: 0.42, enabled: true
    }
  ];
}

export function defaultPaths(): TubePath[] {
  return [
    {
      id: 'sound-1', kind: 'sound', name: '声管',
      points: [[3.5, -2.6, 4.2], [3.8, -3.2, -2], [-0.5, -4.2, -10], [-2.2, -3.2, -18]],
      diameter: 1.9, color: '#22c55e', opacity: 0.72, enabled: true
    },
    {
      id: 'vent-1', kind: 'vent', name: '通气孔',
      points: [[-1.2, 1.2, 18.5], [-0.5, 0.2, 11], [1.2, -1.2, 3], [1.0, -2.8, -8], [-1.4, -3.8, -17]],
      diameter: 1.6, color: '#f97316', opacity: 0.62, enabled: true
    }
  ];
}

interface OBB { center: Vec3; half: Vec3; axes: [Vec3, Vec3, Vec3] }

export function componentOBB(c: LayoutComponent): OBB {
  const rz = c.rotationZ;
  const cos = Math.cos(rz), sin = Math.sin(rz);
  return {
    center: c.position,
    half: [c.size[0] / 2, c.size[1] / 2, c.size[2] / 2],
    axes: [[cos, sin, 0], [-sin, cos, 0], [0, 0, 1]]
  };
}

function obbVertices(b: OBB): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    out.push([
      b.center[0] + b.axes[0][0] * b.half[0] * x + b.axes[1][0] * b.half[1] * y + b.axes[2][0] * b.half[2] * z,
      b.center[1] + b.axes[0][1] * b.half[0] * x + b.axes[1][1] * b.half[1] * y + b.axes[2][1] * b.half[2] * z,
      b.center[2] + b.axes[0][2] * b.half[0] * x + b.axes[1][2] * b.half[1] * y + b.axes[2][2] * b.half[2] * z
    ]);
  }
  return out;
}

export function pointOBBDistance(p: Vec3, box: LayoutComponent): { distance: number; local: Vec3; closest: Vec3 } {
  const o = componentOBB(box);
  const d = sub(p, o.center);
  const local: Vec3 = [dot(d, o.axes[0]), dot(d, o.axes[1]), dot(d, o.axes[2])];
  const clamped: Vec3 = [
    Math.max(-o.half[0], Math.min(o.half[0], local[0])),
    Math.max(-o.half[1], Math.min(o.half[1], local[1])),
    Math.max(-o.half[2], Math.min(o.half[2], local[2]))
  ];
  const delta: Vec3 = [local[0] - clamped[0], local[1] - clamped[1], local[2] - clamped[2]];
  const distance = Math.hypot(...delta);
  const closest: Vec3 = [
    o.center[0] + o.axes[0][0] * clamped[0] + o.axes[1][0] * clamped[1] + o.axes[2][0] * clamped[2],
    o.center[1] + o.axes[0][1] * clamped[0] + o.axes[1][1] * clamped[1] + o.axes[2][1] * clamped[2],
    o.center[2] + o.axes[0][2] * clamped[0] + o.axes[1][2] * clamped[1] + o.axes[2][2] * clamped[2]
  ];
  return { distance, local, closest };
}

function obbOverlap(a: LayoutComponent, b: LayoutComponent): boolean {
  const A = componentOBB(a), B = componentOBB(b);
  const axes: Vec3[] = [...A.axes, ...B.axes];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) axes.push(cross(A.axes[i], B.axes[j]));
  const da = sub(B.center, A.center);
  for (const axisRaw of axes) {
    const l = Math.hypot(...axisRaw);
    if (l < 1e-6) continue;
    const axis: Vec3 = [axisRaw[0] / l, axisRaw[1] / l, axisRaw[2] / l];
    const distCenter = Math.abs(dot(da, axis));
    const ra = A.half[0] * Math.abs(dot(A.axes[0], axis)) + A.half[1] * Math.abs(dot(A.axes[1], axis)) + A.half[2] * Math.abs(dot(A.axes[2], axis));
    const rb = B.half[0] * Math.abs(dot(B.axes[0], axis)) + B.half[1] * Math.abs(dot(B.axes[1], axis)) + B.half[2] * Math.abs(dot(B.axes[2], axis));
    if (distCenter > ra + rb) return false;
  }
  return true;
}

export function checkCollisions(components: LayoutComponent[], paths: TubePath[], sampler?: RadiusSampler): CollisionIssue[] {
  const issues: CollisionIssue[] = [];
  const enabledComponents = components.filter(c => c.enabled);
  for (let i = 0; i < enabledComponents.length; i++) {
    for (let j = i + 1; j < enabledComponents.length; j++) {
      const a = enabledComponents[i], b = enabledComponents[j];
      if (obbOverlap(a, b)) {
        issues.push({
          id: `comp-${a.id}-${b.id}`, severity: 'error',
          message: `${a.name} 与 ${b.name} 实体干涉`,
          position: [(a.position[0] + b.position[0]) / 2, (a.position[1] + b.position[1]) / 2, (a.position[2] + b.position[2]) / 2],
          distance: 0
        });
      }
    }
  }

  for (const path of paths.filter(p => p.enabled)) {
    const radius = path.diameter / 2;
    const samples = samplePath(path.points, 80);
    for (const comp of enabledComponents) {
      let minDist = Infinity;
      let pos: Vec3 = samples[0] ?? [0, 0, 0];
      for (const p of samples) {
        const d = pointOBBDistance(p, comp).distance;
        if (d < minDist) { minDist = d; pos = p; }
      }
      if (minDist < radius + 0.15) {
        issues.push({
          id: `path-${path.id}-${comp.id}`,
          severity: minDist < radius ? 'error' : 'warning',
          message: `${path.name}（⌀${path.diameter.toFixed(1)}）${minDist < radius ? '穿过' : '贴近'}${comp.name}，净距 ${Math.max(0, minDist - radius).toFixed(2)} mm`,
          position: pos,
          distance: minDist
        });
      }
    }
  }

  if (sampler) {
    // Approximate shell envelope check for component bounding-box corners.
    for (const comp of enabledComponents) {
      for (const p of obbVertices(componentOBB(comp))) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < sampler.centerline.length; i++) {
          const d = (sampler.centerline[i][0] - p[0]) ** 2 + (sampler.centerline[i][1] - p[1]) ** 2 + (sampler.centerline[i][2] - p[2]) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
        const t = best / (sampler.centerline.length - 1);
        if (t < 0.02 || t > 0.82) continue;
        const r = sampler.radiiAt(t);
        const f = sampler.frameAt(t);
        const delta = sub(p, f.center);
        const x = dot(delta, f.normal) / r.rx;
        const y = dot(delta, f.binormal) / r.ry;
        if (x * x + y * y > 0.82 * 0.82) {
          issues.push({
            id: `shell-${comp.id}`, severity: 'warning',
            message: `${comp.name} 可能贴近/顶到外壳内壁`,
            position: p, distance: Math.sqrt(x * x + y * y)
          });
          break;
        }
      }
    }
  }
  return issues;
}
