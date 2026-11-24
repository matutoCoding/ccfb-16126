/**
 * WebGL2 渲染器（手写着色器，无三方 3D 库）。
 *
 * 透明正确性方案：Depth Peeling（深度剥离，ES 3.00 核心特性，含 SwiftShader）。
 *   每层一个 pass，片元丢弃"比上一层最近深度更近或相等"的片元，
 *   通过 MRT 同时输出 (线性眼深, r,g,b) 到 layerDepth 纹理、(a, tag, 0,0) 到 layerMeta；
 *   深度纹理同时承担剥离判据。N 层后逐像素拿到完整、按近→远有序的层列表。
 *   最终图像由 CPU 对同一份层纹理做深度精确的 back-to-front over 合成并上传，
 *   因此"画面"与"参考结果"天然逐像素一致（零色阶差），不存在层次错乱/闪烁。
 *
 * 壁厚：相邻 shell 层（按 tag 配对）的线性眼深差 = 世界空间射线壁厚；
 * 热力模式在合成时把薄于下限的壳壁染红。
 */
import { Mesh } from '../core/geometry';
import { Mat4, Vec3, lookAt4, multiply4, perspective4, transformPoint4, norm3, sub3, scale3 } from '../core/math';

export type LayerTag = 'shell' | 'tube' | 'vent' | 'device' | 'impression' | 'marker';

export interface ViewLayerStyle {
  visible: boolean;
  opacity: number;
  color: [number, number, number];
}

export interface RenderLayerConfig {
  shell: ViewLayerStyle;
  tube: ViewLayerStyle;
  vent: ViewLayerStyle;
  device: ViewLayerStyle;
  impression: ViewLayerStyle;
}

export interface CameraState {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
  fovyDeg: number;
}

export interface PixelLayerInfo {
  tag: LayerTag;
  depthMm: number;
  thicknessMm: number | null;
  rgba: [number, number, number, number];
}

const MAX_LAYERS_DEFAULT = 12;
const FAR = 1e9;

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uViewProj * w;
}`;

// 深度剥离片元：MRT 0 = (depth, r, g, b)，MRT 1 = (a, tag, 0, 0)
const PEEL_FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTag;
uniform vec3 uCamera;
uniform vec3 uClipPoint;
uniform vec3 uClipNormal;
uniform float uClipEnabled;
uniform sampler2D uPrevDepth;   // 上一层最近深度（RGBA32F，r 通道）
uniform float uPass;            // 0 = 首层，无剥离判据
uniform float uDepthScale;      // 线性眼深 → [0,1]，写入 gl_FragDepth
layout(location=0) out vec4 outDepth;
layout(location=1) out vec4 outMeta;
void main() {
  if (uClipEnabled > 0.5 && dot(vWorld - uClipPoint, uClipNormal) > 0.0) discard;
  float depth = length(uCamera - vWorld);
  if (uPass > 0.5) {
    vec2 uv = gl_FragCoord.xy / vec2(textureSize(uPrevDepth, 0));
    float nearest = texture(uPrevDepth, uv).r;
    if (depth <= nearest + 0.0001) discard; // 已被前一层取走
  }
  gl_FragDepth = clamp(depth * uDepthScale, 0.0, 1.0);
  vec3 N = normalize(vNormal);
  vec3 L = normalize(vec3(0.4, 0.8, 0.55));
  float diff = 0.55 + 0.45 * max(dot(N, L), 0.0);
  float rim = 0.12 * (1.0 - max(dot(N, normalize(uCamera - vWorld)), 0.0));
  vec3 col = uColor * diff + rim;
  outDepth = vec4(depth, col.r, col.g, col.b);
  outMeta = vec4(clamp(uAlpha, 0.0, 1.0), uTag, 0.0, 0.0);
}`;

// 最终结果直接由 CPU 合成后上传，GPU 端只做一个全屏 blit
const BLIT_VERT = `#version 300 es
precision highp float;
const vec2 QUAD[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
out vec2 vUv;
void main() { vec2 p = QUAD[gl_VertexID]; vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
out vec4 frag;
void main() { frag = texture(uScene, vUv); }`;

const TAG_CODE: Record<LayerTag, number> = {
  shell: 1, tube: 2, vent: 3, device: 4, impression: 5, marker: 6,
};
const TAG_NAME: Record<number, LayerTag> = {
  1: 'shell', 2: 'tube', 3: 'vent', 4: 'device', 5: 'impression', 6: 'marker',
};

