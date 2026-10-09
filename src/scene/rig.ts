// Cutout rigs: a character as parts on bones, posed by clips. Templates ship with the engine
// (a humanoid, a quadruped, a flyer, a blob); a game names a template and the sprites for its
// parts. Procedural clips give every rig idle, walk, run, a swing, a thrust, a hurt, a fall, a
// cast and a carry with no keyframes; keyframed clips are data for the moments that must be
// exact. Layers let the legs walk while the arms swing. Like Godot's Skeleton2D and Unity's
// 2D Animation, minus the editor: the rig is a manifest.

import { type BoneDef, HUMANOID, type RigManifest, type RigTemplate, TEMPLATES, getRigManifest } from "../art/rigs.ts";
import type { Rect } from "../core/math.ts";
import { Node2D } from "./node.ts";
import { Sprite } from "./sprite.ts";

/** Per-bone offsets a clip writes; rotation in radians, offsets in rig units, scales as factors. */
export interface RigPose {
  rot: Record<string, number>;
  x: Record<string, number>;
  y: Record<string, number>;
  sx: Record<string, number>;
  sy: Record<string, number>;
}

export interface RigClipParams {
  /** Leg swing in radians. */
  stride: number;
  /** Vertical bob in rig units. */
  bob: number;
  /** Arm swing as a fraction of the stride. */
  armSwing: number;
}

export interface RigClipEvent {
  /** Time as a fraction of the duration. */
  at: number;
  name: string;
}

export interface RigClip {
  name: string;
  duration: number;
  loop: boolean;
  /** Write the pose for a time as a fraction of the duration. */
  pose: (t: number, pose: RigPose, p: RigClipParams) => void;
  events?: RigClipEvent[];
  /** Keep the last frame when finished instead of returning to rest. */
  holdEnd?: boolean;
}

export type RigKey = [time: number, value: number];

export interface KeyframedRigClip {
  name: string;
  duration: number;
  loop?: boolean;
  /** Bone name to tracks; times are fractions of the duration, values radians or rig units. */
  tracks: Record<string, { rot?: RigKey[]; x?: RigKey[]; y?: RigKey[]; sx?: RigKey[]; sy?: RigKey[] }>;
  events?: RigClipEvent[];
  holdEnd?: boolean;
}

// ---------------------------------------------------------------- procedural clips

const TAU = Math.PI * 2;
const set = (pose: RigPose, bone: string, rot?: number, x?: number, y?: number) => {
  if (rot !== undefined) pose.rot[bone] = (pose.rot[bone] ?? 0) + rot;
  if (x !== undefined) pose.x[bone] = (pose.x[bone] ?? 0) + x;
  if (y !== undefined) pose.y[bone] = (pose.y[bone] ?? 0) + y;
};
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
/** Piecewise linear through (time, value) keys. */
const track = (t: number, keys: RigKey[]): number => {
  if (keys.length === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      const k = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return v0 + (v1 - v0) * ease(k);
    }
  }
  return keys[keys.length - 1][1];
};

const legs = (pose: RigPose, phase: number, p: RigClipParams, k = 1) => {
  const s = Math.sin(phase * TAU);
  set(pose, "leg.near", s * p.stride * k);
  set(pose, "leg.far", -s * p.stride * k);
  set(pose, "arm.near", -s * p.stride * p.armSwing * k);
  set(pose, "arm.far", s * p.stride * p.armSwing * k);
  set(pose, "hips", undefined, undefined, -Math.abs(Math.sin(phase * TAU * 2)) * p.bob * k);
  // Quadrupeds and flyers reuse the same phase on their own bones.
  set(pose, "leg.frontNear", s * p.stride * k);
  set(pose, "leg.backFar", s * p.stride * k);
  set(pose, "leg.frontFar", -s * p.stride * k);
  set(pose, "leg.backNear", -s * p.stride * k);
  set(pose, "body", undefined, undefined, -Math.abs(Math.sin(phase * TAU * 2)) * p.bob * k);
};

