// AnimationPlayer: keyframe tracks on any property of any object, sprite frame tracks,
// sound and callback triggers, blending between clips, and a small state machine that
// picks clips from conditions. Values interpolate with the same easing names as tweens.

import { type EaseFn, type EaseName, resolveEase } from "../core/math.ts";
import { Node } from "./node.ts";

export type Key<T = number> = [time: number, value: T, ease?: EaseName | EaseFn];

export interface PropertyTrack {
  /** The object animated; usually a node. */
  target: object;
  /** Property name, or a dotted path such as "velocity.x". */
  property: string;
  keys: Key<number>[];
}

export interface SpriteTrack {
  /** Anything with a `sprite` (or `frame`) string property, such as a Sprite node. */
  target: object;
  property?: string;
  keys: Key<string>[];
}

export interface CallTrack {
  keys: Key<() => void>[];
}

export interface SoundTrack {
  /** Sound names played through `app.audio` when the playhead crosses them. */
  keys: Key<string>[];
}

export interface Clip {
  /** Seconds; defaults to the last key time. */
  length?: number;
  loop?: boolean;
  speed?: number;
  properties?: PropertyTrack[];
  sprites?: SpriteTrack[];
  calls?: CallTrack;
  sounds?: SoundTrack;
}

export interface PlayOptions {
  speed?: number;
  /** Start time in seconds. */
  from?: number;
  /** Seconds to blend property tracks from their current values. */
  blend?: number;
}

interface Running {
  name: string;
  clip: Required<Pick<Clip, "length" | "loop" | "speed">> & Clip;
  time: number;
  speed: number;
  /** Values at the moment this clip started, for blending. */
  blendFrom: Map<PropertyTrack, number>;
  blend: number;
  blendTime: number;
  lastTime: number;
  done: boolean;
}

function getPath(target: object, path: string): number {
  const parts = path.split(".");
  let o: unknown = target;
  for (const p of parts) o = (o as Record<string, unknown>)?.[p];
  return typeof o === "number" ? o : 0;
}

function setPath(target: object, path: string, value: unknown): void {
  const parts = path.split(".");
  let o: Record<string, unknown> = target as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = o[parts[i]];
    if (!next || typeof next !== "object") return;
    o = next as Record<string, unknown>;
  }
  o[parts[parts.length - 1]] = value;
}

function sample(keys: Key<number>[], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1, ease] = keys[i];
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return v0 + (v1 - v0) * resolveEase(ease)(u);
    }
  }
  return keys[keys.length - 1][1];
}

function stepValue<T>(keys: Key<T>[], t: number): T | undefined {
  let v: T | undefined;
  for (const k of keys) {
    if (k[0] <= t) v = k[1];
    else break;
  }
  return v;
}

/**
 * Plays named clips. Add it anywhere in the scene; it advances with the scene's fixed
 * step and writes to its targets. `onFinished` fires when a non-looping clip ends.
 */
export class AnimationPlayer extends Node {
  private readonly clips = new Map<string, Clip>();
  private current: Running | null = null;
  private queued: { name: string; opts: PlayOptions }[] = [];
  onFinished: ((name: string) => void) | null = null;
  /** Called for sound tracks; the App wires this to `audio.play` when the player enters a scene. */
  playSound: ((name: string) => void) | null = null;

  override ready(): void {
    if (!this.playSound) {
      const app = this.scene?.attachedApp;
      if (app) this.playSound = (n) => app.audio.play(n);
    }
  }

  /** Register a clip under a name. */
  define(name: string, clip: Clip): this {
    this.clips.set(name, clip);
    return this;
  }

  has(name: string): boolean {
    return this.clips.has(name);
  }

  get playing(): string | null {
    return this.current && !this.current.done ? this.current.name : null;
  }

  get time(): number {
    return this.current?.time ?? 0;
  }

  private clipLength(c: Clip): number {
    if (c.length !== undefined) return c.length;
    let end = 0;
    for (const t of c.properties ?? []) for (const k of t.keys) end = Math.max(end, k[0]);
    for (const t of c.sprites ?? []) for (const k of t.keys) end = Math.max(end, k[0]);
    for (const k of c.calls?.keys ?? []) end = Math.max(end, k[0]);
    for (const k of c.sounds?.keys ?? []) end = Math.max(end, k[0]);
    return end;
  }

