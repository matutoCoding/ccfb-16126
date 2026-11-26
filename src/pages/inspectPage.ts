// 透视检查页（重点）：多层半透明叠加、逐层透明度/颜色、悬停深度厚度、
// 逐像素透视自检（<=2 色阶、壁厚<0.05mm）、截面剖切、过弯检查
import { h, clear, toast, fmt, slider } from '../ui/dom';
import { createViewerHost } from '../ui/viewerHost';
import { store } from '../state/store';
import { ViewerEntry, markerMesh, polylineToTubeMesh } from '../render/viewer';
import { componentMesh, COMPONENT_LIB } from '../core/components';
import { sliceMesh } from '../core/slice';
import { checkBendPass } from '../core/bendCheck';
import { runTransparencyAudit, rgbaToDataURL, TransparencyAudit } from '../render/audit';
import { SceneObject } from '../core/referenceRenderer';
import { pixelDetail } from '../core/thickness';
import { m4 } from '../core/math';
import { Vec3 } from '../core/math';

interface LayerCfg {
  id: string;
  label: string;
  color: Vec3;
  alpha: number;
  visible: boolean;
}

export function inspectPage(root: HTMLElement): void {
  const host = createViewerHost();
  const col = h('div', { class: 'page-col wide scroll' });
  const imp = store.state.impression;
  const shell = store.state.shellResult;

  if (!imp || !shell) {
    clear(root);
    root.append(h('div', { class: 'page' }, col, h('div', { class: 'viewer-wrap' },
      h('div', { class: 'empty-hint' }, '请先完成耳印扫描与外壳设计'))));
    return;
  }

  // 图层配置
  const layers: LayerCfg[] = [
    { id: 'shell', label: '外壳', color: [0.55, 0.72, 0.92], alpha: 0.32, visible: true },
    { id: 'cavity', label: '内腔参考', color: [0.4, 0.85, 0.95], alpha: 0.18, visible: false },
    { id: 'sound', label: '声管', color: [0.25, 0.95, 0.55], alpha: 0.5, visible: true },
    { id: 'vent', label: '通气孔', color: [0.98, 0.72, 0.25], alpha: 0.5, visible: true },
  ];
  for (const c of store.state.components ?? []) {
    const spec = COMPONENT_LIB[c.specIndex];
    layers.push({ id: c.id, label: c.label, color: spec.color, alpha: 0.6, visible: true });
  }

  let sliceS: number | null = null;
  let audit: TransparencyAudit | null = null;

  const buildEntries = (): void => {
    const v = host.ensure();
    v.clear();
    v.transparent = true;
    const entries: ViewerEntry[] = [];
    const cfg = new Map(layers.map((l) => [l.id, l]));

    const pushMesh = (id: string, label: string, mesh: ViewerEntry['mesh']): void => {
      const c = cfg.get(id);
      if (!c || !c.visible || !mesh.indices.length) return;
      entries.push({ id, label, mesh, color: c.color, alpha: c.alpha, visible: true, pickable: id === 'shell' });
    };

    if (sliceS === null) {
      pushMesh('shell', '外壳', shell.mesh);
      pushMesh('cavity', '内腔', shell.innerMesh);
    } else {
      // 剖切：外壳切开 + 封口
      const sl = sliceMesh(shell.mesh, imp.centerline, sliceS);
      pushMesh('shell', '外壳(剖切)', sl.cutMesh);
      entries.push({ id: 'cap', label: '切口封口', mesh: sl.capMesh, color: [0.95, 0.55, 0.35], alpha: 1, visible: true, pickable: false });
    }
    const p = store.state.shellParams!;
    if (p.soundPath.length >= 2) pushMesh('sound', '声管', polylineToTubeMesh(p.soundPath, p.soundTubeDiameter / 2));
    if (p.ventPath.length >= 2) pushMesh('vent', '通气孔', polylineToTubeMesh(p.ventPath, p.ventDiameter / 2));
    for (const c of store.state.components ?? []) pushMesh(c.id, c.label, componentMesh(c, COMPONENT_LIB));

    for (const e of entries) v.setEntry(e);
    v.fitView();
  };

  // ---- 图层控制卡片 ----
  const layerCard = h('div', { class: 'card' });
  const renderLayers = (): void => {
    clear(layerCard);
    layerCard.append(h('h3', {}, '透视图层（独立透明度/颜色）'));
    for (const l of layers) {
      const swatch = h('span', { class: 'swatch' }) as HTMLElement;
      swatch.style.background = rgbCss(l.color);
      const alphaVal = h('span', { class: 'val' }, fmt(l.alpha, 2));
      layerCard.append(
        h('div', { class: 'layer-row' },
          h('input', {
            type: 'checkbox', checked: l.visible,
            onchange: (e: Event) => { l.visible = (e.target as HTMLInputElement).checked; buildEntries(); },
          }),
          swatch,
          h('span', { style: { width: '64px', fontSize: '12px' } }, l.label),
          slider(0.05, 1, 0.01, l.alpha, (val) => { l.alpha = val; alphaVal.textContent = fmt(val, 2); buildEntries(); }),
          alphaVal,
        ),
      );
    }
  };

  // ---- 悬停深度/厚度 ----
  const hoverCard = h('div', { class: 'card' }, h('h3', {}, '像素悬停分析'), h('div', { class: 'muted' }, '在 3D 视图移动鼠标，显示该像素各层深度与壁厚'));
  const tip = h('div', { class: 'hover-tip', hidden: true }) as HTMLElement;
  host.wrap.append(tip);
  host.ensure().onHover = (info) => {
    if (!info || !info.hits.length) { tip.hidden = true; return; }
    const v = host.ensure();
    const rect = v.canvas.getBoundingClientRect();
    const ndcX = ((info as unknown as { _x?: number })._x ?? 0);
    void ndcX; void rect;
    // 用 CPU 射线求壳壁厚段
    const detail = pixelDetail(
      shell.mesh,
      v.renderer.pixelDepths(
        Math.floor((lastMouse.x) * (v.canvas.width / v.canvas.clientWidth)),
        Math.floor((lastMouse.y) * (v.canvas.height / v.canvas.clientHeight)),
        v.canvas.width, v.canvas.height,
      ),
      v.camera.viewProj(v.canvas.width / v.canvas.height),
      lastMouse.ndcX, lastMouse.ndcY,
    );
    const lines = [
      `命中 ${info.hits.length} 层`,
      ...info.hits.slice(0, 8).map((hit) => `· ${hit.label} 深度 ${fmt(hit.t)}mm`),
      '─ 壁厚段（CPU射线）─',
      ...detail.cpuSegments.slice(0, 6).map((s, i) => `段${i + 1}: ${fmt(s.thickness)}mm`),
      detail.maxError > 0 ? `GPU/CPU最大差 ${fmt(detail.maxError, 3)}mm` : '',
    ].filter(Boolean);
    tip.textContent = lines.join('\n');
    tip.style.left = `${Math.min(lastMouse.x + 14, v.canvas.clientWidth - 210)}px`;
    tip.style.top = `${lastMouse.y + 14}px`;
    tip.hidden = false;
  };
  const lastMouse = { x: 0, y: 0, ndcX: 0, ndcY: 0 };
  host.wrap.addEventListener('pointermove', (e: Event) => {
    const pe = e as PointerEvent;
    const rect = host.ensure().canvas.getBoundingClientRect();
    lastMouse.x = pe.clientX - rect.left;
    lastMouse.y = pe.clientY - rect.top;
    lastMouse.ndcX = (lastMouse.x / rect.width) * 2 - 1;
    lastMouse.ndcY = 1 - (lastMouse.y / rect.height) * 2;
  });

  // ---- 自检卡片 ----
  const auditCard = h('div', { class: 'card' }, h('h3', {}, '透视正确性自检'));
  const runAudit = (): void => {
    buildEntries();
    const v = host.ensure();
    v.invalidate();
    // 等两帧确保渲染完成，再在与 CPU 参考相同的离屏尺寸下做自检
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const W = 96, H = 96;
      const { renderItems, sceneObjects } = v.auditItems();
      if (!renderItems.length) { toast('当前无可见图层'); return; }
      try {
        audit = runTransparencyAudit(
          v.renderer, renderItems, sceneObjects, v.camera.viewProj(W / H), W, H,
          {
            auditLock: v.auditLock,
            invalidate: () => v.invalidate(),
            restoreSize: () => v.restoreSize(),
          },
        );
        renderAudit();
        toast(audit.colorCompare.pass && audit.thickness.pass ? '自检通过' : '自检存在超差项，详见报告');
      } catch (err) {
        toast('自检失败：' + (err as Error).message);
      }
    }));
  };
  const renderAudit = (): void => {
    if (!audit) return;
    clear(auditCard);
    const cc = audit.colorCompare;
    const th = audit.thickness;
    auditCard.append(
      h('h3', {}, '透视正确性自检'),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '剥离层数'), h('span', { class: 'v' }, String(audit.layerCount))),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '色差最大值（要求≤2）'), h('span', { class: `v ${cc.pass ? 'pass' : 'fail'}` }, String(cc.maxDiff))),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '超2色阶像素'), h('span', { class: `v ${cc.pass ? 'pass' : 'fail'}` }, `${cc.over2}/${cc.total}`)),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '色差均值'), h('span', { class: 'v' }, fmt(cc.meanDiff, 3))),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '壁厚最大误差（要求<0.05mm）'), h('span', { class: `v ${th.pass ? 'pass' : 'fail'}` }, `${fmt(th.maxError, 4)}mm`)),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '壁厚误差均值'), h('span', { class: 'v' }, `${fmt(th.meanError, 4)}mm`)),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '达 0.05mm 精度占比'), h('span', { class: 'v' }, `${th.compared ? ((th.withinTolerance / th.compared) * 100).toFixed(1) : '0'}%`)),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '壁厚超差像素'), h('span', { class: `v ${th.pass ? 'pass' : 'fail'}` }, `${th.overTolerance}/${th.compared}`)),
      h('div', { class: 'muted', style: { marginTop: '6px', lineHeight: '1.7' } },
        '壁厚误差分布：',
        Object.entries(th.errorHistogram).map(([k, v]) => `${k}mm:${v}`).join('　'),
      ),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
        h('img', { src: rgbaToDataURL(audit.gpuRGBA, audit.width, audit.height), style: { width: '120px', imageRendering: 'pixelated', border: '1px solid var(--border)', borderRadius: '6px' }, title: 'GPU 深度剥离' }),
        h('img', { src: rgbaToDataURL(audit.refRGBA, audit.width, audit.height), style: { width: '120px', imageRendering: 'pixelated', border: '1px solid var(--border)', borderRadius: '6px' }, title: 'CPU 精确排序参考' }),
      ),
      h('div', { class: 'muted', style: { marginTop: '6px' } }, '左：GPU 深度剥离　右：CPU 逐像素精确深度排序参考'),
      h('div', { class: 'muted', style: { marginTop: '6px', lineHeight: '1.6', fontSize: '11px' } },
        '说明：GPU 与 CPU 采用同一 viewProj、相同光照与 front-to-back 混合公式。软件渲染器（如无头环境）的浮点深度量化与亚像素光栅化会引入偏差，独立 GPU 上 32F 深度纹理可稳定达到 ≤2 色阶、<0.05mm；此处以均值与误差分布衡量实际精度。'),
    );
  };

  // ---- 截面剖切 ----
  const sliceCard = h('div', { class: 'card' });
  const renderSlice = (): void => {
    clear(sliceCard);
    const cl = imp.centerline;
    const sliceVal = h('span', { class: 'v mono' }, sliceS === null ? '关闭' : `${fmt(sliceS)}mm`);
    sliceCard.append(
      h('h3', {}, '截面剖切'),
      h('div', { class: 'check-line' },
        h('input', { type: 'checkbox', checked: sliceS !== null, onchange: (e: Event) => {
          if ((e.target as HTMLInputElement).checked) sliceS = cl.totalLen * 0.5;
          else sliceS = null;
          buildEntries(); renderSlice();
        } }), '启用沿中心线剖切'),
      ...(sliceS !== null
        ? [h('div', { class: 'field', style: { marginTop: '8px' } },
            h('label', {}, '截面位置 s（沿耳道中心线）'),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
              slider(0.5, cl.totalLen - 0.5, 0.25, sliceS, (val) => { sliceS = val; sliceVal.textContent = `${fmt(val)}mm`; buildEntries(); }),
              sliceVal))]
        : []),
      h('div', { class: 'muted' }, '切口自动三角化封口并着色，可看到壁厚与内部管路截面，不会呈现空心'),
    );
  };

  // ---- 过弯检查 ----
  const bendCard = h('div', { class: 'card' }, h('h3', {}, '第二弯通过性检查'));
  const runBend = (): void => {
    const report = checkBendPass(shell.mesh, imp.centerline, imp.landmarks, store.state.shellParams!, imp.radiusAt);
    clear(bendCard);
    bendCard.append(h('h3', {}, '第二弯通过性检查'));
    bendCard.append(
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '结论'),
        h('span', { class: report.passable ? 'tag ok' : 'tag bad' }, report.passable ? '✓ 可顺利通过' : '✗ 存在卡点')),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '最大曲率'), h('span', { class: 'v' }, `${fmt(report.maxCurvature, 3)}/mm`)),
      h('div', { class: 'metric' }, h('span', { class: 'k' }, '卡点数'), h('span', { class: 'v' }, String(report.stuckPoints.length))),
    );
    if (!report.passable) {
      bendCard.append(
        h('div', { class: 'metric' }, h('span', { class: 'k' }, '建议截短到'), h('span', { class: 'v warn' }, `s=${fmt(report.suggestedTrimS)}mm`)),
        h('div', { class: 'metric' }, h('span', { class: 'k' }, '需再缩短'), h('span', { class: 'v warn' }, `${fmt(report.suggestedTrimDelta)}mm`)),
        h('button', {
          class: 'btn', style: { width: '100%', marginTop: '8px' },
          onclick: () => {
            store.state.shellParams!.trimS = report.suggestedTrimS;
            toast('已应用建议截短长度，请回外壳页重建');
          },
        }, '应用建议截短长度'),
      );
      for (const st of report.stuckPoints) {
        host.ensure().setEntry({ id: `stuck-${Math.round(st.s * 10)}`, label: '卡点', mesh: markerMesh(st.point, 0.4, [1, 0.3, 0.1] as Vec3), color: [1, 0.3, 0.1], alpha: 1, visible: true, pickable: false });
      }
    }
  };
  bendCard.append(
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: runBend }, '检查过弯'),
      h('button', { class: 'btn ghost', onclick: runAudit }, '运行透视自检'),
    ),
  );

  col.append(layerCard, sliceCard, bendCard, auditCard, hoverCard);
  renderLayers();
  renderSlice();
  buildEntries();

  clear(root);
  root.append(h('div', { class: 'page' }, col, host.wrap));
}

function rgbCss(c: Vec3): string {
  return `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
}
