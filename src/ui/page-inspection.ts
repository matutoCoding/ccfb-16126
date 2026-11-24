/**
 * 页面 5：透视检查（本系统正确性核心）
 *  - 每像素链表 OIT，外壳/声管/通气孔/器件半透明叠加，层独立调透明度与颜色
 *  - 逐像素视线穿壳层数与各段壁厚，薄于下限染红（GPU resolve）
 *  - 鼠标悬停显示该像素各层深度与壁厚（链表回读 CPU 排序）
 *  - 沿中心线截面滑条，切口封口着色
 */
import { app } from '../state';
import { h, clear, fmt } from './dom';
import { Viewport, defaultLayerConfig, createViewportDeferred } from '../render/Viewport';
import { RenderLayerConfig, PixelLayerInfo, LayerTag } from '../render/GLRenderer';
import { buildScene, centerOfBounds, boundsRadius, hexToRgb01 } from '../render/scene';
import { buildShellWithStyle } from '../design-service';
import { radialWallThickness } from '../core/analysis';
import { makeEllipsoid } from '../core/geometry';
import { norm3, sub3 } from '../core/math';

const LAYER_META: Array<{ key: keyof RenderLayerConfig; label: string }> = [
  { key: 'shell', label: '外壳' },
  { key: 'tube', label: '声管' },
  { key: 'vent', label: '通气孔' },
  { key: 'device', label: '器件' },
  { key: 'impression', label: '印模参考' },
];
const TAG_LABEL: Record<LayerTag, string> = {
  shell: '外壳', tube: '声管', vent: '通气孔', device: '器件', impression: '印模', marker: '标记',
};

