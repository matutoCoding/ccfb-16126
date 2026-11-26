import type { Mat4 } from '../math/vec';
import type { MeshData, Vec3 } from '../types';
import { createDepthTexture, createProgram, hexToRgb01 } from './glutils';
import { OrbitCamera } from './camera';

export interface SceneObject {
  id: string;
  mesh: MeshData;
  model?: Mat4;
  color?: string;
  opacity?: number;
  visible?: boolean;
  unlit?: boolean;
  heat?: boolean;
  clip?: boolean;
  depthWrite?: boolean;
}

export interface ClipPlane { point: Vec3; normal: Vec3 }

export interface RenderOptions {
  background?: string;
  clipPlane?: ClipPlane | null;
  heatTexture?: WebGLTexture | null;
  useHeat?: boolean;
}

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  count: number;
  type: number;
}

interface PeelTarget {
  fbo: WebGLFramebuffer;
  color: WebGLTexture;
  depth: WebGLTexture;
}

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aSurface;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out float vSurface;
void main() {
  vec4 w = uModel * vec4(aPosition, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vSurface = aSurface;
  gl_Position = uViewProj * w;
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vSurface;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uCameraPos;
uniform bool uUnlit;
uniform bool uClipEnabled;
uniform vec4 uClipPlane;
uniform bool uHeatEnabled;
uniform sampler2D uHeatTexture;
uniform vec2 uResolution;
uniform bool uDepthPeel;
uniform sampler2D uPrevDepth;
uniform bool uHasPrevDepth;
uniform float uDepthEpsilon;
#ifdef LINEAR_ONLY
layout(location=0) out float outLinear;
#else
layout(location=0) out vec4 outColor;
#endif
void main() {
  if (uClipEnabled && dot(vWorld, uClipPlane.xyz) + uClipPlane.w < 0.0) discard;
  vec2 suv = gl_FragCoord.xy / uResolution;
  if (uDepthPeel) {
    float prev = texture(uPrevDepth, suv).r;
    if (uHasPrevDepth && gl_FragCoord.z <= prev + uDepthEpsilon) discard;
  }
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(vec3(0.38, 0.72, 0.62));
  float diffuse = max(dot(N, L), 0.0);
  float fill = max(dot(-N, L) * 0.28, 0.0);
  float light = 0.56 + diffuse * 0.48 + fill;
  vec3 col = uUnlit ? uColor : uColor * light;
  if (uHeatEnabled) {
    vec4 heat = texture(uHeatTexture, suv);
    if (heat.a > 0.01 && vSurface < 0.55) {
      vec3 hot = mix(vec3(1.0, 0.82, 0.05), vec3(0.96, 0.03, 0.02), clamp(heat.r, 0.0, 1.0));
      col = mix(col, hot, clamp(0.22 + heat.r * 0.72, 0.0, 0.92));
    }
  }
  #ifndef LINEAR_ONLY
  outColor = vec4(clamp(col, 0.0, 1.0), clamp(uOpacity, 0.0, 1.0));
  #else
  // Linear-only pass renders an R32F target and does not need lighting/color output.
  #endif
  #ifdef LINEAR_ONLY
  outLinear = length(vWorld - uCameraPos);
  #endif
}`;

const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(-1.0, -1.0);
  if (gl_VertexID == 1) p = vec2(3.0, -1.0);
  if (gl_VertexID == 2) p = vec2(-1.0, 3.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const ACCUM_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAccum;
uniform sampler2D uPeel;
out vec4 outColor;
void main() {
  vec4 acc = texture(uAccum, vUv);
  vec4 src = texture(uPeel, vUv);
  float a = clamp(src.a, 0.0, 1.0);
  float outA = acc.a + (1.0 - acc.a) * a;
  vec3 outRgb = acc.rgb + (1.0 - acc.a) * a * src.rgb;
  outColor = vec4(outRgb, outA);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAccum;
uniform vec3 uBackground;
out vec4 outColor;
void main() {
  vec4 acc = texture(uAccum, vUv);
  vec3 rgb = acc.rgb + uBackground * (1.0 - acc.a);
  outColor = vec4(rgb, 1.0);
}`;

function heatFragmentSource(layerCount: number): string {
  let samples = '';
  for (let i = 0; i < layerCount; i++) {
    samples += `  d = texture(uLayer${i}, vUv).r; if (d > 0.0001) depths[n++] = d;\n`;
  }
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uLayer0;
${Array.from({ length: layerCount }, (_, i) => i === 0 ? '' : `uniform sampler2D uLayer${i};`).join('\n')}
uniform float uMinWall;
out vec4 outColor;
void main() {
  float depths[${layerCount}];
  int n = 0;
  float d = 0.0;
${samples}
  for (int i = 0; i < n; i++) {
    for (int j = i + 1; j < n; j++) {
      if (depths[j] < depths[i]) { float tmp = depths[i]; depths[i] = depths[j]; depths[j] = tmp; }
    }
  }
  float minThick = 10000.0;
  int pairs = 0;
  for (int i = 0; i + 1 < n; i += 2) {
    minThick = min(minThick, depths[i + 1] - depths[i]);
    pairs++;
  }
  if (pairs == 0) { outColor = vec4(0.0); return; }
  float severity = 1.0 - smoothstep(uMinWall - 0.35, uMinWall + 0.25, minThick);
  outColor = vec4(severity, minThick, float(n) / 24.0, 1.0);
}`;
}

export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly camera = new OrbitCamera();
  private meshes = new WeakMap<MeshData, GpuMesh>();
  private meshProgram: WebGLProgram;
  private linearProgram: WebGLProgram;
  private accumProgram: WebGLProgram;
  private compositeProgram: WebGLProgram;
  private heatProgram: WebGLProgram;
  private emptyVao: WebGLVertexArrayObject;
  private peelTargets: PeelTarget[] = [];
  private accumTextures: WebGLTexture[] = [];
  private accumFbos: WebGLFramebuffer[] = [];
  private heatTexture: WebGLTexture | null = null;
  private heatFbo: WebGLFramebuffer | null = null;
  private shellLinearTextures: WebGLTexture[] = [];
  private shellDepthTextures: WebGLTexture[] = [];
  private shellFbo: WebGLFramebuffer;
  private readFbo: WebGLFramebuffer;
  private width = 1;
  private height = 1;
  private readonly shellLayerCount = 12;
  maxPeelLayers = 28;
  floatSupported = true;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('当前浏览器或内嵌环境没有启用 WebGL2。');
    this.gl = gl;
    const floatExt = gl.getExtension('EXT_color_buffer_float');
    this.floatSupported = !!floatExt;
    if (!floatExt) throw new Error('WebGL2 缺少 EXT_color_buffer_float，无法保证高精度透明排序和壁厚读数。');
    gl.getExtension('OES_texture_float_linear');
    this.meshProgram = createProgram(gl, MESH_VS, MESH_FS);
    const linearFS = MESH_FS.replace('#version 300 es\n', '#version 300 es\n#define LINEAR_ONLY 1\n');
    this.linearProgram = createProgram(gl, MESH_VS, linearFS);
    this.accumProgram = createProgram(gl, FULLSCREEN_VS, ACCUM_FS);
    this.compositeProgram = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.heatProgram = createProgram(gl, FULLSCREEN_VS, heatFragmentSource(this.shellLayerCount));
    this.emptyVao = gl.createVertexArray()!;
    this.shellFbo = gl.createFramebuffer()!;
    this.readFbo = gl.createFramebuffer()!;
    this.resize();
  }

  resize(scale = 1): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(320, rect.width || this.canvas.parentElement?.clientWidth || 800);
    const cssH = Math.max(320, rect.height || this.canvas.parentElement?.clientHeight || 560);
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
    const w = Math.floor(cssW * dpr), h = Math.floor(cssH * dpr);
    if (w === this.width && h === this.height && this.canvas.width === w) return false;
    this.canvas.width = w; this.canvas.height = h;
    this.width = w; this.height = h;
    this.camera.updateAspect(w, h);
    this.destroyTargets();
    this.createTargets();
    return true;
  }

  private createTargets() {
    const gl = this.gl, w = this.width, h = this.height;
    this.peelTargets = [0, 1].map(() => {
      const fbo = gl.createFramebuffer()!;
      const color = this.createColorTexture(gl.RGBA32F, gl.RGBA, gl.FLOAT);
      const depth = createDepthTexture(gl, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
      this.assertFbo();
      return { fbo, color, depth };
    });
    this.accumTextures = [0, 1].map(() => this.createColorTexture(gl.RGBA32F, gl.RGBA, gl.FLOAT));
    this.accumFbos = this.accumTextures.map(tex => {
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.assertFbo();
      return fbo;
    });
    this.heatTexture = this.createColorTexture(gl.RGBA32F, gl.RGBA, gl.FLOAT);
    this.heatFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heatFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.heatTexture, 0);
    this.assertFbo();

    this.shellLinearTextures = [];
    this.shellDepthTextures = [];
    for (let i = 0; i < this.shellLayerCount; i++) {
      const linear = this.createColorTexture(gl.R32F, gl.RED, gl.FLOAT);
      const depth = createDepthTexture(gl, w, h);
      this.shellLinearTextures.push(linear);
      this.shellDepthTextures.push(depth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shellFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, linear, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
      this.assertFbo();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private createColorTexture(internal: number, format: number, type: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.width, this.height, 0, format, type, null);
    return tex;
  }

  private assertFbo() {
    const gl = this.gl;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`WebGL framebuffer 不完整: 0x${status.toString(16)}`);
  }

  private destroyTargets() {
    const gl = this.gl;
    this.peelTargets.forEach(t => { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.color); gl.deleteTexture(t.depth); });
    this.accumFbos.forEach(f => gl.deleteFramebuffer(f));
    this.accumTextures.forEach(t => gl.deleteTexture(t));
    this.shellLinearTextures.forEach(t => gl.deleteTexture(t));
    this.shellDepthTextures.forEach(t => gl.deleteTexture(t));
    if (this.heatFbo) gl.deleteFramebuffer(this.heatFbo);
    if (this.heatTexture) gl.deleteTexture(this.heatTexture);
    this.peelTargets = []; this.accumFbos = []; this.accumTextures = [];
    this.shellLinearTextures = []; this.shellDepthTextures = [];
    this.heatFbo = null; this.heatTexture = null;
  }

  get heat(): WebGLTexture | null { return this.heatTexture; }
  get drawingSize() { return { width: this.width, height: this.height }; }

  private gpuMesh(mesh: MeshData): GpuMesh {
    const cached = this.meshes.get(mesh);
    if (cached) return cached;
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const normal = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, normal);
    const normals = mesh.normals ?? new Float32Array(mesh.positions.length);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const surface = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, surface);
    const surf = mesh.surface ?? new Uint8Array(mesh.positions.length / 3);
    gl.bufferData(gl.ARRAY_BUFFER, surf, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);

    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const g: GpuMesh = { vao, count: mesh.indices.length, type: gl.UNSIGNED_INT };
    this.meshes.set(mesh, g);
    return g;
  }

  private setCommonUniforms(program: WebGLProgram, obj: SceneObject, opts: RenderOptions, linear: boolean, peel: { prevDepth?: WebGLTexture; hasPrev: boolean } = { hasPrev: false }) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uViewProj'), false, this.camera.viewProj);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uModel'), false, obj.model ?? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    const rgb = hexToRgb01(obj.color ?? '#9dd7ff');
    gl.uniform3f(gl.getUniformLocation(program, 'uColor'), rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(gl.getUniformLocation(program, 'uOpacity'), obj.opacity ?? 1);
    gl.uniform3f(gl.getUniformLocation(program, 'uCameraPos'), this.camera.position[0], this.camera.position[1], this.camera.position[2]);
    gl.uniform1i(gl.getUniformLocation(program, 'uUnlit'), obj.unlit ? 1 : 0);
    gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), this.width, this.height);
    const clip = opts.clipPlane;
    gl.uniform1i(gl.getUniformLocation(program, 'uClipEnabled'), obj.clip === false || !clip ? 0 : 1);
    if (clip) {
      const d = -(clip.normal[0] * clip.point[0] + clip.normal[1] * clip.point[1] + clip.normal[2] * clip.point[2]);
      gl.uniform4f(gl.getUniformLocation(program, 'uClipPlane'), clip.normal[0], clip.normal[1], clip.normal[2], d);
    }
    const heatLoc = gl.getUniformLocation(program, 'uHeatEnabled');
    if (heatLoc) gl.uniform1i(heatLoc, opts.useHeat && opts.heatTexture && obj.heat !== false ? 1 : 0);
    if (opts.heatTexture) {
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, opts.heatTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'uHeatTexture'), 15);
    }
    gl.uniform1i(gl.getUniformLocation(program, 'uDepthPeel'), linear ? 1 : 1);
    gl.uniform1i(gl.getUniformLocation(program, 'uHasPrevDepth'), peel.hasPrev ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uDepthEpsilon'), 0.0000008);
    if (peel.prevDepth) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, peel.prevDepth);
      gl.uniform1i(gl.getUniformLocation(program, 'uPrevDepth'), 0);
    }
  }

  private drawObject(obj: SceneObject, program: WebGLProgram, opts: RenderOptions, peel?: { prevDepth?: WebGLTexture; hasPrev: boolean }) {
    const gl = this.gl;
    if (obj.visible === false || !obj.mesh.indices.length) return;
    const g = this.gpuMesh(obj.mesh);
    gl.bindVertexArray(g.vao);
    this.setCommonUniforms(program, obj, opts, program === this.linearProgram, peel);
    gl.drawElements(gl.TRIANGLES, g.count, g.type, 0);
    gl.bindVertexArray(null);
  }

  /** Conventional depth-tested rendering for non-perspective work pages. */
  renderNormal(objects: SceneObject[], opts: RenderOptions = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const bg = hexToRgb01(opts.background ?? '#0b1220');
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const sorted = [...objects].filter(o => o.visible !== false).sort((a, b) => (b.opacity ?? 1) - (a.opacity ?? 1));
    for (const obj of sorted) {
      gl.depthMask((obj.opacity ?? 1) >= 0.98 ? true : (obj.depthWrite ?? false));
      this.drawObject(obj, this.meshProgram, opts);
    }
    gl.depthMask(true);
  }

  /** Shell-only depth peeling. Retains Euclidean eye distance for every layer. */
  computeShellLayers(shell: SceneObject, minWall: number, clipPlane?: ClipPlane | null) {
    if (!this.heatTexture) return null;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    for (let i = 0; i < this.shellLayerCount; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shellFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.shellLinearTextures[i], 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shellDepthTextures[i], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const prevDepth = i > 0 ? this.shellDepthTextures[i - 1] : undefined;
      this.drawObject(shell, this.linearProgram, { clipPlane: clipPlane ?? null }, { prevDepth, hasPrev: i > 0 });
    }
    this.renderHeat(minWall);
    return this.heatTexture;
  }

  private renderHeat(minWall: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heatFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.heatProgram);
    gl.bindVertexArray(this.emptyVao);
    for (let i = 0; i < this.shellLayerCount; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.shellLinearTextures[i]);
      gl.uniform1i(gl.getUniformLocation(this.heatProgram, `uLayer${i}`), i);
    }
    gl.uniform1f(gl.getUniformLocation(this.heatProgram, 'uMinWall'), minWall);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  readShellLayerDepths(clientX: number, clientY: number, canvasRect?: DOMRect): number[] {
    const rect = canvasRect ?? this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) * this.width / Math.max(1, rect.width));
    const topY = Math.floor((clientY - rect.top) * this.height / Math.max(1, rect.height));
    return this.readShellLayerDepthsAtPixel(x, topY);
  }

  readShellLayerDepthsAtPixel(x: number, topY: number): number[] {
    const gl = this.gl;
    const px = Math.max(0, Math.min(this.width - 1, x));
    const glY = Math.max(0, Math.min(this.height - 1, this.height - 1 - topY));
    const value = new Float32Array(1);
    const out: number[] = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo);
    for (let i = 0; i < this.shellLayerCount; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.shellLinearTextures[i], 0);
      gl.readPixels(px, glY, 1, 1, gl.RED, gl.FLOAT, value);
      if (value[0] > 0.0001) out.push(value[0]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out.sort((a, b) => a - b);
  }

  readAllShellLayers(): Float32Array[] {
    const gl = this.gl;
    const result: Float32Array[] = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo);
    for (let i = 0; i < this.shellLayerCount; i++) {
      const data = new Float32Array(this.width * this.height);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.shellLinearTextures[i], 0);
      gl.readPixels(0, 0, this.width, this.height, gl.RED, gl.FLOAT, data);
      result.push(data);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return result;
  }

  /** Exact front-to-back depth-peeled transparency. */
  renderTransparent(objects: SceneObject[], opts: RenderOptions = {}) {
    if (!this.peelTargets.length) this.resize();
    const gl = this.gl;
    const visible = objects.filter(o => o.visible !== false && o.mesh.indices.length);
    const passes = Math.max(1, Math.min(this.maxPeelLayers, 48));
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    let accumIndex = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbos[0]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (let pass = 0; pass < passes; pass++) {
      const target = this.peelTargets[pass % 2];
      const prev = pass === 0 ? null : this.peelTargets[(pass + 1) % 2].depth;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      for (const obj of visible) {
        this.drawObject(obj, this.meshProgram, opts, { prevDepth: prev ?? undefined, hasPrev: !!prev });
      }
      const nextAccum = 1 - accumIndex;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbos[nextAccum]);
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(this.accumProgram);
      gl.bindVertexArray(this.emptyVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.accumTextures[accumIndex]);
      gl.uniform1i(gl.getUniformLocation(this.accumProgram, 'uAccum'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, target.color);
      gl.uniform1i(gl.getUniformLocation(this.accumProgram, 'uPeel'), 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      accumIndex = nextAccum;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.compositeProgram);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTextures[accumIndex]);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uAccum'), 0);
    const bg = hexToRgb01(opts.background ?? '#08111f');
    gl.uniform3f(gl.getUniformLocation(this.compositeProgram, 'uBackground'), bg[0], bg[1], bg[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  readCanvasPixels(): Uint8Array {
    const gl = this.gl;
    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  project(world: Vec3): { x: number; y: number; z: number } {
    const m = this.camera.viewProj;
    const x = world[0], y = world[1], z = world[2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const nx = cx / cw, ny = cy / cw, nz = cz / cw;
    return {
      x: (nx * 0.5 + 0.5) * this.width,
      y: (-ny * 0.5 + 0.5) * this.height,
      z: nz
    };
  }

  dataURL(): string {
    return this.canvas.toDataURL('image/png');
  }
}
