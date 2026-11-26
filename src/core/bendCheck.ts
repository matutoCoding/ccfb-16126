// 过弯检查：沿耳道中心线模拟插入，对比外壳截面包络与耳道可用空间，
// 第二弯后卡住的站点标出来，并给出建议截短长度。
import { Vec3, v3 } from './math';
import { Centerline, Landmark } from './centerline';
import { Mesh } from './mesh';
import { RayMeshIntersector } from './raycast';
import { ShellDesignParams } from './shell';

export interface BendCheckResult {
  passable: boolean;
  stuckPoints: { s: number; point: Vec3; clearance: number; required: number }[];
  suggestedTrimS: number; // 建议截短到的弧长
  suggestedTrimDelta: number; // 相对当前截短位置再缩短多少 mm
  maxCurvature: number;
}

// 在站点 s 处，沿截面两轴射线测外壳包络半径与耳道半径
function sectionRadii(
  intersector: RayMeshIntersector,
  cl: Centerline,
  s: number,
): { r1: number; r2: number } {
  const fr = cl.frameAt(s);
  const c = cl.pointAt(s);
  const radii: number[] = [];
  for (const dir of [fr.normal, fr.binormal]) {
    const hits = intersector.intersectAll(c, dir);
    const hitsNeg = intersector.intersectAll(c, v3.neg(dir));
    const rPos = hits.length ? hits[0].t : 0;
    const rNeg = hitsNeg.length ? hitsNeg[0].t : 0;
    radii.push((rPos + rNeg) / 2);
  }
  return { r1: radii[0], r2: radii[1] };
}

export function checkBendPass(
  shellMesh: Mesh,
  cl: Centerline,
  landmarks: Landmark,
  params: ShellDesignParams,
  canalRadiusAt: (s: number) => number,
): BendCheckResult {
  const intersector = new RayMeshIntersector(shellMesh, 48);
  const stuck: BendCheckResult['stuckPoints'] = [];
  let maxK = 0;

  // 从第一弯后开始逐站检查到当前截短位置
  const start = landmarks.firstBend + 1;
  const end = Math.min(params.trimS, cl.totalLen - 1);
  const step = 0.5;
  let lastBadS = start;
  for (let s = start; s <= end; s += step) {
    maxK = Math.max(maxK, cl.curvatureAt(s));
    const { r1, r2 } = sectionRadii(intersector, cl, s);
    const shellR = Math.max(r1, r2);
    // 弯处可用半径：耳道半径扣除弯曲刚性余量（曲率越大余量越大）
    const bendAllowance = 0.35 + cl.curvatureAt(s) * 2.2;
    const required = shellR + bendAllowance;
    const clearance = canalRadiusAt(s);
    if (required > clearance) {
      stuck.push({ s, point: cl.pointAt(s), clearance, required });
      lastBadS = s;
    }
  }

  const passable = stuck.length === 0;
  // 建议截短：缩到最后一个卡点之前 2mm，且不浅于第一弯
  const suggestedTrimS = passable
    ? params.trimS
    : Math.max(landmarks.firstBend + 1, lastBadS - 2);
  return {
    passable,
    stuckPoints: stuck,
    suggestedTrimS,
    suggestedTrimDelta: Math.max(0, params.trimS - suggestedTrimS),
    maxCurvature: maxK,
  };
}
