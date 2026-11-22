import { type DirectionSet, type DirectionView, pickDirection, screenAngleOf, viewFrames } from "../art/directions.ts";
import { type AnimationDef, getAnimation } from "../art/sprites.ts";
import { type AnimationSetDef, type Facing, facingFrom, framesFor, getAnimationSet, hitboxOf, pointOf } from "../art/spritesets.ts";
import type { Heading } from "../core/heading.ts";
import type { Rect } from "../core/math.ts";
import type { ProjectionMatrix } from "../kernel/protocol.ts";
import type { SpriteMaterial } from "../render/types.ts";
import { groundDeltaOf } from "./camera.ts";
import type { DrawContext } from "./draw.ts";
import type { LayoutBox } from "./layout.ts";
import { type Node, Node2D } from "./node.ts";

/** Depth bias of the outgoing view while it fades over the new one, so the order is fixed. */
const FADE_BIAS = 0.01;

export class Sprite extends Node2D {
  flipX = false;
  flipY = false;
  tint = 0xffffff;
  additive = false;
  /** Linear filtering, for imported high-resolution art. */
  smooth = false;
  /** Also drawn into the light pass: unaffected by darkness, and it blooms. */
  emissive = false;
  /** Origin override in pixels; null uses the sprite definition's origin. */
  originX: number | null = null;
  originY: number | null = null;
  /** A fragment effect: `{ kind: "flash", p0 }`, `{ kind: "dissolve", p0 }`, `{ kind: "outline" }` (tint is the colour), `{ kind: "silhouette" }`. */
  material: SpriteMaterial | null = null;

  constructor(
    public sprite: string,
    x = 0,
    y = 0,
  ) {
    super(x, y);
  }

  /** Intrinsic atlas bounds for Row, Column and Margin, including the sprite origin and scale. */
  layoutBox(): LayoutBox {
    const atlas = this.scene?.attachedApp?.atlas;
    if (!atlas?.has(this.sprite)) return { w: 0, h: 0, ox: 0, oy: 0 };
    const region = atlas.region(this.sprite);
    const ox = this.originX ?? region.ox;
    const oy = this.originY ?? region.oy;
    const left = Math.min(-ox * this.scaleX, (region.w - ox) * this.scaleX);
    const right = Math.max(-ox * this.scaleX, (region.w - ox) * this.scaleX);
    const top = Math.min(-oy * this.scaleY, (region.h - oy) * this.scaleY);
    const bottom = Math.max(-oy * this.scaleY, (region.h - oy) * this.scaleY);
    return { w: right - left, h: bottom - top, ox: -left, oy: -top };
  }

  override render(ctx: DrawContext): void {
    ctx.sprite(this.sprite, 0, 0, {
      flipX: this.flipX,
      flipY: this.flipY,
      tint: this.tint,
      additive: this.additive,
      smooth: this.smooth,
      emissive: this.emissive,
      ox: this.originX ?? undefined,
      oy: this.originY ?? undefined,
      material: this.material,
    });
  }
}

/**
 * Plays animations registered with `defineAnimation`, and animation sets from sprite sets:
 * `play("knight.walk")` picks the frames for `facing`, mirrors when the set says a side stands
 * for both, fires the set's frame events through `onEvent`, and holds single-frame poses.
 *
 * Directional animations (`defineDirectionalAnimation`) show the view for `heading` through the
 * camera instead: set `heading`, or give the sprite a `turn` (a Heading) to turn at a limited
 * speed. When the view changes, the old one fades out over the new one for `blend` seconds.
 * `point("muzzle")` and `pointInWorld("muzzle")` find named points on the frame shown.
 */
export class AnimatedSprite extends Sprite {
  animation: AnimationDef | null = null;
  frame = 0;
  speed = 1;
  playing = false;
  private time = 0;
  private hold = 0;
  private set: AnimationSetDef | null = null;
  private facing_: Facing = "down";
  /** Whether the current frames were mirrored from the opposite facing. */
  mirrored = false;
  /** World facing in radians (0 = +x, π/2 = +y); directional animations show the view for it. */
  heading = 0;
  /** A turn controller: when set, it is stepped in update and `heading` follows its angle. */
  turn: Heading | null = null;
  /** Seconds the old view fades out over the new one when the view changes; 0 swaps at once. */
  blend = 0.06;
  /** Radians past a view boundary before the view changes; null uses the direction set's. */
  deadZone: number | null = null;
  private dirSet: DirectionSet | null = null;
  private dirIndex = -1;
  private source: AnimationSetDef | null = null;
  private fadeSprite = "";
  private fadeFlip = false;
  private fadeLeft = 0;
  onFinished: ((name: string) => void) | null = null;
  onEvent: ((name: string, frame: number) => void) | null = null;

