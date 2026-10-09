// The native host protocol, exercised against a fake host that records what a Swift or
// Rust host would receive.

import { beforeAll, describe, expect, test } from "bun:test";
import { App, type HostBridge } from "../src/app/app.ts";
import { Atlas, atlasManifest, bakeAtlas, defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { NativePlatform } from "../src/platform/native.ts";
import { CMD, type BlackironHostApi, NativeRenderer, PASS_ID, POST, TEX } from "../src/render/native.ts";
import { createStore } from "../src/save/store.ts";
import { Label, LightLayer, Light2D, Scene, Sprite, TextInput } from "../src/scene/index.ts";

interface Submit {
  vertexCount: number;
  commandCount: number;
  post: number[];
}

class FakeHost implements BlackironHostApi {
  t = 0;
  uploads: { slot: number; width: number; height: number; bytes: number }[] = [];
  submits: Submit[] = [];
  store = new Map<string, string>();
  files = new Map<string, Uint8Array | string>();
  screen = { width: 844, height: 390, scale: 3, insets: [0, 47, 21, 47] as [number, number, number, number] };
  /** Every on-screen keyboard request, as a phone host receives them. */
  keyboard: boolean[] = [];
  showKeyboard(visible: boolean) {
    this.keyboard.push(visible);
  }
  now() {
    return (this.t += 16);
  }
  storageGet(k: string) {
    return this.store.get(k) ?? null;
  }
  storageSet(k: string, v: string) {
    this.store.set(k, v);
  }
  storageRemove(k: string) {
    this.store.delete(k);
  }
  loadBytes(p: string) {
    const f = this.files.get(p);
    return f instanceof Uint8Array ? f : f ? new TextEncoder().encode(f) : null;
  }
  loadText(p: string) {
    const f = this.files.get(p);
    return typeof f === "string" ? f : f ? new TextDecoder().decode(f) : null;
  }
  uploadTexture(slot: number, width: number, height: number, rgba: Uint8Array) {
    this.uploads.push({ slot, width, height, bytes: rgba.byteLength });
  }
  submit(post: Float32Array, vertexCount: number, commandCount: number) {
    this.submits.push({ vertexCount, commandCount, post: Array.from(post) });
  }
  rasterizeGlyph(_family: string, size: number, _weight: number, _style: string, ch: string) {
    const w = Math.max(1, Math.round(size * 0.6));
    const h = size;
    return { w, h, left: 0, top: -Math.round(size * 0.8), advance: w + 1, ascent: size * 0.8, descent: size * 0.2, data: new Uint8Array(w * h).fill(ch === " " ? 0 : 255) };
  }
}

/** Walk the command stream the way a host does: each command knows its argument count. */
function decode(words: number[]): { cmd: number; args: number[] }[] {
  const arity: Record<number, number> = { [CMD.BEGIN]: 1, [CMD.PASS]: 2, [CMD.DRAW]: 2, [CMD.END]: 0 };
  const out: { cmd: number; args: number[] }[] = [];
  for (let i = 0; i < words.length; ) {
    const cmd = words[i];
    const n = arity[cmd] ?? 0;
    out.push({ cmd, args: words.slice(i + 1, i + 1 + n) });
    i += 1 + n;
  }
  return out;
}

/** The command words of the last frame, read from the renderer's kernel as a host would. */
function commandsOf(app: App): number[] {
  const r = app.renderer as NativeRenderer;
  const host = r.host as FakeHost;
  const s = host.submits.at(-1) as Submit;
  return Array.from(r.kernel.commands.subarray(0, s.commandCount));
}

async function nativeApp(host: FakeHost, scene: Scene): Promise<App> {
  const platform = new NativePlatform(host);
  const app = await App.create({ platform, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
  app.bindHost();
  app.scenes.change(scene);
  return app;
}

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 4, h: 4 }, (p) => p.rect(0, 0, 4, 4, "#fff"));
});