  play(name: string, opts: PlayOptions = {}): this {
    const clip = this.clips.get(name);
    if (!clip) {
      console.warn(`[blackiron] animation "${name}" is not defined`);
      return this;
    }
    if (this.current && this.current.name === name && !this.current.done && opts.from === undefined) return this;
    const blendFrom = new Map<PropertyTrack, number>();
    if (opts.blend && opts.blend > 0) {
      for (const t of clip.properties ?? []) blendFrom.set(t, getPath(t.target, t.property));
    }
    this.current = {
      name,
      clip: { length: this.clipLength(clip), loop: clip.loop ?? false, speed: clip.speed ?? 1, ...clip },
      time: opts.from ?? 0,
      speed: opts.speed ?? clip.speed ?? 1,
      blendFrom,
      blend: opts.blend ?? 0,
      blendTime: 0,
      lastTime: (opts.from ?? 0) - 1e-6,
      done: false,
    };
    this.apply(this.current, true);
    return this;
  }

  /** Play after the current clip finishes (or now, if nothing plays). */
  queue(name: string, opts: PlayOptions = {}): this {
    if (!this.current || this.current.done) return this.play(name, opts);
    this.queued.push({ name, opts });
    return this;
  }

  stop(): void {
    this.current = null;
    this.queued.length = 0;
  }

  pause(): void {
    if (this.current) this.current.speed = 0;
  }

  resume(speed = 1): void {
    if (this.current) this.current.speed = speed;
  }

  seek(time: number): void {
    if (!this.current) return;
    this.current.time = time;
    this.current.lastTime = time - 1e-6;
    this.apply(this.current, true);
  }

  override update(dt: number): void {
    const r = this.current;
    if (!r || r.done) return;
    const len = r.clip.length;
    r.lastTime = r.time;
    r.time += dt * r.speed;
    r.blendTime += dt;
    if (r.time >= len && len > 0) {
      if (r.clip.loop) {
        this.apply(r, false, len);
        r.time = r.time % len;
        r.lastTime = -1e-6;
      } else {
        r.time = len;
        this.apply(r, false);
        r.done = true;
        const finished = r.name;
        const next = this.queued.shift();
        if (next) this.play(next.name, next.opts);
        this.onFinished?.(finished);
        return;
      }
    }
    this.apply(r, false);
  }

  /** Write track values for the playhead; triggers fire once when crossed. */
  private apply(r: Running, initial: boolean, upTo = r.time): void {
    const c = r.clip;
    const t = upTo;
    const blend = r.blend > 0 ? Math.min(1, r.blendTime / r.blend) : 1;
    for (const track of c.properties ?? []) {
      let v = sample(track.keys, t);
      if (blend < 1) {
        const from = r.blendFrom.get(track);
        if (from !== undefined) v = from + (v - from) * blend;
      }
      setPath(track.target, track.property, v);
    }
    for (const track of c.sprites ?? []) {
      const v = stepValue(track.keys, t);
      if (v !== undefined) setPath(track.target, track.property ?? "sprite", v);
    }
    if (!initial) {
      const from = r.lastTime;
      for (const k of c.calls?.keys ?? []) if (k[0] > from && k[0] <= t) k[1]();
      for (const k of c.sounds?.keys ?? []) if (k[0] > from && k[0] <= t) this.playSound?.(k[1]);
    }
  }
}

export interface StateOptions {
  /** Clip to play on the player when entering. */
  clip?: string;
  blend?: number;
  enter?: () => void;
  exit?: () => void;
  update?: (dt: number) => void;
}

export interface Transition {
  /** Source state, or "any". */
  from: string;
  to: string;
  when: () => boolean;
  blend?: number;
}

/**
 * A state machine over an AnimationPlayer: states name clips, transitions are conditions
 * checked every update, in order. `set` switches directly.
 */
export class StateMachine {
  private readonly states = new Map<string, StateOptions>();
  private readonly transitions: Transition[] = [];
  private _state: string | null = null;
  onChange: ((to: string, from: string | null) => void) | null = null;

  constructor(readonly player: AnimationPlayer | null = null) {}

  add(name: string, opts: StateOptions = {}): this {
    this.states.set(name, opts);
    return this;
  }

  transition(from: string, to: string, when: () => boolean, blend?: number): this {
    this.transitions.push({ from, to, when, blend });
    return this;
  }

  get state(): string | null {
    return this._state;
  }

  set(name: string, blend?: number): void {
    if (name === this._state) return;
    const from = this._state;
    const prev = from ? this.states.get(from) : undefined;
    const next = this.states.get(name);
    if (!next) {
      console.warn(`[blackiron] state "${name}" is not defined`);
      return;
    }
    prev?.exit?.();
    this._state = name;
    if (next.clip && this.player) this.player.play(next.clip, { blend: blend ?? next.blend ?? 0 });
    next.enter?.();
    this.onChange?.(name, from);
  }

  update(dt: number): void {
    const s = this._state;
    for (const t of this.transitions) {
      if ((t.from === s || t.from === "any") && t.to !== s && t.when()) {
        this.set(t.to, t.blend);
        break;
      }
    }
    if (this._state) this.states.get(this._state)?.update?.(dt);
  }
}