export const CLIPS: Record<string, RigClip> = {
  idle: {
    name: "idle",
    duration: 2.4,
    loop: true,
    pose: (t, pose) => {
      const breath = Math.sin(t * TAU);
      set(pose, "torso", undefined, undefined, breath * 0.6);
      set(pose, "head", breath * 0.03, undefined, breath * 0.4);
      set(pose, "arm.near", breath * 0.04);
      set(pose, "arm.far", -breath * 0.04);
      set(pose, "body", undefined, undefined, breath * 0.8);
      set(pose, "wing.near", Math.sin(t * TAU * 3) * 0.5);
      set(pose, "wing.far", -Math.sin(t * TAU * 3) * 0.5);
      set(pose, "tail", Math.sin(t * TAU * 1.5) * 0.15);
      pose.sy.body = (pose.sy.body ?? 1) + breath * 0.03;
      pose.sx.body = (pose.sx.body ?? 1) - breath * 0.02;
    },
  },
  walk: { name: "walk", duration: 0.7, loop: true, pose: (t, pose, p) => legs(pose, t, p, 1), events: [{ at: 0.25, name: "step" }, { at: 0.75, name: "step" }] },
  run: {
    name: "run",
    duration: 0.45,
    loop: true,
    pose: (t, pose, p) => {
      legs(pose, t, p, 1.4);
      set(pose, "torso", 0.18);
      set(pose, "head", -0.1);
    },
    events: [{ at: 0.25, name: "step" }, { at: 0.75, name: "step" }],
  },
  swing: {
    name: "swing",
    duration: 0.42,
    loop: false,
    pose: (t, pose) => {
      set(pose, "arm.near", track(t, [[0, 0], [0.3, -2.4], [0.55, 1.3], [1, 0]]));
      set(pose, "torso", track(t, [[0, 0], [0.3, -0.15], [0.55, 0.25], [1, 0]]));
      set(pose, "head", track(t, [[0, 0], [0.3, 0.1], [0.55, -0.1], [1, 0]]));
      set(pose, "hips", undefined, track(t, [[0, 0], [0.55, 3], [1, 0]]));
    },
    events: [{ at: 0.55, name: "hit" }],
  },
  thrust: {
    name: "thrust",
    duration: 0.36,
    loop: false,
    pose: (t, pose) => {
      set(pose, "arm.near", track(t, [[0, 0], [0.3, -0.9], [0.5, -1.65], [1, 0]]), track(t, [[0, 0], [0.3, -3], [0.5, 10], [1, 0]]));
      set(pose, "torso", track(t, [[0, 0], [0.5, 0.2], [1, 0]]));
      set(pose, "hips", undefined, track(t, [[0, 0], [0.5, 6], [1, 0]]));
    },
    events: [{ at: 0.5, name: "hit" }],
  },
  hurt: {
    name: "hurt",
    duration: 0.4,
    loop: false,
    pose: (t, pose) => {
      set(pose, "torso", track(t, [[0, 0], [0.25, -0.35], [1, 0]]));
      set(pose, "head", track(t, [[0, 0], [0.25, -0.4], [1, 0]]));
      set(pose, "hips", undefined, track(t, [[0, 0], [0.25, -5], [1, 0]]));
      set(pose, "arm.near", track(t, [[0, 0], [0.25, -0.8], [1, 0]]));
      set(pose, "arm.far", track(t, [[0, 0], [0.25, -0.8], [1, 0]]));
      set(pose, "body", track(t, [[0, 0], [0.25, -0.3], [1, 0]]), track(t, [[0, 0], [0.25, -4], [1, 0]]));
    },
  },
  fall: {
    name: "fall",
    duration: 0.5,
    loop: false,
    holdEnd: true,
    pose: (t, pose) => {
      set(pose, "hips", track(t, [[0, 0], [1, -1.5]]), track(t, [[0, 0], [1, -14]]), track(t, [[0, 0], [1, 20]]));
      set(pose, "body", track(t, [[0, 0], [1, -1.5]]), undefined, track(t, [[0, 0], [1, 14]]));
      set(pose, "arm.near", track(t, [[0, 0], [1, 1.2]]));
      set(pose, "arm.far", track(t, [[0, 0], [1, 1.2]]));
      set(pose, "head", track(t, [[0, 0], [1, 0.4]]));
    },
  },
  cast: {
    name: "cast",
    duration: 0.7,
    loop: false,
    pose: (t, pose) => {
      const up = track(t, [[0, 0], [0.35, -2.9], [0.7, -2.9], [1, 0]]);
      set(pose, "arm.near", up);
      set(pose, "arm.far", up);
      set(pose, "head", track(t, [[0, 0], [0.4, -0.25], [1, 0]]));
      set(pose, "torso", undefined, undefined, track(t, [[0, 0], [0.4, -2], [1, 0]]));
    },
    events: [{ at: 0.5, name: "cast" }],
  },
  carry: {
    name: "carry",
    duration: 2.4,
    loop: true,
    pose: (t, pose) => {
      set(pose, "arm.near", -1.4);
      set(pose, "arm.far", -1.4);
      set(pose, "torso", undefined, undefined, Math.sin(t * TAU) * 0.6);
    },
  },
};