describe("NativeRenderer protocol", () => {
  test("a frame is one vertex buffer plus begin, pass, draw and end commands", async () => {
    const host = new FakeHost();
    const scene = new Scene();
    const app = await nativeApp(host, scene);
    scene.world.add(new Sprite("dot", 100, 100));
    scene.ui.add(new Label("HI", 10, 10));
    app.frame(1 / 60);
    expect(host.uploads[0]).toMatchObject({ slot: TEX.ATLAS });
    const s = host.submits.at(-1) as Submit;
    const commands = commandsOf(app);
    expect(commands[0]).toBe(CMD.BEGIN);
    expect(commands).toContain(CMD.PASS);
    expect(commands.at(-1)).toBe(CMD.END);
    const draws = decode(commands).filter((c) => c.cmd === CMD.DRAW);
    expect(draws.length).toBeGreaterThanOrEqual(2);
    expect(s.vertexCount).toBe(4 * 3);
    expect(s.post[POST.LOGICAL_W]).toBe(640);
    expect(s.post[POST.LIGHTING]).toBe(0);
    expect(app.renderer.stats.drawCalls).toBe(draws.length);
  });

  test("layout letterboxes into the screen and reports the present rect and insets", async () => {
    const host = new FakeHost();
    const app = await nativeApp(host, new Scene());
    app.frame(1 / 60);
    const p = (host.submits.at(-1) as Submit).post;
    // 844x390 points at 16:9 gives a 693x390 view centred, times scale 3.
    expect(p[POST.VIEW_W]).toBe(693 * 3);
    expect(p[POST.VIEW_H]).toBe(390 * 3);
    expect(p[POST.VIEW_X]).toBe(Math.floor((844 - 693) / 2) * 3);
    expect(p[POST.TARGET_W]).toBe(693 * 3);
    expect(app.safeInsets[2]).toBeGreaterThan(0);
    expect(app.safeInsets[1]).toBe(0);
  });

  test("lights enable the light pass and web-font text rasterises through the host", async () => {
    const host = new FakeHost();
    const scene = new Scene();
    const app = await nativeApp(host, scene);
    scene.world.add(new LightLayer(0x102030)).add(new Light2D({ radius: 40 }, 50, 50));
    scene.ui.add(new Label("Go", 10, 10, { font: { family: "system-ui", size: 20 } }));
    app.frame(1 / 60);
    const s = host.submits.at(-1) as Submit;
    const passes = decode(commandsOf(app)).filter((c) => c.cmd === CMD.PASS).map((c) => [c.args[0], c.args[1]] as [number, number]);
    expect(passes[0][0]).toBe(PASS_ID.world);
    expect(passes).toContainEqual([PASS_ID.light, 0x102030]);
    expect(passes.at(-1)?.[0]).toBe(PASS_ID.overlay);
    expect(s.post[POST.LIGHTING]).toBe(1);
    expect(host.uploads.some((u) => u.slot === TEX.GLYPHS)).toBe(true);
    expect(app.renderer.features.text).toBe(true);
  });

  test("pointer events map from view points to logical units and the bridge drives frames", async () => {
    const host = new FakeHost();
    const scene = new Scene();
    let downAt: [number, number] | null = null;
    scene.onPointerDown = (x, y) => (downAt = [x, y]);
    const app = await nativeApp(host, scene);
    const bridge = (globalThis as { __blackiron?: { pointer: Function; frame: Function } }).__blackiron as { pointer: Function; frame: Function };
    app.start();
    bridge.pointer("down", 1, 844 / 2, 390 / 2, "touch");
    bridge.frame(host.now());
    bridge.frame(host.now());
    expect(downAt).not.toBeNull();
    expect((downAt as unknown as [number, number])[0]).toBeCloseTo(320, 0);
    expect((downAt as unknown as [number, number])[1]).toBeCloseTo(180, 0);
    expect(app.pointer.type).toBe("touch");
    expect(app.frames).toBe(2);
  });

  test("the native platform persists through the host and loads bundled files", async () => {
    const host = new FakeHost();
    host.files.set("hello.txt", "hi");
    const platform = new NativePlatform(host);
    const store = createStore<{ n: number }>({ key: "t", version: 1, initial: () => ({ n: 0 }), backend: platform.storage() });
    store.save({ n: 3 });
    expect(store.load()).toEqual({ n: 3 });
    expect(await platform.loadText("hello.txt")).toBe("hi");
    expect(new Uint8Array(await platform.loadBytes("hello.txt"))[0]).toBe(104);
    await expect(platform.loadText("missing")).rejects.toThrow();
  });

  test("a prebaked atlas round-trips through its manifest", () => {
    const baked = bakeAtlas();
    const manifest = atlasManifest(baked);
    const again = Atlas.fromManifest(manifest, baked.data);
    expect(again.region("dot")).toMatchObject({ x: baked.region("dot").x, u0: baked.region("dot").u0 });
    expect(again.whiteU).toBe(baked.whiteU);
  });

  test("native storage rejection reaches Store.save and preserves existing progress", () => {
    const host: BlackironHostApi = new FakeHost();
    const backend = new NativePlatform(host).storage();
    const store = createStore({ key: "progress", version: 1, initial: () => ({ runs: 0 }), backend });
    expect(store.save({ runs: 1 })).toBe(true); // Legacy void-returning hosts remain supported.
    const write = host.storageSet.bind(host);
    const remove = host.storageRemove.bind(host);
    host.storageSet = () => false;
    host.storageRemove = () => false;
    expect(store.save({ runs: 2 })).toBe(false);
    expect(store.load().runs).toBe(1);
    expect(() => store.clear()).toThrow("Native storage removal failed");
    host.storageSet = (key, value) => { write(key, value); return true; };
    host.storageRemove = (key) => { remove(key); return true; };
    expect(store.save({ runs: 2 })).toBe(true);
    expect(store.load().runs).toBe(2);
    store.clear();
    expect(store.has()).toBe(false);
  });
});