  constructor(animation: string, x = 0, y = 0) {
    super("", x, y);
    this.play(animation);
  }

  get facing(): Facing {
    return this.facing_;
  }

  /** Change the facing; a set animation re-resolves its frames and keeps its place. */
  set facing(f: Facing) {
    if (f === this.facing_) return;
    this.facing_ = f;
    if (this.set) this.resolve(this.set, true);
  }

  /** Face where a movement vector points; still keeps the facing. Turns the heading (or its turn) too. */
  face(x: number, y: number): void {
    this.facing = facingFrom(x, y, this.facing_);
    if (x === 0 && y === 0) return;
    if (this.turn) this.turn.towards(x, y);
    else this.heading = Math.atan2(y, x);
  }

  /** The direction a directional animation shows now: its painted view, screen angle and mirroring. */
  get direction(): DirectionView | null {
    return this.dirSet?.directions[this.dirIndex] ?? null;
  }

  /** Whether the old view is still fading out after a view change. */
  get blending(): boolean {
    return this.fadeLeft > 0;
  }

  /** The heading's angle on screen through the layer's projection. */
  screenHeading(): number {
    return screenAngleOf(this.heading, this.projection());
  }

  /**
   * Show the view for the heading now. Update does this every frame; call it after changing
   * the heading when you need the new view (or its points) before the next update.
   */
  refreshView(): void {
    const set = this.set;
    if (!set?.directions) return;
    if (this.dirSet !== set.directions) {
      this.resolve(set, true);
      return;
    }
    const next = pickDirection(set.directions, this.screenHeading(), this.dirIndex, this.deadZone ?? set.directions.deadZone);
    if (next === this.dirIndex) return;
    if (this.blend > 0 && this.sprite) {
      this.fadeSprite = this.sprite;
      this.fadeFlip = this.flipX;
      this.fadeLeft = this.blend;
    }
    this.dirIndex = next;
    this.resolve(set, true);
  }

  /**
   * A named point (`definePoints`) of the frame shown, from the sprite's origin in local units,
   * mirrored with the view and scaled with the node; null when the frame has none. During a
   * blend it is the incoming view's point.
   */
  point(name: string): [number, number] | null {
    this.refreshView();
    const p = pointOf(this.sprite, name);
    if (!p) return null;
    return [(this.flipX ? -p[0] : p[0]) * this.scaleX, (this.flipY ? -p[1] : p[1]) * this.scaleY];
  }

  /**
   * Where a named point is in the parent's space, with height. On a projected layer this is
   * the ground point that draws there, moved `forward` world units toward the camera so a
   * flash spawned there sorts in front of the figure. Null when the frame has no such point.
   */
  pointInWorld(name: string, forward = 0): [number, number, number] | null {
    const q = this.point(name);
    if (!q) return null;
    const proj = this.projection();
    if (!proj) {
      const c = Math.cos(this.rotation);
      const s = Math.sin(this.rotation);
      return [this.x + q[0] * c - q[1] * s, this.y + q[0] * s + q[1] * c, this.z];
    }
    const [dx, dy, dz] = groundDeltaOf(proj, q[0], q[1], forward);
    return [this.x + dx, this.y + dy, this.z + dz];
  }

  /** The projection of the layer this sprite draws in: the camera's under the scene's world, else none. */
  private projection(): ProjectionMatrix | null {
    const scene = this.scene;
    if (!scene) return null;
    for (let n: Node | null = this.parent; n; n = n.parent) if (n === scene.world) return scene.camera.projectionMatrix();
    return null;
  }

  /** Frames for the current set: the view for the heading, or the four-way facing. */
  private framesOf(set: AnimationSetDef): { frames: string[]; flip: boolean; source: AnimationSetDef } {
    const dirs = set.directions;
    if (dirs) {
      if (this.dirSet !== dirs || !dirs.directions[this.dirIndex]) {
        this.dirSet = dirs;
        this.dirIndex = pickDirection(dirs, this.screenHeading(), -1);
      }
      const d = dirs.directions[this.dirIndex];
      const { frames, source } = viewFrames(set, d.view);
      return { frames, flip: d.flip, source };
    }
    const { frames, flip } = framesFor(set, this.facing_);
    return { frames, flip, source: set };
  }

