// Aiming on projected (isometric) maps: picking the ground under the cursor on a height map,
// turning a stick's screen direction into a ground direction, twin-stick aim that follows
// whichever of mouse or right stick moved last, and aim assist with a sticky cone.

import { angleDelta } from "../core/math.ts";

/** What a camera offers: `Camera` fits. */
export interface ScreenProjector {
  screenToWorld(sx: number, sy: number, z?: number): [number, number];
  worldToScreen(wx: number, wy: number, z?: number): [number, number];
}

/** Ground height at a world position; `IsoTileMap.heightAt` fits. */
export type HeightAt = (x: number, y: number) => number;

export interface GroundPick {
  x: number;
  y: number;
  z: number;
}

/**
 * The ground under a screen point on a height map: the first surface the view ray meets
 * coming down from `maxZ`, so the top of a raised block wins over the floor behind it.
 * `step` is the height between samples (a quarter of the smallest ledge is plenty).
 */
export function pickGround(camera: ScreenProjector, sx: number, sy: number, heightAt: HeightAt, opts: { maxZ: number; step?: number }): GroundPick {
  const step = opts.step ?? Math.max(opts.maxZ / 32, 1e-3);
  const under = (z: number): boolean => {
    const [x, y] = camera.screenToWorld(sx, sy, z);
    return heightAt(x, y) >= z;
  };
  let hi = opts.maxZ;
  if (under(hi)) {
    const [x, y] = camera.screenToWorld(sx, sy, hi);
    return { x, y, z: hi };
  }
  let lo = hi;
  let found = false;
  while (lo > 0) {
    lo = Math.max(0, lo - step);
    if (under(lo)) {
      found = true;
      break;
    }
    hi = lo;
  }
  if (!found) {
    const [x, y] = camera.screenToWorld(sx, sy, 0);
    return { x, y, z: 0 };
  }
  // Between `hi` (in the air) and `lo` (in the ground): close in on the surface.
  for (let i = 0; i < 16; i++) {
    const mid = (hi + lo) / 2;
    if (under(mid)) lo = mid;
    else hi = mid;
  }
  const [x, y] = camera.screenToWorld(sx, sy, lo);
  return { x, y, z: Math.min(lo, heightAt(x, y)) };
}

/**
 * A screen-space direction (a stick, a swipe) as a unit direction on the ground at (x, y):
 * pushing a stick up aims up the screen, whatever the projection.
 */
export function screenDirToWorld(camera: ScreenProjector, x: number, y: number, dx: number, dy: number, z = 0): [number, number] {
  const [ox, oy] = camera.worldToScreen(x, y, z);
  const [ax, ay] = camera.worldToScreen(x + 1, y, z);
  const [bx, by] = camera.worldToScreen(x, y + 1, z);
  const a11 = ax - ox;
  const a21 = ay - oy;
  const a12 = bx - ox;
  const a22 = by - oy;
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-12) return [dx, dy];
  const u = (dx * a22 - dy * a12) / det;
  const v = (a11 * dy - a21 * dx) / det;
  const len = Math.hypot(u, v);
  return len > 0 ? [u / len, v / len] : [0, 0];
}

export type AimDevice = "pointer" | "stick";

/**
 * Twin-stick aim: the right stick past its deadzone wins and holds the aim until the mouse
 * moves again; with neither, the last aim stays.
 */
export class TwinStickAim {
  angle = 0;
  device: AimDevice = "pointer";
  deadzone: number;
  private lastPointer: [number, number] | null = null;

  constructor(opts: { deadzone?: number; angle?: number } = {}) {
    this.deadzone = opts.deadzone ?? 0.3;
    this.angle = opts.angle ?? 0;
  }

