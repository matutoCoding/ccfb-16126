import type { MeshData } from '../../types';

export interface GLProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  attribs: Map<string, number>;
}

export function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): GLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`着色器链接失败: ${log}`);
  }
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const attribs = new Map<string, number>();
  const uCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < uCount; i++) {
    const info = gl.getActiveUniform(program, i)!;
    uniforms.set(info.name, gl.getUniformLocation(program, info.name));
  }
  const aCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < aCount; i++) {
    const info = gl.getActiveAttrib(program, i)!;
    attribs.set(info.name, gl.getAttribLocation(program, info.name));
  }
  return { program, uniforms, attribs };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    throw new Error(`着色器编译失败: ${log}\n${source}`);
  }
  return shader;
}

export interface GPUMesh {
  vao: WebGLVertexArrayObject;
  vertexCount: number;
  indexCount: number;
  posBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
}

export function uploadMesh(gl: WebGL2RenderingContext, mesh: MeshData): GPUMesh {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const posBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const indexBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {
    vao,
    vertexCount: mesh.positions.length / 3,
    indexCount: mesh.indices.length,
    posBuffer,
    indexBuffer,
  };
}

export function disposeMesh(gl: WebGL2RenderingContext, gpu: GPUMesh): void {
  gl.deleteVertexArray(gpu.vao);
  gl.deleteBuffer(gpu.posBuffer);
  gl.deleteBuffer(gpu.indexBuffer);
}

export interface RenderTarget {
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  color: WebGLTexture[]; // MRT 颜色附件
  depth: WebGLTexture;
}

export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  colorFormats: { internal: number; format: number; type: number }[],
  depthFormat: number = gl.R32F,
): RenderTarget {
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const color: WebGLTexture[] = [];
  const drawBuffers: number[] = [];
  colorFormats.forEach((fmt, i) => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, width, height, 0, fmt.format, fmt.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
    color.push(tex);
    drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
    gl.drawBuffers(drawBuffers);
  });
  const depth = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, depth);
  // 深度内部格式与外部 format/type 合法匹配（统一 32F，规避 ANGLE 24UI 兼容问题）
  gl.texImage2D(gl.TEXTURE_2D, 0, depthFormat, width, height, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`帧缓冲不完整: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, width, height, color, depth };
}

export function resizeRenderTarget(
  gl: WebGL2RenderingContext,
  rt: RenderTarget,
  width: number,
  height: number,
  colorFormats: { internal: number; format: number; type: number }[],
  depthFormat: number = gl.R32F,
): RenderTarget {
  disposeRenderTarget(gl, rt);
  return createRenderTarget(gl, width, height, colorFormats, depthFormat);
}

export interface LayerArrayTextures {
  /** 每层 (NDC深度 float, 层ID 0..6, 占位, 占位)，一个采样器常量索引访问 */
  depthId: WebGLTexture;
  layers: number;
  width: number;
  height: number;
}

/** 创建 RGBA16F 2D 纹理数组，每层存放一次深度剥离的 (depth, layerId) */
export function createLayerArray(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  layers: number,
): LayerArrayTextures {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    gl.RGBA16F,
    width,
    height,
    layers,
    0,
    gl.RGBA,
    gl.FLOAT,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { depthId: tex, layers, width, height };
}

/** 把单层 R32F 深度 + R8UI ID 拷进纹理数组的指定切片 */
export function copyIntoLayerArray(
  gl: WebGL2RenderingContext,
  array: LayerArrayTextures,
  layer: number,
  depthTex: WebGLTexture,
  idTex: WebGLTexture,
  copyProgram: GLProgram,
  emptyVao: WebGLVertexArrayObject,
): void {
  // 离屏 FBO 绑定到数组纹理的单个切片
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, array.depthId, 0, layer);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    throw new Error(`纹理数组切片 ${layer} 帧缓冲不完整: 0x${status.toString(16)}`);
  }
  gl.viewport(0, 0, array.width, array.height);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(copyProgram.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, depthTex);
  gl.uniform1i(copyProgram.uniforms.get('uDepth')!, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, idTex);
  gl.uniform1i(copyProgram.uniforms.get('uId')!, 1);
  gl.bindVertexArray(emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  gl.deleteFramebuffer(fbo);
}

export function disposeRenderTarget(gl: WebGL2RenderingContext, rt: RenderTarget): void {
  gl.deleteFramebuffer(rt.fbo);
  for (const c of rt.color) gl.deleteTexture(c);
  gl.deleteTexture(rt.depth);
}

/** 全屏三角形（无顶点缓冲，gl_VertexID 生成） */
export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
