// 深度剥离渲染器：精确顺序无关透明（OIT）。
// 每个剥离 pass 用 MRT 同时输出：location0 颜色（front-to-back 累积）、location1 该层深度编码。
// 层间遮挡用 DEPTH 纹理在着色器内采样；深度编码存 RGBA16F，支持 FLOAT 直接回读（高精度壁厚）。
import { GpuMesh, createProgram, makeTexture, makeDepthTexture, checkFbo } from './glCore';
import { OrbitCamera } from './camera';
import { SCENE_VS, FIRST_FS, PEEL_FS, DEPTH_COPY_VS, DEPTH_COPY_FS, COMPOSITE_VS, COMPOSITE_FS, SIMPLE_FS } from './shaders';
import { Mat4, Vec3 } from '../core/math';

export interface RenderItem {
  mesh: GpuMesh;
  color: Vec3;
  alpha: number;
  visible: boolean;
  id: string;
}

const MAX_LAYERS = 24;
const BG: Vec3 = [0.12, 0.13, 0.16];

export class DepthPeelingRenderer {
  private progFirst: WebGLProgram;
  private progPeel: WebGLProgram;
  private progDepthCopy: WebGLProgram;
  private progComposite: WebGLProgram;
  private progSimple: WebGLProgram;
  private fbo: WebGLFramebuffer;
  private colorTex: WebGLTexture | null = null;
  private compositeTex: WebGLTexture | null = null;
  private depthTex: WebGLTexture[] = [];
  private depthColorTex: WebGLTexture[] = [];
  private vaoQuad: WebGLVertexArrayObject;
  private width = 0;
  private height = 0;
  layerCount = 0;
  private capturedLayerDepths: Float32Array[] = [];

  constructor(private gl: WebGL2RenderingContext, private camera: OrbitCamera) {
    this.progFirst = createProgram(gl, SCENE_VS, FIRST_FS);
    this.progPeel = createProgram(gl, SCENE_VS, PEEL_FS);
    this.progDepthCopy = createProgram(gl, DEPTH_COPY_VS, DEPTH_COPY_FS);
    this.progComposite = createProgram(gl, COMPOSITE_VS, COMPOSITE_FS);
    this.progSimple = createProgram(gl, SCENE_VS, SIMPLE_FS);
    this.fbo = gl.createFramebuffer()!;
    this.vaoQuad = gl.createVertexArray()!;
  }

  resetTargets(): void {
    this.width = 0;
    this.height = 0;
  }

  private ensureTargets(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.width = w;
    this.height = h;
    if (this.colorTex) gl.deleteTexture(this.colorTex);
    if (this.compositeTex) gl.deleteTexture(this.compositeTex);
    for (const t of this.depthTex) gl.deleteTexture(t);
    for (const t of this.depthColorTex) gl.deleteTexture(t);
    this.colorTex = makeTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.compositeTex = makeTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.depthTex = [];
    this.depthColorTex = [];
    for (let i = 0; i < MAX_LAYERS; i++) {
      this.depthTex.push(makeDepthTexture(gl, w, h));
      this.depthColorTex.push(makeTexture(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT));
    }
  }

