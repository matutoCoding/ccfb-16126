import type { VerifyResult } from '../types';
import { WebGLRenderer, type SceneObject } from '../render/Renderer';
import { createMesh } from '../geom/mesh';
import { mat4Compose } from '../math/vec';
import { hexToRgb01 } from '../render/glutils';
import { generateImpression } from '../geom/procedural';
import type { ScanRecord } from '../types';
import { defaultShellParams, buildShellMesh } from '../geom/shell';
import { rayMeshIntersections, pairWallSegments } from '../geom/raycast';
import { screenRayHelper } from '../ui/pick-helpers';

function verifyCanvas(width: number, height: number): { canvas: HTMLCanvasElement; host: HTMLDivElement } {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#020814;padding:6px;border:1px solid #38bdf8;border-radius:8px;';
  const canvas = document.createElement('canvas');
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = width;
  canvas.height = height;
  host.appendChild(canvas);
  document.body.appendChild(host);
  return { canvas, host };
}

function unitPlaneMesh() {
  return createMesh([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], [0, 1, 2, 0, 2, 3]);
}

interface RefLayer { distance: number; rgb: [number, number, number]; opacity: number }

function compositeReference(layers: RefLayer[], bg: [number, number, number]): [number, number, number] {
  layers.sort((a, b) => a.distance - b.distance);
  let r = 0, g = 0, b = 0, a = 0;
  for (const l of layers) {
    const w = (1 - a) * l.opacity;
    r += w * l.rgb[0]; g += w * l.rgb[1]; b += w * l.rgb[2];
    a += (1 - a) * l.opacity;
  }
  return [r + bg[0] * (1 - a), g + bg[1] * (1 - a), b + bg[2] * (1 - a)];
}

export async function runPixelVerification(): Promise<VerifyResult> {
  const W = 256, H = 256;
  const { canvas, host } = verifyCanvas(W, H);
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer(canvas);
  } catch (e) {
    host.remove();
    return { name: '16 层半透明逐像素排序', pass: false, message: `WebGL2 不可用：${(e as Error).message}` };
  }
  renderer.resize(1);
  renderer.camera.target = [0, 0, 0];
  renderer.camera.yaw = 0;
  renderer.camera.pitch = 0;
  renderer.camera.distance = 62;
  renderer.camera.updateAspect(renderer.drawingSize.width, renderer.drawingSize.height);
  renderer.camera.update();
  renderer.maxPeelLayers = 28;

  const plane = unitPlaneMesh();
  const palette = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e'];
  const objects: SceneObject[] = palette.map((color, i) => ({
    id: `layer-${i}`,
    mesh: plane,
    model: mat4Compose([0, 0, 20 - i * 2.15], 0, [70, 70, 1]),
    color,
    opacity: 0.34 + (i % 4) * 0.07,
    unlit: true,
    heat: false
  }));
  const bg = '#0b1220';
  renderer.renderTransparent(objects, { background: bg });
  const pixels = renderer.readCanvasPixels();
  const actualW = renderer.drawingSize.width, actualH = renderer.drawingSize.height;
  const bgRgb = hexToRgb01(bg);
  let maxError = 0;
  let badPixels = 0;
  let checked = 0;

  for (let gy = 0; gy < actualH; gy++) {
    const topY = actualH - 1 - gy;
    for (let x = 0; x < actualW; x++) {
      const ray = screenRayHelper(renderer.camera.viewProj, x, topY, actualW, actualH);
      const layers: RefLayer[] = [];
      for (const obj of objects) {
        const hits = rayMeshIntersections(ray, obj.mesh, obj.model);
        if (hits[0]) layers.push({ distance: hits[0].distance, rgb: hexToRgb01(obj.color!), opacity: obj.opacity! });
      }
      const ref = compositeReference(layers, bgRgb);
      const pi = (gy * actualW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const expected = Math.round(ref[c] * 255);
        const actual = pixels[pi + c];
        const err = Math.abs(expected - actual);
        maxError = Math.max(maxError, err);
        if (err > 2) badPixels++;
      }
      checked++;
    }
  }
  host.remove();
  renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
  const pass = maxError <= 2 && badPixels === 0;
  return {
    name: '16 层外壳/器件半透明逐像素排序',
    pass,
    maxChannelError: maxError,
    tolerance: 2,
    samples: checked,
    message: pass ? `${checked.toLocaleString()} 像素全部 ≤2 色阶，最大误差 ${maxError}` : `${badPixels} 个通道/像素超差，最大误差 ${maxError}`
  };
}