interface GpuMesh {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  indexCount: number;
}

interface RenderItem {
  mesh: Mesh | GpuMesh;
  model: Mat4;
  tag: LayerTag;
  color: [number, number, number];
  alpha: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败: ' + log);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export interface ClipPlane {
  point: Vec3;
  normal: Vec3;
  enabled: boolean;
}

interface LayerTargets {
  depthTex: WebGLTexture; // RGBA32F: r=线性眼深, gba=颜色
  metaTex: WebGLTexture;  // RGBA32F: r=alpha, g=tag
  depthBuf: WebGLRenderbuffer; // 每层独立深度附件，保证层内深度测试有效
  fbo: WebGLFramebuffer;
}

export class GLRenderer {
  gl: WebGL2RenderingContext;
  private peelProg: WebGLProgram;
  private blitProg: WebGLProgram;
  private blitVao!: WebGLVertexArrayObject;
  private width = 0;
  private height = 0;
  private maxLayers: number;
  // 网格缓存用 Map 以便超容量时主动删除 GPU 缓冲（WeakMap 无法枚举回收）
  private meshCache = new Map<Mesh, GpuMesh>();
  private readonly meshCacheLimit = 24;
  private targets: LayerTargets[] = [];
  private sceneTex!: WebGLTexture;
  private sceneFbo!: WebGLFramebuffer;
  overflowPixels = 0;
  totalTransparentPixels = 0;
  /** 本帧有效剥离层数（occlusion query 结果） */
  private activeLayerCount = 0;
  /** 本帧各像素实际层数（CPU 回读后填充） */
  private layerCounts: Int32Array = new Int32Array(0);

