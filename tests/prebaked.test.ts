import { afterEach, expect, test } from "bun:test";
import { Atlas, atlasManifest, bakeAtlas, defineSprite, filterAtlasRows, loadPrebakedAtlas, unfilterAtlasRows } from "../src/art/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve a prebaked atlas the way a web build writes it. */
function serve(files: Record<string, Uint8Array | string>): void {
  globalThis.fetch = (async (url: string) => {
    const body = files[String(url)];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body as BodyInit);
  }) as typeof fetch;
}

test("the up filter round-trips RGBA exactly", () => {
  const data = new Uint8ClampedArray(16 * 8 * 4).map((_, i) => (i * 37 + (i >> 6) * 11) & 255);
  const back = unfilterAtlasRows(filterAtlasRows(data, 16), 16);
  expect([...back]).toEqual([...data]);
});

test("a prebaked atlas loads with the same regions and texels, and falls back when stale or missing", async () => {
  defineSprite("prebaked.test.dot", { w: 6, h: 6 }, (p) => p.circle(3, 3, 2, "#ff8800"));
  const atlas = bakeAtlas({});
  const pack = Bun.gzipSync(filterAtlasRows(atlas.data, atlas.width), { level: 9 });
  // Other tests may have registered normal-mapped sprites; ship that layer too when present.
  const normals: Record<string, Uint8Array> = atlas.normals ? { "./a_n.pack": Bun.gzipSync(filterAtlasRows(atlas.normals, atlas.width)) } : {};
  serve({ "./a.json": JSON.stringify({ id: "v1", ...atlasManifest(atlas) }), "./a.pack": pack, ...normals });
  const loaded = await loadPrebakedAtlas("./a", "v1");
  expect(loaded).toBeInstanceOf(Atlas);
  expect(loaded!.width).toBe(atlas.width);
  expect(Buffer.from(loaded!.data).equals(Buffer.from(atlas.data))).toBe(true);
  expect(loaded!.region("prebaked.test.dot")).toMatchObject({ x: atlas.region("prebaked.test.dot").x, w: 6 });
  // Another build's atlas, a missing file and an already-decompressed body.
  expect(await loadPrebakedAtlas("./a", "v2")).toBeNull();
  serve({ "./a.json": JSON.stringify({ id: "v1", ...atlasManifest(atlas) }) });
  expect(await loadPrebakedAtlas("./a", "v1")).toBeNull();
  serve({ "./a.json": JSON.stringify({ id: "v1", ...atlasManifest(atlas) }), "./a.pack": filterAtlasRows(atlas.data, atlas.width), ...(atlas.normals ? { "./a_n.pack": filterAtlasRows(atlas.normals, atlas.width) } : {}) });
  expect(Buffer.from((await loadPrebakedAtlas("./a", "v1"))!.data).equals(Buffer.from(atlas.data))).toBe(true);
});
