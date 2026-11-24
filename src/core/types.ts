/** 领域模型类型定义（同时是 IndexedDB 持久化结构） */
import type { Vec3 } from './math';

export type Side = 'left' | 'right';
export type ShellStyle = 'full-concha' | 'half-concha' | 'canal' | 'CIC';
export type ShellMaterial = 'hard' | 'silicone';
export type DeviceKind = 'receiver' | 'battery' | 'faceplate' | 'amplifier';

export const SHELL_STYLE_LABEL: Record<ShellStyle, string> = {
  'full-concha': '全耳甲式',
  'half-concha': '半耳甲式',
  canal: '耳道式',
  CIC: '深耳道式',
};

export const MATERIAL_LABEL: Record<ShellMaterial, string> = {
  hard: '硬壳（亚克力）',
  silicone: '软硅胶',
};

/** 壁厚下限（mm），按需求 3：硬壳与软硅胶不同 */
export const MIN_WALL: Record<ShellMaterial, number> = {
  hard: 0.6,
  silicone: 0.9,
};

export interface AudiogramPoint {
  freqHz: number;
  db: number; // 听力级 dB HL
}

export interface EarRecord {
  side: Side;
  audiogram: AudiogramPoint[];
  shellStyle: ShellStyle;
  material: ShellMaterial;
  /** 关联的印模 id */
  impressionId?: string;
  /** 关联的当前设计 id */
  designId?: string;
  /** 历次壳体版本（复诊新旧壳挂在一起） */
  designHistory: string[];
  notes: string;
}

export interface Customer {
  id: string;
  name: string;
  age: number;
  gender: string;
  phone: string;
  createdAt: number;
  updatedAt: number;
  ears: Record<Side, EarRecord>;
  tags: string[];
}

/** 印模解剖标记点（可手动拖动） */
export interface AnnoMarker {
  id: string;
  kind: 'canal-mouth' | 'first-bend' | 'second-bend' | 'defect' | 'bubble';
  position: Vec3;
  /** 缺陷半径（mm），气泡/缺损用 */
  radius?: number;
  label?: string;
}

export interface EarImpression {
  id: string;
  customerId: string;
  side: Side;
  createdAt: number;
  /** 三角网格（positions 交错 xyz，indices 三角索引） */
  meshData: { positions: number[]; indices: number[] };
  /** 中心线（耳道口 → 第二弯方向），等弧长采样 */
  centerline: Vec3[];
  markers: AnnoMarker[];
  /** 中心线各站的耳道半径（mm） */
  canalRadii: number[];
  source: 'imported-stl' | 'synthetic';
  syntheticKind?: SyntheticKind;
}

export type SyntheticKind = 'normal' | 'narrow' | 'sharp-bend' | 'bubble-defect';

export const SYNTHETIC_LABEL: Record<SyntheticKind, string> = {
  normal: '正常印模',
  narrow: '耳道特别窄',
  'sharp-bend': '第二弯很急',
  'bubble-defect': '带气泡缺损',
};

/** 内部器件实例（真实尺寸，mm） */
export interface DeviceInstance {
  id: string;
  kind: DeviceKind;
  name: string;
  /** 中心位置（设计局部坐标，即印模坐标） */
  position: Vec3;
  /** 欧拉旋转（弧度，yxz 顺序仅用于 UI 显示，渲染直接用矩阵） */
  rotation: Vec3;
  /** 尺寸（半长或全尺寸，按 kind 约定，见 components 库） */
  size: Vec3;
  color: [number, number, number];
}

export interface VentSpec {
  /** 通气孔中心线采样点 */
  path: Vec3[];
  /** 直径 1..3 mm 可调 */
  diameterMm: number;
}

export interface SoundTubeSpec {
  path: Vec3[];
  diameterMm: number;
}

export interface ShellDesign {
  id: string;
  customerId: string;
  side: Side;
  impressionId: string;
  createdAt: number;
  version: number;
  wallThickness: number;
  material: ShellMaterial;
  /** 沿中心线截短位置：0..1（1 = 保留到印模末端） */
  trimPosition: number;
  /** 截面边缘倒圆半径 mm */
  edgeRadius: number;
  vent: VentSpec | null;
  soundTube: SoundTubeSpec | null;
  devices: DeviceInstance[];
  /** 工厂订单颜色 */
  color: string;
  notes: string;
}

export interface FactoryOrder {
  id: string;
  designId: string;
  customerId: string;
  side: Side;
  createdAt: number;
  color: string;
  ventDiameterMm: number;
  soundTubeLengthMm: number;
  /** 三张透视截图（dataURL） */
  snapshots: string[];
  /** 壳体 STL（二进制，持久化时存 ArrayBuffer） */
  shellStl?: ArrayBuffer;
  orderNo: string;
}

export interface AppSettings {
  id: 'singleton';
  hardMinWall: number;
  siliconeMinWall: number;
  defaultColor: string;
  palette: Record<string, [number, number, number]>;
  /** A-buffer 每像素最大节点数 */
  abufferMaxNodes: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  id: 'singleton',
  hardMinWall: MIN_WALL.hard,
  siliconeMinWall: MIN_WALL.silicone,
  defaultColor: '#e8b48f',
  palette: {
    shell: [0.91, 0.71, 0.56],
    tube: [0.2, 0.6, 0.95],
    vent: [0.3, 0.9, 0.55],
    receiver: [0.95, 0.35, 0.3],
    battery: [0.95, 0.75, 0.2],
    faceplate: [0.75, 0.75, 0.8],
    amplifier: [0.55, 0.4, 0.9],
  },
  abufferMaxNodes: 96,
};
