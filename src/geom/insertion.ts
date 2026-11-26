import type { InsertionCheck, ScanRecord, ShellParams, Vec3 } from '../types';
import { angleBetween } from './angles';
import { moldRange, RadiusSampler } from './shell';

export function checkInsertion(scan: ScanRecord, params: ShellParams, sampler: RadiusSampler): InsertionCheck {
  const range = moldRange(scan, params.moldType);
  const baseEndLength = sampler.lengthAtT(range.tEnd);
  const endT = sampler.tAtLength(baseEndLength - params.trimMmFromTip);
  const startT = Math.max(range.tStart, (scan.landmarks.find(l => l.id === 'first-bend')?.t ?? 0.4) - 0.03);

  if (params.moldType === 'full-concha' || params.moldType === 'half-concha') {
    return { pass: true, minClearance: 0.8, suggestedTrimMm: 0, samples: [] };
  }

  const samples: InsertionCheck['samples'] = [];
  let minClearance = Infinity;
  let stuckT: number | undefined;
  let stuckPosition: Vec3 | undefined;

  const N = 42;
  for (let i = 0; i <= N; i++) {
    const t = startT + (endT - startT) * (i / N);
    const center = sampler.pointAt(t);
    const here = sampler.radiiAt(t);
    // The leading nose cannot bend perfectly; estimate chord offset through the next 7 mm.
    const leadLength = 7.0;
    const tAhead = sampler.tAtLength(sampler.lengthAtT(t) + leadLength);
    const tangent0 = sampler.frameAt(t).tangent;
    const tangent1 = sampler.frameAt(Math.min(1, t + 0.08)).tangent;
    const bendAngle = angleBetween(tangent0, tangent1);
    const bendPenalty = Math.min(2.8, bendAngle * leadLength / 14);
    let canalMin = Math.min(here.rx, here.ry);
    let shellMax = 0;
    for (let k = -2; k <= 5; k++) {
      const tt = Math.max(0, Math.min(1, t + k * 0.012));
      const r = sampler.radiiAt(tt);
      canalMin = Math.min(canalMin, Math.min(r.rx, r.ry));
      if (k >= 0 && tt <= tAhead) shellMax = Math.max(shellMax, Math.min(r.rx, r.ry) - 0.08);
    }
    // 0.18 mm is the designed sliding clearance; bendPenalty is chord sweep.
    const clearance = canalMin - shellMax - bendPenalty + 0.18;
    samples.push({ t, clearance, x: center[0], y: center[1], z: center[2] });
    if (clearance < minClearance) minClearance = clearance;
    if (stuckT === undefined && clearance < 0.05) {
      stuckT = t;
      stuckPosition = center;
    }
  }

  let suggestedTrimMm = params.trimMmFromTip;
  let pass = minClearance >= 0.05;
  if (!pass && stuckT !== undefined) {
    // Keep the tip 2.5 mm before the first binding station.
    const safeLength = sampler.lengthAtT(Math.max(range.tStart + 0.1, stuckT - 0.045));
    suggestedTrimMm = Math.max(params.trimMmFromTip, baseEndLength - safeLength + 1.2);
  }
  // Sharp second-bend guard: a long CIC tip is recommended to stop just after the bend.
  const secondT = scan.landmarks.find(l => l.id === 'second-bend')?.t ?? 0.69;
  const tangentBefore = sampler.frameAt(Math.max(0, secondT - 0.08)).tangent;
  const tangentAfter = sampler.frameAt(Math.min(1, secondT + 0.08)).tangent;
  const bendDeg = angleBetween(tangentBefore, tangentAfter) * 180 / Math.PI;
  if (bendDeg > 48 && endT > secondT + 0.13) {
    pass = false;
    stuckT = stuckT ?? secondT + 0.1;
    stuckPosition = stuckPosition ?? sampler.pointAt(stuckT);
    const safeLength = sampler.lengthAtT(secondT + 0.08);
    suggestedTrimMm = Math.max(suggestedTrimMm, baseEndLength - safeLength);
    minClearance = Math.min(minClearance, -0.2);
  }

  return { pass, minClearance, stuckT, stuckPosition, suggestedTrimMm: Math.round(suggestedTrimMm * 10) / 10, samples };
}