  /**
   * `from` is the aimer's ground position, `stick` the right stick in screen space, `pointer`
   * the cursor's screen position and `pointerGround` where it lands on the ground. Pass a
   * camera to aim a stick on a projected map.
   */
  update(input: {
    from: { x: number; y: number };
    stick?: { x: number; y: number } | null;
    pointer?: { x: number; y: number } | null;
    pointerGround?: { x: number; y: number } | null;
    camera?: ScreenProjector;
  }): number {
    const { from, stick, pointer, pointerGround, camera } = input;
    const moved = !!pointer && (!this.lastPointer || Math.abs(pointer.x - this.lastPointer[0]) > 0.5 || Math.abs(pointer.y - this.lastPointer[1]) > 0.5);
    if (pointer) this.lastPointer = [pointer.x, pointer.y];
    if (stick && Math.hypot(stick.x, stick.y) > this.deadzone) {
      this.device = "stick";
      const [wx, wy] = camera ? screenDirToWorld(camera, from.x, from.y, stick.x, stick.y) : [stick.x, stick.y];
      this.angle = Math.atan2(wy, wx);
    } else if (pointerGround && (moved || this.device === "pointer")) {
      this.device = "pointer";
      const dx = pointerGround.x - from.x;
      const dy = pointerGround.y - from.y;
      if (dx * dx + dy * dy > 1e-6) this.angle = Math.atan2(dy, dx);
    }
    return this.angle;
  }
}

export interface AimAssistOptions {
  /** Half-angle, radians, a target must be within to be picked up; 0.22 by default (~12°). */
  cone?: number;
  /** Ignore targets farther than this. */
  range?: number;
  /** Share of the way the aim turns onto the target, 0..1; 0.6 by default. */
  strength?: number;
  /** The locked target is kept until it leaves `cone * sticky`; 1.7 by default. */
  sticky?: number;
  /** How much nearness counts against angle when choosing; 0.35 by default. */
  distanceWeight?: number;
}

/**
 * Aim assist: picks the target nearest the aim line inside a cone and bends the aim toward
 * it; once locked it holds on through a wider cone so the aim does not flick between two.
 * Usually on for sticks and off (strength 0) for a mouse.
 */
export class AimAssist<T extends { x: number; y: number }> {
  cone: number;
  range: number;
  strength: number;
  sticky: number;
  distanceWeight: number;
  target: T | null = null;

  constructor(opts: AimAssistOptions = {}) {
    this.cone = opts.cone ?? 0.22;
    this.range = opts.range ?? Infinity;
    this.strength = opts.strength ?? 0.6;
    this.sticky = opts.sticky ?? 1.7;
    this.distanceWeight = opts.distanceWeight ?? 0.35;
  }

  /** The aim from (x, y) bent toward the best target; `canSee` drops hidden ones. */
  apply(x: number, y: number, angle: number, candidates: Iterable<T>, canSee?: (t: T) => boolean, strength = this.strength): number {
    const consider = (t: T, cone: number): number => {
      const dx = t.x - x;
      const dy = t.y - y;
      const d = Math.hypot(dx, dy);
      if (d === 0 || d > this.range) return Infinity;
      const off = Math.abs(angleDelta(angle, Math.atan2(dy, dx)));
      if (off > cone) return Infinity;
      if (canSee && !canSee(t)) return Infinity;
      const reach = Number.isFinite(this.range) ? d / this.range : Math.min(1, d / 1000);
      return off / cone + reach * this.distanceWeight;
    };
    let pick: T | null = null;
    if (this.target && consider(this.target, this.cone * this.sticky) < Infinity) {
      let present = false;
      for (const t of candidates) if (t === this.target) present = true;
      if (present) pick = this.target;
    }
    if (!pick) {
      let best = Infinity;
      for (const t of candidates) {
        const s = consider(t, this.cone);
        if (s < best) {
          best = s;
          pick = t;
        }
      }
    }
    this.target = pick;
    if (!pick || strength <= 0) return angle;
    const want = Math.atan2(pick.y - y, pick.x - x);
    return angle + angleDelta(angle, want) * Math.min(1, strength);
  }

  reset(): void {
    this.target = null;
  }
}