/** Host points for a logical position: the 640x360 view is letterboxed to 693x390 at x 75. */
function hostPoint(lx: number, ly: number): [number, number] {
  return [75 + (lx * 693) / 640, (ly * 390) / 360];
}

function tap(bridge: HostBridge, app: App, lx: number, ly: number): void {
  const [x, y] = hostPoint(lx, ly);
  bridge.pointer("down", 1, x, y, "touch");
  app.frame(1 / 60);
  bridge.pointer("up", 1, x, y, "touch");
  app.frame(1 / 60);
}

describe("Text input through the host bridge", () => {
  test("a tap focuses the field and raises the keyboard; typed text and keys edit it; a tap away lowers it", async () => {
    const host = new FakeHost();
    const scene = new Scene();
    const app = await nativeApp(host, scene);
    const submitted: string[] = [];
    const input = scene.ui.add(new TextInput(20, 20, 200, 30, { placeholder: "name", onSubmit: (v) => submitted.push(v) }));
    app.frame(1 / 60);
    const bridge = (globalThis as { __blackiron?: HostBridge }).__blackiron as HostBridge;
    expect(bridge).toBeDefined();

    tap(bridge, app, 60, 35);
    expect(scene.activeInput).toBe(input);
    expect(host.keyboard).toEqual([true]);

    // The on-screen keyboard delivers text in pieces; hardware keys arrive as codes.
    bridge.text("Jo");
    bridge.text("y");
    app.frame(1 / 60);
    expect(input.value).toBe("Joy");
    bridge.key("Backspace", true);
    bridge.key("Backspace", false);
    app.frame(1 / 60);
    expect(input.value).toBe("Jo");

    // While a field has focus, letter keys are swallowed instead of firing actions.
    app.input.map({ jump: ["KeyJ"] });
    bridge.key("KeyJ", true);
    app.frame(1 / 60);
    expect(app.input.isDown("jump")).toBe(false);
    bridge.key("KeyJ", false);

    // Return submits without leaving the field.
    bridge.key("Enter", true);
    expect(submitted).toEqual(["Jo"]);
    expect(host.keyboard).toEqual([true]);

    // Tapping elsewhere blurs and asks the host to hide the keyboard once.
    tap(bridge, app, 500, 300);
    expect(scene.activeInput).toBeNull();
    expect(host.keyboard).toEqual([true, false]);
    bridge.text("zzz");
    app.frame(1 / 60);
    expect(input.value).toBe("Jo");
    // Without focus the same key drives the action map again.
    bridge.key("KeyJ", true);
    app.frame(1 / 60);
    expect(app.input.isDown("jump")).toBe(true);
  });

  test("text without a focused field is dropped, and control characters never reach the value", async () => {
    const host = new FakeHost();
    const scene = new Scene();
    const app = await nativeApp(host, scene);
    const input = scene.ui.add(new TextInput(20, 20, 200, 30));
    app.frame(1 / 60);
    const bridge = (globalThis as { __blackiron?: HostBridge }).__blackiron as HostBridge;
    bridge.text("lost");
    app.frame(1 / 60);
    expect(input.value).toBe("");
    input.focus();
    bridge.text("a\u0008b\nc");
    app.frame(1 / 60);
    expect(input.value).toBe("abc");
    expect(host.keyboard).toEqual([true]);
  });
});
