// The kernel: the compiled Rust build and the reference TypeScript one must agree, and
// batches, particles and the stream writer must behave.

import { beforeAll, describe, expect, test } from "bun:test";
import { defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { App } from "../src/app/app.ts";
import { BATCH_STRIDE, CFG, type Kernel, STAT, StreamWriter, TsKernel, loadWasmKernel } from "../src/kernel/index.ts";
import { FLOATS_PER_VERT } from "../src/kernel/protocol.ts";
import { CMD } from "../src/kernel/ts.ts";
import { NativeRenderer } from "../src/render/native.ts";
import { NativePlatform } from "../src/platform/native.ts";
import { ParticleEmitter, Scene, TileMap } from "../src/scene/index.ts";
import { TileMapData } from "../src/core/tilemap.ts";

const region = { name: "dot", x: 0, y: 0, w: 8, h: 6, u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4, ox: 4, oy: 3 };

/** A frame with every kind of op, driven the way the renderer drives it. */
function writeFrame(k: Kernel, batch: number, emitter: number, frames: number): number {
  const w = new StreamWriter(k);
  let len = 0;
  for (let f = 0; f < frames; f++) {
    w.begin(0x102030, 640, 360);
    w.pass(0, 0);
    w.transform([2, 0, 0, 2, 10, 20]);
    w.sprite({ region, x: 5, y: 6 });
    w.sprite({ region, x: 50, y: 60, sx: 1.5, sy: -1, rot: 0.7, alpha: 0.5, tint: 0xff8000, additive: true, smooth: true });
    w.rect(1, 2, 3, 4, 0x00ff00, 0.25, false);
    w.glyph(10, 10, 5, 7, 0.5, 0.5, 0.6, 0.6, 0xffffff, 1, false);
    w.batch(batch, 1, 0xffffff, { x: 0, y: 0, w: 150, h: 50 }, false, false);
    w.transform([1, 0, 0, 1, 0, 0]);
    w.particles(emitter, 1 / 60, true, 100, 100, 1, true);
    w.pass(1, 0x202020);
    w.sprite({ region, x: 5, y: 6, additive: true });
    w.light(120, 80, 64, 0xffc080, 0.9, 2, 0.6);
    w.pass(3, 0);
    w.light(120, 80, 64, 0xffc080, 0.9, 2, 0.6);
    w.quad([100, 60, 140, 60, 400, -200, -200, -200], 0x000000, 1, true);
    w.pass(1, 0x202020);
    w.blitScratch(640, 360);
    w.pass(0, 0);
    w.sprite({ region, x: 30, y: 30, material: { kind: "outline", p0: 1 / 512, p1: 1 / 512 }, tint: 0xff0000 });
    w.sprite({ region, x: 40, y: 30, material: { kind: "flash", p0: 0.5 } });
    w.mesh([0, 0, 0.1, 0.1, 8, 0, 0.2, 0.1, 8, 8, 0.2, 0.2], 3, 0xffffff, 1);
    w.pass(2, 0);
    w.rect(0, 0, 640, 8, 0x000000, 1, false);
    w.transform([2, 0, 0, 2, 5, 5]);
    w.clip(10, 10, 100, 50);
    w.rect(0, 0, 640, 8, 0x000000, 1, false);
    w.clipEnd();
    w.end();
    len = w.length;
    k.run(len);
  }
  return len;
}

function setup(k: Kernel): { batch: number; emitter: number } {
  k.setWhite(0.9, 0.9);
  const batch = k.createBatch(4);
  const d = k.batchData(batch);
  for (let n = 0; n < 4; n++) {
    const o = n * BATCH_STRIDE;
    d[o] = n * 100;
    d[o + 1] = 0;
    d[o + 2] = 32;
    d[o + 3] = 32;
    d[o + 4] = 0.1;
    d[o + 5] = 0.1;
    d[o + 6] = 0.2;
    d[o + 7] = 0.2;
  }
  k.setBatchCount(batch, 4);
  const s = k.scratch;
  s.fill(0, 0, CFG.COLORS + 2);
  s[CFG.RATE] = 600;
  s[CFG.LIFE0] = 0.5;
  s[CFG.LIFE1] = 1.5;
  s[CFG.SPEED0] = 10;
  s[CFG.SPEED1] = 40;
  s[CFG.ANGLE1] = Math.PI * 2;
  s[CFG.GRAVITY] = 30;
  s[CFG.DRAG] = 0.5;
  s[CFG.SIZE0] = 1;
  s[CFG.SIZE1] = 3;
  s[CFG.SIZE_END] = 0.5;
  s[CFG.ALPHA0] = 1;
  s[CFG.ALPHA1] = 0;
  s[CFG.SPREAD] = 4;
  s[CFG.SPIN] = 2;
  s[CFG.MAX] = 400;
  s[CFG.SEED] = 9;
  s[CFG.HAS_SPRITE] = 1;
  s[CFG.SPRITE_W] = 4;
  s[CFG.SPRITE_H] = 4;
  s[CFG.SPRITE_OX] = 2;
  s[CFG.SPRITE_OY] = 2;
  s[CFG.SPRITE_U0] = 0.7;
  s[CFG.SPRITE_V0] = 0.7;
  s[CFG.SPRITE_U1] = 0.8;
  s[CFG.SPRITE_V1] = 0.8;
  s[CFG.COLOR_COUNT] = 2;
  s[CFG.COLORS] = 0xff0000;
  s[CFG.COLORS + 1] = 0x00ff00;
  const emitter = k.createEmitter(CFG.COLORS + 2);
  return { batch, emitter };
}

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 4, h: 4 }, (p) => p.rect(0, 0, 4, 4, "#fff"));
  defineSprite("tile", { w: 16, h: 16 }, (p) => p.rect(0, 0, 16, 16, "#8a8"));
  defineSprite("tile2", { w: 16, h: 16 }, (p) => p.rect(0, 0, 16, 16, "#88a"));
});

