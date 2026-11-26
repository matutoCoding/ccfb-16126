export type Vec3 = [number, number, number];
export type EarSide = 'left' | 'right';
export type MoldType = 'full-concha' | 'half-concha' | 'canal' | 'deep-canal';
export type MaterialType = 'hard-acrylic' | 'soft-silicone';
export type ScanVariant = 'normal' | 'narrow' | 'sharp-bend' | 'bubble-damage' | 'imported';
export type PageKey = 'clients' | 'scan' | 'shell' | 'layout' | 'perspective' | 'settings';

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  /** Optional per-vertex surface classification: 0 outer impression, 1 inner wall, 2 cut/cap, 3 defect. */
  surface?: Uint8Array;
}

export interface Landmark {
  id: 'opening' | 'first-bend' | 'second-bend' | 'tip' | string;
  name: string;
  position: Vec3;
  t?: number;
  editable: boolean;
}

export interface DefectMark {
  id: string;
  type: 'bubble' | 'missing';
  center: Vec3;
  radius: number;
  depth: number;
  note: string;
}

export interface Audiogram {
  frequencies: number[];
  left: (number | null)[];
  right: (number | null)[];
}

export interface EarProfile {
  side: EarSide;
  audiogram: Audiogram;
  deviceModel: string;
  moldType: MoldType;
  scanId?: string;
  designId?: string;
  orderIds: string[];
  note: string;
}

export interface ClientRecord {
  id: string;
  name: string;
  phone: string;
  age?: number;
  createdAt: number;
  updatedAt: number;
  left: EarProfile;
  right: EarProfile;
  history: ShellHistoryEntry[];
}

export interface ShellHistoryEntry {
  id: string;
  date: number;
  side: EarSide;
  orderId?: string;
  designId?: string;
  version: number;
  issue?: string;
  note?: string;
}

export interface ScanRecord {
  id: string;
  clientId?: string;
  side?: EarSide;
  name: string;
  variant: ScanVariant;
  createdAt: number;
  mesh: MeshData;
  landmarks: Landmark[];
  defects: DefectMark[];
  centerline: Vec3[];
  stl?: ArrayBuffer;
}

export interface ShellParams {
  moldType: MoldType;
  material: MaterialType;
  nominalWall: number;
  trimMmFromTip: number;
  edgeRadius: number;
  ventDiameter: number;
  soundTubeDiameter: number;
  sectionT: number;
  sectionEnabled: boolean;
}

export interface LayoutComponent {
  id: string;
  kind: 'receiver' | 'battery' | 'amplifier' | 'faceplate';
  name: string;
  size: Vec3;
  position: Vec3;
  rotationZ: number;
  color: string;
  opacity: number;
  enabled: boolean;
}

export interface TubePath {
  id: string;
  kind: 'sound' | 'vent';
  name: string;
  points: Vec3[];
  diameter: number;
  color: string;
  opacity: number;
  enabled: boolean;
}

export interface CollisionIssue {
  id: string;
  severity: 'error' | 'warning';
  message: string;
  position: Vec3;
  distance: number;
}

export interface InsertionCheck {
  pass: boolean;
  minClearance: number;
  stuckT?: number;
  stuckPosition?: Vec3;
  suggestedTrimMm: number;
  samples: { t: number; clearance: number; x: number; y: number; z: number }[];
}

export interface LayerStyle {
  id: string;
  name: string;
  color: string;
  opacity: number;
  visible: boolean;
}

export interface DesignRecord {
  id: string;
  clientId?: string;
  side?: EarSide;
  scanId: string;
  createdAt: number;
  updatedAt: number;
  params: ShellParams;
  shellMesh: MeshData;
  actualWallMm?: number;
  tStart?: number;
  tEnd?: number;
  components: LayoutComponent[];
  paths: TubePath[];
  collisions: CollisionIssue[];
  insertion?: InsertionCheck;
  layerStyles: Record<string, LayerStyle>;
}

export interface FactoryOrder {
  id: string;
  clientId: string;
  side: EarSide;
  designId: string;
  createdAt: number;
  material: MaterialType;
  color: string;
  ventDiameter: number;
  soundTubeLength: number;
  stl: Blob;
  screenshots: string[];
  note: string;
  shellSignature?: ShellSignature;
}

export interface ShellSignature {
  lengthMm: number;
  maxWidthMm: number;
  bendAngle: number;
  volumeMm3: number;
  landmarkDistances: number[];
}

export interface SettingsRecord {
  id: 'app';
  rendererScale: number;
  maxPeelLayers: number;
  heatmapEnabled: boolean;
  strictVerification: boolean;
}

export interface VerifyResult {
  name: string;
  pass: boolean;
  maxChannelError?: number;
  tolerance?: number;
  maxThicknessErrorMm?: number;
  samples?: number;
  message: string;
  details?: unknown;
}
