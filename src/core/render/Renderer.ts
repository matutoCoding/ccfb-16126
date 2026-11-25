import type { LayerId, LayerStyle, MeshData, Vec3 } from '../../types';
import {
  createLayerArray,
  createProgram,
  createRenderTarget,
  copyIntoLayerArray,
  disposeMesh,
  disposeRenderTarget,
  uploadMesh,
  type GLProgram,
  type GPUMesh,
  type LayerArrayTextures,
  type RenderTarget,
  FULLSCREEN_VS,
} from './gl';
import {
  ANALYSIS_FS,
  BLEND_FS,
  LAYER_PACK_FS,
  MARKER_FS,
  PEEL_FS,
  SCENE_VS,
  SOLID_FS,
} from './shaders';
import {
  mat4Identity,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  screenRay,
  type Mat4,
} from './mat4';

export interface SceneMesh {
  id: string;
  layerId: LayerId | 'impression' | 'marker';
  mesh: MeshData;
  color: Vec3;
  alpha: number;
  visible: boolean;
}

export interface PixelLayerInfo {
  index: number;
  layerId: number;
  depthMm: number;
}

export interface PixelInspection {
  layers: PixelLayerInfo[];
  shellSegments: { thickness: number; depthEnter: number }[];
  minWall: number;
}

const LAYER_IDS: LayerId[] = ['shell', 'tube', 'vent', 'receiver', 'battery', 'faceplate', 'amplifier'];
export const MAX_LAYERS = 12;

interface PeelTarget {
  rt: RenderTarget; // MRT：color[0]=R32F 深度, color[1]=R8UI 层ID，共用同一深度缓冲
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private peelProgram: GLProgram;
  private blendProgram: GLProgram;
  private analysisProgram: GLProgram;
  private solidProgram: GLProgram;
  private markerProgram: GLProgram;
  private packProgram: GLProgram;
  private gpuMeshes = new Map<string, GPUMesh>();
  private scene: SceneMesh[] = [];
  private width = 1;
  private height = 1;

  private peelTargets: PeelTarget[] = [];
  private layerArray: LayerArrayTextures | null = null;
  private blendRT: RenderTarget | null = null;
  private blendRT2: RenderTarget | null = null;
  private depthMinRT: RenderTarget | null = null;
  private vaoEmpty: WebGLVertexArrayObject;

  private eye: Vec3 = [26, 20, 30];
  private target: Vec3 = [0, 0, 6];
  private up: Vec3 = [0, 0, 1];
  private fov = (42 * Math.PI) / 180;
  private near = 1;
  private far = 150;
  proj: Mat4 = mat4Identity();
  view: Mat4 = mat4Identity();
  private invProjView: Mat4 = mat4Identity();

  wallMin = 0.8;
  thinRedEnabled = true;
  maxPeelLayers = MAX_LAYERS;
  private layerStyles = new Map<LayerId, LayerStyle>();

