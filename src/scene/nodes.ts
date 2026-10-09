// SpritePool: thousands of sprites that live in the kernel's node table. Spawn once with a
// position, velocity and look; the kernel moves, animates, culls and draws them every frame
// with no script work per sprite. Nodes can follow physics bodies in bulk.

import type { Region } from "../art/atlas.ts";
import type { Rect } from "../core/math.ts";
import { FRAME_WORDS, type Kernel, NODE as N, NODE_BOUNDS, NODE_FLAG as F, NODE_FLOOR, NODE_WORDS } from "../kernel/protocol.ts";
import { TsKernel } from "../kernel/ts.ts";
import type { PhysicsWorld } from "../physics/world.ts";
import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

export type BoundsMode = "none" | "wrap" | "bounce" | "kill";

export interface SpritePoolOptions {
  /** Slots in the table; spawns beyond it return -1. */
  capacity?: number;
  /** Default sprite for spawns that name none. */
  sprite?: string;
  additive?: boolean;
  smooth?: boolean;
  /** Acceleration applied to every node, in units per second squared. */
  gravity?: [number, number];
  /** Velocity damping per second. */
  damping?: number;
  /** Rectangle the nodes stay in, with `boundsMode` saying how. */
  bounds?: Rect | null;
  boundsMode?: BoundsMode;
  /** Named frame lists spawns can animate through. */
  animations?: Record<string, string[]>;
  /** Acceleration along height, in units per second squared (negative pulls down). */
  gravityZ?: number;
  /** What happens at height zero: fall through, stop, or bounce. */
  floor?: "none" | "stop" | "bounce";
  /** Draw blob shadows under every node in projected layers. */
  shadow?: boolean;
}

export interface SpawnOptions {
  x?: number;
  y?: number;
  rot?: number;
  sx?: number;
  sy?: number;
  /** Sets both sx and sy. */
  scale?: number;
  vx?: number;
  vy?: number;
  /** Spin in radians per second. */
  vrot?: number;
  alpha?: number;
  tint?: number;
  /** Seconds until the node frees itself. */
  life?: number;
  sprite?: string;
  /** One of the pool's `animations`; `fps` plays it. */
  animation?: string;
  fps?: number;
  frame?: number;
  additive?: boolean;
  smooth?: boolean;
  flipX?: boolean;
  flipY?: boolean;
  hidden?: boolean;
  /** Physics body id to follow (see `attachPhysics`). */
  body?: number;
  /** A number the game keeps per node. */
  user?: number;
  /** Height and vertical speed, for projected layers. */
  z?: number;
  vz?: number;
  shadow?: boolean;
  depthBias?: number;
}

export interface NodeState {
  alive: boolean;
  x: number;
  y: number;
  rot: number;
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  vrot: number;
  alpha: number;
  tint: number;
  life: number;
  frame: number;
  body: number;
  user: number;
  z: number;
  vz: number;
}

const BOUNDS: Record<BoundsMode, number> = { none: NODE_BOUNDS.NONE, wrap: NODE_BOUNDS.WRAP, bounce: NODE_BOUNDS.BOUNCE, kill: NODE_BOUNDS.KILL };
const FLOORS = { none: NODE_FLOOR.NONE, stop: NODE_FLOOR.STOP, bounce: NODE_FLOOR.BOUNCE } as const;

export class SpritePool extends Node2D {
  readonly capacity: number;
  tint = 0xffffff;
  additive: boolean;
  smooth: boolean;
  private kernel: Kernel | null = null;
  private id = -1;
  private data: Float32Array = new Float32Array(0);
  private readonly opts: SpritePoolOptions;
  private readonly animations = new Map<string, { base: number; count: number }>();
  private frameRegions: Region[] = [];
  private pending: SpawnOptions[] = [];
  private dirtyLo = Number.POSITIVE_INFINITY;
  private dirtyHi = -1;
  private stale = false;
  private physics: PhysicsWorld | null = null;
  private unbindPhysics: (() => void) | null = null;
  /** Records handed to `get`, reused to avoid allocation. */
  private readonly view: NodeState = { alive: false, x: 0, y: 0, rot: 0, sx: 1, sy: 1, vx: 0, vy: 0, vrot: 0, alpha: 1, tint: 0xffffff, life: 0, frame: 0, body: -1, user: 0, z: 0, vz: 0 };

  constructor(opts: SpritePoolOptions = {}, x = 0, y = 0) {
    super(x, y);
    this.opts = opts;
    this.capacity = Math.max(1, opts.capacity ?? 1024);
    this.additive = opts.additive ?? false;
    this.smooth = opts.smooth ?? false;
  }

