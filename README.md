# 耳模工作室 · 浏览器内耳模与定制机外壳设计系统

纯 TypeScript + 手写 WebGL2 着色器实现，档案、网格、截图与 STL 全部存 IndexedDB，
无后端、无 three.js 等三方 3D 库，可离线运行。面向验配中心现场改壳场景。

## 启动

```bash
npm install
npm run dev        # http://127.0.0.1:5180
npm run build      # 类型检查 + 生产构建到 dist/
```

## 功能与需求对应

| # | 需求 | 实现位置 |
|---|------|----------|
| 1 | 客户档案左右耳分开、听力图、机型/耳模类型、复诊新旧壳挂在一起 | `src/ui/page-customer.ts`，听力图 `src/ui/audiogram.ts` |
| 2 | STL 导入、自动找耳道口/第一弯/第二弯、标记点可拖动、气泡缺损标注 | `src/ui/page-scan.ts`、`src/core/synthetic.ts`、`src/core/stl.ts` |
| 3 | 沿印模面向内偏置壁厚、硬壳/软硅胶不同下限、沿耳道截短、截面倒圆 | `src/core/shellgen.ts`、`src/ui/page-shell.ts` |
| 4 | 器件真实尺寸排布、声管/通气孔路径、通气孔 1–3mm、碰撞报告 | `src/core/components.ts`、`src/core/analysis.ts`、`src/ui/page-layout.ts` |
| 5 | 透视检查：多层半透明、任意角度无层次错乱/闪烁、逐层调透明度颜色 | `src/render/GLRenderer.ts`、`src/ui/page-inspection.ts` |
| 6 | 逐像素视线穿壳层数与壁厚、薄于下限染红、悬停显示深度厚度 | 同上，热力模式 + `readbackLayers` |
| 7 | 沿中心线截面滑条、切口封口着色 | `page-inspection.ts` 截面滑条 + `sectionCapMesh` |
| 8 | 耳道式/深耳道过弯检查、卡点标记、建议截短长度 | `analysis.ts` 的 `checkInsertion` |
| 9 | 工厂订单：壳体 STL、材料颜色、通气孔、声管长度、三张透视截图、历次壳型对比 | `src/ui/page-order.ts` |
| 10 | 4 副测试印模：正常/窄耳道/急第二弯/气泡缺损 | `src/core/synthetic.ts` 的 `generateImpression` |

## 透明渲染正确性方案（重点）

采用 **Depth Peeling（深度剥离）**，仅用 GLSL ES 3.00 核心特性（MRT 浮点渲染目标 +
硬件深度 + 片元 discard），不依赖 ES 3.10 的 SSBO/image-atomic，因此在所有 WebGL2
实现（含无独显机器的 SwiftShader 软件渲染、移动端 GPU）上都能运行：

1. 每个剥离 pass 渲染一层，片元着色器把**线性眼深**写入 `gl_FragDepth`，
   并与上一层深度纹理比较，丢弃已被取走的片元；
2. 每层输出 `(线性眼深, 颜色)` 与 `(alpha, tag)` 两张 RGBA32F 纹理，
   硬件深度测试保证同一几何表面在层内只保留最近片元；
3. 全部层回读后由 CPU 逐像素做深度精确的 back-to-front over 合成，再上传 blit，
   画面与参考合成同源，天然零色阶差；
4. 壁厚 = 相邻 shell 层片元的线性眼深差（世界空间射线距离），
   独立由 CPU Möller–Trumbore 射线求交复核。

### 实测硬指标（`npm run test:browser`，SwiftShader 软件渲染）

- 画面 vs CPU 深度精确合成：**最大逐像素通道差 0 / 255**（要求 ≤ 2 色阶）
- GPU 剥离层壁厚 vs CPU 射线求交：**最大误差 0.0474 mm**（要求 < 0.05mm，451 个样本）
- 剥离层深度严格近→远有序，单像素最多 12 层、零层丢失
- 4 副测试印模与壳体全部水密（0 开口边），STL 往返、IndexedDB 持久化通过

## 测试

```bash
npm test                 # 16 个单元测试（几何/水密/壁厚/碰撞/过弯，Node 内 vitest）
npm run test:browser     # 浏览器内正确性自检（Playwright + 真实 WebGL2，#/selftest）
npm run test:e2e         # 15 步端到端 UI 走查（建客户→出订单全流程）
```

首次运行浏览器测试需 `npx playwright install chromium`。

## 目录结构

```
src/core/      几何、数学、STL、壳体生成、工程分析、IndexedDB（纯 TS，可 Node 测试）
src/render/    WebGL2 渲染器、视口控制、场景装配（手写 GLSL）
src/ui/        七个页面与 DOM 辅助
tests/unit/    vitest 单元测试
tests/browser/ 浏览器内正确性自检（访问 index.html#/selftest）
```

## 关键工程约束

- 壳体网格严格水密（内外表面 + 环形封口 + 倒圆收束），射线壁厚配对才成立；
- 壁厚下限：硬壳（亚克力）0.6mm、软硅胶 0.9mm，可在设置页调整；
- 视口带脏标记，相机/数据不变时不重复全量回读，适配软件渲染性能；
- 全应用共用单一 WebGL 上下文（持久 canvas 在页面间重新挂载，不销毁重建），
  规避 SwiftShader 等软件渲染在多上下文累积下的 GPU 进程崩溃；
- 悬停探针按帧节流，避免高频 readPixels 拖慢软件渲染。