  private setSceneUniforms(prog: WebGLProgram, viewProj: Mat4, it: RenderItem): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uViewProj'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(prog, 'uColor'), it.color);
    gl.uniform1f(gl.getUniformLocation(prog, 'uAlpha'), it.alpha);
  }

  private drawAll(items: RenderItem[], prog: WebGLProgram, viewProj: Mat4): void {
    const gl = this.gl;
    gl.useProgram(prog);
    for (const it of items) {
      if (!it.visible) continue;
      this.setSceneUniforms(prog, viewProj, it);
      it.mesh.draw();
    }
  }

  // 绑定单颜色目标 + 深度附件
  private bindTarget(color: WebGLTexture | null, depth: WebGLTexture | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    checkFbo(gl);
  }

  // 把 depthTex 全屏采样并编码写入 depthColorTex（无几何重绘）
  private copyDepth(layer: number, w: number, h: number): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    this.bindTarget(this.depthColorTex[layer], null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progDepthCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex[layer]);
    gl.uniform1i(gl.getUniformLocation(this.progDepthCopy, 'uDepth'), 0);
    gl.uniform1f(gl.getUniformLocation(this.progDepthCopy, 'uNear'), this.camera.near);
    gl.uniform1f(gl.getUniformLocation(this.progDepthCopy, 'uFar'), this.camera.far);
    gl.bindVertexArray(this.vaoQuad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }

  render(items: RenderItem[], w: number, h: number, transparent: boolean): number {
    const gl = this.gl;
    this.ensureTargets(w, h);
    const viewProj = this.camera.viewProj(w / h);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);

    if (!transparent) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.drawBuffers([gl.BACK]);
      gl.clearColor(BG[0], BG[1], BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      this.drawAll(items, this.progSimple, viewProj);
      this.layerCount = 1;
      this.capturedLayerDepths = [];
      return 1;
    }

    // ---- 第 0 层：颜色进 colorTex，最近深度进 depthTex[0] ----
    gl.clearColor(0, 0, 0, 0);
    this.bindTarget(this.colorTex, this.depthTex[0]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawAll(items, this.progFirst, viewProj);
    this.copyDepth(0, w, h);

    // ---- 逐层剥离 ----
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let layers = 0;
    for (let peel = 0; peel < MAX_LAYERS - 1; peel++) {
      // 颜色累积进 colorTex，本层深度写 depthTex[peel+1]
      this.bindTarget(this.colorTex, this.depthTex[peel + 1]);
      gl.clear(gl.DEPTH_BUFFER_BIT);

      gl.useProgram(this.progPeel);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex[peel]);
      gl.uniform1i(gl.getUniformLocation(this.progPeel, 'uPrevDepth'), 0);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progPeel, 'uViewProj'), false, viewProj);
      for (const it of items) {
        if (!it.visible) continue;
        this.setSceneUniforms(this.progPeel, viewProj, it);
        it.mesh.draw();
      }

      // 全屏复制本层深度到编码纹理（在混合禁用状态）
      gl.disable(gl.BLEND);
      this.copyDepth(peel + 1, w, h);
      gl.enable(gl.BLEND);

      const frgba = this.readFloatRGBA(this.depthColorTex[peel + 1], w, h);
      let nz = 0;
      for (let i = 0; i < frgba.length; i += 4) if (frgba[i] + frgba[i + 1] > 0) nz++;
      if (nz === 0) break;
      layers++;
    }
    gl.disable(gl.BLEND);

    // ---- 合成到离屏 compositeTex，再 blit 到默认帧缓冲 ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.compositeTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    checkFbo(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progComposite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.uniform1i(gl.getUniformLocation(this.progComposite, 'uColor'), 0);
    gl.uniform3fv(gl.getUniformLocation(this.progComposite, 'uBg'), BG);
    gl.bindVertexArray(this.vaoQuad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DEPTH_TEST);

    this.layerCount = layers + 1;
    return this.layerCount;
  }

  private readFloatRGBA(tex: WebGLTexture, w: number, h: number): Float32Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    const buf = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    return buf;
  }

  // 回读每层深度：RGBA16F 存的是归一化线性深度，还原为相机空间线性距离 mm，背景 0
  readLayerDepths(w: number, h: number): Float32Array[] {
    const gl = this.gl;
    const n = this.camera.near, f = this.camera.far;
    const out: Float32Array[] = [];
    for (let layer = 0; layer < this.layerCount; layer++) {
      const rgba = this.readFloatRGBA(this.depthColorTex[layer], w, h);
      const lin = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        // r 高 16 位 + g 低 16 位残差，重建归一化线性深度
        const norm = rgba[i * 4] + rgba[i * 4 + 1];
        if (norm <= 0 || rgba[i * 4] <= 0) { lin[i] = 0; continue; }
        lin[i] = n + norm * (f - n);
      }
      out.push(lin);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.capturedLayerDepths = out;
    return out;
  }

  pixelDepths(px: number, py: number, w: number, h: number): number[] {
    const fy = h - 1 - py;
    const idx = fy * w + px;
    return this.capturedLayerDepths.map((t) => t[idx]).filter((d) => d > 0);
  }

  readColor(w: number, h: number): Uint8Array {
    return this.blitReadRGBA8(this.compositeTex!, w, h);
  }

  private blitReadRGBA8(tex: WebGLTexture, w: number, h: number): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.colorTex) gl.deleteTexture(this.colorTex);
    if (this.compositeTex) gl.deleteTexture(this.compositeTex);
    for (const t of this.depthTex) gl.deleteTexture(t);
    for (const t of this.depthColorTex) gl.deleteTexture(t);
    gl.deleteFramebuffer(this.fbo);
  }
}