/** A keyframed clip as a clip: tracks are eased between keys. */
export function clipFromKeys(k: KeyframedRigClip): RigClip {
  return {
    name: k.name,
    duration: k.duration,
    loop: k.loop ?? false,
    holdEnd: k.holdEnd,
    events: k.events,
    pose: (t, pose) => {
      for (const [bone, tr] of Object.entries(k.tracks)) {
        if (tr.rot) set(pose, bone, track(t, tr.rot));
        if (tr.x) set(pose, bone, undefined, track(t, tr.x));
        if (tr.y) set(pose, bone, undefined, undefined, track(t, tr.y));
        if (tr.sx) pose.sx[bone] = (pose.sx[bone] ?? 1) * track(t, tr.sx);
        if (tr.sy) pose.sy[bone] = (pose.sy[bone] ?? 1) * track(t, tr.sy);
      }
    },
  };
}

/** Interpolate angles the short way round. */
function mixAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * Math.max(0, Math.min(1, t));
}

// ---------------------------------------------------------------- the node

interface Playing {
  clip: RigClip;
  time: number;
  /** Which events of the current cycle have fired. */
  fired: Set<number>;
  done: boolean;
  /** Blend weight, 0 to 1; fading clips move toward `target` at `rate` per second. */
  weight: number;
  target: number;
  rate: number;
}

/** An inverse-kinematics goal: a two-bone chain reaching for a point in rig space, or one bone aiming at it. */
interface IkGoal {
  bone: string;
  x: number;
  y: number;
  /** Which way the middle joint bends: 1 or -1. */
  bend: 1 | -1;
  /** 0 to 1; how much of the solved pose applies. */
  weight: number;
}

/**
 * A rigged character. `play` runs a clip on the whole body; `layer("upper", clip)` runs another
 * on the template's upper bones over it, so the legs keep walking while the arms swing.
 * Facing left mirrors the rig. `onEvent` fires clip events ("step", "hit", "cast").
 */
export class Rig2D extends Node2D {
  readonly manifest: RigManifest;
  readonly template: RigTemplate;
  readonly bones = new Map<string, Node2D>();
  readonly parts = new Map<string, Sprite>();
  readonly params: RigClipParams = { stride: 0.5, bob: 1.5, armSwing: 0.8 };
  speed = 1;
  onEvent: ((name: string, layer: string) => void) | null = null;
  onFinished: ((clip: string, layer: string) => void) | null = null;
  /** Base clips, newest last; earlier ones fade out during a crossfade. */
  private bases: Playing[] = [];
  private readonly layers = new Map<string, Playing>();
  private readonly ik = new Map<string, IkGoal>();
  private facing_: "left" | "right" = "right";
  private readonly unit: number;
  private readonly anchors: Record<string, [number, number]>;

