/**
 * 把设计稿装配成渲染场景：壳体 / 器件 / 声管 / 通气孔 / 标记点 / 截面封口。
 */
import { Mesh, makeBox, makeCylinder, makeEllipsoid, makeSweptTube } from '../core/geometry';
import { Mat4, Vec3, add3, identity4, multiply4, scale3, sub3, translate4 } from '../core/math';
import { rotateEuler } from './transform';
import {
  DeviceInstance, EarImpression, ShellDesign, SoundTubeSpec, VentSpec,
} from '../core/types';
import { GeneratedShell } from '../core/shellgen';
import { LayerTag } from './GLRenderer';

export interface SceneItem {
  mesh: Mesh;
  model: Mat4;
  tag: LayerTag;
  color: [number, number, number];
  alpha: number;
  label: string;
}

/** 器件盒体（局部原点在中心），返回的 model 把它放到位姿 */
export function deviceMesh(d: DeviceInstance): { mesh: Mesh; model: Mat4 } {
  const mesh = d.kind === 'receiver'
    ? makeCylinder([0, -d.size[1] / 2, 0], [0, d.size[1] / 2, 0], d.size[0] / 2, 22)
    : d.kind === 'battery'
      ? makeCylinder([0, -d.size[1] / 2, 0], [0, d.size[1] / 2, 0], d.size[0] / 2, 22)
      : makeBox([0, 0, 0], d.size);
  const model = multiply4(translate4(d.position[0], d.position[1], d.position[2]), rotateEuler(d.rotation));
  return { mesh, model };
}

/** 截面封口圆盘（切开后防止看成空心），在 clip 点处沿法线填一个着色圆片 */
export function sectionCapMesh(center: Vec3, normal: Vec3, radius: number): Mesh {
  // 用一个扁椭球近似封口圆片，视觉上是着色的实心截面
  const n = normal;
  const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  void ref;
  return makeEllipsoid(center, [radius, radius, radius], 16, 24);
}

export function buildScene(
  shell: GeneratedShell | null,
  design: ShellDesign | null,
  impression: EarImpression | null,
  showImpression: boolean,
): SceneItem[] {
  const items: SceneItem[] = [];
  if (showImpression && impression) {
    items.push({
      mesh: {
        positions: Float32Array.from(impression.meshData.positions),
        normals: new Float32Array(impression.meshData.positions.length),
        indices: Uint32Array.from(impression.meshData.indices),
      },
      model: identity4(),
      tag: 'impression',
      color: [0.85, 0.78, 0.68],
      alpha: 0.18,
      label: '耳印模',
    });
  }
  if (shell && design) {
    items.push({
      mesh: shell.mesh,
      model: identity4(),
      tag: 'shell',
      color: hexToRgb01(design.color),
      alpha: 0.32,
      label: '外壳',
    });
    for (const d of design.devices) {
      const dm = deviceMesh(d);
      items.push({ mesh: dm.mesh, model: dm.model, tag: 'device', color: d.color, alpha: 0.72, label: d.name });
    }
    if (design.soundTube) {
      items.push(tubeItem(design.soundTube, 'tube', [0.2, 0.6, 0.95], '声管'));
    }
    if (design.vent) {
      items.push(tubeItem(design.vent, 'vent', [0.3, 0.9, 0.55], '通气孔'));
    }
  }
  return items;
}

function tubeItem(spec: VentSpec | SoundTubeSpec, tag: LayerTag, color: [number, number, number], label: string): SceneItem {
  const mesh = makeSweptTube(spec.path, spec.diameterMm / 2, 16, true, true);
  return { mesh, model: identity4(), tag, color, alpha: 0.6, label };
}

export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 标记点小球 */
export function markerMesh(center: Vec3, radius: number, color: [number, number, number]): SceneItem {
  return {
    mesh: makeEllipsoid(center, [radius, radius, radius], 12, 18),
    model: identity4(),
    tag: 'marker',
    color,
    alpha: 0.95,
    label: '标记',
  };
}

export function centerOfBounds(points: Vec3[]): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[k]);
    max[k] = Math.max(max[k], p[k]);
  }
  return scale3(add3(min, max), 0.5);
}

export function boundsRadius(points: Vec3[], center: Vec3): number {
  let r = 0;
  for (const p of points) r = Math.max(r, Math.hypot(...sub3(p, center)));
  return r;
}