  /** 修改剥离层数需重建全部渲染目标与纹理数组 */
  setMaxPeelLayers(n: number): void {
    const clamped = Math.max(4, Math.min(MAX_LAYERS, Math.round(n)));
    if (clamped === this.maxPeelLayers) return;
    this.maxPeelLayers = clamped;
    this.allocateTargets();
  }

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('缺少 EXT_color_buffer_float，无法进行浮点深度剥离');
    }
    gl.getExtension('OES_texture_float_linear');
    this.peelProgram = createProgram(gl, SCENE_VS, PEEL_FS);
    this.blendProgram = createProgram(gl, SCENE_VS, BLEND_FS);
    this.analysisProgram = createProgram(gl, FULLSCREEN_VS, ANALYSIS_FS);
    this.solidProgram = createProgram(gl, SCENE_VS, SOLID_FS);
    this.markerProgram = createProgram(gl, SCENE_VS, MARKER_FS);
    this.packProgram = createProgram(gl, FULLSCREEN_VS, LAYER_PACK_FS);
    this.vaoEmpty = gl.createVertexArray()!;
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // 壳体内外双面都要参与剥离
    gl.clearColor(0.07, 0.08, 0.1, 1);
  }

  setSize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = Math.max(2, Math.floor(w));
    this.height = Math.max(2, Math.floor(h));
    (this.gl.canvas as HTMLCanvasElement).width = this.width;
    (this.gl.canvas as HTMLCanvasElement).height = this.height;
    this.allocateTargets();
  }

  setLayerStyles(styles: LayerStyle[]): void {
    this.layerStyles.clear();
    for (const s of styles) this.layerStyles.set(s.id, s);
  }

  private allocateTargets(): void {
    const gl = this.gl;
    for (const t of this.peelTargets) {
      disposeRenderTarget(gl, t.rt);
    }
    if (this.layerArray) gl.deleteTexture(this.layerArray.depthId);
    if (this.blendRT) disposeRenderTarget(gl, this.blendRT);
    if (this.blendRT2) disposeRenderTarget(gl, this.blendRT2);
    if (this.depthMinRT) disposeRenderTarget(gl, this.depthMinRT);
    this.peelTargets = [];
    const depthFmt = { internal: gl.R32F, format: gl.RED, type: gl.FLOAT };
    const idFmt = { internal: gl.R32F, format: gl.RED, type: gl.FLOAT };
    // 混合累加用全浮点 RGBA32F，避免 16F 在多层 F2B 累加下的精度损失
    const rgbaFmt = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
    const depthBuffer = gl.DEPTH_COMPONENT32F; // 深度附件必须用 DEPTH 系列内部格式
    for (let i = 0; i < this.maxPeelLayers; i++) {
      // 单 FBO 双颜色附件：深度与 ID 一次绘制同时写出，保证逐像素严格一致
      this.peelTargets.push({
        rt: createRenderTarget(gl, this.width, this.height, [depthFmt, idFmt], depthBuffer),
      });
    }
    this.layerArray = createLayerArray(gl, this.width, this.height, this.maxPeelLayers);
    this.blendRT = createRenderTarget(gl, this.width, this.height, [rgbaFmt], depthBuffer);
    this.blendRT2 = createRenderTarget(gl, this.width, this.height, [rgbaFmt], depthBuffer);
    this.depthMinRT = createRenderTarget(gl, this.width, this.height, [depthFmt], depthBuffer);
  }

  setScene(meshes: SceneMesh[]): void {
    const gl = this.gl;
    const keep = new Set(meshes.map((m) => m.id));
    for (const [id, gpu] of this.gpuMeshes) {
      if (!keep.has(id)) {
        disposeMesh(gl, gpu);
        this.gpuMeshes.delete(id);
      }
    }
    for (const m of meshes) {
      if (!this.gpuMeshes.has(m.id)) this.gpuMeshes.set(m.id, uploadMesh(gl, m.mesh));
    }
    this.scene = meshes;
  }

  setCamera(eye: Vec3, target: Vec3): void {
    this.eye = eye;
    this.target = target;
  }

  getCamera(): { eye: Vec3; target: Vec3 } {
    return { eye: this.eye, target: this.target };
  }

  private updateMatrices(): void {
    const aspect = this.width / this.height;
    this.proj = mat4Perspective(this.fov, aspect, this.near, this.far);
    this.view = mat4LookAt(this.eye, this.target, this.up);
    this.invProjView = mat4Invert(mat4Multiply(this.proj, this.view));
  }

  screenToRay(clientX: number, clientY: number): { origin: Vec3; dir: Vec3 } {
    const rect = (this.gl.canvas as HTMLCanvasElement).getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    return screenRay(this.invProjView, ndcX, ndcY);
  }

  /** 主渲染：深度剥离 + F2B 精确混合 + 逐像素分析 */
  render(): void {
    const gl = this.gl;
    // 渲染目标尚未按当前层数/尺寸分配时跳过本帧，避免 FBO 越界
    if (this.peelTargets.length < this.maxPeelLayers || !this.layerArray) return;
    this.updateMatrices();
    const mvp = mat4Multiply(this.proj, this.view);
    const visible = this.scene.filter((m) => m.visible);
    const quad = this.vaoEmpty;

    // ---------- pass 1: 逐层深度剥离（单 FBO + MRT，深度与 ID 同时写出） ----------
    let prevDepthTex: WebGLTexture | null = null;
    for (let pass = 0; pass < this.maxPeelLayers; pass++) {
      const target = this.peelTargets[pass].rt;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      // 深度哨兵 1.0、ID 哨兵 255（浮点附件）
      gl.clearBufferfv(gl.COLOR, 0, [1, 0, 0, 0]);
      gl.clearBufferfv(gl.COLOR, 1, [255, 0, 0, 0]);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.disable(gl.BLEND);
      gl.useProgram(this.peelProgram.program);
      gl.uniformMatrix4fv(this.peelProgram.uniforms.get('uMVP')!, false, mvp);
      gl.uniformMatrix4fv(this.peelProgram.uniforms.get('uModel')!, false, mat4Identity());
      gl.uniform1i(this.peelProgram.uniforms.get('uPass')!, pass);
      if (prevDepthTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prevDepthTex);
        gl.uniform1i(this.peelProgram.uniforms.get('uPrevDepth')!, 0);
      }
      for (const m of visible) {
        if (m.layerId === 'marker') continue;
        const gpu = this.gpuMeshes.get(m.id);
        if (!gpu) continue;
        gl.uniform1i(this.peelProgram.uniforms.get('uLayerId')!, this.layerNumber(m.layerId));
        gl.bindVertexArray(gpu.vao);
        gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(quad);
      prevDepthTex = target.color[0];

      // 打包进 2D 纹理数组的第 pass 个切片（单采样器常量索引，规避动态采样器限制）
      copyIntoLayerArray(
        gl,
        this.layerArray!,
        pass,
        target.color[0],
        target.color[1],
        this.packProgram,
        this.vaoEmpty,
      );
    }

    // 最近深度（背景判定）
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthMinRT!.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearBufferfv(gl.COLOR, 0, [1, 0, 0, 0]);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.solidProgram.program);
    gl.uniformMatrix4fv(this.solidProgram.uniforms.get('uMVP')!, false, mvp);
    gl.uniformMatrix4fv(this.solidProgram.uniforms.get('uModel')!, false, mat4Identity());
    gl.uniform3fv(this.solidProgram.uniforms.get('uCamPos')!, this.eye);
    gl.uniform1f(this.solidProgram.uniforms.get('uAlpha')!, 1);
    for (const m of visible) {
      if (m.layerId === 'marker') continue;
      const gpu = this.gpuMeshes.get(m.id);
      if (!gpu) continue;
      gl.uniform3fv(this.solidProgram.uniforms.get('uColor')!, m.color);
      gl.bindVertexArray(gpu.vao);
      gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(quad);

    // ---------- pass 2: F2B 精确顺序混合 ----------
    let ping = this.blendRT!;
    let pong = this.blendRT2!;
    // 两个混合累加缓冲先清零（ping-pong 首跳读取的源必须是 0）
    for (const rt of [ping, pong]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    }
    prevDepthTex = null;
    for (let pass = 0; pass < this.maxPeelLayers; pass++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pong.fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      // 实测：关闭硬件深度、完全由着色器按剥离纹理软件筛选，F2B 颜色精度最高
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.BLEND);
      gl.useProgram(this.blendProgram.program);
      gl.uniformMatrix4fv(this.blendProgram.uniforms.get('uMVP')!, false, mvp);
      gl.uniformMatrix4fv(this.blendProgram.uniforms.get('uModel')!, false, mat4Identity());
      gl.uniform1i(this.blendProgram.uniforms.get('uPass')!, pass);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ping.color[0]);
      gl.uniform1i(this.blendProgram.uniforms.get('uAccumColor')!, 0);
      if (prevDepthTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, prevDepthTex);
        gl.uniform1i(this.blendProgram.uniforms.get('uPrevDepth')!, 1);
      } else {
        // pass0 绑定哨兵深度纹理（值为 1.0），避免采样未初始化纹理单元
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.depthMinRT!.color[0]);
        gl.uniform1i(this.blendProgram.uniforms.get('uPrevDepth')!, 1);
      }
      for (const m of visible) {
        if (m.layerId === 'marker') continue;
        const gpu = this.gpuMeshes.get(m.id);
        if (!gpu) continue;
        const style = this.layerStyles.get(m.layerId as LayerId);
        gl.uniform3fv(this.blendProgram.uniforms.get('uColor')!, style?.color ?? m.color);
        gl.uniform1f(this.blendProgram.uniforms.get('uAlpha')!, style?.alpha ?? m.alpha);
        gl.uniform1i(this.blendProgram.uniforms.get('uLayerId')!, this.layerNumber(m.layerId));
        gl.bindVertexArray(gpu.vao);
        gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(quad);
      prevDepthTex = this.peelTargets[pass].rt.color[0];
      [ping, pong] = [pong, ping];
    }
    // 恢复深度写入，供后续逐像素分析与标志点 pass 使用
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);

    // ---------- pass 3: 逐像素分析 + 最终合成 ----------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.analysisProgram.program);
    // 仅占用 3 个纹理单元：层数组、合成色、最近深度
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.layerArray!.depthId);
    gl.uniform1i(this.analysisProgram.uniforms.get('uLayerArray')!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ping.color[0]);
    gl.uniform1i(this.analysisProgram.uniforms.get('uBlendColor')!, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.depthMinRT!.color[0]);
    gl.uniform1i(this.analysisProgram.uniforms.get('uDepthMin')!, 2);
    gl.uniform2fv(this.analysisProgram.uniforms.get('uCameraNearFar')!, [this.near, this.far]);
    gl.uniform1f(this.analysisProgram.uniforms.get('uWallMin')!, this.wallMin);
    gl.uniform1f(this.analysisProgram.uniforms.get('uThinRed')!, this.thinRedEnabled ? 1 : 0);
    gl.uniform1i(this.analysisProgram.uniforms.get('uMaxLayers')!, this.maxPeelLayers);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.renderMarkers(mvp);
  }

  private renderMarkers(mvp: Mat4): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(this.markerProgram.program);
    gl.uniformMatrix4fv(this.markerProgram.uniforms.get('uMVP')!, false, mvp);
    gl.uniformMatrix4fv(this.markerProgram.uniforms.get('uModel')!, false, mat4Identity());
    for (const m of this.scene) {
      if (m.layerId !== 'marker' || !m.visible) continue;
      const gpu = this.gpuMeshes.get(m.id);
      if (!gpu) continue;
      gl.uniform3fv(this.markerProgram.uniforms.get('uColor')!, m.color);
      gl.uniform1f(this.markerProgram.uniforms.get('uSelected')!, m.alpha > 1 ? 1 : 0);
      gl.bindVertexArray(gpu.vao);
      gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(this.vaoEmpty);
  }

  private layerNumber(layer: SceneMesh['layerId']): number {
    if (layer === 'impression' || layer === 'marker') return 0;
    return LAYER_IDS.indexOf(layer);
  }

  /** 读取某像素的全部层深度/ID（悬停信息用） */
  inspectPixel(clientX: number, clientY: number): PixelInspection | null {
    const gl = this.gl;
    const rect = (this.gl.canvas as HTMLCanvasElement).getBoundingClientRect();
    const px = Math.floor(((clientX - rect.left) / rect.width) * this.width);
    const py = this.height - 1 - Math.floor(((clientY - rect.top) / rect.height) * this.height);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return null;
    const layers: PixelLayerInfo[] = [];
    const depthBuf = new Float32Array(1);
    const idBuf = new Float32Array(1);
    for (let pass = 0; pass < this.maxPeelLayers; pass++) {
      const t = this.peelTargets[pass].rt;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(px, py, 1, 1, gl.RED, gl.FLOAT, depthBuf);
      const depthNdc = depthBuf[0];
      if (depthNdc >= 1 || depthNdc <= 0) continue;
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(px, py, 1, 1, gl.RED, gl.FLOAT, idBuf);
      const layerId = Math.round(idBuf[0]);
      layers.push({
        index: pass,
        layerId: layerId >= 255 ? -1 : layerId,
        depthMm: this.linearize(depthNdc),
      });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const shellSegments: { thickness: number; depthEnter: number }[] = [];
    let minWall = Infinity;
    for (let i = 0; i + 1 < layers.length; i++) {
      if (layers[i].layerId === 0 && layers[i + 1].layerId === 0) {
        const thickness = layers[i + 1].depthMm - layers[i].depthMm;
        shellSegments.push({ thickness, depthEnter: layers[i].depthMm });
        minWall = Math.min(minWall, thickness);
        i++;
      }
    }
    return { layers, shellSegments, minWall: Number.isFinite(minWall) ? minWall : -1 };
  }

  private linearize(d: number): number {
    const z = d * 2 - 1;
    return (2 * this.near * this.far) / (this.far + this.near - z * (this.far - this.near));
  }

  /** 读取整屏各剥离层（自检页 CPU 参考对比用） */
  readPeelTargets(): { depth: Float32Array; id: Uint8Array }[] {
    const gl = this.gl;
    const out: { depth: Float32Array; id: Uint8Array }[] = [];
    if (this.peelTargets.length < this.maxPeelLayers) return out;
    const n = this.width * this.height;
    for (let pass = 0; pass < this.maxPeelLayers; pass++) {
      const t = this.peelTargets[pass].rt;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const depth = new Float32Array(n);
      gl.readPixels(0, 0, this.width, this.height, gl.RED, gl.FLOAT, depth);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      const idFloat = new Float32Array(n);
      gl.readPixels(0, 0, this.width, this.height, gl.RED, gl.FLOAT, idFloat);
      const id = new Uint8Array(n);
      for (let k = 0; k < n; k++) id[k] = Math.round(idFloat[k]);
      out.push({ depth, id });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  readCompositePixels(): Uint8Array {
    const gl = this.gl;
    const buf = new Uint8Array(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** 缓冲区像素坐标 -> canvas CSS 像素坐标（供自检模块调用 screenToRay） */
  bufferToClient(px: number, pyTop: number): { x: number; y: number } {
    const rect = (this.gl.canvas as HTMLCanvasElement).getBoundingClientRect();
    return {
      x: rect.left + (px / this.width) * rect.width,
      y: rect.top + (pyTop / this.height) * rect.height,
    };
  }

  snapshot(): string {
    return (this.gl.canvas as HTMLCanvasElement).toDataURL('image/png');
  }

  dispose(): void {
    const gl = this.gl;
    for (const gpu of this.gpuMeshes.values()) disposeMesh(gl, gpu);
    for (const t of this.peelTargets) {
      disposeRenderTarget(gl, t.rt);
    }
    if (this.layerArray) gl.deleteTexture(this.layerArray.depthId);
    if (this.blendRT) disposeRenderTarget(gl, this.blendRT);
    if (this.blendRT2) disposeRenderTarget(gl, this.blendRT2);
    if (this.depthMinRT) disposeRenderTarget(gl, this.depthMinRT);
  }
}
