import { nativePointerCapture, nativePointerMotion } from "../input/native-pointer-lock.ts";
// The App owns the platform, canvas, renderer, atlas, input, audio, the fixed-step loop
// and the scene stack. `App.create` reads `blackiron.json` values injected by the CLI.
// It runs in three modes: web (a canvas in a document), native (a host object drives
// frames and input), and headless (tests and tools).

import { type Atlas, bakeAtlas } from "../art/atlas.ts";
import { rgbOf } from "../art/color.ts";
import { resolveAssets } from "../art/images.ts";
import { NativeAudioBackend } from "../audio/native.ts";
import { memoryBackend, setDefaultBackend } from "../save/store.ts";
import { NativePhysics, type NativePhysicsWorld } from "../physics/native.ts";
import { loadWasmPhysics } from "../physics/wasm.ts";
import { PhysicsWorld } from "../physics/world.ts";
import { dispatchCollisions, PhysicsBody2D } from "../scene/physics.ts";
import { type Theme, type ThemePatch, defaultTheme, mergeTheme } from "../scene/theme.ts";
import { TransitionScene, type TransitionOptions } from "../scene/transition.ts";
import { AudioEngine } from "../audio/synth.ts";
import { WorkletBackend, audioContextCtor } from "../audio/worklet.ts";
import type { HapticKind } from "../platform/types.ts";
import { FixedStep } from "../core/clock.ts";
import { Rng } from "../core/rng.ts";
import { Tweens } from "../core/tween.ts";
import { Profiler } from "./profiler.ts";
import { ActionMap } from "../input/actions.ts";
import { GamepadInput } from "../input/gamepad.ts";
import { Pointer } from "../input/pointer.ts";
import { HeadlessPlatform } from "../platform/headless.ts";
import { detectPlatform } from "../platform/index.ts";
import { NativePlatform } from "../platform/native.ts";
import type { Platform } from "../platform/types.ts";
import { FakeRenderer } from "../render/fake.ts";
import { type KernelChoice, createKernel } from "../kernel/index.ts";
import type { KernelOptions } from "../kernel/protocol.ts";
import { type RendererChoice, createRenderer } from "../render/index.ts";
import { NativeRenderer } from "../render/native.ts";
import { type PostSettings, type Renderer, type RenderStats, defaultPost } from "../render/types.ts";
import { DrawContext } from "../scene/draw.ts";
import type { Scene } from "../scene/scene.ts";

export interface ViewportBase {
  width: number;
  height: number;
  /** Limits for "expand". */
  maxWidth?: number;
  maxHeight?: number;
}

export interface ViewportConfig extends ViewportBase {
  /**
   * fit: letterbox the design size into the container. integer: whole multiples only.
   * none: 1:1. expand: fill the container and grow the logical size to match its aspect.
   */
  scale?: "fit" | "integer" | "none" | "expand";
  /** A different design size when the container is wider than tall (or taller than wide), so a phone game can lay out for a desktop. */
  landscape?: ViewportBase;
  portrait?: ViewportBase;
}

/** The design size to use for a container: the landscape or portrait alternate when one matches, else the main one. */
export function viewportBaseFor(vp: ViewportConfig, availW: number, availH: number): ViewportBase {
  if (availW > 0 && availH > 0) {
    if (availW > availH && vp.landscape) return vp.landscape;
    if (availH >= availW && vp.portrait) return vp.portrait;
  }
  return vp;
}

/** The letterboxed view (in points) and the logical size for a container, pure so tests can check it. */
export function layoutFor(vp: ViewportConfig, availW: number, availH: number): { cssW: number; cssH: number; lw: number; lh: number } {
  const base = viewportBaseFor(vp, availW, availH);
  const mode = vp.scale ?? "fit";
  let cssW = base.width;
  let cssH = base.height;
  let lw = base.width;
  let lh = base.height;
  if (availW > 0 && availH > 0) {
    if (mode === "expand") {
      const aspect = availW / availH;
      if (aspect > base.width / base.height) lw = Math.min(base.maxWidth ?? base.width * 2, Math.round(base.height * aspect));
      else lh = Math.min(base.maxHeight ?? base.height * 2, Math.round(base.width / aspect));
      const k = Math.min(availW / lw, availH / lh);
      cssW = Math.floor(lw * k);
      cssH = Math.floor(lh * k);
    } else if (mode !== "none") {
      let k = Math.min(availW / base.width, availH / base.height);
      if (mode === "integer") k = Math.max(1, Math.floor(k));
      cssW = Math.floor(base.width * k);
      cssH = Math.floor(base.height * k);
    }
  }
  return { cssW, cssH, lw, lh };
}

export interface RenderConfig {
  /** "native" composes at the canvas backing store's resolution; a number multiplies the logical size. */
  scale: "native" | number;
  /** world: sprites in the world snap to whole units. all: UI too. none: free sub-pixel placement. */
  snap: "world" | "all" | "none";
}

export interface PhysicsConfig {
  gravity?: [number, number];
  pixelsPerMeter?: number;
}

export interface AndroidConfig {
  applicationId?: string;
  orientation?: "landscape" | "portrait" | "any";
}

export interface IosConfig {
  bundleId?: string;
  orientation?: "landscape" | "portrait" | "any";
  minVersion?: string;
  /** Sprite name painted into the app icon. */
  icon?: string;
  /** Apple developer team id used by the generated Xcode project. */
  team?: string;
  /** External build settings, Xcode automatic signing, or an explicitly unsigned export. */
  signing?: "external" | "automatic" | "unsigned";
}