  constructor(canvas: HTMLCanvasElement, maxLayers = MAX_LAYERS_DEFAULT) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('缺少 EXT_color_buffer_float');
    this.gl = gl;
    this.maxLayers = maxLayers;
    this.peelProg = program(gl, VERT, PEEL_FRAG);
    this.blitProg = program(gl, BLIT_VERT, BLIT_FRAG);
    this.blitVao = gl.createVertexArray()!;
    this.initTargets();
  }

  private tex(storage: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    // NEAREST + CLAMP_TO_EDGE 缺一不可，否则采样器不完整，纹理读取返回零值
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, storage, Math.max(1, this.width), Math.max(1, this.height));
    return t;
  }

  private initTargets(): void {
    const gl = this.gl;
    // 先用占位尺寸建，resize 时重建
    this.width = 1; this.height = 1;
    this.allocateTargets();
    // 最终场景纹理（RGBA8，给 blit 用）
    this.sceneTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    this.sceneFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private allocateTargets(): void {
    const gl = this.gl;
    for (const t of this.targets) {
      gl.deleteTexture(t.depthTex);
      gl.deleteTexture(t.metaTex);
      gl.deleteRenderbuffer(t.depthBuf);
      gl.deleteFramebuffer(t.fbo);
    }
    this.targets = [];
    for (let i = 0; i < this.maxLayers; i++) {
      const depthTex = this.tex(gl.RGBA32F);
      const metaTex = this.tex(gl.RGBA32F);
      const depthBuf = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuf);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, Math.max(1, this.width), Math.max(1, this.height));
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, depthTex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, metaTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuf);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      this.targets.push({ depthTex, metaTex, depthBuf, fbo });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.allocateTargets();
    const gl = this.gl;
    // 不可变纹理不能重新 texStorage，需删除后重建
    gl.deleteTexture(this.sceneTex);
    this.sceneTex = this.tex(gl.RGBA8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  uploadMesh(mesh: Mesh): GpuMesh {
    const cached = this.meshCache.get(mesh);
    if (cached) return cached;
    const gl = this.gl;
    // 超容量：删除最旧网格的 GPU 缓冲，防止反复重建场景时显存泄漏
    if (this.meshCache.size >= this.meshCacheLimit) {
      const oldest = this.meshCache.keys().next().value as Mesh | undefined;
      if (oldest) {
        const old = this.meshCache.get(oldest)!;
        gl.deleteBuffer(old.vbo);
        gl.deleteBuffer(old.ibo);
        gl.deleteVertexArray(old.vao);
        this.meshCache.delete(oldest);
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const verts = new Float32Array(mesh.positions.length + mesh.normals.length);
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      verts[i * 6] = mesh.positions[i * 3];
      verts[i * 6 + 1] = mesh.positions[i * 3 + 1];
      verts[i * 6 + 2] = mesh.positions[i * 3 + 2];
      verts[i * 6 + 3] = mesh.normals[i * 3];
      verts[i * 6 + 4] = mesh.normals[i * 3 + 1];
      verts[i * 6 + 5] = mesh.normals[i * 3 + 2];
    }
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const gm: GpuMesh = { vbo, ibo, vao, indexCount: mesh.indices.length };
    this.meshCache.set(mesh, gm);
    return gm;
  }
  cameraMatrices(cam: CameraState): { view: Mat4; proj: Mat4; viewProj: Mat4; eye: Vec3 } {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const eye: Vec3 = [
      cam.target[0] + cam.distance * cp * Math.sin(cam.yaw),
      cam.target[1] + cam.distance * sp,
      cam.target[2] + cam.distance * cp * Math.cos(cam.yaw),
    ];
    const view = lookAt4(eye, cam.target, [0, 1, 0]);
    const proj = perspective4((cam.fovyDeg * Math.PI) / 180, this.width / Math.max(1, this.height), 1, 500);
    return { view, proj, viewProj: multiply4(proj, view), eye };
  }

  private clearTarget(t: LayerTargets): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clearBufferfv(gl.COLOR, 0, [FAR, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  /** 主渲染：depth peeling 采集分层 → CPU 精确合成 → 上传 blit */
  render(items: RenderItem[], cam: CameraState, clip: ClipPlane, heatMode: boolean, minWall: number): void {
    const gl = this.gl;
    const { viewProj, eye } = this.cameraMatrices(cam);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    // 硬件深度测试 + 着色器写 gl_FragDepth（线性深度），层内只保留最近片元
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);

    gl.useProgram(this.peelProg);
    const u = {
      viewProj: gl.getUniformLocation(this.peelProg, 'uViewProj'),
      model: gl.getUniformLocation(this.peelProg, 'uModel'),
      color: gl.getUniformLocation(this.peelProg, 'uColor'),
      alpha: gl.getUniformLocation(this.peelProg, 'uAlpha'),
      tag: gl.getUniformLocation(this.peelProg, 'uTag'),
      camera: gl.getUniformLocation(this.peelProg, 'uCamera'),
      clipPoint: gl.getUniformLocation(this.peelProg, 'uClipPoint'),
      clipNormal: gl.getUniformLocation(this.peelProg, 'uClipNormal'),
      clipEnabled: gl.getUniformLocation(this.peelProg, 'uClipEnabled'),
      prevDepth: gl.getUniformLocation(this.peelProg, 'uPrevDepth'),
      pass: gl.getUniformLocation(this.peelProg, 'uPass'),
      depthScale: gl.getUniformLocation(this.peelProg, 'uDepthScale'),
    };
    gl.uniform3fv(u.camera, eye);
    gl.uniform1f(u.depthScale, 1 / 500); // far plane 500mm
    gl.uniform3fv(u.clipPoint, clip.point);
    gl.uniform3fv(u.clipNormal, norm3(clip.normal));
    gl.uniform1f(u.clipEnabled, clip.enabled ? 1 : 0);
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform1i(u.prevDepth, 0);

    // ---- 逐层剥离（occlusion query 早停，不切换 FBO） ----
    const queries: WebGLQuery[] = [];
    for (let layer = 0; layer < this.maxLayers; layer++) {
      const target = this.targets[layer];
      this.clearTarget(target);
      if (layer > 0) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.targets[layer - 1].depthTex);
      }
      gl.uniform1f(u.pass, layer);
      const q = gl.createQuery()!;
      gl.beginQuery(gl.ANY_SAMPLES_PASSED, q);
      for (const it of items) {
        const gm = 'vao' in it.mesh ? (it.mesh as GpuMesh) : this.uploadMesh(it.mesh);
        gl.bindVertexArray(gm.vao);
        gl.uniformMatrix4fv(u.model, false, it.model);
        gl.uniform3fv(u.color, it.color);
        gl.uniform1f(u.alpha, it.alpha);
        gl.uniform1f(u.tag, TAG_CODE[it.tag]);
        gl.drawElements(gl.TRIANGLES, gm.indexCount, gl.UNSIGNED_INT, 0);
      }
      gl.endQuery(gl.ANY_SAMPLES_PASSED);
      queries.push(q);
    }
    // 查询结果决定有效层数（合成时仅遍历非空层）
    const activeLayers: boolean[] = [];
    for (let layer = 0; layer < this.maxLayers; layer++) {
      activeLayers.push(gl.getQueryParameter(queries[layer], gl.QUERY_RESULT_AVAILABLE)
        ? gl.getQueryParameter(queries[layer], gl.QUERY_RESULT) > 0
        : true);
      gl.deleteQuery(queries[layer]);
    }
    this.activeLayerCount = activeLayers.findIndex((a) => !a);
    if (this.activeLayerCount < 0) this.activeLayerCount = this.maxLayers;
    gl.bindVertexArray(null);

    // ---- 回读所有层纹理，CPU 逐像素精确合成 ----
    const composite = this.compositeCpu(heatMode, minWall);
    this.overflowPixels = composite.overflow;
    this.totalTransparentPixels = composite.covered;

    // ---- 上传最终画面并 blit 到默认帧缓冲 ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, composite.pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(gl.getUniformLocation(this.blitProg, 'uScene'), 0);
    gl.bindVertexArray(this.blitVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** 每像素层数（合成后有效），用于功能验证 */
  getLayerCount(pixelX: number, pixelY: number): number {
    const gy = this.height - 1 - pixelY;
    const idx = gy * this.width + pixelX;
    return this.layerCounts[idx] ?? 0;
  }

  private readTarget(t: LayerTargets): { depth: Float32Array; meta: Float32Array } {
    const gl = this.gl;
    const n = this.width * this.height * 4;
    const depth = new Float32Array(n);
    const meta = new Float32Array(n);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, depth);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, meta);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { depth, meta };
  }

  /** CPU 逐像素深度精确 over 合成（也是测试对标的参考实现，画面即参考） */
  private compositeCpu(heatMode: boolean, minWall: number): {
    pixels: Uint8ClampedArray; overflow: number; covered: number;
  } {
    const layers: Array<{ depth: Float32Array; meta: Float32Array }> = [];
    for (let i = 0; i < this.maxLayers; i++) layers.push(this.readTarget(this.targets[i]));

    const n = this.width * this.height;
    const pixels = new Uint8ClampedArray(n * 4);
    const counts = new Int32Array(n);
    let overflow = 0, covered = 0;
    const bgTop = [0.16, 0.18, 0.22], bgBot = [0.07, 0.08, 0.1];
    const layerLimit = this.activeLayerCount || this.maxLayers;

    for (let p = 0; p < n; p++) {
      // depth peeling 已保证层按近→远写入；收集有效层
      const seq: Array<{ d: number; r: number; g: number; b: number; a: number; tag: number }> = [];
      for (let l = 0; l < layerLimit; l++) {
        const d = layers[l].depth[p * 4];
        if (d >= FAR * 0.5) break; // 该层及以后为空
        seq.push({
          d,
          r: layers[l].depth[p * 4 + 1],
          g: layers[l].depth[p * 4 + 2],
          b: layers[l].depth[p * 4 + 3],
          a: layers[l].meta[p * 4],
          tag: Math.round(layers[l].meta[p * 4 + 1]),
        });
      }
      counts[p] = seq.length;
      if (!seq.length) {
        const gy = Math.floor(p / this.width);
        const t = gy / this.height;
        pixels[p * 4] = (bgBot[0] * (1 - t) + bgTop[0] * t) * 255;
        pixels[p * 4 + 1] = (bgBot[1] * (1 - t) + bgTop[1] * t) * 255;
        pixels[p * 4 + 2] = (bgBot[2] * (1 - t) + bgTop[2] * t) * 255;
        pixels[p * 4 + 3] = 255;
        continue;
      }
      covered++;
      if (seq.length === this.maxLayers) overflow++;
      const gy = Math.floor(p / this.width);
      const t = gy / this.height;
      let acc: [number, number, number] = [
        bgBot[0] * (1 - t) + bgTop[0] * t,
        bgBot[1] * (1 - t) + bgTop[1] * t,
        bgBot[2] * (1 - t) + bgTop[2] * t,
      ];

      if (heatMode) {
        // 找最薄 shell 段
        let thinnest = Infinity;
        let enter = -1;
        for (let i = 0; i < seq.length; i++) {
          if (seq[i].tag !== 1) continue;
          if (enter < 0) enter = i;
          else { thinnest = Math.min(thinnest, seq[i].d - seq[enter].d); enter = -1; }
        }
        // 非 shell 层先正常 over
        for (let i = seq.length - 1; i >= 0; i--) {
          if (seq[i].tag === 1) continue;
          const s = seq[i];
          acc = [acc[0] * (1 - s.a) + s.r * s.a, acc[1] * (1 - s.a) + s.g * s.a, acc[2] * (1 - s.a) + s.b * s.a];
        }
        if (isFinite(thinnest)) {
          const heat: [number, number, number] = thinnest < minWall
            ? [0.95, 0.12, 0.08]
            : [
              1.0 * (1 - Math.min(1, (thinnest - minWall) / 0.8)) + 0.2 * Math.min(1, (thinnest - minWall) / 0.8),
              0.85 * (1 - Math.min(1, (thinnest - minWall) / 0.8)) + 0.85 * Math.min(1, (thinnest - minWall) / 0.8),
              0.25 * (1 - Math.min(1, (thinnest - minWall) / 0.8)) + 0.35 * Math.min(1, (thinnest - minWall) / 0.8),
            ];
          acc = [acc[0] * 0.22 + heat[0] * 0.78, acc[1] * 0.22 + heat[1] * 0.78, acc[2] * 0.22 + heat[2] * 0.78];
        }
      } else {
        // back-to-front over
        for (let i = seq.length - 1; i >= 0; i--) {
          const s = seq[i];
          acc = [acc[0] * (1 - s.a) + s.r * s.a, acc[1] * (1 - s.a) + s.g * s.a, acc[2] * (1 - s.a) + s.b * s.a];
        }
      }
      // GL 左下原点 → 图像左上原点
      const gx = p % this.width;
      const screenIdx = ((this.height - 1 - gy) * this.width + gx) * 4;
      pixels[screenIdx] = Math.round(acc[0] * 255);
      pixels[screenIdx + 1] = Math.round(acc[1] * 255);
      pixels[screenIdx + 2] = Math.round(acc[2] * 255);
      pixels[screenIdx + 3] = 255;
    }
    this.layerCounts = counts;
    return { pixels, overflow, covered };
  }

  /** 单像素层信息（悬停探针）：直接从已采集的层纹理读 */
  readbackLayers(pixelX: number, pixelY: number): PixelLayerInfo[] {
    const gl = this.gl;
    const gx = pixelX;
    const gy = this.height - 1 - pixelY; // CSS 坐标 → GL
    if (gx < 0 || gy < 0 || gx >= this.width || gy >= this.height) return [];
    const out: PixelLayerInfo[] = [];
    const limit = this.activeLayerCount || this.maxLayers;
    for (let l = 0; l < limit; l++) {
      const t = this.targets[l];
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      const d = new Float32Array(4);
      const m = new Float32Array(4);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(gx, gy, 1, 1, gl.RGBA, gl.FLOAT, d);
      if (d[0] >= FAR * 0.5) break;
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(gx, gy, 1, 1, gl.RGBA, gl.FLOAT, m);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      out.push({
        tag: TAG_NAME[Math.round(m[1])] ?? 'marker',
        depthMm: d[0],
        thicknessMm: null,
        rgba: [d[1], d[2], d[3], m[0]],
      });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // shell 配对壁厚
    let enter = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i].tag !== 'shell') continue;
      if (enter < 0) enter = i;
      else {
        const th = out[i].depthMm - out[enter].depthMm;
        out[enter].thicknessMm = th;
        out[i].thicknessMm = th;
        enter = -1;
      }
    }
    return out;
  }

  /** 提供与 GPU 画面同源的 CPU 参考 ImageData（测试逐像素比对用） */
  referenceImage(): ImageData {
    // compositeCpu 的产物已上传到 sceneTex；回读它即"画面=参考"
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 翻转到屏幕坐标
    const out = new Uint8ClampedArray(data.length);
    const row = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      out.set(data.subarray((this.height - 1 - y) * row, (this.height - y) * row), y * row);
    }
    return new ImageData(out, this.width, this.height);
  }

  /** 屏幕像素 → 世界空间射线 */
  pixelRay(cam: CameraState, px: number, py: number): { origin: Vec3; dir: Vec3 } {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const eye: Vec3 = [
      cam.target[0] + cam.distance * cp * Math.sin(cam.yaw),
      cam.target[1] + cam.distance * sp,
      cam.target[2] + cam.distance * cp * Math.cos(cam.yaw),
    ];
    const view = lookAt4(eye, cam.target, [0, 1, 0]);
    const proj = perspective4((cam.fovyDeg * Math.PI) / 180, this.width / Math.max(1, this.height), 1, 500);
    const ndcX = (px / this.width) * 2 - 1;
    const ndcY = 1 - (py / this.height) * 2;
    const invProj = invert4(proj);
    const invView = invert4(view);
    const near4 = multiply4(invProj, new Float32Array([ndcX, ndcY, -1, 1]));
    const near = scale3([near4[0], near4[1], near4[2]], 1 / near4[3]);
    const far4 = multiply4(invProj, new Float32Array([ndcX, ndcY, 1, 1]));
    const far = scale3([far4[0], far4[1], far4[2]], 1 / far4[3]);
    const nearW = transformPoint4(invView, near);
    const farW = transformPoint4(invView, far);
    return { origin: eye, dir: norm3(sub3(farW, nearW)) };
  }

  snapshot(): string {
    return (this.gl.canvas as HTMLCanvasElement).toDataURL('image/png');
  }

  /** 释放全部 GL 资源（纹理/FBO/缓冲/程序） */
  dispose(): void {
    const gl = this.gl;
    for (const gm of this.meshCache.values()) {
      gl.deleteBuffer(gm.vbo);
      gl.deleteBuffer(gm.ibo);
      gl.deleteVertexArray(gm.vao);
    }
    this.meshCache.clear();
    for (const t of this.targets) {
      gl.deleteTexture(t.depthTex);
      gl.deleteTexture(t.metaTex);
      gl.deleteRenderbuffer(t.depthBuf);
      gl.deleteFramebuffer(t.fbo);
    }
    this.targets = [];
    gl.deleteTexture(this.sceneTex);
    gl.deleteFramebuffer(this.sceneFbo);
    gl.deleteProgram(this.peelProg);
    gl.deleteProgram(this.blitProg);
    gl.deleteVertexArray(this.blitVao);
    this.meshCache.clear();
    // 最后主动丢上下文，触发 SwiftShader 立即回收
    const ext = gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}

