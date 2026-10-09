import type { Kernel } from "../kernel/protocol.ts";
import { Canvas2DRenderer } from "./canvas2d.ts";
import { FakeRenderer } from "./fake.ts";
import type { Renderer, RendererKind, RendererOptions } from "./types.ts";
import { WebGL2Renderer } from "./webgl2.ts";

export * from "./types.ts";
export { WebGL2Renderer, Canvas2DRenderer, FakeRenderer };
export { GlyphCache, estimateText, type Glyph } from "./glyphs.ts";
export { NativeRenderer, CMD, PASS_ID, TEX, POST, PROTOCOL_VERSION, FLOATS_PER_VERT, type BlackironHostApi, type GlyphBitmap } from "./native.ts";
export { buildLut, lutPreset, resolveLut, type LutName } from "./lut.ts";

export type RendererChoice = RendererKind | "auto";

/**
 * Create a renderer for a canvas. "auto" tries WebGL2 first and falls back to Canvas 2D,
 * and an explicit WebGL2 request falls back the same way unless `fallback` is false.
 */
export function createRenderer(
  choice: RendererChoice,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  opts: RendererOptions & { fallback?: boolean; kernel?: Kernel } = {},
): Renderer {
  const fallback = opts.fallback ?? true;
  if (choice === "fake") return new FakeRenderer(width, height);
  if (choice === "canvas2d") return new Canvas2DRenderer(canvas, width, height, opts);
  try {
    return new WebGL2Renderer(canvas, width, height, opts, opts.kernel);
  } catch (err) {
    if (!fallback) throw err;
    console.warn("[blackiron] WebGL2 unavailable, using Canvas 2D:", (err as Error).message);
    return new Canvas2DRenderer(canvas, width, height, opts);
  }
}
