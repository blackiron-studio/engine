// Trails: a fading ribbon behind anything that moves. The game pushes a key (a projectile id,
// a dashing actor) and its world position each frame; the node keeps the recent positions,
// draws a tapered strip through them and lets it shrink away once the key stops moving or
// stops being pushed. Each segment sorts at its own depth in projected layers.

import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";
import { mixColor, placeAt, projectDir, restorePlace, stripRegions } from "./place.ts";

export interface TrailStyle {
  /** Seconds of history drawn; older points fall off, so a trail retracts this fast once its key stops. */
  time?: number;
  /** Longest trail in world units, as well. */
  length?: number;
  /** Width at the head, in screen pixels at zoom 1. */
  width?: number;
  /** Width at the tail. */
  endWidth?: number;
  color?: number;
  endColor?: number;
  alpha?: number;
  endAlpha?: number;
  additive?: boolean;
  /** Hard edges instead of a soft falloff across the ribbon. */
  solid?: boolean;
}

export interface TrailsOptions extends TrailStyle {
  /** Trails kept at once; a new key past it replaces the stalest. */
  capacity?: number;
  /** Points kept per trail. */
  points?: number;
  /** A new point is kept once the head has moved this far, in world units; closer moves update the head. */
  minStep?: number;
}

type Key = number | string;

interface Trail {
  style: Required<TrailStyle>;
  x: number[];
  y: number[];
  z: number[];
  t: number[];
  last: number;
}

const DEFAULTS: Required<Omit<TrailStyle, "endColor">> = {
  time: 0.25,
  length: Number.POSITIVE_INFINITY,
  width: 6,
  endWidth: 0,
  color: 0xffffff,
  alpha: 1,
  endAlpha: 0,
  additive: true,
  solid: false,
};

export class Trails extends Node2D {
  readonly capacity: number;
  readonly points: number;
  readonly minStep: number;
  private readonly style: TrailStyle;
  private readonly trails = new Map<Key, Trail>();
  private now = 0;
  private readonly verts = new Float32Array(6 * 4);

  constructor(opts: TrailsOptions = {}) {
    super();
    this.capacity = Math.max(1, opts.capacity ?? 32);
    this.points = Math.max(2, opts.points ?? 24);
    this.minStep = Math.max(0, opts.minStep ?? 4);
    const { capacity: _c, points: _p, minStep: _m, ...style } = opts;
    this.style = style;
  }

  /** Trails drawn now. */
  get count(): number {
    return this.trails.size;
  }

  has(key: Key): boolean {
    return this.trails.has(key);
  }

  /** The head of `key` is now at (x, y, z) in this node's ground space. `style` applies when the trail starts. */
  push(key: Key, x: number, y: number, z = 0, style: TrailStyle = {}): void {
    let tr = this.trails.get(key);
    if (!tr) {
      if (this.trails.size >= this.capacity) {
        let stale: Key | null = null;
        let at = Number.POSITIVE_INFINITY;
        for (const [k, v] of this.trails) if (v.last < at) [stale, at] = [k, v.last];
        if (stale !== null) this.trails.delete(stale);
      }
      const s = { ...DEFAULTS, ...defined(this.style), ...defined(style) };
      tr = { style: { ...s, endColor: s.endColor ?? s.color }, x: [], y: [], z: [], t: [], last: this.now };
      this.trails.set(key, tr);
    }
    tr.last = this.now;
    const n = tr.x.length;
    // Close to the point before the head: move the head instead of adding one.
    if (n >= 2 && Math.hypot(x - tr.x[n - 2], y - tr.y[n - 2], z - tr.z[n - 2]) < this.minStep) {
      tr.x[n - 1] = x;
      tr.y[n - 1] = y;
      tr.z[n - 1] = z;
      tr.t[n - 1] = this.now;
      return;
    }
    if (n >= this.points) {
      tr.x.shift();
      tr.y.shift();
      tr.z.shift();
      tr.t.shift();
    }
    tr.x.push(x);
    tr.y.push(y);
    tr.z.push(z);
    tr.t.push(this.now);
  }

