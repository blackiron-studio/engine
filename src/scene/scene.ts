import { ResourceScope } from "../content/resources.ts";
// A Scene is the root of a node tree plus a camera, a UI layer, post settings and its
// own tweens. The App owns a stack of scenes and drives the active one.

import type { App } from "../app/app.ts";
import { type Insets, type ScreenInfo, describeScreen } from "../app/screen.ts";
import type { PhysicsWorld } from "../physics/world.ts";
import type { Rect } from "../core/math.ts";
import { Rng } from "../core/rng.ts";
import { Tweens } from "../core/tween.ts";
import { type Mat, type PostSettings, defaultPost, matIdentity } from "../render/types.ts";
import { Camera2D } from "./camera.ts";
import type { DrawContext } from "./draw.ts";
import { Node, Node2D } from "./node.ts";
import { Control, type PointerSnapshot, routePointer } from "./ui.ts";

/** What a focused text field must offer the scene. */
export interface TextTarget {
  type(text: string): void;
  key(code: string, down: boolean): boolean;
  blur(): void;
}

/** Marker for screen-space layers; the scene's `ui` is one. */
export class CanvasLayer extends Node2D {}

/** Ink behind a UI that no longer covers the whole screen, drawn in the world so it is not scaled with the UI. */
class FitBackdrop extends Node2D {
  constructor(
    public ink: number,
    public opacity: number,
  ) {
    super();
    this.name = "fit-backdrop";
  }

  override render(ctx: DrawContext): void {
    ctx.rect(-16000, -16000, 32000, 32000, this.ink, this.opacity);
  }
}

/** A tap target a game draws itself, in `ui` units; see `Scene.reportTarget`. */
export interface ReportedTarget {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FitOptions {
  /** Colour behind the fitted UI where it does not reach the edges; null for none. Black by default. */
  backdrop?: number | null;
  backdropAlpha?: number;
  /** Largest scale allowed; 1 keeps pixel art crisp on big screens. */
  max?: number;
}

export class Scene extends Node {
  resources = new ResourceScope();
  private _app: App | null = null;
  /** World-space content, drawn under the camera and lit. */
  readonly world = new Node2D();
  /** Screen-space content, drawn last, unlit and ungraded. */
  readonly ui = new CanvasLayer();
  readonly camera: Camera2D;
  readonly tweens = new Tweens();
  post: PostSettings = defaultPost();
  background = 0x000000;
  rng = new Rng(1);
  /** Whether `ready` has run; nodes added afterwards are readied immediately. */
  isStarted = false;
  /** Pushed as an overlay: the scene below keeps drawing underneath. */
  overlay = false;
  /** Multiplies the world's time: 0.3 for slow motion, 0 to freeze. The UI layer keeps real time. */
  timeScale = 1;
  /** This scene's isolated simulation, created by App.enablePhysics and disposed on detach. */
  physics: PhysicsWorld | null = null;
  /** @internal World delta used by the most recent update, shared with physics. */
  worldStep = 0;
  /** Seconds of world freeze left; see `hitStop`. */
  hitStopLeft = 0;
  /** World-to-screen matrix as of the last draw. */
  readonly cameraMatrix: Mat = matIdentity();
  /** Control currently under the pointer, if any. */
  hoveredControl: Control | null = null;
  private controlsCache: Control[] | null = null;

  constructor(width = 640, height = 360) {
    super();
    this.camera = new Camera2D(width, height);
    this.world.name = "world";
    this.ui.name = "ui";
    this.scene = this;
    super.add(this.world);
    super.add(this.ui);
  }

  override get app(): App {
    if (!this._app) throw new Error("Scene is not attached to an App");
    return this._app;
  }

  /** The App this scene is attached to, or null before `scenes.change` / `push`. */
  get attachedApp(): App | null {
    return this._app;
  }

  get width(): number {
    return this.camera.width;
  }

  get height(): number {
    return this.camera.height;
  }

  /** Logical size used by controls inside the fitted (or automatically grown) UI layer. */
  get uiWidth(): number { return this.fitDesign?.w ?? this.width / this.autoScale; }
  get uiHeight(): number { return this.fitDesign?.h ?? this.height / this.autoScale; }

