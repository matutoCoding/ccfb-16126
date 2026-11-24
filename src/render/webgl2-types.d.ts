/**
 * TS DOM lib 对 WebGL2 部分常量与图像方法声明不全，这里补齐。
 * 运行时这些成员在所有 WebGL2 实现中都存在。
 */
export {};

declare global {
  interface WebGL2RenderingContext {
    bindImageTexture(
      unit: number, texture: WebGLTexture | null, level: number, layered: boolean,
      layer: number, access: number, format: number,
    ): void;
    getBufferSubData(target: number, srcByteOffset: number, dst: ArrayBufferView): void;
    SHADER_STORAGE_BUFFER: number;
    ATOMIC_COUNTER_BUFFER: number;
    READ_WRITE: number;
    READ_ONLY: number;
    WRITE_ONLY: number;
    RGBA32UI: number;
    RGBA_INTEGER: number;
    UNSIGNED_INT: number;
    DYNAMIC_COPY: number;
  }
}
