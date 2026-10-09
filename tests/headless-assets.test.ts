// Headless runs read a project's assets from disk: a sheet imported with `blackiron art import`
// loads in tests and tools the same way it does in the browser and on the native hosts.

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePNG } from "../cli/png.ts";
import { Painter, defineSheet, resetImageRegistry, resolveAssets } from "../src/art/index.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";

describe("Headless assets", () => {
  test("a sheet and its JSON load from the platform root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blackiron-assets-"));
    const p = new Painter(8, 4);
    p.rect(0, 0, 4, 4, "#ff0000");
    p.rect(4, 0, 4, 4, "#00ff00");
    await writeFile(join(dir, "pair.png"), encodePNG(8, 4, p.data));
    await writeFile(join(dir, "pair.json"), JSON.stringify({ frames: [{ filename: "0", frame: { x: 0, y: 0, w: 4, h: 4 }, duration: 100 }, { filename: "1", frame: { x: 4, y: 0, w: 4, h: 4 }, duration: 100 }], meta: { image: "pair.png", frameTags: [{ name: "blink", from: 0, to: 1 }] } }));
    resetImageRegistry();
    defineSheet("pair", "pair.json");
    const items = await resolveAssets(new HeadlessPlatform({ root: dir }));
    expect(items.map((i) => i.name)).toEqual(["pair.0", "pair.1"]);
    expect(Array.from(items[1].data.slice(0, 4))).toEqual([0, 255, 0, 255]);
    resetImageRegistry();
  });

  test("files a test registers by hand still win", async () => {
    const platform = new HeadlessPlatform({ root: "/nowhere" });
    platform.files.set("hello.txt", "hi");
    expect(await platform.loadText("hello.txt")).toBe("hi");
    await expect(platform.loadText("missing.txt")).rejects.toThrow();
  });
});