  /**
   * The screen this scene is shown on (points, insets, touch, size class); see `App.screen`.
   * Not called `screen`, so games keep that name for their own state ("title", "play", …).
   */
  get screenInfo(): ScreenInfo {
    return this._app?.screen ?? describeScreen({ width: this.width, height: this.height, pixelRatio: 1, insets: [0, 0, 0, 0], touch: false, pointsPerUnit: 1 });
  }

  /** A small screen (under 600 points across): lay the UI out compactly. */
  get compact(): boolean {
    return this.screenInfo.compact;
  }

  /** The safe-area insets (notch, rounded corners, home bar) in UI units: top, right, bottom, left. */
  get uiInsets(): Insets {
    const ins = this._app?.safeInsets ?? [0, 0, 0, 0];
    const k = this.ui.scaleX || 1;
    const right = this.width - (this.ui.x + this.uiWidth * k),
      bottom = this.height - (this.ui.y + this.uiHeight * k);
    return [Math.max(0, ins[0] - this.ui.y) / k, Math.max(0, ins[1] - right) / k, Math.max(0, ins[2] - bottom) / k, Math.max(0, ins[3] - this.ui.x) / k];
  }

  /** The part of the UI layer clear of the notch and home bar, in UI units. */
  get safeRect(): Rect {
    const [t, r, b, l] = this.uiInsets;
    return { x: l, y: t, w: Math.max(0, this.uiWidth - l - r), h: Math.max(0, this.uiHeight - t - b) };
  }

  /** Whether `node` is drawn inside this scene's `ui` layer. */
  inUI(node: Node): boolean {
    for (let n: Node | null = node; n; n = n.parent) if (n === this.ui) return true;
    return false;
  }

