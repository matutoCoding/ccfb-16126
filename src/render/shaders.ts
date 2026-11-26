// 深度剥离 GLSL：首遍与剥离遍均用 MRT 同时输出颜色(location0)与深度编码(location1)
// 世界坐标直接等于模型坐标（单位 mm）

export const SCENE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform vec3 uColor;
uniform float uAlpha;
out vec3 vNormal;
out vec3 vWorldPos;
out vec4 vColor;
void main() {
  vNormal = aNormal;
  vWorldPos = aPos;
  vColor = vec4(uColor, uAlpha);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

// 把 gl_FragCoord.z 编码为高/低两段（配合 RGBA16F，等效约 32 位精度）
const ENCODE = `
  vec2 encodeDepth(float z) {
    z = clamp(z, 0.0, 1.0);
    float hi = floor(z * 65535.0) / 65535.0;
    float lo = fract(z * 65535.0);
    return vec2(hi, lo);
  }
`;

const LIGHT = `
  vec3 lightDir = normalize(vec3(0.4, 0.7, 0.6));
  // 用屏幕空间导数求面法向（平坦着色），与 CPU 参考渲染的三角形面法向严格一致
  vec3 fn = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  float diff = 0.55 + 0.45 * abs(dot(fn, lightDir));
  vec3 rgb = vColor.rgb * diff;
`;

// 首遍片元：最近层颜色（预乘 alpha），深度由 FBO 深度附件记录
export const FIRST_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorldPos;
in vec4 vColor;
out vec4 outColor;
void main() {
  ${LIGHT}
  outColor = vec4(rgb * vColor.a, vColor.a);
}`;

// 剥离遍片元：丢弃不比上一层更远的片元，输出当前层颜色
export const PEEL_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrevDepth;
in vec3 vNormal;
in vec3 vWorldPos;
in vec4 vColor;
out vec4 outColor;
void main() {
  float prev = texture(uPrevDepth, gl_FragCoord.xy / vec2(textureSize(uPrevDepth, 0))).r;
  if (gl_FragCoord.z <= prev) discard;
  ${LIGHT}
  outColor = vec4(rgb * vColor.a, vColor.a);
}`;

// 全屏四边形：把当前层深度纹理采样并编码到颜色目标（无几何重绘，避免层错位）
export const DEPTH_COPY_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vUv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}`;

export const DEPTH_COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uDepth;
uniform float uNear;
uniform float uFar;
in vec2 vUv;
out vec4 outColor;
vec2 encodeDepth(float z) {
  z = clamp(z, 0.0, 1.0);
  float hi = floor(z * 65535.0) / 65535.0;
  float lo = fract(z * 65535.0);
  return vec2(hi, lo);
}
void main() {
  float z = texture(uDepth, vUv).r; // NDC 深度 [0,1]
  if (z <= 0.0 || z >= 1.0) discard;
  float ndc = z * 2.0 - 1.0;
  // 相机空间线性深度，再归一化到 [0,1]
  float linear = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  float norm = clamp((linear - uNear) / (uFar - uNear), 0.0, 1.0);
  // 32 位等效拆分：高 16 位存 r，低 16 位残差存 g
  float scale = 65535.0;
  float hi = floor(norm * scale) / scale;
  float lo = (norm - hi) * scale / scale;
  outColor = vec4(hi, lo, 0.0, 1.0);
}`;

// 合成全屏三角形
export const COMPOSITE_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vUv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}`;

// 合成：colorTex 为 front-to-back 预乘累积结果，与背景混合
export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform vec3 uBg;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 src = texture(uColor, vUv);
  vec3 rgb = src.rgb + (1.0 - src.a) * uBg;
  frag = vec4(rgb, 1.0);
}`;

// 纯色不透明着色（非透视页面），同样用面法向平坦着色
export const SIMPLE_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorldPos;
in vec4 vColor;
out vec4 frag;
void main() {
  vec3 lightDir = normalize(vec3(0.4, 0.7, 0.6));
  vec3 fn = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  float diff = 0.55 + 0.45 * abs(dot(fn, lightDir));
  frag = vec4(vColor.rgb * diff, vColor.a);
}`;

// 薄片染红：每顶点厚度标量（location 2）
export const THIN_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aScalar;
uniform mat4 uViewProj;
out float vScalar;
out vec3 vNormal;
void main() {
  vScalar = aScalar;
  vNormal = aNormal;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const THIN_FS = `#version 300 es
precision highp float;
in float vScalar;
in vec3 vNormal;
uniform float uLimit;
out vec4 frag;
void main() {
  vec3 lightDir = normalize(vec3(0.4, 0.7, 0.6));
  float diff = 0.55 + 0.45 * abs(dot(normalize(vNormal), lightDir));
  vec3 base = vec3(0.72, 0.78, 0.82) * diff;
  vec3 red = vec3(0.95, 0.12, 0.08) * diff;
  float t = smoothstep(uLimit + 0.15, uLimit - 0.05, vScalar);
  frag = vec4(mix(base, red, t), 1.0);
}`;