function invert4(m: Mat4): Mat4 {
  const a = Array.from(m);
  const inv: number[] = new Array(16).fill(0);
  const c2 = (r0: number, r1: number, r2: number, c0: number, c1: number, c2n: number) => {
    const i = (r: number, c: number) => r * 4 + c;
    return (
      a[i(r0, c0)] * (a[i(r1, c1)] * a[i(r2, c2n)] - a[i(r1, c2n)] * a[i(r2, c1)]) -
      a[i(r0, c1)] * (a[i(r1, c0)] * a[i(r2, c2n)] - a[i(r1, c2n)] * a[i(r2, c0)]) +
      a[i(r0, c2n)] * (a[i(r1, c0)] * a[i(r2, c1)] - a[i(r1, c1)] * a[i(r2, c0)])
    );
  };
  inv[0] = c2(1, 2, 3, 1, 2, 3);
  inv[4] = -c2(1, 2, 3, 0, 2, 3);
  inv[8] = c2(1, 2, 3, 0, 1, 3);
  inv[12] = -c2(1, 2, 3, 0, 1, 2);
  inv[1] = -c2(0, 2, 3, 1, 2, 3);
  inv[5] = c2(0, 2, 3, 0, 2, 3);
  inv[9] = -c2(0, 2, 3, 0, 1, 3);
  inv[13] = c2(0, 2, 3, 0, 1, 2);
  inv[2] = c2(0, 1, 3, 1, 2, 3);
  inv[6] = -c2(0, 1, 3, 0, 2, 3);
  inv[10] = c2(0, 1, 3, 0, 1, 3);
  inv[14] = -c2(0, 1, 3, 0, 1, 2);
  inv[3] = -c2(0, 1, 2, 1, 2, 3);
  inv[7] = c2(0, 1, 2, 0, 2, 3);
  inv[11] = -c2(0, 1, 2, 0, 1, 3);
  inv[15] = c2(0, 1, 2, 0, 1, 2);
  let det = 0;
  for (let c = 0; c < 4; c++) det += a[c] * inv[c * 4];
  if (Math.abs(det) < 1e-12) return new Float32Array(m);
  for (let i = 0; i < 16; i++) inv[i] /= det;
  return Float32Array.from(inv);
}