  constructor(manifest: RigManifest | string) {
    super();
    if (typeof manifest === "string") {
      const m = getRigManifest(manifest);
      if (!m) throw new Error(`rig "${manifest}" is not defined; call defineRig first`);
      manifest = m;
    }
    this.manifest = manifest;
    this.name = "rig";
    this.template = typeof manifest.template === "string" ? (TEMPLATES[manifest.template] ?? HUMANOID) : manifest.template;
    this.unit = (manifest.height ?? this.template.height) / this.template.height;
    this.anchors = manifest.anchors ?? {};
    // Bones become nodes in parent order; parts hang off them.
    const pending = [...this.template.bones];
    let guard = 0;
    while (pending.length && guard++ < 1000) {
      const b = pending.shift() as BoneDef;
      const parentNode = b.parent === null ? this : this.bones.get(b.parent);
      if (!parentNode) {
        pending.push(b);
        continue;
      }
      const pivot = this.pivotOf(b);
      const node = parentNode.add(new Node2D(pivot[0], pivot[1]));
      node.name = b.name;
      this.bones.set(b.name, node);
      const partName = manifest.parts[b.name];
      if (partName) {
        // Parts are the rig's own children, not the bone's, so draw order is one flat sort;
        // each frame they take their bone's transform.
        const part = this.add(new Sprite(partName));
        part.zIndex = b.order;
        this.parts.set(b.name, part);
      }
    }
    this.pose();
  }

  /** A bone's rest pivot in pixels: the manifest's when the cut worked it out, else the template's scaled. */
  private pivotOf(b: BoneDef): [number, number] {
    const own = this.manifest.pivots?.[b.name];
    return own ? [own[0], own[1]] : [b.x * this.unit, b.y * this.unit];
  }

  /** Put every part where its bone is: position, rotation and scale composed down the chain. */
  private pose(): void {
    const k = this.manifest.scale ?? 1;
    for (const b of this.template.bones) {
      const part = this.parts.get(b.name);
      const bone = this.bones.get(b.name);
      if (!part || !bone) continue;
      let rot = 0;
      let sx = 1;
      let sy = 1;
      for (let n: Node2D | null = bone; n && n !== this; n = n.parent as Node2D | null) {
        rot += n.rotation;
        sx *= n.scaleX;
        sy *= n.scaleY;
      }
      const [x, y] = bone.positionIn(this);
      part.x = x;
      part.y = y;
      part.rotation = rot;
      part.scaleX = sx * k;
      part.scaleY = sy * k;
    }
  }

  get facing(): "left" | "right" {
    return this.facing_;
  }

  set facing(f: "left" | "right") {
    this.facing_ = f;
    this.scaleX = Math.abs(this.scaleX) * (f === "left" ? -1 : 1);
  }

  /** Face where a movement vector points; still keeps the facing. */
  face(x: number): void {
    if (x < -0.05) this.facing = "left";
    else if (x > 0.05) this.facing = "right";
  }

  private static resolve(clip: string | RigClip): RigClip {
    if (typeof clip !== "string") return clip;
    const c = CLIPS[clip];
    if (!c) throw new Error(`rig clip "${clip}" is not defined`);
    return c;
  }

  private get base(): Playing | null {
    return this.bases.length ? this.bases[this.bases.length - 1] : null;
  }

  private static playing(c: RigClip, weight = 1): Playing {
    return { clip: c, time: 0, fired: new Set(), done: false, weight, target: weight, rate: 0 };
  }

  /** Run a clip on the whole body. Playing the same looping clip again keeps its time. */
  play(clip: string | RigClip, restart = false): void {
    const c = Rig2D.resolve(clip);
    const cur = this.base;
    if (cur && cur.clip.name === c.name && !restart && (c.loop || !cur.done)) return;
    this.bases = [Rig2D.playing(c)];
  }

  /**
   * Fade into a clip over `seconds`: the current base keeps playing while its weight falls and
   * the new one's rises, so a walk melts into a run instead of snapping.
   */
  crossfade(clip: string | RigClip, seconds = 0.2): void {
    const c = Rig2D.resolve(clip);
    const cur = this.base;
    if (cur && cur.clip.name === c.name && (c.loop || !cur.done)) return;
    if (seconds <= 0 || !cur) {
      this.play(c, true);
      return;
    }
    for (const b of this.bases) {
      b.target = 0;
      b.rate = b.weight / seconds;
    }
    const next = Rig2D.playing(c, 0);
    next.target = 1;
    next.rate = 1 / seconds;
    this.bases.push(next);
  }

