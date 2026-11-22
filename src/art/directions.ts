// Directional views: figures painted from several directions around the screen (6, 8, 16 or
// any uneven set), with mirroring so one painting covers both sides. A direction set names the
// painted views and the screen angle each faces. An animation gives frames per view and falls
// back along a chain (kick → fire → idle) where a view lacks it. An AnimatedSprite then shows
// the view for its heading through the camera, so "toward the lower right" means the same in
// isometric and flat layers. See docs/TURNING.md.

import type { ProjectionMatrix } from "../kernel/protocol.ts";
import { angleDelta } from "../core/math.ts";
import { type AnimationSetDef, defineAnimationSet, getAnimationSet } from "./spritesets.ts";

/** One direction a figure can show: a painted view, the screen angle it faces, and whether it is mirrored. */
export interface DirectionView {
  view: string;
  /** Radians on screen: 0 is right, π/2 is down the screen. */
  angle: number;
  flip: boolean;
}

export interface DirectionSet {
  name: string;
  directions: DirectionView[];
  /** Radians past the halfway line between two directions before the view changes. */
  deadZone: number;
}

export interface DirectionsSpec {
  /** Each painted view and the screen angle it faces (radians, 0 right, π/2 down the screen). */
  views: Record<string, number>;
  /**
   * Also show every view mirrored across the screen's vertical, at π − its angle. Paint one
   * side only. A view facing straight up or down the screen is its own mirror.
   */
  mirror?: boolean;
  /** Radians past the halfway line before the view changes, both ways (4° by default). */
  deadZone?: number;
}

const directionSets = new Map<string, DirectionSet>();

export function defineDirections(name: string, spec: DirectionsSpec): DirectionSet {
  const directions: DirectionView[] = [];
  for (const [view, angle] of Object.entries(spec.views)) {
    directions.push({ view, angle: norm(angle), flip: false });
    if (spec.mirror && Math.abs(Math.cos(angle)) > 1e-6) directions.push({ view, angle: norm(Math.PI - angle), flip: true });
  }
  if (!directions.length) throw new Error(`Direction set "${name}" has no views.`);
  directions.sort((a, b) => a.angle - b.angle);
  const set: DirectionSet = { name, directions, deadZone: spec.deadZone ?? (4 * Math.PI) / 180 };
  directionSets.set(name, set);
  return set;
}

export const getDirections = (name: string): DirectionSet | undefined => directionSets.get(name);

/**
 * The direction (an index into `set.directions`) shown at a screen angle: the nearest one,
 * except that `current` stays until the angle is `deadZone` past the halfway line, so aiming
 * right on a boundary never flickers.
 */
export function pickDirection(set: DirectionSet, screenAngle: number, current = -1, deadZone = set.deadZone): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < set.directions.length; i++) {
    const d = Math.abs(angleDelta(set.directions[i].angle, screenAngle));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const cur = set.directions[current];
  if (cur && current !== best && Math.abs(angleDelta(cur.angle, screenAngle)) - bestD <= 2 * deadZone) return current;
  return best;
}

/** The screen angle of a world facing through a projection (as is when flat). */
export function screenAngleOf(worldAngle: number, projection: ProjectionMatrix | null): number {
  const c = Math.cos(worldAngle);
  const s = Math.sin(worldAngle);
  if (!projection) return worldAngle;
  return Math.atan2(projection[4] * c + projection[5] * s, projection[0] * c + projection[1] * s);
}

export interface DirectionalAnimationSpec {
  /** The direction set, or its name. */
  directions: string | DirectionSet;
  /**
   * Frames for each painted view, as sprite names: a map, or a function of the view name.
   * Leave a view out (or return nothing) where this animation has no frames for it.
   */
  frames: Record<string, readonly string[]> | ((view: string) => readonly string[] | null | undefined);
  fps?: number;
  /** Loops by default; a `hold` pose does not. */
  loop?: boolean;
  /** Seconds a single-frame pose holds before it counts as finished. */
  hold?: number;
  /** Sprite name to event name, fired when that frame shows. */
  events?: Record<string, string>;
  /** Another animation whose frames stand in for views this one lacks; chains (kick → fire → idle). */
  fallback?: string;
}

/** An animation set with frames per view; play it on an AnimatedSprite and set its heading. */
export function defineDirectionalAnimation(name: string, spec: DirectionalAnimationSpec): AnimationSetDef {
  const directions = typeof spec.directions === "string" ? directionSets.get(spec.directions) : spec.directions;
  if (!directions) throw new Error(`Animation "${name}" uses direction set "${String(spec.directions)}", which is not defined.`);
  const views: Record<string, string[]> = {};
  for (const d of directions.directions) {
    if (d.view in views) continue;
    const list = typeof spec.frames === "function" ? spec.frames(d.view) : spec.frames[d.view];
    views[d.view] = list ? [...list] : [];
  }
  const first = Object.values(views).find((f) => f.length) ?? [];
  const hold = spec.hold ?? 0;
  return defineAnimationSet({
    name,
    fps: spec.fps ?? 8,
    loop: spec.loop ?? !(hold > 0),
    mirror: false,
    frames: first,
    facings: {},
    events: new Map(Object.entries(spec.events ?? {})),
    hold,
    directions,
    views,
    fallback: spec.fallback,
  });
}

/** The frames an animation shows for a painted view, following its fallback chain; `source` is the animation they came from. */
export function viewFrames(def: AnimationSetDef, view: string): { frames: string[]; source: AnimationSetDef } {
  let d: AnimationSetDef | undefined = def;
  for (let i = 0; d && i < 16; i++) {
    const f = d.views?.[view];
    if (f && f.length) return { frames: f, source: d };
    d = d.fallback ? getAnimationSet(d.fallback) : undefined;
  }
  return { frames: def.frames, source: def };
}

export function resetDirections(): void {
  directionSets.clear();
}

function norm(a: number): number {
  return angleDelta(0, a);
}