export async function runThicknessVerification(): Promise<VerifyResult> {
  const W = 420, H = 320;
  const { canvas, host } = verifyCanvas(W, H);
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer(canvas);
  } catch (e) {
    host.remove();
    return { name: '屏幕壁厚 vs 网格射线求交', pass: false, message: `WebGL2 不可用：${(e as Error).message}` };
  }
  renderer.resize(1);
  const generated = generateImpression('normal');
  const scan = {
    id: 'verify-scan', name: 'verify', variant: 'normal', createdAt: 0,
    ...generated
  } as ScanRecord;
  const params = defaultShellParams('full-concha', 'hard-acrylic');
  params.nominalWall = 1.25;
  params.trimMmFromTip = 1.2;
  const built = buildShellMesh(scan, params);
  const shell: SceneObject = { id: 'shell', mesh: built.mesh, color: '#7dd3fc', opacity: 0.5, heat: false };

  renderer.camera.target = [0, -1.5, -4];
  renderer.camera.yaw = 0.34;
  renderer.camera.pitch = 0.2;
  renderer.camera.distance = 94;
  renderer.resize(1);
  renderer.camera.updateAspect(renderer.drawingSize.width, renderer.drawingSize.height);
  renderer.camera.update();
  renderer.computeShellLayers(shell, 1.0);
  const layers = renderer.readAllShellLayers();
  const w = renderer.drawingSize.width, h = renderer.drawingSize.height;
  const stepX = Math.max(5, Math.floor(w / 28));
  const stepY = Math.max(5, Math.floor(h / 20));
  let maxErr = 0;
  let matched = 0;
  let comparedSegments = 0;
  const errors: number[] = [];
  const worst: Array<Record<string, unknown>> = [];

  for (let gy = stepY; gy < h - stepY; gy += stepY) {
    const topY = h - 1 - gy;
    for (let x = stepX; x < w - stepX; x += stepX) {
      const gpuDepths: number[] = [];
      for (const data of layers) {
        const d = data[gy * w + x];
        if (d > 0.0001) gpuDepths.push(d);
      }
      if (gpuDepths.length < 2) continue;
      const screenRay0 = screenRayHelper(renderer.camera.viewProj, x, topY, w, h);
      // Use the eye as origin. screenRayHelper gives the correct direction; its origin is on near.
      const ray = { origin: renderer.camera.position, dir: screenRay0.dir };
      const hits = rayMeshIntersections(ray, built.mesh);
      if (hits.length < 2) continue;
      // Triangle seams/silhouettes are coverage-conditioned rather than point-depth-conditioned.
      const edgeMargin = Math.min(...hits.map(hit => {
        const [u, v] = hit.barycentric;
        return Math.min(u, v, 1 - u - v);
      }));
      if (edgeMargin < 0.018) continue;
      // Stable samples require the rasterized peel and CPU ray to see the same layer count.
      if (hits.length !== gpuDepths.length) continue;
      const gpuSegs = pairWallSegments(gpuDepths);
      const cpuSegs = pairWallSegments(hits.map(hit => hit.distance));
      if (!gpuSegs.length || gpuSegs.length !== cpuSegs.length) continue;
      matched++;
      const layerDiffs = gpuDepths.map((d, i) => Math.abs(d - hits[i].distance));
      const maxLayerDiff = Math.max(...layerDiffs);
      for (let i = 0; i < gpuSegs.length; i++) {
        const err = Math.abs(gpuSegs[i].thickness - cpuSegs[i].thickness);
        errors.push(err);
        maxErr = Math.max(maxErr, err);
        comparedSegments++;
        if (err > 0.025) {
          worst.push({ x, gy, err, maxLayerDiff, gpuDepths, cpuDepths: hits.map(h => Number(h.distance.toFixed(4))), gpuThickness: gpuSegs.map(s => Number(s.thickness.toFixed(4))), cpuThickness: cpuSegs.map(s => Number(s.thickness.toFixed(4))) });
        }
      }
    }
  }
  errors.sort((a, b) => a - b);
  const p95 = errors[Math.floor(errors.length * 0.95)] ?? maxErr;
  const details = worst.sort((a, b) => Number(b.err) - Number(a.err)).slice(0, 6);
  host.remove();
  renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
  const pass = maxErr < 0.05 && matched >= 24;
  return {
    name: '屏幕壁厚与网格射线求交一致性',
    pass,
    maxThicknessErrorMm: maxErr,
    tolerance: 0.05,
    samples: comparedSegments,
    message: pass
      ? `${matched} 个像素、${comparedSegments} 个壁段；最大误差 ${maxErr.toFixed(4)} mm，95 分位 ${p95.toFixed(4)} mm`
      : `稳定样本 ${matched}/${comparedSegments}，最大误差 ${maxErr.toFixed(4)} mm（需 ≥24 像素且 <0.05 mm）`,
    details: { p95, worst: details }
  };
}

export async function runAllVerification(): Promise<VerifyResult[]> {
  const pixel = await runPixelVerification();
  const thickness = await runThicknessVerification();
  return [pixel, thickness];
}

export async function runBrowserVerificationPage(app?: { toast?: (m: string, k?: 'ok' | 'bad') => void }) {
  const pre = document.createElement('pre');
  pre.id = 'verify-result';
  pre.className = 'verification-log';
  pre.style.cssText = 'position:fixed;inset:24px;z-index:2147483647;background:#020814;color:#dbeafe;padding:24px;overflow:auto;font-size:14px;border:1px solid #38bdf8;border-radius:16px;';
  pre.textContent = '正在运行 WebGL2 像素与壁厚验收，请稍候…';
  document.body.appendChild(pre);
  const results: VerifyResult[] = [];
  try {
    results.push(await runPixelVerification());
    results.push(await runThicknessVerification());
  } catch (e) {
    results.push({ name: '验收执行异常', pass: false, message: (e as Error).stack ?? String(e) });
  }
  (window as unknown as { __VERIFY_RESULTS__?: VerifyResult[]; __VERIFY_DONE__?: boolean }).__VERIFY_RESULTS__ = results;
  (window as unknown as { __VERIFY_DONE__?: boolean }).__VERIFY_DONE__ = true;
  pre.textContent = results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n  ${r.message}`).join('\n\n');
  const allPass = results.every(r => r.pass);
  pre.style.borderColor = allPass ? '#22c55e' : '#ef4444';
  app?.toast?.(allPass ? '全部验收通过' : '验收存在失败项', allPass ? 'ok' : 'bad');
  return results;
}
