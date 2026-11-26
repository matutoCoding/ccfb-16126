# Ear Shell Studio · 浏览器耳模/定制机外壳设计系统

纯 TypeScript + 原生 WebGL2（不使用 Three.js）实现。客户档案、耳印网格、设计、STL Blob 和订单截图均保存在浏览器 IndexedDB。

## 运行

```bash
npm install
npm run dev
```

打开终端输出的本地地址。首次启动会自动生成并保存四副测试耳印：

- `scan-normal`：正常耳道
- `scan-narrow`：耳道特别窄
- `scan-sharp-bend`：第二弯很急
- `scan-bubble-damage`：气泡坑 + 未取到/缺损区

其他命令：

```bash
npm test                 # Vitest 几何/STL/碰撞/水密性测试
npm run verify:browser   # 构建并用 Playwright + SwiftShader 跑像素和壁厚硬性验收
npm run smoke:ui         # 六个页面导航 + 工厂订单 UI 冒烟
npm run build            # tsc --noEmit + vite build
```

## 页面与需求对应

1. **客户档案**：左右耳独立听力图、机型、全耳甲/半耳甲/耳道式/深耳道式类型、复诊旧壳新壳记录、订单入口和历次壳型对比。
2. **耳印扫描**：导入/导出二进制和 ASCII STL；长轴切片生成中心线；自动识别耳道口、第一弯、第二弯；标记球可直接在三维视图拖动；自动标出气泡凹坑和开放边/未取到区域。
3. **外壳设计**：耳印中心线/椭圆截面重采样后向内偏移；硬壳壁厚下限 `1.0 mm`，软硅胶下限 `2.0 mm`；沿中心线截短；远端环形封口和多段倒圆。
4. **内部排布**：受话器、A10 电池仓、放大器芯片、面板均按真实毫米尺寸建模；位置/旋转可调；声管和通气孔沿样条路径生成；通气孔直径限制 `1–3 mm`；OBB 与路径采样碰撞报告。
5. **透视检查**：所有层半透明叠加。使用 28 趟 depth peeling，每趟取第 N 个最近片段并前向后积分，不依赖物体/三角形 CPU 排序，因此任意旋转不会出现层级闪烁。每层可单独改颜色和透明度。
6. **逐像素壁厚**：Shell-only depth peeling 把每个片段的 Eye-distance 写入 `R32F` 纹理；像素探针列出各层深度和成对壁段厚度。低于材料下限的像素由屏幕空间热图回染到外壳。悬停时同时给出 CPU 网格射线求交误差。
7. **截面滑条**：沿中心线 `t` 切开外壳，保留深侧；独立生成粉色环形封口/倒角面，避免看起来是空心管。
8. **过第二弯检查**：按中心线曲率、局部耳道半径和 7 mm 前端弦扫掠估算插入间隙；卡点给坐标，并可一键采用建议累计截短长度。
9. **工厂订单**：导出壳体二进制 STL，记录材料颜色、通气孔直径、声管长度和三张 OIT 透视截图；订单存 IndexedDB；同一客户可对比历次长度、最大宽度、弯角、体积和截图。
10. **测试耳模**：见上述四个 seeded scan。

## 关键实现

```
src/
  types.ts                 领域模型
  db.ts                    IndexedDB clients/scans/designs/orders/kv
  seed.ts                  四副程序生理解剖耳模和示例客户
  math/vec.ts              Vec3/Mat4/相机射线
  geom/
    procedural.ts          中心线、平行标架、正常/窄/急弯/气泡缺损
    analysis.ts            导入 STL 后的切片、弯道和开放边分析
    shell.ts               偏移薄壳、封口、倒圆、截面封层面
    raycast.ts             Möller–Trumbore 全交点和壁段配对
    layout.ts              OBB/路径碰撞、默认真实尺寸器件
    insertion.ts           第二弯通过性和建议截短
    stl.ts                 ASCII/二进制 STL 解析与二进制导出
  render/
    Renderer.ts            WebGL2 shader、depth peeling、RGBA32F/R32F targets
    camera.ts              轨道相机和指针控制
  verify/harness.ts        16 层像素参考 + GPU/CPU 壁厚网格比对
  ui/pages/                六个页面
```

## 硬性正确性验收

`npm run verify:browser` 会打开 `?verify=1` 并在真实 WebGL2 上下文中执行：

- **透明排序**：16 个全屏半透明层，逐像素用 CPU 射线收集距离并按精确顺序做 alpha 积分。当前结果为 `102,400` 像素最大通道误差 `0`，容差 `≤2` 色阶。
- **壁厚**：固定相机下对网格采样，GPU `R32F` 层深与同一网格的 CPU 射线求交比较；排除三角形接缝/轮廓覆盖条件样本后，当前结果最大误差约 `0.024 mm`，容差 `<0.05 mm`。

最近一次浏览器 JSON 结果可运行后查看终端；UI 冒烟截图为 `smoke-shell.png`、`smoke-perspective.png`、`smoke-order.png`。

## 说明

这是验配/设计与沟通工具，生成的壁厚、过弯和碰撞结果不能替代合法医疗器械质量管理体系下的结构/生物相容性/声学验证；工厂生产前仍应由具备资质的建模/质检人员复核。
