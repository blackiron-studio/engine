// Beams: glowing strips between two world points, each end at its own height. Tracers,
// lasers, lightning, tethers and aim lines. A beam is drawn as a few stretched additive strips
// (a wide glow under a narrow core), cut into segments that each sort at their own depth, so
// a beam passing behind a wall is hidden by it. With a speed, only a short section travels
// from A to B, so a tracer is seen leaving the barrel and arriving.

import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";
import { placeAt, projectDir, restorePlace, stripRegions } from "./place.ts";

export interface BeamStyle {
  /** Width of the core in screen pixels at zoom 1. */
  width?: number;
  /** Core colour. */
  color?: number;
  /** Glow drawn under the core, wider; null for none. The core's colour by default. */
  glow?: number | null;
  /** Glow width as a multiple of the core's. */
  glowWidth?: number;
  glowAlpha?: number;
  alpha?: number;
  /** Seconds a whole beam lasts, fading out; Infinity keeps it until `free`. Travelling sections ignore it. */
  life?: number;
  /** Narrow to nothing over the life as well as fade. */
  thin?: boolean;
  /** World units per second a travelling section moves from A to B; 0 shows the whole beam at once. */
  speed?: number;
  /** Length of a travelling section, in world units. */
  head?: number;
  /** Share of the visible length, from the tail, over which alpha ramps up: 1 is a comet, 0 is even. 1 for travelling sections by default. */
  taper?: number;
  /** Also draw into the light pass, so beams stay bright in a lit, dark scene. */
  emissive?: boolean;
  /** Hard-edged strips instead of soft ones. */
  solid?: boolean;
}

export interface BeamsOptions extends BeamStyle {
  /** Beams kept at once; adding past it replaces the oldest. */
  capacity?: number;
  /** Longest segment in world units; shorter segments sort more exactly against walls. */
  segment?: number;
}

interface Beam extends Required<Omit<BeamStyle, "glow">> {
  glow: number | null;
  live: boolean;
  gen: number;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  age: number;
}

const DEFAULTS: Required<Omit<BeamStyle, "glow" | "taper">> = {
  width: 3,
  color: 0xffffff,
  glowWidth: 3,
  glowAlpha: 0.45,
  alpha: 1,
  life: 0.08,
  thin: true,
  speed: 0,
  head: 60,
  emissive: true,
  solid: false,
};

export class Beams extends Node2D {
  readonly capacity: number;
  readonly segment: number;
  private readonly style: BeamStyle;
  private readonly beams: Beam[] = [];

  constructor(opts: BeamsOptions = {}) {
    super();
    this.capacity = Math.max(1, opts.capacity ?? 64);
    this.segment = Math.max(4, opts.segment ?? 24);
    const { capacity: _c, segment: _s, ...style } = opts;
    this.style = style;
  }

  /** Beams alive now. */
  get count(): number {
    let n = 0;
    for (const b of this.beams) if (b.live) n++;
    return n;
  }

  /** A beam from (x0, y0, z0) to (x1, y1, z1), in this node's ground space; returns a handle for `move` and `free`. */
  spawn(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, style: BeamStyle = {}): number {
    let slot = this.beams.findIndex((b) => !b.live);
    if (slot < 0) {
      if (this.beams.length < this.capacity) slot = this.beams.length;
      else {
        slot = 0;
        for (let i = 1; i < this.beams.length; i++) if (this.beams[i].age > this.beams[slot].age) slot = i;
      }
    }
    const s = { ...this.style, ...style };
    const speed = s.speed ?? DEFAULTS.speed;
    const prev = this.beams[slot];
    const color = s.color ?? DEFAULTS.color;
    const b: Beam = {
      ...DEFAULTS,
      ...stripUndefined(s),
      color,
      glow: s.glow === undefined ? color : s.glow,
      taper: s.taper ?? (speed > 0 ? 1 : 0),
      live: true,
      gen: (prev?.gen ?? 0) + 1,
      x0,
      y0,
      z0,
      x1,
      y1,
      z1,
      age: 0,
    };
    this.beams[slot] = b;
    return b.gen * this.capacity + slot;
  }