  /**
   * Hold two clips at once, `t` of the way from `a` to `b`, both kept in step by phase: the
   * blend tree's simplest node, for walk-to-run by speed.
   */
  blend(a: string | RigClip, b: string | RigClip, t: number): void {
    const ca = Rig2D.resolve(a);
    const cb = Rig2D.resolve(b);
    const k = Math.max(0, Math.min(1, t));
    const cur = this.bases;
    if (cur.length === 2 && cur[0].clip.name === ca.name && cur[1].clip.name === cb.name) {
      cur[0].weight = cur[0].target = 1 - k;
      cur[1].weight = cur[1].target = k;
      // Keep the two cycles aligned so the legs agree.
      const phase = (cur[0].time / ca.duration) % 1;
      cur[1].time = phase * cb.duration;
      return;
    }
    const pa = Rig2D.playing(ca, 1 - k);
    const pb = Rig2D.playing(cb, k);
    this.bases = [pa, pb];
  }

  /**
   * Reach with a two-bone chain: `bone` is the tip's parent (the hand's arm), which bends at the
   * joint before it, toward (x, y) in rig space. With one bone in the chain it just aims.
   */
  reach(bone: string, x: number, y: number, opts: { bend?: 1 | -1; weight?: number } = {}): void {
    this.ik.set(bone, { bone, x, y, bend: opts.bend ?? 1, weight: opts.weight ?? 1 });
  }

  /** Turn `bone` so its length points at (x, y) in rig space, over whatever the clips did. */
  aim(bone: string, x: number, y: number, weight = 1): void {
    this.ik.set(bone, { bone, x, y, bend: 1, weight });
  }

  /** Drop an IK goal, or all of them. */
  release(bone?: string): void {
    if (bone === undefined) this.ik.clear();
    else this.ik.delete(bone);
  }

  /** Run a clip on a layer; null clears it. Layer names match the template (`upper`) or any bone set. */
  layer(name: string, clip: string | RigClip | null, restart = false): void {
    if (!clip) {
      this.layers.delete(name);
      return;
    }
    const c = Rig2D.resolve(clip);
    const cur = this.layers.get(name);
    if (cur && cur.clip.name === c.name && !restart && (c.loop || !cur.done)) return;
    this.layers.set(name, Rig2D.playing(c));
  }

  get current(): string {
    return this.base?.clip.name ?? "";
  }

  /** Blend weight of a base clip by name, 0 when it is not playing. */
  weightOf(clip: string): number {
    return this.bases.find((b) => b.clip.name === clip)?.weight ?? 0;
  }

  /** True while a one-shot base clip is still running, so a scene can hold off idle and walk. */
  get busy(): boolean {
    return !!this.base && !this.base.clip.loop && !this.base.done;
  }

  isPlaying(layer = "base"): boolean {
    const p = layer === "base" ? this.base : this.layers.get(layer);
    return !!p && !p.done;
  }

  /** The bones a layer poses. */
  private layerBones(name: string): Set<string> | null {
    if (name === "upper") return new Set(this.template.upper);
    if (name === "lower") return new Set(this.template.bones.map((b) => b.name).filter((n) => !this.template.upper.includes(n)));
    return null;
  }

  private step(p: Playing, dt: number, layerName: string): void {
    if (p.rate > 0) {
      const d = p.target - p.weight;
      const stepW = p.rate * dt;
      p.weight = Math.abs(d) <= stepW ? p.target : p.weight + Math.sign(d) * stepW;
      if (p.weight === p.target) p.rate = 0;
    }
    if (p.done) return;
    const c = p.clip;
    p.time += dt * this.speed;
    const cycles = Math.floor(p.time / c.duration);
    const frac = c.loop ? (p.time / c.duration) % 1 : Math.min(1, p.time / c.duration);
    if (c.loop && cycles > 0 && p.time - dt * this.speed < cycles * c.duration) p.fired.clear();
    for (let i = 0; i < (c.events?.length ?? 0); i++) {
      const ev = (c.events as RigClipEvent[])[i];
      if (!p.fired.has(i) && frac >= ev.at) {
        p.fired.add(i);
        this.onEvent?.(ev.name, layerName);
      }
    }
    if (!c.loop && p.time >= c.duration) {
      p.done = true;
      this.onFinished?.(c.name, layerName);
    }
  }