  /** A point in logical screen units (the pointer, a touch) in the `ui` layer's units. */
  toUI(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.ui.x) / (this.ui.scaleX || 1), y: (y - this.ui.y) / (this.ui.scaleY || 1) };
  }

  /**
   * The size and safe-area insets of the layer `node` is drawn in: `uiWidth` × `uiHeight` and
   * `uiInsets` inside the `ui` layer (which `ui.minPoints` or `fitUI` may scale), the logical
   * size and `app.safeInsets` elsewhere. Full-screen nodes size themselves from this, not from
   * `ctx.width`, which is always the logical size.
   */
  areaOf(node: Node): { width: number; height: number; insets: Insets; ui: boolean } {
    if (this.inUI(node)) return { width: this.uiWidth, height: this.uiHeight, insets: this.uiInsets, ui: true };
    return { width: this.width, height: this.height, insets: this._app?.safeInsets ?? [0, 0, 0, 0], ui: false };
  }

  private readonly reported: ReportedTarget[] = [];
  private reportedCount = 0;

  /**
   * Report a tap target the game draws itself rather than with a Control, in `ui` units, so
   * `app.auditScreen()` and `blackiron screens` measure it with the engine's own buttons. Call
   * it from `render` on every frame the target is shown: the list starts empty each frame.
   */
  reportTarget(name: string, x: number, y: number, w: number, h: number): void {
    let t = this.reported[this.reportedCount];
    if (!t) this.reported.push((t = { name, x, y, w, h }));
    else Object.assign(t, { name, x, y, w, h });
    this.reportedCount++;
  }

  /** The tap targets reported with `reportTarget` in the last frame drawn, in `ui` units. */
  get reportedTargets(): readonly Readonly<ReportedTarget>[] {
    return this.reported.slice(0, this.reportedCount);
  }

  /**
   * Visible, enabled controls in the UI layer and the targets reported with `reportTarget`,
   * with their size on screen in logical units, for `App.auditScreen`.
   */
  measureControls(): { name: string; width: number; height: number }[] {
    const out: { name: string; width: number; height: number }[] = [];
    const kx = Math.abs(this.ui.scaleX),
      ky = Math.abs(this.ui.scaleY);
    for (let i = 0; i < this.reportedCount; i++) {
      const t = this.reported[i];
      if (t.w > 0 && t.h > 0) out.push({ name: t.name, width: t.w * kx, height: t.h * ky });
    }
    for (const c of this.ui.findAllInDrawOrder(Control)) {
      if (c.disabled || c.w <= 0 || c.h <= 0) continue;
      let sx = 1,
        sy = 1,
        shown = true;
      for (let n: Node | null = c; n && n !== this; n = n.parent) {
        if (!n.visible) shown = false;
        if (n instanceof Node2D) {
          sx *= Math.abs(n.scaleX);
          sy *= Math.abs(n.scaleY);
        }
      }
      if (!shown) continue;
      const label = (c as { text?: unknown }).text;
      out.push({ name: c.name || (typeof label === "string" && label ? `${c.constructor.name} "${label}"` : c.constructor.name), width: c.w * sx, height: c.h * sy });
    }
    return out;
  }

  /** Wider than tall. Lay out a side panel here and a bottom bar otherwise. */
  get wide(): boolean {
    return this.width > this.height;
  }

  get orientation(): "landscape" | "portrait" {
    return this.wide ? "landscape" : "portrait";
  }

  private fitDesign: { w: number; h: number; opts: FitOptions } | null = null;
  /** The scale `ui.minPoints` gave the UI layer (1 when it is off or not needed). */
  private autoScale = 1;

  /**
   * Lay the UI out for a fixed design size: the `ui` layer is scaled to fit the screen and
   * centred, a backdrop fills what it leaves, and the fit is kept through every resize. A
   * phone screen designed at 720 by 1280 shows on a desktop this way without a second layout.
   * Returns the scale applied.
   */
  fitUI(designW: number, designH: number, opts: FitOptions = {}): number {
    if (!Number.isFinite(designW) || !Number.isFinite(designH) || designW <= 0 || designH <= 0)
      throw new RangeError("UI design size must be positive and finite");
    this.fitDesign = { w: designW, h: designH, opts };
    return this.applyFit();
  }

  private applyFit(): number {
    const d = this.fitDesign;
    if (!d) {
      // Without a fixed design, `ui.minPoints` grows the UI on small screens; layouts then work
      // in uiWidth × uiHeight. A scene that scales its UI itself keeps doing so while this is 1.
      const s = this._app?.config.ui?.minPoints ? this._app.screen.uiScale : 1;
      if (s !== 1 || this.autoScale !== 1) {
        this.ui.scale = s;
        this.ui.x = 0;
        this.ui.y = 0;
      }
      this.autoScale = s;
      return s;
    }
    this.autoScale = 1;
    const k = Math.min(d.opts.max ?? 1, this.width / d.w, this.height / d.h);
    this.ui.scale = k;
    this.ui.x = Math.round((this.width - d.w * k) / 2);
    this.ui.y = Math.round((this.height - d.h * k) / 2);
    const colour = d.opts.backdrop;
    if (colour !== null) {
      let back = this.world.children.find((c) => c instanceof FitBackdrop) as FitBackdrop | undefined;
      if (!back) back = this.world.add(new FitBackdrop(colour ?? 0x000000, d.opts.backdropAlpha ?? 0.9));
      back.ink = colour ?? 0x000000;
      back.opacity = d.opts.backdropAlpha ?? 0.9;
    }
    return k;
  }

  /** Full-screen rect in logical pixels. */
  get screenRect(): Rect {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }

  // --- Hooks for subclasses ------------------------------------------------------

  /** Named input action changed state (from the ActionMap or a Button). */
  onAction(_name: string, _pressed: boolean): void {}
  /** Raw key codes before the action map sees them; return true to consume. Text inputs use this. */
  onKey(code: string, down: boolean): boolean {
    return this.activeInput?.key(code, down) ?? false;
  }
  /** Typed characters, delivered while a text input has focus. */
  onText(text: string): void {
    this.activeInput?.type(text);
  }
  /** The text field with keyboard focus, if any. */
  activeInput: TextTarget | null = null;
  get hasTextFocus(): boolean {
    return this.activeInput !== null;
  }
  /** Pointer pressed on the canvas at logical coordinates, if no control took it. */
  onPointerDown(_x: number, _y: number): void {}
  onPointerUp(_x: number, _y: number): void {}
  onPointerMove(_x: number, _y: number): void {}
  /** The logical size changed (viewport mode "expand"). Re-anchor UI here. */
  onResize(_width: number, _height: number): void {}

  // --- Driven by the App ---------------------------------------------------------

  /** @internal */
  attach(app: App): void {
    this._app = app;
    this.camera.width = app.width;
    this.camera.height = app.height;
    // fitUI may have been configured in a scene constructor, before the app's
    // actual viewport replaced the scene's default camera dimensions.
    this.applyFit();
    this.camera.snap = app.config.render.snap !== "none";
    // Fork by the scene's name so minified builds (which mangle class names) seed the same.
    this.rng = app.rng.fork(this.name || this.constructor.name);
    this.isStarted = false;
    this.enterTree(this);
    this.readyTree();
    this.isStarted = true;
  }

  /** @internal */
  detach(): void {
    this.activeInput?.blur();
    this.activeInput = null;
    const errors: unknown[] = [];
    for (const cleanup of [() => this.exitTree(), () => this.physics?.destroy(), () => this.resources.dispose()]) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    this.physics = null;
    this.resources = new ResourceScope();
    this.tweens.clear();
    this.isStarted = false;
    this.worldStep = 0;
    this.hoveredControl = null;
    this.controlsCache = null;
    this._app = null;
    if (errors.length) throw new AggregateError(errors, "Scene detach failed");
  }

  /** @internal */
  resize(width: number, height: number): void {
    this.camera.width = width;
    this.camera.height = height;
    this.camera.clampToBounds();
    this.applyFit();
    this.onResize(width, height);
    this.controlsCache = null;
  }

  override enterTree(scene: Scene): void {
    this.scene = scene;
    for (const c of this.childSnapshot()) if (c.parent === this) c.enterTree(scene);
  }

  /** Freeze the world for a moment (a heavy hit, a kill that should land); the UI keeps moving. */
  hitStop(seconds: number): void {
    if (seconds > this.hitStopLeft) this.hitStopLeft = seconds;
  }

  override updateTree(dt: number): void {
    this.worldStep = 0;
    if (this.paused) return;
    const frozen = Math.min(dt, Math.max(0, this.hitStopLeft));
    this.hitStopLeft = Math.max(0, this.hitStopLeft - dt);
    const sdt = (dt - frozen) * Math.max(0, this.timeScale);
    this.worldStep = this.world.paused ? 0 : sdt;
    const kids = this.childSnapshot();
    const app = this._app;
    this.tweens.update(dt);
    // A tween may change scenes (a game-over fade, say); a detached scene must not update.
    if (app && this._app !== app) return;
    this.update(sdt);
    if (app && this._app !== app) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.parent === this) c.updateTree(c === this.ui ? dt : sdt);
      if (app && this._app !== app) return;
    }
    this.camera.shakeScale = this._app?.accessibility.shakeScale ?? 1;
    this.camera.update(dt);
  }

  override drawTree(ctx: DrawContext): void {
    this.reportedCount = 0;
    this.camera.matrix(this.cameraMatrix);
    ctx.beginPass("world");
    ctx.beginLayer(this.cameraMatrix, this.camera.visibleRect(), true, this.camera.projectionMatrix());
    this.world.drawTree(ctx);
    ctx.beginPass("overlay");
    ctx.beginLayer([1, 0, 0, 1, 0, 0], this.screenRect, true);
    for (const c of this.children) if (c !== this.world && c !== this.ui) c.drawTree(ctx);
    this.ui.drawTree(ctx);
  }

  /** @internal Called by the App once per frame after input is sampled. */
  routePointer(p: PointerSnapshot): void {
    this.hoveredControl = routePointer(this.ui, p, this.controls());
    if (p.justPressed && this.activeInput && (this.hoveredControl as unknown) !== this.activeInput) this.activeInput.blur();
    if (!this.hoveredControl) {
      if (p.justPressed) this.onPointerDown(p.x, p.y);
      if (p.justReleased) this.onPointerUp(p.x, p.y);
    }
    this.onPointerMove(p.x, p.y);
  }

  /** Invalidate the control cache after adding or removing UI during a frame. */
  uiChanged(): void {
    this.controlsCache = null;
  }

  /** Every control on the UI layer, in draw order. */
  controls(): Control[] {
    // ySort can change without a structural mutation; use exactly the current draw order.
    this.controlsCache ??= [];
    this.controlsCache.length = 0;
    this.ui.findAllInDrawOrder(Control, this.controlsCache);
    return this.controlsCache;
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return this.camera.screenToWorld(sx, sy);
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return this.camera.worldToScreen(wx, wy);
  }
}