  /** Drop a trail at once, without letting it retract. */
  free(key: Key): void {
    this.trails.delete(key);
  }

  freeAll(): void {
    this.trails.clear();
  }

  override update(dt: number): void {
    this.now += dt;
    for (const [key, tr] of this.trails) {
      // Points older than the trail's time fall off; the newest stays as long as it is young.
      let drop = 0;
      while (drop < tr.t.length && this.now - tr.t[drop] > tr.style.time) drop++;
      if (drop >= tr.t.length) {
        this.trails.delete(key);
        continue;
      }
      if (drop > 0) {
        tr.x.splice(0, drop);
        tr.y.splice(0, drop);
        tr.z.splice(0, drop);
        tr.t.splice(0, drop);
      }
    }
  }

  override render(ctx: DrawContext): void {
    const bias = ctx.depthBias;
    const strips = stripRegions(ctx);
    let placed = false;
    for (const tr of this.trails.values()) {
      const n = tr.x.length;
      if (n < 2) continue;
      const s = tr.style;
      // From the head back: each point's share of the way to the tail, by age and by length.
      const f: number[] = new Array(n);
      let dist = 0;
      let end = 0;
      for (let i = n - 1; i >= 0; i--) {
        if (i < n - 1) dist += Math.hypot(tr.x[i + 1] - tr.x[i], tr.y[i + 1] - tr.y[i], tr.z[i + 1] - tr.z[i]);
        f[i] = Math.min(1, Math.max((this.now - tr.t[i]) / s.time, Number.isFinite(s.length) ? dist / s.length : 0));
        if (f[i] >= 1) {
          end = i;
          break;
        }
      }
      // Projected points, relative to each segment's start; normals from the neighbours on screen.
      const qx: number[] = new Array(n);
      const qy: number[] = new Array(n);
      for (let i = end; i < n; i++) [qx[i], qy[i]] = projectDir(ctx, tr.x[i], tr.y[i], tr.z[i]);
      const region = s.solid ? strips.solid : strips.soft;
      const u = (region.u0 + region.u1) / 2;
      for (let i = end; i < n - 1; i++) {
        const fm = (f[i] + f[i + 1]) / 2;
        const alpha = s.alpha + (s.endAlpha - s.alpha) * fm;
        if (alpha <= 0.002) continue;
        const v = this.verts;
        let k = 0;
        const [ax, ay] = this.edge(qx, qy, i, end, n);
        const [bx, by] = this.edge(qx, qy, i + 1, end, n);
        const wa = (s.width + (s.endWidth - s.width) * f[i]) / 2;
        const wb = (s.width + (s.endWidth - s.width) * f[i + 1]) / 2;
        const ox = qx[i + 1] - qx[i];
        const oy = qy[i + 1] - qy[i];
        const L = [ax * wa, ay * wa, region.v0];
        const R = [-ax * wa, -ay * wa, region.v1];
        const L2 = [ox + bx * wb, oy + by * wb, region.v0];
        const R2 = [ox - bx * wb, oy - by * wb, region.v1];
        for (const p of [L, R, L2, R, R2, L2]) {
          v[k++] = p[0];
          v[k++] = p[1];
          v[k++] = u;
          v[k++] = p[2];
        }
        placeAt(ctx, this, bias, tr.x[i], tr.y[i], tr.z[i]);
        placed = true;
        ctx.mesh(v, 6, { tint: mixColor(s.color, s.endColor, fm), alpha, additive: s.additive, smooth: true });
      }
    }
    if (placed) restorePlace(ctx, this, bias);
  }

  /** Unit normal on screen at point i, from its neighbours. */
  private edge(qx: number[], qy: number[], i: number, lo: number, n: number): [number, number] {
    const a = Math.max(lo, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dx = qx[b] - qx[a];
    const dy = qy[b] - qy[a];
    const len = Math.hypot(dx, dy) || 1;
    return [-dy / len, dx / len];
  }
}

function defined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