  /** Live nodes. */
  get count(): number {
    return this.kernel && this.id >= 0 ? this.kernel.nodeCount(this.id) : this.pending.length;
  }

  /** The kernel table id, for games that drive the table directly. */
  get tableId(): number {
    return this.id;
  }

  /** The raw records, `NODE_WORDS` floats each; `NODE` names the offsets. Call `sync()` first when reading. */
  get records(): Float32Array {
    return this.data;
  }

  /** The kernel the pool lives in: the renderer's, or a private reference kernel with no renderer. */
  private kernelFor(): Kernel | null {
    const app = this.scene?.attachedApp;
    if (!app) return null;
    return app.renderer.kernel ?? this.kernel ?? new TsKernel({ maxQuads: 64, streamWords: 1024 });
  }

  private ensure(): boolean {
    if (this.kernel && this.id >= 0) return true;
    const k = this.kernelFor();
    if (!k) return false;
    this.kernel = k;
    this.id = k.createNodes(this.capacity);
    this.data = k.nodesData(this.id);
    const o = this.opts;
    const b = o.bounds ?? null;
    k.configureNodes(this.id, o.gravity?.[0] ?? 0, o.gravity?.[1] ?? 0, o.damping ?? 0, BOUNDS[o.boundsMode ?? (b ? "bounce" : "none")], b?.x ?? 0, b?.y ?? 0, b?.w ?? 0, b?.h ?? 0, o.gravityZ ?? 0, FLOORS[o.floor ?? "none"]);
    this.uploadFrames();
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) this.spawn(p);
    return true;
  }

  private region(name: string): Region | null {
    const app = this.scene?.attachedApp;
    return app ? app.atlas.region(name) : null;
  }

  /** Build the table's frame list from the named animations. */
  private uploadFrames(): void {
    const k = this.kernel;
    if (!k || this.id < 0) return;
    this.animations.clear();
    this.frameRegions = [];
    const anims = this.opts.animations ?? {};
    for (const [name, frames] of Object.entries(anims)) {
      const base = this.frameRegions.length;
      for (const f of frames) {
        const r = this.region(f);
        if (r) this.frameRegions.push(r);
      }
      this.animations.set(name, { base, count: this.frameRegions.length - base });
    }
    const max = Math.floor(k.scratch.length / FRAME_WORDS);
    const n = Math.min(max, this.frameRegions.length);
    const s = k.scratch;
    for (let i = 0; i < n; i++) {
      const r = this.frameRegions[i];
      const o = i * FRAME_WORDS;
      s[o] = r.w;
      s[o + 1] = r.h;
      s[o + 2] = r.ox;
      s[o + 3] = r.oy;
      s[o + 4] = r.u0;
      s[o + 5] = r.v0;
      s[o + 6] = r.u1;
      s[o + 7] = r.v1;
    }
    k.setNodeFrames(this.id, n * FRAME_WORDS);
  }

  /** Add an animation after construction; existing nodes keep their frames. */
  defineAnimation(name: string, frames: string[]): void {
    this.opts.animations = { ...(this.opts.animations ?? {}), [name]: frames };
    if (this.kernel && this.id >= 0) this.uploadFrames();
  }

  private markDirty(index: number): void {
    if (index < this.dirtyLo) this.dirtyLo = index;
    if (index + 1 > this.dirtyHi) this.dirtyHi = index + 1;
  }

  /** Spawn a node; returns its handle, or -1 when the pool is full or not yet in a scene. */
  spawn(o: SpawnOptions = {}): number {
    if (!this.ensure()) {
      this.pending.push(o);
      return -1;
    }
    const k = this.kernel as Kernel;
    const i = k.allocNode(this.id);
    if (i < 0) return -1;
    this.data = k.nodesData(this.id);
    this.write(i, o, true);
    return i;
  }

  /** Change a node's fields; unspecified ones keep their values. */
  set(handle: number, o: SpawnOptions): void {
    if (handle < 0 || handle >= this.capacity || !this.kernel) return;
    this.write(handle, o, false);
  }

  private write(i: number, o: SpawnOptions, fresh: boolean): void {
    const d = this.data;
    const b = i * NODE_WORDS;
    if (o.x !== undefined) d[b + N.X] = o.x;
    if (o.y !== undefined) d[b + N.Y] = o.y;
    if (o.rot !== undefined) d[b + N.ROT] = o.rot;
    if (o.scale !== undefined) {
      d[b + N.SX] = o.scale;
      d[b + N.SY] = o.scale;
    }
    if (o.sx !== undefined) d[b + N.SX] = o.sx;
    if (o.sy !== undefined) d[b + N.SY] = o.sy;
    if (o.vx !== undefined) d[b + N.VX] = o.vx;
    if (o.vy !== undefined) d[b + N.VY] = o.vy;
    if (o.vrot !== undefined) d[b + N.VROT] = o.vrot;
    if (o.alpha !== undefined) d[b + N.ALPHA] = o.alpha;
    if (o.tint !== undefined) d[b + N.TINT] = o.tint & 0xffffff;
    if (o.user !== undefined) d[b + N.USER] = o.user;
    if (o.body !== undefined) d[b + N.BODY] = o.body;
    if (o.z !== undefined) d[b + N.Z] = o.z;
    if (o.vz !== undefined) d[b + N.VZ] = o.vz;
    if (o.depthBias !== undefined) d[b + N.DEPTH_BIAS] = o.depthBias;
    let flags = d[b + N.FLAGS] | F.ALIVE;
    const setFlag = (bit: number, on: boolean | undefined) => {
      if (on === undefined) return;
      flags = on ? flags | bit : flags & ~bit;
    };
    setFlag(F.ADDITIVE, o.additive);
    setFlag(F.SMOOTH, o.smooth);
    setFlag(F.FLIP_X, o.flipX);
    setFlag(F.FLIP_Y, o.flipY);
    setFlag(F.HIDDEN, o.hidden);
    setFlag(F.SHADOW, o.shadow ?? (fresh ? this.opts.shadow : undefined));
    if (o.life !== undefined) {
      d[b + N.LIFE] = o.life;
      flags |= F.EXPIRES;
    }
    const sprite = o.sprite ?? (fresh && !o.animation ? this.opts.sprite : undefined);
    if (o.animation !== undefined) {
      const a = this.animations.get(o.animation);
      if (a) {
        d[b + N.FRAME_BASE] = a.base;
        d[b + N.FRAME_COUNT] = a.count;
        d[b + N.FRAME] = o.frame ?? 0;
        d[b + N.FPS] = o.fps ?? d[b + N.FPS];
      }
    } else if (sprite !== undefined) {
      const r = this.region(sprite);
      if (r) {
        d[b + N.W] = r.w;
        d[b + N.H] = r.h;
        d[b + N.OX] = r.ox;
        d[b + N.OY] = r.oy;
        d[b + N.U0] = r.u0;
        d[b + N.V0] = r.v0;
        d[b + N.U1] = r.u1;
        d[b + N.V1] = r.v1;
      }
      d[b + N.FRAME_COUNT] = 0;
    }
    if (o.fps !== undefined) d[b + N.FPS] = o.fps;
    if (o.frame !== undefined && o.animation === undefined) d[b + N.FRAME] = o.frame;
    d[b + N.FLAGS] = flags;
    this.markDirty(i);
  }

  /** Free a node. */
  free(handle: number): void {
    if (!this.kernel || this.id < 0 || handle < 0) return;
    this.kernel.freeNode(this.id, handle);
  }

  /** Free every node (`clear` removes child nodes, as on every Node). */
  freeAll(): void {
    this.pending.length = 0;
    if (this.kernel && this.id >= 0) this.kernel.clearNodes(this.id);
  }

  /** Bring the script-visible records up to date; a no-op where the records alias kernel memory. */
  sync(): void {
    const k = this.kernel;
    if (!k || this.id < 0) return;
    this.flush();
    if (this.stale && k.pullNodes) {
      k.pullNodes(this.id);
      this.stale = false;
    }
  }

  private flush(): void {
    const k = this.kernel;
    if (!k || this.id < 0 || this.dirtyHi < 0) return;
    k.flushNodes?.(this.id, this.dirtyLo, this.dirtyHi);
    this.dirtyLo = Number.POSITIVE_INFINITY;
    this.dirtyHi = -1;
  }

  /** Read a node. The returned object is reused by the next call; copy what you keep. */
  get(handle: number): NodeState {
    const v = this.view;
    if (handle < 0 || handle >= this.capacity || !this.kernel) {
      v.alive = false;
      return v;
    }
    this.sync();
    const d = this.data;
    const b = handle * NODE_WORDS;
    v.alive = (d[b + N.FLAGS] & F.ALIVE) !== 0;
    v.x = d[b + N.X];
    v.y = d[b + N.Y];
    v.rot = d[b + N.ROT];
    v.sx = d[b + N.SX];
    v.sy = d[b + N.SY];
    v.vx = d[b + N.VX];
    v.vy = d[b + N.VY];
    v.vrot = d[b + N.VROT];
    v.alpha = d[b + N.ALPHA];
    v.tint = d[b + N.TINT];
    v.life = d[b + N.LIFE];
    v.frame = d[b + N.FRAME];
    v.body = d[b + N.BODY];
    v.user = d[b + N.USER];
    v.z = d[b + N.Z];
    v.vz = d[b + N.VZ];
    return v;
  }

  /** Whether a handle refers to a live node. */
  alive(handle: number): boolean {
    return this.get(handle).alive;
  }

  /** Follow physics: after every step, nodes with a `body` take that body's transform. */
  attachPhysics(world: PhysicsWorld): void {
    this.unbindPhysics?.();
    this.physics = world;
    this.unbindPhysics = world.onStep(() => this.syncBodies());
  }

  /** Bind a node to a body; pass -1 to release it. */
  bindBody(handle: number, body: number): void {
    this.set(handle, { body });
  }

  private syncBodies(): void {
    const k = this.kernel;
    const w = this.physics;
    if (!k || !w || this.id < 0) return;
    this.flush();
    const t = w.rawTransforms();
    const s = k.scratch;
    const chunk = Math.floor(s.length / 8) * 8;
    for (let o = 0; o < t.length; o += chunk) {
      const n = Math.min(chunk, t.length - o);
      s.set(t.subarray(o, o + n));
      k.applyNodeTransforms(this.id, n);
    }
    this.stale = true;
  }

  override ready(): void {
    this.ensure();
  }

  override update(dt: number): void {
    if (!this.ensure()) return;
    this.flush();
    (this.kernel as Kernel).stepNodes(this.id, dt);
    this.stale = true;
  }

  override exit(): void {
    this.unbindPhysics?.();
    this.unbindPhysics = null;
    if (this.kernel && this.id >= 0) this.kernel.destroyNodes(this.id);
    this.kernel = null;
    this.id = -1;
    this.data = new Float32Array(0);
  }

  override render(ctx: DrawContext): void {
    if (!this.ensure()) return;
    const k = this.kernel as Kernel;
    this.flush();
    if (ctx.renderer.drawNodes && ctx.kernel === k) {
      ctx.nodes(this.id, { tint: this.tint, additive: this.additive, smooth: this.smooth });
      return;
    }
    // No kernel-backed renderer (Canvas 2D, the recording renderer): draw from the records.
    this.sync();
    const d = this.data;
    const high = k.nodesHigh(this.id);
    const region: Region = { name: "", x: 0, y: 0, w: 0, h: 0, u0: 0, v0: 0, u1: 0, v1: 0, ox: 0, oy: 0 };
    for (let i = 0; i < high; i++) {
      const b = i * NODE_WORDS;
      const flags = d[b + N.FLAGS];
      if ((flags & F.ALIVE) === 0 || flags & F.HIDDEN) continue;
      let r: Region = region;
      if (this.frameRegions.length && d[b + N.FRAME_COUNT] > 0) {
        const idx = d[b + N.FRAME_BASE] + Math.min(Math.max(0, Math.floor(d[b + N.FRAME])), d[b + N.FRAME_COUNT] - 1);
        r = this.frameRegions[idx] ?? region;
      } else {
        region.w = d[b + N.W];
        region.h = d[b + N.H];
        region.ox = d[b + N.OX];
        region.oy = d[b + N.OY];
        region.u0 = d[b + N.U0];
        region.v0 = d[b + N.V0];
        region.u1 = d[b + N.U1];
        region.v1 = d[b + N.V1];
      }
      const tint = d[b + N.TINT];
      const opts = {
        sx: d[b + N.SX],
        sy: d[b + N.SY],
        rot: d[b + N.ROT],
        alpha: d[b + N.ALPHA],
        tint: this.tint === 0xffffff ? tint : mulTint(tint, this.tint),
        additive: this.additive || (flags & F.ADDITIVE) !== 0,
        smooth: this.smooth || (flags & F.SMOOTH) !== 0,
        flipX: (flags & F.FLIP_X) !== 0,
        flipY: (flags & F.FLIP_Y) !== 0,
      };
      if (ctx.projection) {
        if (flags & F.SHADOW && ctx.atlas.has("shadow")) {
          const z = d[b + N.Z];
          const k = Math.max(0.4, 1 - z / 160);
          ctx.sprite3("shadow", d[b + N.X], d[b + N.Y], 0, { sx: k, sy: k, alpha: 0.5 * Math.max(0.2, 1 - z / 200) });
        }
        ctx.sprite3(r, d[b + N.X], d[b + N.Y], d[b + N.Z], opts);
      } else ctx.sprite(r, d[b + N.X], d[b + N.Y], opts);
    }
  }
}

function mulTint(a: number, b: number): number {
  const r = Math.round((((a >> 16) & 255) * ((b >> 16) & 255)) / 255);
  const g = Math.round((((a >> 8) & 255) * ((b >> 8) & 255)) / 255);
  const bl = Math.round(((a & 255) * (b & 255)) / 255);
  return (r << 16) | (g << 8) | bl;
}
