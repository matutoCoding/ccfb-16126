import { describe, expect, it } from 'vitest';
import { generateImpression } from '../src/geom/procedural';
import { buildShellMesh, defaultShellParams, WALL_LIMITS } from '../src/geom/shell';
import { parseSTL, writeBinarySTL } from '../src/geom/stl';
import { checkCollisions } from '../src/geom/layout';
import { checkInsertion } from '../src/geom/insertion';
import { pairWallSegments } from '../src/geom/raycast';
import type { LayoutComponent, ScanRecord } from '../src/types';

function scan(variant: Parameters<typeof generateImpression>[0]): ScanRecord {
  return { id: variant, name: variant, variant, createdAt: 0, ...generateImpression(variant) };
}

function boundaryEdgeCount(indices: Uint32Array): number {
  const counts = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[i + e], b = indices[i + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.values()].filter(n => n === 1).length;
}

describe('procedural ear impressions', () => {
  it('creates four distinct test molds with landmarks and defects', () => {
    const variants = ['normal', 'narrow', 'sharp-bend', 'bubble-damage'] as const;
    for (const v of variants) {
      const s = scan(v);
      expect(s.mesh.indices.length).toBeGreaterThan(5000);
      expect(s.landmarks.map(l => l.id)).toContain('second-bend');
      expect(s.centerline.length).toBeGreaterThan(20);
      if (v === 'bubble-damage') expect(s.defects.length).toBeGreaterThanOrEqual(5);
      if (v === 'narrow') {
        const narrow = generateImpression('narrow');
        const normal = generateImpression('normal');
        const narrowX = narrow.mesh.positions.filter((_, i) => i % 3 === 0).reduce((a, b) => a + Math.abs(b), 0);
        const normalX = normal.mesh.positions.filter((_, i) => i % 3 === 0).reduce((a, b) => a + Math.abs(b), 0);
        expect(narrowX).toBeLessThan(normalX);
      }
    }
  });
});

describe('shell construction', () => {
  it.each(['full-concha', 'half-concha', 'canal', 'deep-canal'] as const)('builds a closed shell for %s', moldType => {
    const s = scan('normal');
    const params = defaultShellParams(moldType, 'hard-acrylic');
    const result = buildShellMesh(s, params);
    expect(result.mesh.positions.length).toBeGreaterThan(1000);
    expect(boundaryEdgeCount(result.mesh.indices)).toBe(0);
    expect(result.actualWall).toBeGreaterThan(0.3);
  });

  it('enforces different hard and soft wall limits', () => {
    expect(WALL_LIMITS['hard-acrylic'].min).toBeLessThan(WALL_LIMITS['soft-silicone'].min);
    const s = scan('narrow');
    const params = defaultShellParams('deep-canal', 'soft-silicone');
    params.nominalWall = 2.4;
    const built = buildShellMesh(s, params);
    expect(built.actualWall).toBeLessThan(2.0);
    expect(built.warning).toContain('低于');
  });

  it('flags the sharp second bend and suggests a trim', () => {
    const s = scan('sharp-bend');
    const params = defaultShellParams('deep-canal', 'hard-acrylic');
    const built = buildShellMesh(s, params);
    const check = checkInsertion(s, params, built.sampler);
    expect(check.suggestedTrimMm).toBeGreaterThan(2);
  });
});

describe('STL round trip', () => {
  it('writes binary STL and parses the same triangle count', async () => {
    const s = scan('normal');
    const blob = writeBinarySTL(s.mesh, 'unit');
    const buffer = await blob.arrayBuffer();
    const parsed = parseSTL(buffer);
    expect(parsed.indices.length / 3).toBe(s.mesh.indices.length / 3);
    expect(parsed.positions.length).toBeGreaterThan(0);
  });
});

describe('collision and thickness helpers', () => {
  it('detects overlapping OBB components', () => {
    const a: LayoutComponent = {
      id: 'a', kind: 'receiver', name: 'A', size: [4, 4, 4], position: [0, 0, 0],
      rotationZ: 0, color: '#fff', opacity: 1, enabled: true
    };
    const b: LayoutComponent = { ...a, id: 'b', kind: 'battery', position: [1, 0, 0] };
    const issues = checkCollisions([a, b], []);
    expect(issues.some(i => i.severity === 'error')).toBe(true);
  });

  it('pairs sorted shell depths into wall segments', () => {
    const segs = pairWallSegments([10, 11.25, 20, 21.4]);
    expect(segs).toHaveLength(2);
    expect(segs[0].thickness).toBeCloseTo(1.25, 5);
    expect(segs[1].thickness).toBeCloseTo(1.4, 5);
  });
});
