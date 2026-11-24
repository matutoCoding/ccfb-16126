/** 设计稿编排：默认器件/管路布局、壳体再生成、版本管理 */
import { EarImpression, ShellDesign, ShellMaterial, ShellStyle, VentSpec, SoundTubeSpec, MIN_WALL } from './core/types';
import { generateShell, GeneratedShell } from './core/shellgen';
import { Mesh, makeSweptTube, computeVertexNormals } from './core/geometry';
import { Vec3, add3, dist3, lerp3 } from './core/math';
import { COMPONENT_LIBRARY, instantiateComponent } from './core/components';
import { uid } from './core/db';

export function impressionToMesh(im: EarImpression): Mesh {
  const mesh: Mesh = {
    positions: Float32Array.from(im.meshData.positions),
    normals: new Float32Array(im.meshData.positions.length),
    indices: Uint32Array.from(im.meshData.indices),
  };
  computeVertexNormals(mesh);
  return mesh;
}

/** 默认设计：沿中心线布受话器/电池/面板/芯片 + 通气孔/声管路径 */
export function createDefaultDesign(
  customerId: string,
  im: EarImpression,
  style: ShellStyle,
  material: ShellMaterial,
): ShellDesign {
  const cl = im.centerline;
  const at = (t: number): Vec3 => {
    const f = Math.max(0, Math.min(1, t)) * (cl.length - 1);
    return lerp3(cl[Math.floor(f)], cl[Math.min(cl.length - 1, Math.ceil(f))], f - Math.floor(f));
  };
  void style;
  const devices = [
    instantiateComponent(COMPONENT_LIBRARY[0], at(0.55)), // 受话器
    instantiateComponent(COMPONENT_LIBRARY[2], at(0.3)),  // 电池仓 10A
    instantiateComponent(COMPONENT_LIBRARY[5], at(0.06)), // 面板
    instantiateComponent(COMPONENT_LIBRARY[7], at(0.4)),  // 放大器
  ];

  const vent: VentSpec = {
    diameterMm: 1.6,
    path: [0.12, 0.3, 0.5, 0.7, 0.85].map((t) => add3(at(t), [0.8, 0, 0.5])),
  };
  const soundTube: SoundTubeSpec = {
    diameterMm: 1.2,
    path: [0.15, 0.35, 0.55, 0.75, 0.92].map((t) => add3(at(t), [-0.7, 0, -0.4])),
  };

  return {
    id: uid('design'),
    customerId,
    side: im.side,
    impressionId: im.id,
    createdAt: Date.now(),
    version: 1,
    wallThickness: material === 'silicone' ? MIN_WALL.silicone + 0.2 : MIN_WALL.hard + 0.25,
    material,
    trimPosition: 0.9,
    edgeRadius: 0.4,
    vent,
    soundTube,
    devices,
    color: '#e8b48f',
    notes: '',
  };
}

export function buildShellWithStyle(im: EarImpression, design: ShellDesign, style: ShellStyle): GeneratedShell {
  const mesh = impressionToMesh(im);
  return generateShell(mesh, im.centerline, {
    wallThickness: design.wallThickness,
    trimPosition: design.trimPosition,
    edgeRadius: design.edgeRadius,
    shellStyle: style,
  });
}

/** 声管长度（mm，订单字段） */
export function tubeLength(spec: SoundTubeSpec | null): number {
  if (!spec) return 0;
  let total = 0;
  for (let i = 1; i < spec.path.length; i++) total += dist3(spec.path[i - 1], spec.path[i]);
  return total;
}

/** 通气孔网格（导出/校验用） */
export function ventMesh(spec: VentSpec | null): Mesh | null {
  if (!spec) return null;
  return makeSweptTube(spec.path, spec.diameterMm / 2, 14, true, true);
}

export function clampVent(d: number): number {
  return Math.max(1, Math.min(3, d));
}