  private resolve(set: AnimationSetDef, keepTime: boolean): void {
    const { frames, flip, source } = this.framesOf(set);
    this.source = source;
    const def: AnimationDef = { name: set.name, frames, fps: set.fps, loop: set.loop };
    this.animation = def;
    this.mirrored = flip;
    this.flipX = flip;
    if (!keepTime || this.frame >= frames.length) {
      this.frame = 0;
      this.time = 0;
    }
    this.sprite = frames[this.frame] ?? frames[0] ?? "";
  }

  play(name: string, restart = false): void {
    const set = getAnimationSet(name);
    if (set) {
      if (this.set === set && !restart) {
        this.playing = true;
        return;
      }
      this.set = set;
      this.resolve(set, false);
      this.hold = this.animation && this.animation.frames.length <= 1 ? set.hold : 0;
      this.playing = true;
      this.fire();
      return;
    }
    const def = getAnimation(name);
    if (!def) {
      console.warn(`[blackiron] animation "${name}" is not defined`);
      return;
    }
    if (this.animation === def && !restart) {
      this.playing = true;
      return;
    }
    this.set = null;
    this.source = null;
    this.hold = def.durations?.[0] ?? 0;
    this.mirrored = false;
    this.animation = def;
    this.frame = 0;
    this.time = 0;
    this.playing = true;
    this.sprite = def.frames[0];
  }

  stop(): void {
    this.playing = false;
  }

  get current(): string {
    return this.animation?.name ?? "";
  }

  /** Whether the current animation ends on its own: a one-shot with frames, or a held pose. */
  get willFinish(): boolean {
    const a = this.animation;
    return !!a && !a.loop && (a.frames.length > 1 || this.hold > 0);
  }

  /** The current frame's hitbox in local space (origin at the sprite's anchor), or null. */
  hitbox(): Rect | null {
    const hb = hitboxOf(this.sprite);
    if (!hb) return null;
    const region = this.scene?.attachedApp?.atlas.region(this.sprite);
    const ox = this.originX ?? region?.ox ?? 0;
    const oy = this.originY ?? region?.oy ?? 0;
    const x = this.flipX && region ? region.w - ox - hb.x - hb.w : hb.x - ox;
    return { x, y: hb.y - oy, w: hb.w, h: hb.h };
  }

  private fire(): void {
    const ev = this.set?.events.get(this.sprite) ?? this.source?.events.get(this.sprite);
    if (ev) this.onEvent?.(ev, this.frame);
  }

  override render(ctx: DrawContext): void {
    super.render(ctx);
    if (this.fadeLeft <= 0 || !this.fadeSprite || this.blend <= 0) return;
    // The outgoing view on top, fading, at the same spot and (just in front) at the same depth.
    const bias = ctx.depthBias;
    if (ctx.projection) ctx.setTransform3(this.ground, this.worldZ, this.worldAlpha, bias + FADE_BIAS);
    ctx.sprite(this.fadeSprite, 0, 0, {
      alpha: this.fadeLeft / this.blend,
      flipX: this.fadeFlip,
      flipY: this.flipY,
      tint: this.tint,
      additive: this.additive,
      smooth: this.smooth,
      emissive: this.emissive,
      ox: this.originX ?? undefined,
      oy: this.originY ?? undefined,
      material: this.material,
    });
    if (ctx.projection) ctx.setTransform3(this.ground, this.worldZ, this.worldAlpha, bias);
  }

  override update(dt: number): void {
    if (this.turn) this.heading = this.turn.update(dt);
    if (this.fadeLeft > 0) this.fadeLeft = Math.max(0, this.fadeLeft - (Number.isFinite(dt) && dt > 0 ? dt : 0));
    this.refreshView();
    const a = this.animation;
    if (!a || !this.playing) return;
    if (a.frames.length <= 1) {
      // A held pose counts down, then finishes like a one-shot.
      if (this.hold > 0 && !a.loop) {
        this.time += dt * this.speed;
        if (this.time >= this.hold) {
          this.playing = false;
          this.onFinished?.(a.name);
        }
      }
      return;
    }
    if (!Number.isFinite(dt) || !Number.isFinite(this.speed) || dt < 0 || this.speed < 0) return;
    this.time += dt * this.speed;
    const duration = () => a.durations?.[this.frame] ?? 1 / a.fps;
    while (this.time >= duration()) {
      this.time -= duration();
      if (this.frame + 1 >= a.frames.length) {
        if (a.loop) this.frame = 0;
        else {
          this.playing = false;
          this.onFinished?.(a.name);
          break;
        }
      } else this.frame++;
      this.sprite = a.frames[this.frame];
      this.fire();
      if (this.animation !== a || !this.playing) return;
    }
    if (this.animation === a) this.sprite = a.frames[this.frame];
  }
}
