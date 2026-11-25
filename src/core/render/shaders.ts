// 全部着色器为 GLSL ES 3.00，手写无第三方库

export const SCENE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uMVP;
uniform mat4 uModel;
out vec3 vWorldPos;
out vec3 vViewPos;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vec4 clip = uMVP * vec4(aPos, 1.0);
  vViewPos = clip.xyz;
  gl_Position = clip;
}`;

/** 深度剥离几何 pass：MRT 同时输出 [深度(float), 层ID(float)]，共用同一深度缓冲 */
export const PEEL_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorldPos;
uniform sampler2D uPrevDepth; // 上一层深度（首轮不绑定）
uniform int uPass;
uniform int uLayerId;
layout(location = 0) out float outDepth;
layout(location = 1) out float outId;
// 共面吸收阈值：相对 NDC 深度，足以合并接缝共面片元，又不会吞掉真实的相邻表面
const float PEEL_EPS = 0.00002;
void main() {
  float fragDepth = gl_FragCoord.z;
  if (uPass > 0) {
    float prev = texture(uPrevDepth, gl_FragCoord.xy / vec2(textureSize(uPrevDepth, 0))).r;
    // 只保留比上一层更远的最近片元；共面（含接缝重叠）片元并入当前层，避免伪层
    if (fragDepth <= prev + PEEL_EPS) discard;
  }
  outDepth = fragDepth;
  outId = float(uLayerId);
}`;

/** 深度剥离合成 pass：按 front-to-back 顺序精确混合 */
export const BLEND_FS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
uniform sampler2D uPrevDepth;
uniform sampler2D uAccumColor;
uniform vec3 uColor;
uniform float uAlpha;
uniform int uPass;
uniform int uLayerId;
layout(location = 0) out vec4 outColor;
void main() {
  float fragDepth = gl_FragCoord.z;
  vec4 prev = texelFetch(uAccumColor, ivec2(gl_FragCoord.xy), 0);
  if (uPass > 0) {
    float pd = texture(uPrevDepth, gl_FragCoord.xy / vec2(textureSize(uPrevDepth, 0))).r;
    if (fragDepth <= pd + 0.00002) {
      outColor = prev;
      return;
    }
  }
  // F2B: C' = C + a(1-aAccum)*Cs, aAccum' = aAccum + a(1-aAccum)
  float remaining = 1.0 - prev.a;
  outColor = vec4(prev.rgb + uAlpha * remaining * uColor, prev.a + uAlpha * remaining);
}`;

/** 最终分析 pass：纹理数组常量索引读取 12 层，输出合成色 + 最小壁厚 + 染红 */
export const ANALYSIS_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2DArray uLayerArray;
uniform sampler2D uBlendColor;
uniform sampler2D uDepthMin;
uniform vec2 uCameraNearFar;
uniform float uWallMin;       // 壁厚下限 mm
uniform float uThinRed;       // 1=开启薄壁厚染红
uniform int uMaxLayers;
out vec4 fragColor;

#define SHELL_ID 0
#define MAX_PEEL 12

float linearDepth(float d, float near, float far) {
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}

vec4 readLayer(int i, ivec2 px) {
  // 纹理数组要求常量层索引，完全展开
  if (i == 0) return texelFetch(uLayerArray, ivec3(px, 0), 0);
  if (i == 1) return texelFetch(uLayerArray, ivec3(px, 1), 0);
  if (i == 2) return texelFetch(uLayerArray, ivec3(px, 2), 0);
  if (i == 3) return texelFetch(uLayerArray, ivec3(px, 3), 0);
  if (i == 4) return texelFetch(uLayerArray, ivec3(px, 4), 0);
  if (i == 5) return texelFetch(uLayerArray, ivec3(px, 5), 0);
  if (i == 6) return texelFetch(uLayerArray, ivec3(px, 6), 0);
  if (i == 7) return texelFetch(uLayerArray, ivec3(px, 7), 0);
  if (i == 8) return texelFetch(uLayerArray, ivec3(px, 8), 0);
  if (i == 9) return texelFetch(uLayerArray, ivec3(px, 9), 0);
  if (i == 10) return texelFetch(uLayerArray, ivec3(px, 10), 0);
  return texelFetch(uLayerArray, ivec3(px, 11), 0);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 blend = texelFetch(uBlendColor, px, 0);
  vec3 color = blend.rgb;
  float minDepth = texelFetch(uDepthMin, px, 0).r;
  if (minDepth >= 1.0) {
    fragColor = vec4(0.07, 0.08, 0.10, 1.0);
    return;
  }

  float depths[MAX_PEEL];
  int ids[MAX_PEEL];
  float linears[MAX_PEEL];
  int count = 0;
  for (int i = 0; i < MAX_PEEL; i++) {
    if (i >= uMaxLayers) break;
    vec4 L = readLayer(i, px);
    float d = L.r;
    int id = int(round(L.g * 255.0));
    if (d >= 1.0 || id == 255) break;
    depths[count] = d;
    ids[count] = id;
    linears[count] = linearDepth(d, uCameraNearFar.x, uCameraNearFar.y);
    count++;
  }

  float minWall = 9999.0;
  for (int i = 0; i < MAX_PEEL - 1; i++) {
    if (i + 1 >= count) break;
    if (ids[i] == SHELL_ID && ids[i + 1] == SHELL_ID) {
      float thick = linears[i + 1] - linears[i];
      if (thick > 0.001 && thick < minWall) minWall = thick;
    }
  }

  if (uThinRed > 0.5 && minWall < uWallMin && minWall < 100.0) {
    color = mix(color, vec3(1.0, 0.08, 0.05), 0.72);
  }

  // blend.rgb 是 F2B 预乘累加色，blend.a 是累计不透明度；
  // 在不透明背景上正确合成：最终 = 累加色 + 背景 × (1 - 累计不透明度)
  vec3 bg = vec3(0.07, 0.08, 0.10);
  float a = clamp(blend.a, 0.0, 1.0);
  color = color + bg * (1.0 - a);
  fragColor = vec4(color, 1.0);
}`;

/** 简单实体着色（扫描页/标志点等不需要透明排序的场景） */
export const SOLID_FS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
uniform vec3 uColor;
uniform float uAlpha;
uniform vec3 uCamPos;
out vec4 fragColor;
void main() {
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 l = normalize(vec3(0.4, 0.6, 0.8));
  float diff = 0.55 + 0.45 * abs(dot(n, l));
  fragColor = vec4(uColor * diff, uAlpha);
}`;

/** 标志点球体/线段着色（纯色 + 发光描边） */
export const MARKER_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uSelected;
out vec4 fragColor;
void main() {
  fragColor = vec4(mix(uColor, vec3(1.0), uSelected * 0.45), 1.0);
}`;

/** 参考合成（自检页用，CPU 端在 JS 中实现同样公式，此 shader 仅做直接输出） */
export const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  fragColor = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0);
}`;

/** 把单层 MRT (R32F 深度, R32F 层ID) 打包成 RGBA 写进纹理数组切片 */
export const LAYER_PACK_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uDepth;
uniform sampler2D uId;
out vec4 outPacked;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float d = texelFetch(uDepth, px, 0).r;
  float id = texelFetch(uId, px, 0).r;
  // ID 用 0..7 整数，编码到 g 通道，分析端 round 还原
  outPacked = vec4(d, id / 255.0, 0.0, 1.0);
}`;
