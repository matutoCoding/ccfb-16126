import type { DesignRecord, ScanRecord, Vec3 } from '../types';
import type { SceneObject } from '../render/Renderer';
import { createBoxMesh, createSphereMesh } from '../geom/mesh';
import { mat4Compose } from '../math/vec';
import { createTubeMesh } from '../geom/pathgeom';
import { RadiusSampler, sectionCapMesh } from '../geom/shell';

const markerSphere = createSphereMesh(0.85, 14, 20);
const defectSphere = createSphereMesh(1, 14, 20);

export interface SceneBuildOptions {
  includeImpression?: boolean;
  includeMarkers?: boolean;
  includeDefects?: boolean;
  includeInternals?: boolean;
  forceOpaque?: boolean;
}

export function sectionClipPlane(scan: ScanRecord, design: DesignRecord) {
  const sampler = new RadiusSampler(scan);
  const t = design.params.sectionT;
  const f = sampler.frameAt(t);
  // Remove the lateral/concha side, retain the deep canal side.
  return { point: f.center, normal: f.tangent };
}

export function buildSceneObjects(scan: ScanRecord, design?: DesignRecord, options: SceneBuildOptions = {}): SceneObject[] {
  const objects: SceneObject[] = [];
  const styles = design?.layerStyles;
  const style = (id: string, fallbackColor: string, fallbackOpacity: number) =>
    styles?.[id] ?? { id, name: id, color: fallbackColor, opacity: fallbackOpacity, visible: true };

  if (options.includeImpression !== false) {
    const s = style('impression', '#cba6f7', design ? 0.16 : 0.72);
    if (s.visible) objects.push({
      id: 'impression', mesh: scan.mesh, color: s.color,
      opacity: options.forceOpaque ? 1 : s.opacity, unlit: false, heat: false
    });
  }

  if (design) {
    const shellStyle = style('shell', '#7dd3fc', 0.36);
    if (shellStyle.visible) objects.push({
      id: 'shell', mesh: design.shellMesh, color: shellStyle.color,
      opacity: options.forceOpaque ? 0.96 : shellStyle.opacity, heat: true, clip: true
    });

    if (design.params.sectionEnabled) {
      try {
        const sampler = new RadiusSampler(scan);
        const cap = sectionCapMesh(sampler, design.params.sectionT, design.actualWallMm ?? design.params.nominalWall, design.params.edgeRadius);
        const capStyle = style('sectionCap', '#f472b6', 0.94);
        if (capStyle.visible) objects.push({
          id: 'section-cap', mesh: cap, color: capStyle.color, opacity: capStyle.opacity,
          unlit: false, clip: false, heat: false
        });
      } catch (e) { console.warn(e); }
    }

    if (options.includeInternals !== false) for (const comp of design.components) {
      if (!comp.enabled) continue;
      const ls = style(comp.kind, comp.color, comp.opacity);
      if (!ls.visible) continue;
      objects.push({
        id: comp.id,
        mesh: createBoxMesh(comp.size),
        model: mat4Compose(comp.position, comp.rotationZ, [1, 1, 1]),
        color: ls.color,
        opacity: options.forceOpaque ? 0.96 : ls.opacity,
        heat: false,
        clip: false
      });
    }

    if (options.includeInternals !== false) for (const path of design.paths) {
      if (!path.enabled || path.points.length < 2) continue;
      const ls = style(path.kind, path.color, path.opacity);
      if (!ls.visible) continue;
      objects.push({
        id: path.id,
        mesh: createTubeMesh(path.points, path.diameter / 2, 18, true),
        color: ls.color,
        opacity: options.forceOpaque ? 0.96 : ls.opacity,
        heat: false,
        clip: false
      });
    }
  }

  if (options.includeMarkers !== false) {
    for (const lm of scan.landmarks) {
      const s = style('markers', '#f87171', 1);
      if (!s.visible) continue;
      objects.push({
        id: `marker-${lm.id}`,
        mesh: markerSphere,
        model: mat4Compose(lm.position, 0, [1, 1, 1]),
        color: lm.id === 'second-bend' ? '#ef4444' : lm.id === 'first-bend' ? '#f59e0b' : '#22c55e',
        opacity: 1,
        unlit: true,
        heat: false
      });
    }
  }

  if (options.includeDefects !== false) {
    for (const d of scan.defects) {
      objects.push({
        id: `defect-${d.id}`,
        mesh: defectSphere,
        model: mat4Compose(d.center, 0, [d.radius, d.radius, d.radius]),
        color: d.type === 'missing' ? '#a78bfa' : '#ef4444',
        opacity: 0.28,
        unlit: true,
        heat: false
      });
    }
  }

  return objects;
}

export function markerScreenRadius(): number { return 13; }

export async function captureThreeShots(scan: ScanRecord, design: DesignRecord): Promise<string[]> {
  const { WebGLRenderer } = await import('../render/Renderer');
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:-10000px;top:0;width:960px;height:640px;';
  document.body.appendChild(canvas);
  const renderer = new WebGLRenderer(canvas);
  canvas.style.width = '960px'; canvas.style.height = '640px';
  renderer.resize(1);
  const objects = buildSceneObjects(scan, design, { includeImpression: false, includeMarkers: false, includeDefects: false });
  const clip = design.params.sectionEnabled ? sectionClipPlane(scan, design) : null;
  const angles: Array<[number, number]> = [[0.38, 0.2], [2.35, 0.34], [0.85, 1.02]];
  const shots: string[] = [];
  for (const [yaw, pitch] of angles) {
    renderer.camera.target = [0, -2.2, -4];
    renderer.camera.distance = 96;
    renderer.camera.yaw = yaw;
    renderer.camera.pitch = pitch;
    renderer.camera.update();
    const shell = objects.find(o => o.id === 'shell');
    if (shell) renderer.computeShellLayers(shell, design.actualWallMm ?? 1, clip);
    renderer.renderTransparent(objects, { clipPlane: clip, heatTexture: renderer.heat, useHeat: false, background: '#08111f' });
    shots.push(renderer.dataURL());
  }
  const gl = renderer.gl;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.remove();
  return shots;
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename; a.click();
}

export type { Vec3 };
