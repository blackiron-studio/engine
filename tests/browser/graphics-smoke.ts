import { bakeAtlas } from "../../src/art/atlas.ts";
import { loadWasmKernel } from "../../src/kernel/wasm.ts";
import { GlyphCache } from "../../src/render/glyphs.ts";
import { WebGL2Renderer } from "../../src/render/webgl2.ts";
import { defaultPost } from "../../src/render/types.ts";

/** Force capacity and glyph paging through actual Wasm commands and GPU texture arrays. */
export async function graphicsSmoke(): Promise<{
  glyphPages: number;
  repeatedGlyphPixels: number;
  glErrors: number[];
}> {
  const canvas = document.createElement("canvas");
  const kernel = await loadWasmKernel({ maxQuads: 64 });
  if (!kernel) throw new Error("Wasm kernel unavailable");
  const renderer = new WebGL2Renderer(canvas, 320, 180, { scale: 1 }, kernel);
  renderer.resize(320, 180, 1);
  renderer.uploadAtlas(bakeAtlas());
  const gl = canvas.getContext("webgl2")!;
  const post = defaultPost();
  post.bloom = 0;
  post.vignette = 0;
  const errors: number[] = [];
  try {
    for (const count of [50, 60, 64]) {
      renderer.begin(0);
      for (let i = 0; i < count; i++)
        renderer.rect(i * 4, 20, 3, 40, 0xffcc44, 1, false);
      renderer.end(post);
      errors.push(gl.getError());
    }
    const cache = new GlyphCache(1, 64, 16);
    (renderer as unknown as { glyphs: GlyphCache }).glyphs = cache;
    const font = { family: "sans-serif", size: 24, weight: 400 };
    renderer.begin(0);
    renderer.text({
      text: "W",
      x: 5,
      y: 20,
      font,
      align: "left",
      color: 0xffffff,
      alpha: 1,
    });
    renderer.text({
      text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      x: 45,
      y: 55,
      font,
      align: "left",
      color: 0xffffff,
      alpha: 1,
    });
    renderer.text({
      text: "W",
      x: 5,
      y: 100,
      font,
      align: "left",
      color: 0xffffff,
      alpha: 1,
    });
    renderer.end(post);
    errors.push(gl.getError());
    const first = new Uint8Array(32 * 40 * 4),
      last = new Uint8Array(first.length);
    gl.readPixels(3, 180 - 20 - 40, 32, 40, gl.RGBA, gl.UNSIGNED_BYTE, first);
    gl.readPixels(3, 180 - 100 - 40, 32, 40, gl.RGBA, gl.UNSIGNED_BYTE, last);
    let lit = 0,
      differing = 0;
    for (let i = 0; i < first.length; i += 4) {
      if (first[i] > 32) lit++;
      if (Math.abs(first[i] - last[i]) > 2) differing++;
    }
    if (
      cache.pages.length < 2 ||
      lit < 20 ||
      differing > 2 ||
      errors.some(Boolean)
    )
      throw new Error(
        `Glyph/capacity GPU regression: ${JSON.stringify({ pages: cache.pages.length, lit, differing, errors })}`,
      );
    return {
      glyphPages: cache.pages.length,
      repeatedGlyphPixels: lit,
      glErrors: errors,
    };
  } finally {
    renderer.destroy();
  }
}
