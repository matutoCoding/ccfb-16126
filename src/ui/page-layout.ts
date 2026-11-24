/** 页面 4：内部排布 —— 器件库摆放 / 声管通气孔路径 / 碰撞报告 / 第二弯过弯检查 */
import { app } from '../state';
import { h, clear, toast, fmt } from './dom';
import { DeviceInstance } from '../core/types';
import { COMPONENT_LIBRARY, instantiateComponent } from '../core/components';
import { Viewport, defaultLayerConfig, createViewportDeferred } from '../render/Viewport';
import { buildScene, centerOfBounds, boundsRadius } from '../render/scene';
import { createDefaultDesign, buildShellWithStyle, clampVent } from '../design-service';
import { checkCollisions, checkInsertion, makeOBB } from '../core/analysis';
import { Vec3, add3, dist3, sub3 } from '../core/math';
import { Mesh, rayMeshFirstHit, makeEllipsoid } from '../core/geometry';

export function renderLayoutPage(root: HTMLElement): void {
  clear(root);
  root.append(h('h2', {}, '内部排布与碰撞检查'));
  const c = app.currentCustomer;
  const im = app.currentImpression;
  if (!c || !im) { root.append(h('div', { class: 'card muted' }, '请先准备客户与印模。')); return; }
  const ear = c.ears[app.currentSide];

  const viewHost = h('div', { class: 'viewport-wrap' });
  const panel = h('div', { class: 'card', style: 'width:340px;flex:0 0 340px;overflow:auto' });
  root.append(h('div', { style: 'display:flex;gap:16px;height:calc(100% - 40px);min-height:0' }, viewHost, panel));

  let viewport: Viewport | null = null;
  let design = app.currentDesign;
  let shell = app.currentShell;
  let selectedId: string | null = null;

  const ensure = () => {
    if (!design) {
      design = createDefaultDesign(c.id, im, ear.shellStyle, ear.material);
      shell = buildShellWithStyle(im, design, ear.shellStyle);
      app.saveDesign(design, shell);
    } else if (!shell) {
      shell = buildShellWithStyle(im, design, ear.shellStyle);
      app.shellCache.set(design.id, shell);
    }
  };

  const refresh = () => {
    if (!viewport || !design || !shell) return;
    const items = buildScene(shell, design, im, false);
    // 选中器件高亮框
    const sel = design.devices.find((d) => d.id === selectedId);
    if (sel) {
      const obb = makeOBB(sel);
      for (const cn of obb.corners) items.push({
        mesh: makeEllipsoid(cn, [0.45, 0.45, 0.45], 8, 12),
        model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        tag: 'marker', color: [1, 1, 0.2], alpha: 1, label: '选中',
      });
    }
    // 过弯卡点
    const ins = checkInsertion(im.centerline, shell.frames, shell.innerRadii, design, shell.stationRange);
    for (const st of ins.stuckPoints) items.push({
      mesh: makeEllipsoid(st.point, [0.9, 0.9, 0.9], 10, 14),
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      tag: 'marker', color: [1, 0.15, 0.1], alpha: 1, label: '卡点',
    });
    viewport.setItems(items);
  };

  const reportBox = h('div', {});
  const drawReport = () => {
    clear(reportBox);
    if (!design || !shell) return;
    const collisions = checkCollisions(design, shell.frames, shell.innerRadii);
    const ins = checkInsertion(im.centerline, shell.frames, shell.innerRadii, design, shell.stationRange);
    reportBox.append(
      h('h3', {}, '碰撞检查（真实尺寸）'),
      collisions.collisions.length === 0
        ? h('div', { class: 'badge ok' }, '器件/管路/壳壁无碰撞 ✓')
        : h('div', {}, ...collisions.collisions.map((cc) =>
          h('div', { class: 'collision-item ' + (cc.gap < 0 ? 'bad' : 'warn') }, cc.message))),
      h('h3', {}, '第二弯插入通过性'),
      h('div', { class: 'muted', style: 'margin-bottom:6px' },
        `中心线最小曲率半径：${fmt(ins.minBendRadiusMm, 2)} mm`),
      ins.pass
        ? h('div', { class: 'badge ok' }, '刚性器件可通过第二弯 ✓')
        : h('div', {},
          h('div', { class: 'badge bad', style: 'margin-bottom:6px' }, `检出 ${ins.stuckPoints.length} 个卡点`),
          ...ins.stuckPoints.map((s) => h('div', { class: 'collision-item bad' },
            `站 ${s.station}：需通道 ${fmt(s.required, 2)}mm，实际仅 ${fmt(s.available, 2)}mm`)),
          h('div', { style: 'margin:8px 0' }, h('button', {
            class: 'btn', onclick: () => {
              if (!design) return;
              design.trimPosition = Math.max(0.45, ins.suggestedTrimStation / (im.centerline.length - 1));
              shell = buildShellWithStyle(im, design, ear.shellStyle);
              app.saveDesign(design, shell);
              drawPanel(); refresh();
              toast(`已按建议截短 ${fmt(ins.suggestedTrimLengthMm, 2)} mm`);
            },
          }, `应用建议：再截短 ${fmt(ins.suggestedTrimLengthMm, 2)} mm`))),
    );
  };

  const drawPanel = () => {
    clear(panel);
    ensure();
    const d = design!;
    panel.append(
      h('h3', {}, '器件库（点击添加，真实尺寸 mm）'),
      h('div', { class: 'grid cols-2' }, ...COMPONENT_LIBRARY.map((def) =>
        h('button', {
          class: 'btn ghost small', style: 'text-align:left',
          onclick: () => {
            const pos = im.centerline[Math.floor(im.centerline.length * 0.4)];
            const inst = instantiateComponent(def, pos);
            d.devices.push(inst);
            selectedId = inst.id;
            app.saveDesign(d, shell);
            drawPanel(); refresh();
          },
        }, h('div', { style: 'font-weight:600' }, def.name), h('div', { class: 'muted mono' }, def.size.join(' × '))))),

      h('h3', {}, '已布器件'),
      ...d.devices.map((dv) => h('div', {
        class: 'customer-item' + (dv.id === selectedId ? ' selected' : ''),
        onclick: () => { selectedId = dv.id; drawDeviceEditor(dv); refresh(); },
      },
        h('div', {}, h('div', { style: 'font-weight:600' }, dv.name), h('div', { class: 'muted mono' }, dv.size.join(' × '))),
        h('button', {
          class: 'btn danger small', onclick: (e: Event) => {
            e.stopPropagation();
            d.devices = d.devices.filter((x) => x.id !== dv.id);
            if (selectedId === dv.id) selectedId = null;
            app.saveDesign(d, shell);
            drawPanel(); refresh(); drawReport();
          },
        }, '移除'))),

      h('h3', {}, '通气孔 / 声管'),
      h('div', { class: 'slider-row' },
        h('span', { style: 'width:90px' }, '通气孔 Ø'),
        h('input', {
          type: 'range', min: '1', max: '3', step: '0.1', value: String(d.vent?.diameterMm ?? 1.6),
          oninput: (e: Event) => {
            const v = clampVent(Number((e.target as HTMLInputElement).value));
            if (d.vent) d.vent.diameterMm = v;
            app.saveDesign(d, shell); refresh(); drawReport();
          },
        }),
        h('span', { class: 'mono' }, `${fmt(d.vent?.diameterMm ?? 1.6, 1)}mm`)),
      h('div', { class: 'muted', style: 'margin:4px 0 10px' }, '通气孔与声管沿中心线路径自动生成，跟随壳体联动'),

      reportBox,
      h('button', { class: 'btn', style: 'margin-top:12px;width:100%', onclick: drawReport }, '重新运行检查'),
    );
    drawReport();
  };

  const editorBox = h('div', {});
  const drawDeviceEditor = (dv: DeviceInstance) => {
    const old = panel.querySelector('#device-editor');
    old?.remove();
    const ed = h('div', { id: 'device-editor', class: 'card', style: 'margin-top:10px;background:var(--panel-2)' });
    const axisName = ['X', 'Y', 'Z'];
    ed.append(h('h3', { style: 'margin-top:0' }, `编辑：${dv.name}`));
    for (let i = 0; i < 3; i++) {
      ed.append(h('div', { class: 'slider-row' },
        h('span', { style: 'width:20px' }, axisName[i]),
        h('input', {
          type: 'range', min: '-25', max: '25', step: '0.1', value: String(dv.position[i]),
          oninput: (e: Event) => {
            dv.position[i] = Number((e.target as HTMLInputElement).value);
            app.saveDesign(design!, shell); refresh();
          },
        }),
        h('span', { class: 'mono', style: 'width:52px' }, fmt(dv.position[i], 1))));
    }
    for (let i = 0; i < 3; i++) {
      ed.append(h('div', { class: 'slider-row' },
        h('span', { style: 'width:24px' }, `R${axisName[i]}`),
        h('input', {
          type: 'range', min: '-3.14', max: '3.14', step: '0.05', value: String(dv.rotation[i]),
          oninput: (e: Event) => {
            dv.rotation[i] = Number((e.target as HTMLInputElement).value);
            app.saveDesign(design!, shell); refresh();
          },
        }),
        h('span', { class: 'mono', style: 'width:52px' }, fmt(dv.rotation[i], 2))));
    }
    ed.append(h('div', { class: 'muted' }, '也可在视口里直接拖动器件（拖到表面自动吸附）'));
    panel.append(ed);
    void editorBox;
  };

  // 视口拖动器件
  const bindDeviceDrag = (vp: Viewport) => {
    const canvas = vp.canvas;
    let dragging: DeviceInstance | null = null;
    let offset: Vec3 = [0, 0, 0];
    canvas.addEventListener('pointerdown', (e) => {
      if (!design) return;
      const rect = canvas.getBoundingClientRect();
      const ray = vp.pickRay(e.clientX - rect.left, e.clientY - rect.top);
      let best: { dv: DeviceInstance; t: number } | null = null;
      for (const dv of design.devices) {
        const oc = sub3(dv.position, ray.origin);
        const along = oc[0] * ray.dir[0] + oc[1] * ray.dir[1] + oc[2] * ray.dir[2];
        const closest = add3(ray.origin, scale3Tmp(ray.dir, along));
        const d = dist3(closest, dv.position);
        if (d < Math.max(...dv.size) * 0.7) {
          if (!best || along < best.t) best = { dv, t: along };
        }
      }
      if (best) {
        dragging = best.dv;
        selectedId = best.dv.id;
        offset = [0, 0, 0];
        canvas.setPointerCapture(e.pointerId);
        e.stopImmediatePropagation();
        drawPanel();
      }
    }, true);
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging || !design) return;
      const rect = canvas.getBoundingClientRect();
      const ray = vp.pickRay(e.clientX - rect.left, e.clientY - rect.top);
      const mesh: Mesh = {
        positions: Float32Array.from(im.meshData.positions),
        normals: new Float32Array(im.meshData.positions.length),
        indices: Uint32Array.from(im.meshData.indices),
      };
      // 沿射线放到器件当前深度的位置
      const along = dist3(ray.origin, dragging.position);
      const target = add3(ray.origin, scale3Tmp(ray.dir, along + offset[0]));
      const hit = rayMeshFirstHit(mesh, ray);
      if (hit && hit.t < along) {
        // 已穿出印模表面：吸附到表面内缩 1mm
        dragging.position = add3(ray.origin, scale3Tmp(ray.dir, Math.max(2, hit.t - 1)));
      } else {
        dragging.position = target;
      }
      refresh();
    });
    canvas.addEventListener('pointerup', () => {
      if (dragging && design) {
        app.saveDesign(design, shell);
        drawReport();
        toast(`「${dragging.name}」位置已保存`);
        dragging = null;
      }
    });
  };

  createViewportDeferred(viewHost, [0, 0, 0], 30, {
    layerConfig: defaultLayerConfig(),
    heatMode: false,
    minWall: app.settings.hardMinWall,
    clip: { point: [0, 0, 0], normal: [1, 0, 0], enabled: false },
  }, (vp) => {
    viewport = vp;
    ensure();
    const center = centerOfBounds(im.centerline);
    viewport.frame(center, boundsRadius(im.centerline, center) + 3);
    bindDeviceDrag(viewport);
    drawPanel();
    refresh();
  });
}

function scale3Tmp(dir: Vec3, s: number): Vec3 {
  return [dir[0] * s, dir[1] * s, dir[2] * s];
}