/** One scripted screenshot for `blackiron verify`: frames to run, taps to make, and the file name. */
export interface SnapshotSpec {
  name: string;
  /** Frame to capture (60 per second of synthetic time). */
  frame?: number;
  /** Taps in logical units, "x,y:frame". */
  taps?: string[];
}

export interface BlackironConfig {
  /** Application release version and increasing store build number. */
  version?: string;
  buildNumber?: number;
  name: string;
  entry?: string;
  /** Screenshot scenarios compared against golden images by `blackiron verify`. */
  snapshots?: SnapshotSpec[];
  /** Module that only defines sprites; used by `blackiron atlas` and native builds. */
  art?: string;
  viewport: ViewportConfig;
  render: RenderConfig;
  renderer: RendererChoice;
  /** Which kernel expands the frame on the web: the compiled Wasm one, the reference TypeScript one, or auto. */
  kernel: KernelChoice;
  /** Kernel capacities: quads per frame and command-stream words. */
  kernelOptions?: KernelOptions;
  /** Enable physics at start: gravity in pixels per second squared, and the pixel scale. */
  physics?: PhysicsConfig;
  /** Fall back to Canvas 2D when WebGL2 fails. */
  fallback: boolean;
  /** Legacy alias for `render.scale` as a number. */
  renderScale?: number;
  background: string | number;
  /** Default post settings for every scene; `tint` may be a hex string in blackiron.json. */
  post: Partial<Omit<PostSettings, "tint">> & { tint?: number | string };
  fixedStep: number;
  pixelSnap: boolean;
  seed?: number | string;
  /** Start with the debug overlay visible. */
  debug?: boolean;
  /** Show the frame-rate counter (fps, frame time, draw calls). F3 toggles it at runtime. */
  fps?: boolean;
  /** Stylesheet URLs to load before the first frame, for web fonts. */
  fonts?: string[];
  ios?: IosConfig;
  android?: AndroidConfig;
}

export const defaultConfig = (): BlackironConfig => ({
  name: "game",
  viewport: { width: 1280, height: 720, scale: "fit" },
  render: { scale: "native", snap: "world" },
  renderer: "auto",
  kernel: "auto",
  fallback: true,
  background: "#000000",
  post: {},
  fixedStep: 1 / 60,
  pixelSnap: true,
});

declare global {
  // eslint-disable-next-line no-var
  var BLACKIRON_CONFIG: Partial<BlackironConfig> | undefined;
}

/**
 * `?renderer=canvas2d&debug=1&scale=2&snap=none` on the page URL overrides the config, for
 * testing backends. The same keys work in the hash for hosts that drop query strings.
 */