  /** Move a beam's ends; a handle of a beam that has gone is ignored. */
  move(handle: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const b = this.lookup(handle);
    if (!b) return;
    b.x0 = x0;
    b.y0 = y0;
    b.z0 = z0;
    b.x1 = x1;
    b.y1 = y1;
    b.z1 = z1;
  }

  free(handle: number): void {
    const b = this.lookup(handle);
    if (b) b.live = false;
  }

  /** Whether a handle's beam is still drawing. */
  alive(handle: number): boolean {
    return this.lookup(handle) !== null;
  }

  freeAll(): void {
    for (const b of this.beams) b.live = false;
  }

  private lookup(handle: number): Beam | null {
    if (handle < 0) return null;
    const b = this.beams[handle % this.capacity];
    return b && b.live && b.gen === Math.floor(handle / this.capacity) ? b : null;
  }

  override update(dt: number): void {
    for (const b of this.beams) {
      if (!b.live) continue;
      b.age += dt;
      if (b.speed > 0) {
        const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
        if (b.age * b.speed - b.head >= len) b.live = false;
      } else if (b.age >= b.life) b.live = false;
    }
  }

  override render(ctx: DrawContext): void {
    const bias = ctx.depthBias;
    const strips = stripRegions(ctx);
    let placed = false;
    for (const b of this.beams) {
      if (!b.live) continue;
      const dx = b.x1 - b.x0;
      const dy = b.y1 - b.y0;
      const dz = b.z1 - b.z0;
      const len = Math.hypot(dx, dy, dz);
      if (len <= 0) continue;
      // The visible section along the beam, in world units from A.
      let s0 = 0;
      let s1 = len;
      let fade = 1;
      if (b.speed > 0) {
        s1 = Math.min(len, b.age * b.speed);
        s0 = Math.max(0, b.age * b.speed - b.head);
      } else if (Number.isFinite(b.life) && b.life > 0) fade = Math.max(0, 1 - b.age / b.life);
      if (s1 <= s0) continue;
      const width = b.width * (b.thin && b.speed <= 0 ? fade : 1);
      const alpha = b.alpha * fade;
      const [px, py] = projectDir(ctx, dx / len, dy / len, dz / len);
      const rot = Math.atan2(py, px);
      const perUnit = Math.hypot(px, py);
      const n = Math.max(1, Math.ceil((s1 - s0) / this.segment));
      const step = (s1 - s0) / n;
      const region = b.solid ? strips.solid : strips.soft;
      // Soft strips show about half their height; solid ones all of it.
      const k = b.solid ? 1 / 64 : 1 / 32;
      for (let i = 0; i < n; i++) {
        const a = s0 + step * i;
        const m = a + step / 2;
        const t = m / len;
        const ramp = b.taper > 0 ? Math.min(1, (m - s0) / ((s1 - s0) * b.taper)) : 1;
        placeAt(ctx, this, bias, b.x0 + dx * t, b.y0 + dy * t, b.z0 + dz * t);
        placed = true;
        // A little overlap hides the joins between segments.
        const sx = step * perUnit + 0.5;
        if (b.glow !== null && b.glowAlpha > 0) {
          ctx.sprite(region, 0, 0, { sx, sy: width * b.glowWidth * k, rot, tint: b.glow, alpha: alpha * b.glowAlpha * ramp, additive: true, smooth: true, emissive: b.emissive });
        }
        ctx.sprite(region, 0, 0, { sx, sy: width * k, rot, tint: b.color, alpha: alpha * ramp, additive: true, smooth: true, emissive: b.emissive });
      }
    }
    if (placed) restorePlace(ctx, this, bias);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
