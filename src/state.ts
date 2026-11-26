import type { AppState } from './app-types';
import type { DesignRecord, LayerStyle, ScanRecord } from './types';
import { db, uid } from './db';
import { buildShellMesh, defaultShellParams, RadiusSampler } from './geom/shell';
import { checkCollisions, defaultComponents, defaultPaths } from './geom/layout';
import { checkInsertion } from './geom/insertion';

export function defaultLayerStyles(): Record<string, LayerStyle> {
  return {
    impression: { id: 'impression', name: '耳印模', color: '#cba6f7', opacity: 0.28, visible: true },
    shell: { id: 'shell', name: '外壳/壁厚', color: '#7dd3fc', opacity: 0.34, visible: true },
    receiver: { id: 'receiver', name: '受话器', color: '#38bdf8', opacity: 0.78, visible: true },
    battery: { id: 'battery', name: '电池仓', color: '#fbbf24', opacity: 0.72, visible: true },
    amplifier: { id: 'amplifier', name: '放大器芯片', color: '#a78bfa', opacity: 0.78, visible: true },
    faceplate: { id: 'faceplate', name: '面板', color: '#e2e8f0', opacity: 0.38, visible: true },
    sound: { id: 'sound', name: '声管', color: '#22c55e', opacity: 0.76, visible: true },
    vent: { id: 'vent', name: '通气孔', color: '#fb923c', opacity: 0.66, visible: true },
    sectionCap: { id: 'sectionCap', name: '切口封层面', color: '#f472b6', opacity: 0.92, visible: true },
    markers: { id: 'markers', name: '弯道标记', color: '#f87171', opacity: 1, visible: true }
  };
}

export function createDesign(scan: ScanRecord, clientId?: string, side?: 'left' | 'right'): DesignRecord {
  const params = defaultShellParams(scan.variant === 'imported' ? 'canal' : 'full-concha', 'hard-acrylic');
  if (side === 'right') params.moldType = 'deep-canal';
  if (scan.variant === 'narrow') params.nominalWall = 1.05;
  const built = buildShellMesh(scan, params);
  const components = defaultComponents();
  const paths = defaultPaths();
  const collisions = checkCollisions(components, paths, built.sampler);
  const insertion = checkInsertion(scan, params, built.sampler);
  const now = Date.now();
  return {
    id: uid('design'), clientId, side, scanId: scan.id, createdAt: now, updatedAt: now,
    params, shellMesh: built.mesh, actualWallMm: built.actualWall, tStart: built.tStart, tEnd: built.tEnd,
    components, paths, collisions, insertion,
    layerStyles: defaultLayerStyles()
  };
}

export function rebuildDesign(design: DesignRecord, scan: ScanRecord): DesignRecord {
  const built = buildShellMesh(scan, design.params);
  design.shellMesh = built.mesh;
  design.actualWallMm = built.actualWall;
  design.tStart = built.tStart;
  design.tEnd = built.tEnd;
  design.collisions = checkCollisions(design.components, design.paths, built.sampler);
  design.insertion = checkInsertion(scan, design.params, built.sampler);
  design.updatedAt = Date.now();
  return design;
}

export async function loadState(): Promise<AppState> {
  const [clients, scans, designs, orders, settings] = await Promise.all([
    db.clients.all(), db.scans.all(), db.designs.all(), db.orders.all(), db.settings.get()
  ]);
  scans.sort((a, b) => a.createdAt - b.createdAt);
  const firstScan = scans[0];
  let currentDesign = designs.find(d => d.scanId === firstScan?.id) ?? designs[0];
  if (!currentDesign && firstScan) {
    currentDesign = createDesign(firstScan, clients[0]?.id, 'right');
    await db.designs.save(currentDesign);
  }
  return {
    page: 'clients',
    clients: clients.sort((a, b) => b.updatedAt - a.updatedAt),
    scans,
    designs,
    orders: orders.sort((a, b) => b.createdAt - a.createdAt),
    settings,
    currentScanId: firstScan?.id,
    currentClientId: clients[0]?.id,
    currentDesignId: currentDesign?.id,
    toast: ''
  };
}

export function getCurrentScan(state: AppState): ScanRecord | undefined {
  return state.scans.find(s => s.id === state.currentScanId) ?? state.scans[0];
}

export function getCurrentDesign(state: AppState): DesignRecord | undefined {
  const scan = getCurrentScan(state);
  if (!scan) return undefined;
  let d = state.designs.find(x => x.id === state.currentDesignId && x.scanId === scan.id)
    ?? state.designs.find(x => x.scanId === scan.id);
  if (!d) {
    d = createDesign(scan, state.currentClientId);
    state.designs.push(d);
  }
  state.currentDesignId = d.id;
  void db.designs.save(d);
  return d;
}

export async function persistDesign(design: DesignRecord) {
  design.updatedAt = Date.now();
  await db.designs.save(design);
}

export function samplerFor(scan: ScanRecord): RadiusSampler {
  return new RadiusSampler(scan);
}
