import { type AnimationDef, getAnimation } from "../art/sprites.ts";
import { type AnimationSetDef, type Facing, facingFrom, framesFor, getAnimationSet, hitboxOf } from "../art/spritesets.ts";
import type { Rect } from "../core/math.ts";
import type { SpriteMaterial } from "../render/types.ts";
import type { DrawContext } from "./draw.ts";
import type { LayoutBox } from "./layout.ts";
import { Node2D } from "./node.ts";

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

  /** Face where a movement vector points; still keeps the facing. */
  face(x: number, y: number): void {
    this.facing = facingFrom(x, y, this.facing_);
  }

  private resolve(set: AnimationSetDef, keepTime: boolean): void {
    const { frames, flip } = framesFor(set, this.facing_);
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
      this.hold = framesFor(set, this.facing_).frames.length <= 1 ? set.hold : 0;
      this.resolve(set, false);
      this.playing = true;
      this.fire();
      return;
    }
    const def = getAnimation(name);
    if (!def) {
      console.warn(`[kiln] animation "${name}" is not defined`);
      return;
    }
    if (this.animation === def && !restart) {
      this.playing = true;
      return;
    }
    this.set = null;
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
    const ev = this.set?.events.get(this.sprite);
    if (ev) this.onEvent?.(ev, this.frame);
  }

  override update(dt: number): void {
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