function queryOverrides(): Partial<BlackironConfig> {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc || typeof loc.search !== "string") return {};
  const q = new URLSearchParams(loc.search);
  for (const [k, v] of new URLSearchParams((loc.hash ?? "").replace(/^#/, ""))) q.set(k, v);
  const out: Partial<BlackironConfig> = {};
  const r = q.get("renderer");
  if (r === "webgl2" || r === "canvas2d" || r === "auto") out.renderer = r;
  const k = q.get("kernel");
  if (k === "wasm" || k === "ts" || k === "auto") out.kernel = k;
  if (q.has("debug")) out.debug = q.get("debug") !== "0";
  if (q.has("fps")) out.fps = q.get("fps") !== "0";
  const seed = q.get("seed");
  if (seed) out.seed = seed;
  const render: Partial<RenderConfig> = {};
  const scale = q.get("scale");
  if (scale === "native") render.scale = "native";
  else if (scale && Number(scale) > 0) render.scale = Number(scale);
  const snap = q.get("snap");
  if (snap === "world" || snap === "all" || snap === "none") render.snap = snap;
  if (Object.keys(render).length) out.render = render as RenderConfig;
  return out;
}

/** Merge defaults, the build-time config, URL overrides and explicit overrides. */
export function resolveConfig(overrides: Partial<BlackironConfig> = {}): BlackironConfig {
  const injected = (globalThis as { BLACKIRON_CONFIG?: Partial<BlackironConfig> }).BLACKIRON_CONFIG ?? {};
  const query = queryOverrides();
  const base = defaultConfig();
  const merged: BlackironConfig = {
    ...base,
    ...injected,
    ...query,
    ...overrides,
    viewport: { ...base.viewport, ...injected.viewport, ...overrides.viewport },
    render: { ...base.render, ...injected.render, ...query.render, ...overrides.render },
    post: { ...injected.post, ...overrides.post },
  };
  if (merged.renderScale && !injected.render && !query.render && !overrides.render) merged.render.scale = merged.renderScale;
  return merged;
}

export type AppMode = "web" | "native" | "headless";

export interface AppOptions {
  /** Canvas element or selector. Created and appended to `document.body` when omitted. */
  canvas?: HTMLCanvasElement | string;
  config?: Partial<BlackironConfig>;
  /** No DOM, no loop, a recording renderer. For tests and tools. */
  headless?: boolean;
  mode?: AppMode;
  renderer?: Renderer;
  /** Skip baking and use this atlas. */
  atlas?: Atlas;
  platform?: Platform;
}

export interface PushOptions {
  /** Keep drawing the scene below; only the top scene updates and takes input. */
  overlay?: boolean;
}

export class SceneStack {
  private readonly stack: Scene[] = [];

  constructor(private readonly app: App) {}

  get current(): Scene | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  get depth(): number {
    return this.stack.length;
  }

  /** Scenes to draw this frame: from the last non-overlay scene up to the top. */
  visible(): Scene[] {
    let i = this.stack.length - 1;
    while (i > 0 && this.stack[i].overlay) i--;
    return this.stack.slice(Math.max(0, i));
  }

  /** Replace every scene with this one, optionally behind a transition. */
  change(scene: Scene, opts: TransitionOptions = {}): Scene {
    if (opts.transition) {
      this.transition(opts, () => {
        while (this.stack.length) this.pop();
        this.pushNow(scene, {});
      });
      return scene;
    }
    while (this.stack.length) this.pop();
    return this.pushNow(scene, {});
  }

  /** Push on top; the scene below keeps its state but stops updating. */
  push(scene: Scene, opts: PushOptions & TransitionOptions = {}): Scene {
    if (opts.transition) {
      this.transition(opts, () => this.pushNow(scene, opts));
      return scene;
    }
    return this.pushNow(scene, opts);
  }

  private pushNow(scene: Scene, opts: PushOptions): Scene {
    scene.overlay = opts.overlay ?? false;
    this.stack.push(scene);
    this.app.attachScene(scene);
    return scene;
  }

  /** Run `swap` at the midpoint of a cover-and-reveal overlay. */
  private transition(opts: TransitionOptions, swap: () => void): void {
    const kind = opts.transition ?? "fade";
    const t: TransitionScene = new TransitionScene(
      kind,
      (opts.duration ?? 0.6) * (this.app.accessibility.reducedMotion ? 0.3 : 1),
      opts.color ?? 0x000000,
      () => {
        // Keep the transition on top while the scenes under it change.
        const idx = this.stack.indexOf(t);
        if (idx >= 0) this.stack.splice(idx, 1);
        swap();
        this.stack.push(t);
      },
      () => {
        const idx = this.stack.indexOf(t);
        if (idx >= 0) {
          this.stack.splice(idx, 1);
          t.detach();
        }
      },
    );
    this.pushNow(t, { overlay: true });
  }

  pop(): Scene | null {
    const s = this.stack.pop() ?? null;
    if (s) s.detach();
    return s;
  }

  all(): readonly Scene[] {
    return this.stack;
  }
}

/** What a native host calls into. Installed as `globalThis.__blackiron` by `bindHost`. */
export interface HostBridge {
  pointerCapture(locked:boolean):void;
  mouseMotion(x:number,y:number):void;
  frame(timeMs: number): void;
  pointer(kind: "down" | "move" | "up" | "cancel", id: number, x: number, y: number, type?: "touch" | "mouse" | "pen"): void;
  /** A pointer event already in logical units (scripted taps in screenshot tests). */
  pointerLogical(kind: "down" | "move" | "up" | "cancel", id: number, x: number, y: number): void;
  key(code: string, down: boolean): void;
  /** Typed characters (from a keyboard or an on-screen keyboard). */
  text(text: string): void;
  /** Wheel or scroll delta in logical units, positive is down. */
  wheel(dy: number): void;
  resize(width: number, height: number, scale: number, insets?: [number, number, number, number]): void;
  visibility(visible: boolean): void;
  capture(): string | null;
}

const FRAME_HISTORY = 120;

export class App {
  readonly platform: Platform;
  readonly config: BlackironConfig;
  readonly mode: AppMode;
  readonly canvas: HTMLCanvasElement | null;
  readonly renderer: Renderer;
  readonly atlas: Atlas;
  readonly draw: DrawContext;
  readonly input = new ActionMap();
  readonly pointer = new Pointer();
  readonly gamepad = new GamepadInput();
  readonly audio: AudioEngine;
  /** The active scene's physics world. Every stacked scene has an isolated simulation. */
  get physics(): PhysicsWorld | null {
    return this.scene?.physics ?? this.pendingPhysics;
  }
  private pendingPhysics: PhysicsWorld | null = null;
  private physicsFactory: (() => PhysicsWorld) | null = null;
  private enablingPhysics: Promise<PhysicsWorld> | null = null;
  private destroyed = false;
  /** Defaults for UI nodes that pass no style. */
  theme: Theme = defaultTheme;
  /**
   * Player preferences the engine honours: camera shake scale, shorter transitions, text size;
   * and `announce(text)`, which reads text out through the platform's screen reader when one is on.
   */
  readonly accessibility = { shakeScale: 1, reducedMotion: false, textScale: 1, announce: (text: string): void => this.platform.announce?.(text) };
  private typed: string[] = [];
  readonly tweens = new Tweens();
  readonly rng: Rng;
  readonly clock: FixedStep;
  readonly scenes = new SceneStack(this);
  readonly basePost: PostSettings;
  /** Renderer stats from the previous completed frame. */
  readonly lastStats: RenderStats = { drawCalls: 0, sprites: 0, frameMs: 0, targetWidth: 0, targetHeight: 0 };
  /** CPU milliseconds for the whole last frame: input, updates, draw and submission. */
  cpuMs = 0;
  /** Per-node and per-system timings; `profiler.enable()` or F4 turns it on. */
  readonly profiler = new Profiler(() => this.platform.now());
  /** Recent frame times in milliseconds, oldest first once full. */
  readonly frameTimes = new Float32Array(FRAME_HISTORY);
  /** Safe-area insets in logical units: top, right, bottom, left. */
  readonly safeInsets: [number, number, number, number] = [0, 0, 0, 0];
  private frameIndex = 0;
  debug = false;
  /** Whether the frame-rate counter is drawn. */
  showFps = false;
  running = false;
  /** Real seconds since start. */
  time = 0;
  frames = 0;
  fps = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private last = 0;
  private cancelFrame: (() => void) | null = null;
  private cleanups: (() => void)[] = [];
  private readonly bg: number;
  private stepFirst = true;
  private logicalW: number;
  private logicalH: number;
  /** Where the logical viewport sits inside the host view, in points. */
  private view = { x: 0, y: 0, w: 0, h: 0 };

  private constructor(platform: Platform, config: BlackironConfig, canvas: HTMLCanvasElement | null, renderer: Renderer, atlas: Atlas, mode: AppMode) {
    this.audio = new AudioEngine(
      mode === "web" && audioContextCtor()
        ? new WorkletBackend()
        : mode === "native" && (platform as NativePlatform).host.audio
          ? new NativeAudioBackend((platform as NativePlatform).host.audio as NonNullable<NativePlatform["host"]["audio"]>)
          : null,
    );
    this.platform = platform;
    this.config = config;
    this.canvas = canvas;
    this.renderer = renderer;
    this.atlas = atlas;
    this.mode = mode;
    this.logicalW = config.viewport.width;
    this.logicalH = config.viewport.height;
    this.view = { x: 0, y: 0, w: this.logicalW, h: this.logicalH };
    this.draw = new DrawContext(renderer, atlas);
    this.draw.pixelSnap = config.pixelSnap && config.render.snap !== "none";
    // Under a synthetic clock (screenshot tests) an unseeded game still renders the same frame.
    this.rng = new Rng(config.seed ?? (platform.deterministic ? 1 : Date.now()));
    // Stores persist through the platform; scripted (golden) runs start from nothing every time.
    setDefaultBackend(platform.deterministic ? memoryBackend() : platform.storage());
    this.clock = new FixedStep(config.fixedStep);
    this.bg = rgbOf(config.background);
    this.basePost = { ...defaultPost(), ...config.post, tint: typeof config.post.tint === "string" ? rgbOf(config.post.tint) : (config.post.tint ?? 0xffffff) };
    this.debug = config.debug ?? false;
    this.showFps = (config.fps ?? false) && !platform.deterministic;
    renderer.uploadAtlas(atlas);
  }

  /** Kept for 0.1 callers. */
  get headless(): boolean {
    return this.mode === "headless";
  }

  static async create(opts: AppOptions = {}): Promise<App> {
    const config = resolveConfig(opts.config);
    const platform = opts.platform ?? (opts.headless ? new HeadlessPlatform() : detectPlatform());
    const mode: AppMode = opts.mode ?? (opts.headless ? "headless" : platform.kind === "native" ? "native" : platform.kind === "headless" ? "headless" : "web");
    const { width, height } = config.viewport;
    if (mode === "web" && config.fonts?.length) await loadFonts(config.fonts);
    const images = await resolveAssets(platform);
    const atlas = opts.atlas ?? bakeAtlas({ images });
    if (mode === "headless") {
      const app = new App(platform, config, null, opts.renderer ?? new FakeRenderer(width, height), atlas, "headless");
      app.renderer.resize(width, height, 1);
      return app;
    }
    if (mode === "native") {
      const native = platform as NativePlatform;
      const renderer = opts.renderer ?? new NativeRenderer(native.host, width, height, { scale: config.render.scale });
      const app = new App(platform, config, null, renderer, atlas, "native");
      const s = native.host.screen;
      app.hostResize(s.width, s.height, s.scale, s.insets);
      (globalThis as { blackiron?: App }).blackiron = app;
      if (config.physics) await app.enablePhysics();
      return app;
    }
    let canvas: HTMLCanvasElement;
    if (opts.canvas instanceof HTMLCanvasElement) canvas = opts.canvas;
    else if (typeof opts.canvas === "string") {
      const el = document.querySelector(opts.canvas);
      if (!(el instanceof HTMLCanvasElement)) throw new Error(`No canvas matches "${opts.canvas}"`);
      canvas = el;
    } else {
      canvas = document.createElement("canvas");
      document.body.appendChild(canvas);
    }
    const kernel = opts.renderer ? undefined : await createKernel(config.kernel, config.kernelOptions);
    const renderer = opts.renderer ?? createRenderer(config.renderer, canvas, width, height, { scale: config.render.scale, fallback: config.fallback, kernel });
    const app = new App(platform, config, canvas, renderer, atlas, "web");
    app.attachDom();
    app.layout();
    // A console handle: `blackiron.scene`, `blackiron.debug = true`, `blackiron.renderer.stats`.
    (globalThis as { blackiron?: App }).blackiron = app;
    if (config.physics) await app.enablePhysics();
    return app;
  }

  /** Current logical width; equals the viewport width unless the scale mode is "expand". */
  get width(): number {
    return this.logicalW;
  }

  get height(): number {
    return this.logicalH;
  }

  get scene(): Scene | null {
    return this.scenes.current;
  }

  /** @internal */
  attachScene(scene: Scene): void {
    scene.post = { ...this.basePost };
    this.attachScenePhysics(scene);
    scene.attach(this);
  }

  private attachScenePhysics(scene: Scene): void {
    if (scene.physics || !this.physicsFactory) return;
    scene.physics = this.pendingPhysics ?? this.physicsFactory();
    this.pendingPhysics = null;
  }

  /**
   * Create the physics world. On the web this fetches `physics.wasm` next to the game;
   * native hosts have it built in; tests pass the module bytes in `opts.wasm`.
   */
  async enablePhysics(opts: PhysicsConfig & { wasm?: BufferSource } = {}): Promise<PhysicsWorld> {
    if (this.destroyed) throw new Error("Cannot enable physics on a destroyed App");
    if (this.physics) return this.physics;
    if (this.enablingPhysics) return this.enablingPhysics;
    this.enablingPhysics = this.initializePhysics(opts).finally(() => { this.enablingPhysics = null; });
    return this.enablingPhysics;
  }

  private async initializePhysics(opts: PhysicsConfig & { wasm?: BufferSource }): Promise<PhysicsWorld> {
    const ppm = opts.pixelsPerMeter ?? this.config.physics?.pixelsPerMeter ?? 100;
    const gravity = opts.gravity ?? this.config.physics?.gravity ?? [0, 980];
    const host = this.mode === "native" ? (this.platform as NativePlatform).host : null;
    if (host && typeof (host as { createPhysics?: (ppm: number) => NativePhysicsWorld }).createPhysics === "function") {
      this.physicsFactory = () => new PhysicsWorld(new NativePhysics((host as unknown as { createPhysics(ppm: number): NativePhysicsWorld }).createPhysics(ppm)), gravity);
      this.pendingPhysics = this.physicsFactory();
    } else {
      const bytes = opts.wasm ?? (await this.platform.loadBytes("physics.wasm"));
      const backend = await loadWasmPhysics(bytes, ppm);
      if (this.destroyed) {
        backend.destroy();
        throw new Error("App was destroyed while loading physics");
      }
      this.pendingPhysics = new PhysicsWorld(backend, gravity);
      this.physicsFactory = () => new PhysicsWorld(backend.fork(ppm), gravity);
    }
    for (const scene of this.scenes.all()) {
      this.attachScenePhysics(scene);
      for (const node of scene.findAll(PhysicsBody2D)) if (node.body < 0) node.attach(scene.physics!);
    }
    return this.physics!;
  }

  /** Merge into the theme; existing UI nodes pick up changes on their next draw. */
  setTheme(patch: ThemePatch): Theme {
    this.theme = mergeTheme(this.theme, patch);
    return this.theme;
  }

  /** A key edge from any host: the scene (a focused text field) may consume it before the action map. */
  keyEvent(code: string, down: boolean): boolean {
    if (this.scene?.onKey(code, down)) return true;
    return down ? this.input.keyDown(code) : this.input.keyUp(code);
  }

  /** Typed text from any host, delivered to the scene on the next frame. */
  textEvent(text: string): void {
    if (text) this.typed.push(text);
  }

  /** Ask the host for its on-screen keyboard where one exists (phones). */
  showKeyboard(visible: boolean): void {
    if (this.mode === "native") (this.platform as NativePlatform).host.showKeyboard?.(visible);
  }

  /** Haptic feedback on devices that have it; nothing elsewhere. */
  haptic(kind: HapticKind = "light"): void {
    this.platform.haptic?.(kind);
  }

  /** Fetch and decode an audio file into a sample playable with `audio.play(name)`. */
  async loadSample(name: string, url: string): Promise<boolean> {
    return this.audio.loadSample(name, await this.platform.loadBytes(url));
  }

  // --- Loop ----------------------------------------------------------------------------

  start(): void {
    if (this.running || this.mode === "headless") return;
    this.running = true;
    this.last = this.platform.now();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.cancelFrame?.();
    this.cancelFrame = null;
  }

  private schedule(): void {
    this.cancelFrame = this.platform.requestFrame((t) => this.tick(t));
  }

  private tick(now: number): void {
    if (!this.running) return;
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    this.frame(dt);
    this.schedule();
  }

  /** Route input and run fixed steps. Disable drawing for replays, simulation tests and catch-up work. */
  frame(dt: number, options: { render?: boolean } = {}): void {
    if (this.destroyed) return;
    const t0 = this.platform.now();
    this.time += dt;
    this.frames++;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    const prof = this.profiler.isEnabled ? this.profiler : null;
    prof?.beginFrame();
    prof?.begin("input");
    if (this.mode === "web") this.gamepad.poll(this.input);
    if (this.pointer.down && this.pointer.type === "touch") this.input.lastDevice = "touch";
    const scene = this.scene;
    if (scene) {
      let source: object | undefined;
      let target: Scene | null = null;
      for (const ev of this.input.drain()) {
        const nextSource = this.input.sourceOf(ev);
        // Escape may be bound to both back and pause. Once one alias changes the scene,
        // the remaining aliases of that same physical edge must not undo the transition.
        if (nextSource && nextSource === source && this.scene !== target) continue;
        if (nextSource !== source || !nextSource) { source = nextSource; target = this.scene; }
        this.scene?.onAction(ev.name, ev.pressed);
      }
      const pointer = this.pointer.consumeRoutingSnapshot();
      this.scene?.routePointer(pointer);
      if (this.typed.length) {
        const chunks = this.typed;
        this.typed = [];
        for (const t of chunks) this.scene?.onText(t);
      }
    } else {
      this.typed.length = 0;
      this.pointer.consumeRoutingSnapshot();
    }
    prof?.end("input");
    this.stepFirst = true;
    this.clock.advance(dt, (step) => {
      prof?.begin("update");
      const active = this.scene;
      active?.updateTree(step);
      prof?.end("update");
      prof?.begin("tweens");
      this.tweens.update(step);
      prof?.end("tweens");
      const physics = active?.physics ?? null;
      if (physics && active === this.scene && active!.worldStep > 0) {
        prof?.begin("physics");
        for (const n of physics.nodes.values()) n.beforeStep();
        const events = physics.step(active!.worldStep);
        for (const n of physics.nodes.values()) n.afterStep();
        dispatchCollisions(physics, events);
        prof?.end("physics");
      }
      if (this.stepFirst) {
        this.stepFirst = false;
        this.input.endFrame();
        this.pointer.endFrame();
      }
    });
    if (options.render !== false) this.render();
    prof?.endFrame();
    this.cpuMs = this.platform.now() - t0;
    this.frameTimes[this.frameIndex % FRAME_HISTORY] = this.cpuMs;
    this.frameIndex++;
  }

  private render(): void {
    const visible = this.scenes.visible();
    const top = visible[visible.length - 1] ?? null;
    const r = this.renderer;
    const prof = this.profiler.isEnabled ? this.profiler : null;
    prof?.begin("draw");
    this.draw.beginFrame();
    r.begin(visible[0] ? visible[0].background : this.bg);
    for (const s of visible) s.drawTree(this.draw);
    prof?.end("draw");
    if (this.showFps) this.drawFps();
    if (this.debug) this.drawOverlay();
    if (prof) this.drawProfiler();
    prof?.begin("present");
    r.end(top ? top.post : this.basePost, 0, 0);
    prof?.end("present");
    this.lastStats.drawCalls = r.stats.drawCalls;
    this.lastStats.sprites = r.stats.sprites;
    this.lastStats.frameMs = r.stats.frameMs;
    this.lastStats.targetWidth = r.stats.targetWidth;
    this.lastStats.targetHeight = r.stats.targetHeight;
  }

  /** A small performance pill in the bottom-right corner: fps, frame time, draw calls. */
  private drawFps(): void {
    const d = this.draw;
    d.beginPass("overlay");
    d.beginLayer([1, 0, 0, 1, 0, 0], { x: 0, y: 0, w: this.width, h: this.height }, false);
    const s = this.lastStats;
    const font = { family: "system-ui", size: Math.max(12, Math.round(this.height / 48)), weight: 600 as const };
    const text = `${this.fps} FPS   ${this.cpuMs.toFixed(1)} ms   ${s.drawCalls} calls`;
    const useFont = this.renderer.features.text;
    const w = useFont ? this.renderer.measureText(text, font).width : d.measure(text);
    const h = useFont ? this.renderer.measureText("Hg", font).height : 7;
    const pad = Math.round(font.size * 0.45);
    const x = this.width - w - pad * 2 - 8 - this.safeInsets[1];
    const y = this.height - h - pad * 2 - 8 - this.safeInsets[2];
    const color = this.fps >= 55 ? 0x7ee39a : this.fps >= 30 ? 0xf2c14e : 0xff6b5a;
    d.rect(x, y, w + pad * 2, h + pad * 2, 0x000000, 0.55);
    d.rect(x, y, 3, h + pad * 2, color, 0.9);
    if (useFont) d.text(text, x + pad + 3, y + pad, { font, color, shadow: 0x000000 });
    else d.text(text, x + pad + 3, y + pad, { color, shadow: 0x000000 });
  }

  /** The profiler panel: frame sections and the heaviest node classes, top-left. */
  private drawProfiler(): void {
    const d = this.draw;
    d.beginPass("overlay");
    d.beginLayer([1, 0, 0, 1, 0, 0], { x: 0, y: 0, w: this.width, h: this.height }, false);
    const lines = this.profiler.lines(8);
    const w = Math.max(...lines.map((l) => d.measure(l))) + 8;
    const x = 2 + this.safeInsets[3];
    const y = 2 + this.safeInsets[0];
    d.rect(x, y, w, lines.length * 9 + 6, 0x000000, 0.65);
    for (let i = 0; i < lines.length; i++) d.text(lines[i], x + 4, y + 3 + i * 9, { color: i === 0 ? 0xffe28a : 0xc9c6e0 });
  }

  private drawOverlay(): void {
    const d = this.draw;
    d.beginPass("overlay");
    d.beginLayer([1, 0, 0, 1, 0, 0], { x: 0, y: 0, w: this.width, h: this.height }, false);
    const s = this.lastStats;
    const lines = [
      `${this.renderer.kind}  ${this.fps} fps  ${this.cpuMs.toFixed(1)} ms cpu  ${s.frameMs.toFixed(1)} ms draw  ${s.targetWidth}x${s.targetHeight}`,
      `${s.drawCalls} calls  ${s.sprites} sprites  ${this.scene ? this.scene.name || this.scene.constructor.name : "-"}`,
    ];
    const w = Math.max(...lines.map((l) => d.measure(l))) + 8;
    const graphH = 18;
    const y = this.height - 24 - graphH - 4 - this.safeInsets[2];
    d.rect(2, y, Math.max(w, FRAME_HISTORY + 8), 22 + graphH + 4, 0x000000, 0.6);
    d.text(lines[0], 6, y + 3, { color: 0xffe28a });
    d.text(lines[1], 6, y + 12, { color: 0xc9c6e0 });
    const gy = y + 24 + graphH;
    d.rect(6, gy - Math.round((16.7 / 33) * graphH), FRAME_HISTORY, 1, 0xffffff, 0.25);
    for (let i = 0; i < FRAME_HISTORY; i++) {
      const ms = this.frameTimes[(this.frameIndex + i) % FRAME_HISTORY];
      const h = Math.min(graphH, Math.round((ms / 33) * graphH));
      if (h <= 0) continue;
      d.rect(6 + i, gy - h, 1, h, ms < 8 ? 0x6cc08d : ms < 16.7 ? 0xe3b341 : 0xe6925a, 0.9);
    }
  }

  // --- Layout, shared by web and native ---------------------------------------------------

  /** Compute the letterboxed view (in points) and the logical size for a container. */
  private computeLayout(availW: number, availH: number): { cssW: number; cssH: number; lw: number; lh: number } {
    return layoutFor(this.config.viewport, availW, availH);
  }

  private applyLogicalSize(lw: number, lh: number): void {
    if (lw === this.logicalW && lh === this.logicalH) return;
    this.logicalW = lw;
    this.logicalH = lh;
    this.renderer.setLogicalSize(lw, lh);
    for (const s of this.scenes.all()) s.resize(lw, lh);
  }

  /** Size the canvas to its container according to the viewport scale mode. */
  layout(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const availW = parent ? parent.clientWidth : window.innerWidth;
    const availH = parent ? parent.clientHeight : window.innerHeight;
    const { cssW, cssH, lw, lh } = this.computeLayout(availW, availH);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    this.view = { x: 0, y: 0, w: cssW, h: cssH };
    this.applyLogicalSize(lw, lh);
    this.renderer.resize(cssW, cssH, this.platform.pixelRatio());
  }

  // --- Native host entry points -----------------------------------------------------------

  /** The host's view changed size or scale. Sizes are in points. */
  hostResize(width: number, height: number, scale: number, insets: [number, number, number, number] = [0, 0, 0, 0]): void {
    const { cssW, cssH, lw, lh } = this.computeLayout(width, height);
    this.view = { x: Math.floor((width - cssW) / 2), y: Math.floor((height - cssH) / 2), w: cssW, h: cssH };
    this.applyLogicalSize(lw, lh);
    this.renderer.resize(cssW, cssH, scale);
    const r = this.renderer as Renderer & { setPresentRect?: (x: number, y: number, w: number, h: number) => void };
    r.setPresentRect?.(Math.round(this.view.x * scale), Math.round(this.view.y * scale), Math.round(cssW * scale), Math.round(cssH * scale));
    const k = this.logicalW / Math.max(1, cssW);
    this.safeInsets[0] = Math.max(0, insets[0] - this.view.y) * k;
    this.safeInsets[1] = Math.max(0, insets[1] - this.view.x) * k;
    this.safeInsets[2] = Math.max(0, insets[2] - this.view.y) * k;
    this.safeInsets[3] = Math.max(0, insets[3] - this.view.x) * k;
  }

  /** A pointer event from the host, in points relative to the view. */
  hostPointer(kind: "down" | "move" | "up" | "cancel", id: number, x: number, y: number, type: "touch" | "mouse" | "pen" = "touch"): void {
    const lx = ((x - this.view.x) / Math.max(1, this.view.w)) * this.logicalW;
    const ly = ((y - this.view.y) / Math.max(1, this.view.h)) * this.logicalH;
    if (kind === "down") {
      this.audio.unlock();
      this.pointer.handleDown(lx, ly, 0, id, type);
    } else if (kind === "move") this.pointer.handleMove(lx, ly, type, id);
    else this.pointer.handleUp(lx, ly, id);
  }

  /** Install `globalThis.__blackiron` for a native host and return it. */
  bindHost(): HostBridge {
    const platform = this.platform as NativePlatform;
    const bridge: HostBridge = {
      pointerCapture:locked=>nativePointerCapture(this.input,locked),
      mouseMotion:(x,y)=>nativePointerMotion(this.input,x,y),
      frame: (t) => platform.fireFrame(t),
      pointer: (kind, id, x, y, type) => this.hostPointer(kind, id, x, y, type),
      pointerLogical: (kind, id, x, y) => {
        // The desktop snapshot host scripts logical mouse clicks. Treating them as touch
        // incorrectly turns on virtual sticks and touch-only prompts in golden images.
        if (kind === "down") this.pointer.handleDown(x, y, 0, id, "mouse");
        else if (kind === "move") this.pointer.handleMove(x, y, "mouse", id);
        else this.pointer.handleUp(x, y, id);
      },
      text: (text) => this.textEvent(text),
      wheel: (dy) => this.pointer.handleWheel(dy),
      key: (code, down) => {
        this.keyEvent(code, down);
      },
      resize: (w, h, scale, insets) => this.hostResize(w, h, scale, insets),
      visibility: (v) => {
        platform.setVisible(v);
        if (!v) this.stop();
        else if (!this.running) this.start();
      },
      capture: () => this.renderer.snapshot?.() ?? null,
    };
    (globalThis as { __blackiron?: HostBridge }).__blackiron = bridge;
    return bridge;
  }

  // --- DOM -------------------------------------------------------------------------

  private attachDom(): void {
    const canvas = this.canvas as HTMLCanvasElement;
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    canvas.style.display = "block";
    canvas.style.imageRendering = this.config.render.scale === "native" ? "auto" : "pixelated";
    canvas.tabIndex = canvas.tabIndex >= 0 ? canvas.tabIndex : 0;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window | Document, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    const toLogical = (e: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [((e.clientX - rect.left) / rect.width) * this.width, ((e.clientY - rect.top) / rect.height) * this.height];
    };
    const ptype = (e: PointerEvent) => (e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse");
    on(canvas.ownerDocument, "pointerlockchange", () => this.pointer.cancel());
    on(canvas, "pointerdown", (e: PointerEvent) => {
      if (canvas.ownerDocument.pointerLockElement === canvas) return;
      const [x, y] = toLogical(e);
      this.audio.unlock();
      this.pointer.handleDown(x, y, e.button, e.pointerId, ptype(e));
      canvas.setPointerCapture?.(e.pointerId);
      canvas.focus({ preventScroll: true });
      e.preventDefault();
    });
    on(canvas, "pointermove", (e: PointerEvent) => {
      if (canvas.ownerDocument.pointerLockElement === canvas) return;
      const [x, y] = toLogical(e);
      this.pointer.handleMove(x, y, ptype(e), e.pointerId);
    });
    on(canvas, "pointerup", (e: PointerEvent) => {
      if (canvas.ownerDocument.pointerLockElement === canvas) return;
      const [x, y] = toLogical(e);
      this.pointer.handleUp(x, y, e.pointerId);
    });
    on(canvas, "pointercancel", (e: PointerEvent) => {
      this.pointer.handleUp(this.pointer.x, this.pointer.y, e.pointerId);
    });
    on(canvas, "pointerleave", () => this.pointer.handleLeave());
    on(canvas, "wheel", (e: WheelEvent) => {
      this.pointer.handleWheel(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    on(canvas, "contextmenu", (e: Event) => e.preventDefault());
    on(window, "keydown", (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      this.audio.unlock();
      if (e.code === "Backquote" && !e.repeat) {
        this.debug = !this.debug;
        e.preventDefault();
        return;
      }
      if (e.code === "F8" && !e.repeat) {
        void this.capture();
        e.preventDefault();
        return;
      }
      if (e.code === "F3" && !e.repeat) {
        this.showFps = !this.showFps;
        e.preventDefault();
        return;
      }
      if (e.code === "F4" && !e.repeat) {
        this.profiler.toggle();
        e.preventDefault();
        return;
      }
      // An input method is composing (CJK, dead keys): the text arrives on compositionend.
      if (e.isComposing || e.keyCode === 229) return;
      if (this.scene?.hasTextFocus && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.textEvent(e.key);
        this.keyEvent(e.code, true);
        e.preventDefault();
        return;
      }
      if (this.keyEvent(e.code, true)) e.preventDefault();
    });
    on(window, "keyup", (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (this.keyEvent(e.code, false)) e.preventDefault();
    });
    on(window, "compositionend", (e: CompositionEvent) => {
      if (this.scene?.hasTextFocus && e.data) this.textEvent(e.data);
    });
    on(window, "blur", () => {
      this.input.reset();
      this.pointer.cancel();
      this.gamepad.reset(this.input);
    });
    this.cleanups.push(
      this.platform.onVisibility((visible) => {
        if (!visible) this.stop();
        else if (!this.running) this.start();
      }),
    );
    const parent = canvas.parentElement ?? document.body;
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.layout());
      ro.observe(parent);
      this.cleanups.push(() => ro.disconnect());
    } else on(window, "resize", () => this.layout());
    const mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    if (mq) on(mq as unknown as HTMLElement, "change", () => this.layout());
  }

  /**
   * Capture the last frame as a PNG data URL. In `blackiron dev` it is also posted to the
   * server, which writes it to `screenshots/`. Bound to F8.
   */
  async capture(name = `shot-${Date.now()}`): Promise<string | null> {
    this.render();
    const url = this.renderer.snapshot?.() ?? null;
    if (!url) return null;
    if (this.mode !== "web") return url;
    try {
      const res = await fetch(`dev/screenshot?name=${encodeURIComponent(name)}`, { method: "POST", body: url });
      if (res.ok) console.info(`[blackiron] saved screenshots/${name}.png`);
    } catch {
      /* not running under blackiron dev */
    }
    return url;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    while (this.scenes.depth) this.scenes.pop();
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    this.pendingPhysics?.destroy();
    this.pendingPhysics = null;
    this.physicsFactory = null;
    this.tweens.clear();
    this.typed.length = 0;
    this.input.reset();
    this.pointer.cancel();
    this.gamepad.reset(this.input);
    this.audio.destroy();
    this.renderer.destroy();
  }
}

/** Inject stylesheet links and wait briefly for the fonts they declare. */
async function loadFonts(urls: string[]): Promise<void> {
  const families: string[] = [];
  for (const url of urls) {
    if (!document.querySelector(`link[href="${url}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      document.head.appendChild(link);
    }
    for (const m of url.matchAll(/family=([^&:]+)/g)) families.push(decodeURIComponent(m[1]).replace(/\+/g, " "));
  }
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  const loads = families.map((f) => fonts.load(`700 16px "${f}"`).catch(() => undefined));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 2000))]);
}