  override update(dt: number): void {
    for (const b of this.bases) this.step(b, dt, "base");
    for (const [name, p] of this.layers) this.step(p, dt, name);
    // Faded-out bases fall away; the newest always stays.
    if (this.bases.length > 1) this.bases = this.bases.filter((b, i) => i === this.bases.length - 1 || b.weight > 0.001);
    // Compose the pose: rest, then the weighted base clips, then each layer on its bones.
    const pose: RigPose = { rot: {}, x: {}, y: {}, sx: {}, sy: {} };
    const write = (p: Playing, only: Set<string> | null, weight: number) => {
      const c = p.clip;
      const frac = c.loop ? (p.time / c.duration) % 1 : Math.min(1, p.time / c.duration);
      if (p.done && !c.holdEnd) return;
      if (weight <= 0) return;
      const scratch: RigPose = { rot: {}, x: {}, y: {}, sx: {}, sy: {} };
      c.pose(frac, scratch, this.params);
      const bones = only ?? new Set([...Object.keys(scratch.rot), ...Object.keys(scratch.x), ...Object.keys(scratch.y), ...Object.keys(scratch.sx), ...Object.keys(scratch.sy)]);
      for (const b of bones) {
        if (only) {
          // A layer replaces what is under it on its bones.
          if (scratch.rot[b] !== undefined) pose.rot[b] = scratch.rot[b];
          if (scratch.x[b] !== undefined) pose.x[b] = scratch.x[b];
          if (scratch.y[b] !== undefined) pose.y[b] = scratch.y[b];
          if (scratch.sx[b] !== undefined) pose.sx[b] = scratch.sx[b];
          if (scratch.sy[b] !== undefined) pose.sy[b] = scratch.sy[b];
        } else {
          // Base clips add by weight.
          if (scratch.rot[b] !== undefined) pose.rot[b] = (pose.rot[b] ?? 0) + scratch.rot[b] * weight;
          if (scratch.x[b] !== undefined) pose.x[b] = (pose.x[b] ?? 0) + scratch.x[b] * weight;
          if (scratch.y[b] !== undefined) pose.y[b] = (pose.y[b] ?? 0) + scratch.y[b] * weight;
          if (scratch.sx[b] !== undefined) pose.sx[b] = (pose.sx[b] ?? 1) + (scratch.sx[b] - 1) * weight;
          if (scratch.sy[b] !== undefined) pose.sy[b] = (pose.sy[b] ?? 1) + (scratch.sy[b] - 1) * weight;
        }
      }
    };
    const total = this.bases.reduce((sum, b) => sum + b.weight, 0) || 1;
    for (const b of this.bases) write(b, null, b.weight / total);
    for (const [name, p] of this.layers) write(p, this.layerBones(name), 1);
    for (const b of this.template.bones) {
      const node = this.bones.get(b.name);
      if (!node) continue;
      const pivot = this.pivotOf(b);
      node.rotation = pose.rot[b.name] ?? 0;
      node.x = pivot[0] + (pose.x[b.name] ?? 0) * this.unit;
      node.y = pivot[1] + (pose.y[b.name] ?? 0) * this.unit;
      node.scaleX = pose.sx[b.name] ?? 1;
      node.scaleY = pose.sy[b.name] ?? 1;
    }
    // Layers that finished fall away so the base shows through again.
    for (const [name, p] of this.layers) if (p.done && !p.clip.holdEnd) this.layers.delete(name);
    for (const goal of this.ik.values()) this.solve(goal);
    this.pose();
  }