describe("kernel", () => {
  test("the compiled kernel and the reference kernel produce the same frame", async () => {
    const wasm = await loadWasmKernel({ maxQuads: 2048, streamWords: 8192 });
    expect(wasm).not.toBeNull();
    const ts = new TsKernel({ maxQuads: 2048, streamWords: 8192 });
    const a = setup(ts);
    const b = setup(wasm as Kernel);
    expect(a).toEqual(b);
    writeFrame(ts, a.batch, a.emitter, 4);
    writeFrame(wasm as Kernel, b.batch, b.emitter, 4);
    const sa = Array.from(ts.stats);
    const sb = Array.from((wasm as Kernel).stats);
    expect(sb).toEqual(sa);
    expect(sa[STAT.PARTICLES]).toBeGreaterThan(20);
    // World, light, scratch, light, world, overlay and the clipped overlay draw.
    expect(sa[STAT.DRAWS]).toBe(7);
    const cmds = Array.from(ts.commands.subarray(0, sa[STAT.COMMANDS]));
    const scissorAt = cmds.indexOf(CMD.SCISSOR);
    expect(cmds.slice(scissorAt, scissorAt + 5)).toEqual([CMD.SCISSOR, 25, 25, 200, 100]);
    const n = sa[STAT.VERTICES] * 10;
    const va = ts.vertices.subarray(0, n);
    const vb = (wasm as Kernel).vertices.subarray(0, n);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(va[i] - vb[i]));
    expect(maxDiff).toBeLessThan(1e-3);
    expect(Array.from((wasm as Kernel).commands.subarray(0, sa[STAT.COMMANDS]))).toEqual(Array.from(ts.commands.subarray(0, sa[STAT.COMMANDS])));
    expect(ts.emitterCount(a.emitter)).toBe((wasm as Kernel).emitterCount(b.emitter));
    (wasm as Kernel).destroy();
  });

  test("a sprite expands to one transformed quad and batches cull to the rect", () => {
    const k = new TsKernel({ maxQuads: 256, streamWords: 2048 });
    const { batch } = setup(k);
    const w = new StreamWriter(k);
    w.begin(0, 640, 360);
    w.transform([2, 0, 0, 2, 10, 20]);
    w.sprite({ region, x: 5, y: 6, ox: 0, oy: 0 });
    w.batch(batch, 1, 0xffffff, { x: 0, y: 0, w: 150, h: 50 }, false, false);
    w.end();
    k.run(w.length);
    const v = k.vertices;
    const S = FLOATS_PER_VERT;
    expect(v[0]).toBe(20);
    expect(v[1]).toBe(32);
    expect(v[S]).toBe(36);
    expect(v[2 * S + 1]).toBe(44);
    expect(k.stats[STAT.SPRITES]).toBe(1 + 2);
    expect(Array.from(k.commands.subarray(0, k.stats[STAT.COMMANDS]))).toEqual([CMD.BEGIN, 0, CMD.DRAW, 0, 12, CMD.END]);
  });

  test("emitters spawn at their rate, age out, and burst on demand", () => {
    const k = new TsKernel({ maxQuads: 4096, streamWords: 4096 });
    const { emitter } = setup(k);
    const w = new StreamWriter(k);
    const step = (dt: number, emitting: boolean) => {
      w.begin(0, 640, 360);
      w.particles(emitter, dt, emitting, 100, 100, 1, false);
      w.end();
      k.run(w.length);
    };
    step(0.1, true);
    expect(k.emitterCount(emitter)).toBe(60);
    k.burst(emitter, 25, 10, 10);
    expect(k.emitterCount(emitter)).toBe(85);
    step(2, false);
    expect(k.emitterCount(emitter)).toBe(0);
    k.clearEmitter(emitter);
    k.destroyEmitter(emitter);
    step(0.1, true);
    expect(k.stats[STAT.EMITTERS]).toBe(0);
  });

  test("a full stream drops draws and counts them instead of failing", () => {
    const k = new TsKernel({ maxQuads: 64, streamWords: 1024 });
    k.setWhite(0, 0);
    const w = new StreamWriter(k);
    w.begin(0, 100, 100);
    const warn = console.warn;
    console.warn = () => {};
    for (let i = 0; i < 200; i++) w.rect(i, 0, 1, 1, 0xffffff, 1, false);
    console.warn = warn;
    w.end();
    k.run(w.length);
    expect(k.stats[STAT.SPRITES]).toBeLessThanOrEqual(64);
    expect(k.stats[STAT.DROPPED]).toBeGreaterThan(0);
  });
});

