import { describe, expect, test } from "bun:test";
import { bakeAtlas } from "../src/art/atlas.ts";
import { GlyphCache } from "../src/render/glyphs.ts";
import { FLOATS_PER_VERT, OP, OP_WORDS, STAT, commandWords, type Kernel } from "../src/kernel/protocol.ts";
import { StreamWriter } from "../src/kernel/stream.ts";
import { TsKernel } from "../src/kernel/ts.ts";
import { loadWasmKernel } from "../src/kernel/wasm.ts";

const backends: [string, () => Kernel | Promise<Kernel | null>][] = [["TypeScript", () => new TsKernel({ maxQuads: 64 })], ["Wasm", () => loadWasmKernel({ maxQuads: 64 })]];
for (const [name, create] of backends) describe(name, () => {
  test("all advertised quad vertices are uploadable at capacity", async () => {
    const k = (await create())!;
    const w = new StreamWriter(k);
    w.begin(0, 320, 240);
    for (let i = 0; i < 65; i++) w.rect(i, 0, 1, 1, 0xffffff, 1, false);
    w.end(); k.run(w.length);
    expect(k.stats[STAT.VERTICES]).toBe(64 * 4);
    expect(k.vertices.length).toBeGreaterThanOrEqual(k.stats[STAT.VERTICES] * FLOATS_PER_VERT);
    expect(k.vertices[63 * 4 * FLOATS_PER_VERT]).toBe(63);
    expect(k.stats[STAT.DROPPED]).toBe(1);
    k.destroy();
  });
  test("truncated commands never consume stale stream words", async () => {
    const k = (await create())!;
    k.stream.set([OP.BEGIN, 0, 320, 240, OP.RECT, 0, 0, 20, 20, 0xffffff, 1, 0]);
    k.run(6);
    expect(k.stats[STAT.VERTICES]).toBe(0);
    expect(k.stats[STAT.DROPPED]).toBe(1);
    for (const count of [3, -3, 2, Infinity, NaN]) {
      k.stream.set([OP.MESH, count, 0xffffff, 1, 0]);
      k.run(5);
      expect(k.stats[STAT.VERTICES]).toBe(0);
      expect(k.stats[STAT.DROPPED]).toBe(1);
    }
    k.destroy();
  });
  test("glyph page survives the command boundary", async () => {
    const k = (await create())!, w = new StreamWriter(k);
    w.begin(0, 320, 240);
    w.glyph(1, 2, 3, 4, 0, 0, 1, 1, 0xffffff, 1, false, 3);
    w.end(); k.run(w.length);
    expect(k.vertices[9]).toBe(2);
    expect(k.vertices[10]).toBe(3);
    expect(k.vertices[8]).toBe(0);
    k.destroy();
  });
  test("sorted batches remain bounded and stable across frames", async () => {
    const k = (await create())!, w = new StreamWriter(k);
    for (let frame = 0; frame < 3; frame++) {
      w.begin(0, 320, 240);
      w.projection([1, 0, 0, 0, 0, 1, -1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], true);
      for (let i = 0; i < 80; i++) w.rect(i, 0, 1, 1, 0xffffff, 1, false);
      w.projectionEnd(); w.end(); k.run(w.length);
      expect(k.stats[STAT.VERTICES]).toBe(256);
      expect(k.stats[STAT.DROPPED]).toBe(16);
      expect(k.vertices[63 * 4 * FLOATS_PER_VERT]).toBe(63);
    }
    k.destroy();
  });
});

test("every command has a complete protocol size", () => {
  for (const op of Object.values(OP)) expect(OP_WORDS[op]).toBeGreaterThan(0);
  expect(OP_WORDS[OP.SPRITE]).toBe(19);
  expect(commandWords(new Float32Array([OP.MESH, 3, 0, 1, 0, ...Array(12).fill(0)]), 0, 17)).toBe(17);
});

test("atlas grows to the widest item and paints it only once", () => {
  let paints = 0;
  const atlas = bakeAtlas({ defs: [{ name: "wide", w: 1280, h: 512, origin: [0, 0], seed: 1, index: 0, normal: null, style: "none", paint: p => { paints++; p.clear("#ffffff"); } }], font: false, builtins: false });
  expect(atlas.width).toBeGreaterThanOrEqual(1284);
  expect(atlas.height).toBe(516);
  expect(paints).toBe(1);
});
test("atlas rejects oversize height and packing before output allocation", () => {
  const def = { name: "large", w: 48, h: 48, origin: [0, 0] as [number, number], seed: 1, index: 0, normal: null, style: "none" as const, paint: () => {} };
  expect(() => bakeAtlas({ defs: [def, { ...def, name: "second" }], font: false, builtins: false, maxTextureSize: 64 })).toThrow("maximum texture size");
  expect(() => bakeAtlas({ defs: [{ ...def, h: 80 }], font: false, builtins: false, maxTextureSize: 64 })).toThrow("maximum texture size");
});

test("glyph overflow adds pages without clearing earlier queued glyphs", () => {
  const previous = globalThis.document;
  const canvases: { writes: string[]; clears: number }[] = [];
  globalThis.document = { createElement: () => {
    const record = { writes: [] as string[], clears: 0 }; canvases.push(record);
    const ctx = { setTransform() {}, clearRect() { record.clears++; }, measureText() { return { width: 12, actualBoundingBoxRight: 12, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 2 }; }, fillText(ch: string) { record.writes.push(ch); } };
    return { width: 0, height: 0, getContext: () => ctx };
  } } as unknown as Document;
  try {
    const cache = new GlyphCache(1, 32, 4), font = { family: "sans-serif", size: 12 };
    const first = cache.glyph("A", font);
    const second = cache.glyph("B", font);
    expect(first.page).toBe(0); expect(second.page).toBe(1);
    expect(cache.glyph("A", font)).toBe(first);
    expect(canvases[0].clears).toBe(1);
    expect(canvases[0].writes).toEqual(["A"]);
    expect(cache.pages.length).toBe(2);
  } finally { globalThis.document = previous; }
});
