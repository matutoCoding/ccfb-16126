// 全局领域类型：单位统一为毫米(mm)，坐标系 +Z 指向耳道内侧(第二弯方向)

export type Side = 'left' | 'right';
export type MoldType = 'fullConcha' | 'halfConcha' | 'canal' | 'cic';
export type ShellMaterial = 'hard' | 'softSilicone';
export type DeviceKind = 'customShell' | 'earmold';

export const MOLD_TYPE_LABEL: Record<MoldType, string> = {
  fullConcha: '全耳甲式',
  halfConcha: '半耳甲式',
  canal: '耳道式',
  cic: '深耳道式',
};

export interface AudiogramPoint {
  freqHz: number;
  dbHL: number;
}

export interface Audiogram {
  ac: AudiogramPoint[]; // 气导
  bc: AudiogramPoint[]; // 骨导
}

export interface Client {
  id: string;
  name: string;
  gender: '男' | '女' | '';
  age: number;
  phone: string;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 单耳病例：左右耳各自独立，复诊时新壳挂在同一 caseId 下 */
export interface EarCase {
  id: string;
  clientId: string;
  side: Side;
  deviceKind: DeviceKind;
  moldType: MoldType;
  model: string; // 机型
  audiogram: Audiogram;
  /** 历次设计（复诊新旧壳挂在一起），按时间排序 */
  designIds: string[];
  createdAt: number;
  updatedAt: number;
}

export type Vec3 = [number, number, number];

export interface Landmarks {
  /** 耳道口（面板块基准） */
  aperture: Vec3;
  /** 第一弯 */
  firstBend: Vec3;
  /** 第二弯 */
  secondBend: Vec3;
  /** 耳道中心线折线顶点，沿 +Z 向内 */
  centerline: Vec3[];
}

export interface DefectMark {
  id: string;
  kind: 'bubble' | 'missing';
  position: Vec3;
  radius: number;
  note: string;
}

export interface ScanRecord {
  id: string;
  caseId: string;
  side: Side;
  label: string;
  /** 印模三角网格（顶点+三角形索引），存 IndexedDB */
  mesh: MeshData;
  landmarks: Landmarks;
  defects: DefectMark[];
  source: 'generated' | 'stl';
  createdAt: number;
}

export interface MeshData {
  positions: Float32Array; // xyz 交错
  indices: Uint32Array;
}

export interface ShellParams {
  material: ShellMaterial;
  /** 壁厚 mm；硬壳下限 0.8，软硅胶下限 1.2 */
  wallThickness: number;
  /** 沿中心线截掉的长度（从最内侧算起保留到的站点比例 0..1） */
  trimStation: number;
  /** 截面边缘倒圆半径 mm */
  edgeFillet: number;
  ventDiameter: number; // 1..3 mm
  soundTubeDiameter: number;
}

export interface ShellDesign {
  id: string;
  caseId: string;
  side: Side;
  label: string;
  scanId: string;
  params: ShellParams;
  /** 生成后的壳体网格（含内腔的双层网格） */
  shellMesh: MeshData | null;
  layout: LayoutState;
  note: string;
  createdAt: number;
}

export type ComponentKind = 'receiver' | 'battery' | 'faceplate' | 'amplifier';

export interface PlacedComponent {
  id: string;
  kind: ComponentKind;
  label: string;
  /** 真实尺寸 mm：圆柱/盒体 */
  size: { radius?: number; length?: number; width?: number; height?: number; depth?: number };
  /** 中心点 */
  center: Vec3;
  /** 朝向（局部 +Z 轴方向） */
  axis: Vec3;
}

export interface LayoutState {
  components: PlacedComponent[];
  /** 声管路径折线（受话器出声面 -> 耳道内侧出声孔） */
  soundTubePath: Vec3[];
  /** 通气孔路径折线（面板 -> 内侧） */
  ventPath: Vec3[];
  /** 碰撞/干涉报警 */
  collisions: CollisionReport[];
}

export interface CollisionReport {
  id: string;
  kind: 'component-shell' | 'component-component' | 'tube-vent' | 'tube-component';
  message: string;
  position: Vec3;
  severity: 'error' | 'warning';
}

export interface FactoryOrder {
  id: string;
  designId: string;
  caseId: string;
  clientId: string;
  side: Side;
  material: ShellMaterial;
  color: string;
  ventDiameter: number;
  soundTubeLength: number;
  shellStl: string; // STL 文本
  /** 三张透视截图（dataURL） */
  snapshots: string[];
  createdAt: number;
}

export interface AppSettings {
  wallMinHard: number;       // 硬壳壁厚下限
  wallMinSoftSilicone: number;
  ventMin: number;
  ventMax: number;
  /** 深度剥离最大层数 */
  maxPeelLayers: number;
  /** 透视精度自检：允许色阶误差 */
  colorTolerance: number;
  /** 壁厚 GPU/CPU 允许误差 mm */
  thicknessTolerance: number;
  layerDefaults: Record<LayerId, { alpha: number; color: Vec3 }>;
}

export type LayerId = 'shell' | 'tube' | 'vent' | 'receiver' | 'battery' | 'faceplate' | 'amplifier';

export interface LayerStyle {
  id: LayerId;
  label: string;
  visible: boolean;
  alpha: number;
  color: Vec3;
}
