import type { ShellSignature } from '../types';
import { cross, dot } from '../math/vec';
import type { MeshData, ScanRecord } from '../types';
import { RadiusSampler } from './shell';
import { meshBounds } from './mesh';

export function meshVolumeMm3(mesh: MeshData): number {
  const p = mesh.positions, idx = mesh.indices;
  let sum = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const v0 = [p[a], p[a + 1], p[a + 2]] as const;
    const v1 = [p[b], p[b + 1], p[b + 2]] as const;
    const v2 = [p[c], p[c + 1], p[c + 2]] as const;
    sum += dot(v0 as unknown as Parameters<typeof dot>[0], cross(v1 as unknown as Parameters<typeof cross>[0], v2 as unknown as Parameters<typeof cross>[0]));
  }
  return Math.abs(sum) / 6;
}

export function shellSignature(scan: ScanRecord, shell: MeshData): ShellSignature {
  const sampler = new RadiusSampler(scan);
  const opening = scan.landmarks.find(l => l.id === 'opening')?.t ?? 0.18;
  const first = scan.landmarks.find(l => l.id === 'first-bend')?.t ?? 0.4;
  const second = scan.landmarks.find(l => l.id === 'second-bend')?.t ?? 0.69;
  const d = (a: number, b: number) => Math.abs(sampler.lengthAtT(b) - sampler.lengthAtT(a));
  const t0 = sampler.frameAt(Math.max(0, second - 0.08)).tangent;
  const t1 = sampler.frameAt(Math.min(1, second + 0.08)).tangent;
  const bendAngle = Math.acos(Math.max(-1, Math.min(1, dot(t0, t1)))) * 180 / Math.PI;
  const bounds = meshBounds(shell);
  const maxWidth = Math.max(bounds.size[0], bounds.size[1]);
  return {
    lengthMm: Math.round(sampler.totalLength * 10) / 10,
    maxWidthMm: Math.round(maxWidth * 10) / 10,
    bendAngle: Math.round(bendAngle * 10) / 10,
    volumeMm3: Math.round(meshVolumeMm3(shell)),
    landmarkDistances: [Math.round(d(opening, first) * 10) / 10, Math.round(d(first, second) * 10) / 10]
  };
}