describe("kernel-backed nodes", () => {
  class Host {
    t = 0;
    submits = 0;
    screen = { width: 640, height: 360, scale: 1, insets: [0, 0, 0, 0] as [number, number, number, number] };
    now() {
      return (this.t += 16);
    }
    storageGet() {
      return null;
    }
    storageSet() {}
    storageRemove() {}
    loadBytes() {
      return null;
    }
    loadText() {
      return null;
    }
    uploadTexture() {}
    submit() {
      this.submits++;
    }
  }

  async function appWith(scene: Scene): Promise<{ app: App; kernel: Kernel }> {
    const host = new Host();
    const platform = new NativePlatform(host);
    const kernel = new TsKernel({ maxQuads: 8192, streamWords: 1 << 16 });
    const renderer = new NativeRenderer(host, 640, 360, { scale: 1 }, kernel);
    const app = await App.create({ platform, renderer, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
    app.scenes.change(scene);
    return { app, kernel };
  }

  test("a TileMap becomes one retained batch and only visible tiles are drawn", async () => {
    const scene = new Scene();
    const { app, kernel } = await appWith(scene);
    const data = new TileMapData(100, 100);
    for (let r = 0; r < 100; r++) for (let c = 0; c < 100; c++) data.set(c, r, 1 + ((c + r) % 2));
    const map = scene.world.add(new TileMap({ data, tileSize: 16, tiles: { 1: "tile", 2: "tile2" } }));
    scene.camera.x = 320;
    scene.camera.y = 180;
    app.frame(1 / 60);
    expect(kernel.stats[STAT.BATCHES]).toBe(1);
    // 640x360 at 16 px is 40x23 tiles, plus one tile of overscan each side.
    const drawn = kernel.stats[STAT.SPRITES];
    expect(drawn).toBeGreaterThan(40 * 23);
    expect(drawn).toBeLessThan(44 * 26);
    map.set(0, 0, 0);
    app.frame(1 / 60);
    expect(kernel.stats[STAT.SPRITES]).toBe(drawn - 1);
    map.destroy();
    app.frame(1 / 60);
    expect(kernel.stats[STAT.BATCHES]).toBe(0);
  });

  test("a ParticleEmitter runs in the kernel and reports its count", async () => {
    const scene = new Scene();
    const { app, kernel } = await appWith(scene);
    const e = scene.world.add(new ParticleEmitter({ rate: 300, life: [1, 1], speed: [5, 10], sprite: "dot", seed: 4 }, 100, 100));
    for (let i = 0; i < 6; i++) app.frame(1 / 60);
    expect(kernel.stats[STAT.EMITTERS]).toBe(1);
    expect(e.count).toBe(30);
    e.burst(10);
    expect(e.count).toBe(40);
    for (let i = 0; i < 6; i++) app.frame(1 / 60);
    expect(e.count).toBe(70);
    expect(kernel.stats[STAT.SPRITES]).toBeGreaterThanOrEqual(70);
    e.clearParticles();
    expect(e.count).toBe(0);
    e.destroy();
    app.frame(1 / 60);
    expect(kernel.stats[STAT.EMITTERS]).toBe(0);
  });
});
