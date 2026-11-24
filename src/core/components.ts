/** 内部器件库：受话器 / 电池仓 / 面板 / 放大器芯片，真实尺寸 mm */
import { DeviceInstance } from './types';
import { Vec3 } from './math';

export interface ComponentDef {
  kind: DeviceInstance['kind'];
  name: string;
  size: Vec3; // 全尺寸 mm
  color: [number, number, number];
}

export const COMPONENT_LIBRARY: ComponentDef[] = [
  { kind: 'receiver', name: '受话器 600 系列', size: [3.4, 5.2, 3.4], color: [0.95, 0.35, 0.3] },
  { kind: 'receiver', name: '受话器 800 系列', size: [4.0, 6.4, 4.0], color: [0.9, 0.25, 0.2] },
  { kind: 'battery', name: '电池仓 10A', size: [5.8, 3.6, 3.6], color: [0.95, 0.75, 0.2] },
  { kind: 'battery', name: '电池仓 312', size: [7.9, 3.6, 3.6], color: [0.9, 0.65, 0.15] },
  { kind: 'battery', name: '电池仓 13', size: [7.9, 5.4, 5.4], color: [0.85, 0.6, 0.1] },
  { kind: 'faceplate', name: '面板（全耳甲）', size: [13, 1.2, 10], color: [0.75, 0.75, 0.8] },
  { kind: 'faceplate', name: '面板（耳道式）', size: [8, 1.0, 7], color: [0.7, 0.7, 0.78] },
  { kind: 'amplifier', name: '放大器芯片', size: [4.2, 0.9, 2.8], color: [0.55, 0.4, 0.9] },
  { kind: 'amplifier', name: '放大器芯片（小型）', size: [3.2, 0.7, 2.2], color: [0.45, 0.3, 0.8] },
];

let seq = 0;
export function instantiateComponent(def: ComponentDef, position: Vec3): DeviceInstance {
  seq += 1;
  return {
    id: `dev-${Date.now().toString(36)}-${seq}`,
    kind: def.kind,
    name: def.name,
    position,
    rotation: [0, 0, 0],
    size: def.size,
    color: def.color,
  };
}