export function renderInspectionPage(root: HTMLElement): void {
  clear(root);
  root.append(h('h2', {}, '透视检查 · 逐像素透明排序与壁厚测量'));
  const c = app.currentCustomer;
  const im = app.currentImpression;
  if (!c || !im) { root.append(h('div', { class: 'card muted' }, '请先准备客户、印模与外壳设计。')); return; }

  let design = app.currentDesign;
  let shell = app.currentShell;
  if (design && !shell) {
    shell = buildShellWithStyle(im, design, c.ears[app.currentSide].shellStyle);
    app.shellCache.set(design.id, shell);
  }
  if (!design || !shell) { root.append(h('div', { class: 'card muted' }, '请先在「外壳设计」生成壳体。')); return; }

  const layerConfig = defaultLayerConfig();
  layerConfig.shell.color = hexToRgb01(design.color);
  const clip = { point: im.centerline[0], normal: norm3(sub3(im.centerline[1], im.centerline[0])), enabled: false };

  const viewHost = h('div', { class: 'viewport-wrap tall' });
  const panel = h('div', { class: 'card', style: 'width:340px;flex:0 0 340px;overflow:auto' });
  root.append(h('div', { style: 'display:flex;gap:16px;height:calc(100% - 40px);min-height:0' }, viewHost, panel));

  let heatMode = false;
  const minWall = design.material === 'silicone' ? app.settings.siliconeMinWall : app.settings.hardMinWall;
  let viewport: Viewport;
  let sectionT = 0.5;
  let showCap = true;
  const tip = h('div', { class: 'hover-tip', style: 'display:none' });
  document.body.append(tip);

  const rebuildItems = () => {
    const items = buildScene(shell!, design!, im, layerConfig.impression.visible);
    if (clip.enabled && showCap) {
      const radius = Math.max(...shell!.outerRadii[Math.min(shell!.stationRange[1], Math.max(shell!.stationRange[0],
        Math.floor(sectionT * (im.centerline.length - 1))))]);
      items.push({
        mesh: makeEllipsoid(clip.point, [radius, radius * 0.35, radius], 18, 28),
        model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        tag: 'marker', color: [0.85, 0.55, 0.95], alpha: 0.85, label: '截面封口',
      });
    }
    viewport.setItems(items);
  };

  const cpuSamples = radialWallThickness(shell.mesh, shell.frames, shell.stationRange, 20);
  const cpuMin = Math.min(...cpuSamples.map((s) => s.thicknessMm));
  const cpuAvg = cpuSamples.reduce((a, s) => a + s.thicknessMm, 0) / cpuSamples.length;

  const drawPanel = () => {
    clear(panel);
    panel.append(
      h('h3', {}, '分层透明度 / 颜色 / 可见性'),
      ...LAYER_META.map(({ key, label }) => {
        const st = layerConfig[key];
        const alpha = h('input', {
          type: 'range', min: '0.05', max: '1', step: '0.05', value: String(st.opacity),
          oninput: (e: Event) => {
            st.opacity = Number((e.target as HTMLInputElement).value);
            viewport.setOptions({ layerConfig });
          },
        }) as HTMLInputElement;
        const color = h('input', {
          type: 'color',
          value: rgbToHex(st.color),
          oninput: (e: Event) => {
            st.color = hexToRgb01((e.target as HTMLInputElement).value);
            viewport.setOptions({ layerConfig });
          },
        }) as HTMLInputElement;
        const visible = h('input', {
          type: 'checkbox', checked: st.visible ? 'checked' : null,
          onchange: (e: Event) => {
            st.visible = (e.target as HTMLInputElement).checked;
            viewport.setOptions({ layerConfig });
          },
        }) as HTMLInputElement;
        return h('div', { class: 'layer-row', style: 'border:1px solid var(--border);border-radius:6px;padding:6px 8px' },
          visible, h('span', { style: 'width:52px' }, label), alpha, color);
      }),

      h('h3', {}, '壁厚逐像素检测'),
      h('button', {
        class: 'btn ' + (heatMode ? 'danger' : ''), style: 'width:100%',
        onclick: () => {
          heatMode = !heatMode;
          viewport.setOptions({ heatMode });
          drawPanel();
        },
      }, heatMode ? '关闭壁厚热力图' : '打开壁厚热力图（薄于下限染红）'),
      h('div', { class: 'muted', style: 'margin:8px 0' },
        `材料下限 ${fmt(minWall, 2)}mm · CPU 射线参考：最小 ${fmt(cpuMin, 3)}mm / 平均 ${fmt(cpuAvg, 3)}mm`),
      h('div', { class: 'muted' }, '热力图红色 = 屏幕像素视线方向上存在薄于下限的壳壁段'),

      h('h3', {}, '沿耳道中心线截面'),
      h('div', { class: 'slider-row' },
        h('input', {
          type: 'range', min: '0', max: '1', step: '0.01', value: String(sectionT),
          oninput: (e: Event) => {
            sectionT = Number((e.target as HTMLInputElement).value);
            applyClip();
          },
        }),
        h('span', { class: 'mono' }, Math.round(sectionT * 100) + '%')),
      h('label', { class: 'layer-row' },
        h('input', {
          type: 'checkbox', checked: showCap ? 'checked' : null,
          onchange: (e: Event) => { showCap = (e.target as HTMLInputElement).checked; applyClip(); },
        }), '切口封口着色（防止看成空心）'),
      h('button', {
        class: 'btn ghost', style: 'width:100%;margin-top:6px',
        onclick: () => { clip.enabled = false; viewport.setOptions({ clip }); rebuildItems(); drawPanel(); },
      }, '关闭截面'),

      h('h3', {}, '悬停探针'),
      h('div', { class: 'muted' }, '在视口移动鼠标，浮层显示该像素各层的视线深度与 shell 层段壁厚。'),
    );
  };

  const applyClip = () => {
    const idx = Math.floor(sectionT * (im.centerline.length - 1));
    const p = im.centerline[idx];
    const nrm = norm3(sub3(im.centerline[Math.min(im.centerline.length - 1, idx + 1)],
      im.centerline[Math.max(0, idx - 1)]));
    clip.point = p;
    clip.normal = nrm;
    clip.enabled = true;
    viewport.setOptions({ clip });
    rebuildItems();
  };

  createViewportDeferred(viewHost, [0, 0, 0], 30, {
    layerConfig, heatMode: false, minWall, clip,
    onHover: (info: PixelLayerInfo[] | null, x: number, y: number) => {
        if (!info) { tip.style.display = 'none'; return; }
        tip.style.display = 'block';
        tip.style.left = Math.min(window.innerWidth - 260, x + 14) + 'px';
        tip.style.top = Math.min(window.innerHeight - 220, y + 14) + 'px';
        clear(tip);
        const shellLayers = info.filter((l) => l.tag === 'shell');
        tip.append(
          h('div', { style: 'font-weight:700;margin-bottom:4px' }, `该像素 ${info.length} 层 · shell 片元 ${shellLayers.length}`),
          h('table', {},
            h('tbody', {}, ...info.slice(0, 12).map((l) => h('tr', {},
              h('td', {}, TAG_LABEL[l.tag]),
              h('td', { class: 'mono' }, `d=${fmt(l.depthMm, 2)}`),
              h('td', { class: 'mono ' + (l.thicknessMm != null && l.thicknessMm < minWall ? 'badge bad' : '') },
                l.thicknessMm != null ? `壁${fmt(l.thicknessMm, 3)}` : ''))))),
        );
        if (info.length > 12) tip.append(h('div', { class: 'muted' }, `…其余 ${info.length - 12} 层`));
      },
  }, (vp) => {
    viewport = vp;
    const center = centerOfBounds(im.centerline);
    viewport.frame(center, boundsRadius(im.centerline, center) + 3);
    rebuildItems();
    drawPanel();
  });

  // 页面离开时移除浮层
  const observer = new MutationObserver(() => {
    if (!document.body.contains(root) && document.body.contains(tip)) tip.remove();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function rgbToHex(rgb: [number, number, number]): string {
  const c = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}