  /** The length a bone reaches: to its first child's pivot, else its part's height, else 16. */
  private boneLength(name: string): number {
    const node = this.bones.get(name);
    if (!node) return 0;
    const child = this.template.bones.find((b) => b.parent === name);
    if (child) {
      const c = this.bones.get(child.name);
      if (c) return Math.hypot(c.x, c.y);
    }
    const part = this.parts.get(name);
    const app = this.scene?.attachedApp;
    if (part && app) return app.atlas.region(part.sprite).h * (this.manifest.scale ?? 1);
    return 16 * this.unit;
  }

  /** Angle of a bone's rest direction in its parent: down the y axis, the way limbs hang. */
  private static readonly REST = Math.PI / 2;

  /**
   * Two-bone analytic IK on `goal.bone` and its parent (when the parent is a limb bone), else a
   * single aim. Works in rig space from the bones' current pivots, after the clips have posed them.
   */
  private solve(goal: IkGoal): void {
    const tip = this.bones.get(goal.bone);
    if (!tip) return;
    const parent = tip.parent instanceof Node2D && tip.parent !== this ? tip.parent : null;
    const l2 = this.boneLength(goal.bone);
    const [tx, ty] = [goal.x, goal.y];
    const upper = parent && this.template.bones.some((b) => b.name === parent.name && b.parent !== null && this.template.upper.includes(b.name) === this.template.upper.includes(goal.bone)) ? parent : null;
    if (upper && l2 > 0) {
      const l1 = Math.hypot(tip.x, tip.y);
      const [ux, uy] = upper.positionIn(this);
      const dx = tx - ux;
      const dy = ty - uy;
      const d = Math.max(1e-4, Math.min(Math.hypot(dx, dy), l1 + l2 - 1e-3));
      // Law of cosines for the elbow, then the shoulder aims at the target offset by it.
      const cosElbow = Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2)));
      const elbow = Math.PI - Math.acos(cosElbow);
      const cosShoulder = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
      const shoulder = Math.atan2(dy, dx) - goal.bend * Math.acos(cosShoulder);
      const parentWorldRot = this.worldRotation(upper.parent as Node2D | null);
      const restUpper = Math.atan2(tip.y, tip.x);
      const wantUpper = shoulder - parentWorldRot - restUpper;
      upper.rotation = mixAngle(upper.rotation, wantUpper, goal.weight);
      const restTip = Rig2D.REST;
      const wantTip = shoulder + goal.bend * elbow - (parentWorldRot + upper.rotation) - restTip;
      tip.rotation = mixAngle(tip.rotation, wantTip, goal.weight);
      return;
    }
    // Single bone: aim its rest direction at the target.
    const [px, py] = tip.positionIn(this);
    const want = Math.atan2(ty - py, tx - px) - this.worldRotation(tip.parent as Node2D | null) - Rig2D.REST;
    tip.rotation = mixAngle(tip.rotation, want, goal.weight);
  }

  /** Summed rotation from a bone up to the rig. */
  private worldRotation(n: Node2D | null): number {
    let rot = 0;
    for (let k: Node2D | null = n; k && k !== this; k = k.parent as Node2D | null) rot += k.rotation;
    return rot;
  }

  /** Part origins come from the template anchors once the atlas knows the part sizes. */
  override ready(): void {
    const app = this.scene?.attachedApp;
    if (!app) return;
    for (const b of this.template.bones) {
      const part = this.parts.get(b.name);
      if (!part) continue;
      const region = app.atlas.region(part.sprite);
      const anchor = this.anchors[b.name] ?? b.anchor;
      part.originX = Math.round(region.w * anchor[0]);
      part.originY = Math.round(region.h * anchor[1]);
    }
  }

  /** A part's box in the rig's local space at the current pose, for hit checks; null for joints. */
  hitbox(boneName: string): Rect | null {
    const part = this.parts.get(boneName);
    const app = this.scene?.attachedApp;
    if (!part || !app) return null;
    const region = app.atlas.region(part.sprite);
    const w = region.w * (this.manifest.scale ?? 1);
    const h = region.h * (this.manifest.scale ?? 1);
    const [px, py] = part.positionIn(this);
    return { x: px - w / 2, y: py - h / 2, w, h };
  }
}
