// 2D lighting: a LightLayer sets the ambient level and holds Light2D nodes, which draw into
// the light target; the composite multiplies the world by it. Lights shade against the normal
// maps of what they fall on, and lights with `shadows` are blocked by LightOccluder2D polygons
// and the solid tiles of tile maps that opt in, like Godot's occluders.

import { TAU } from "../core/math.ts";
import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

export interface LightOptions {
  radius?: number;
  color?: number;
  /** Brightness at the centre; above 1 over-brightens. */
  intensity?: number;
  /** Random flicker amount in [0, 1]. */
  flicker?: number;
  /** A cone instead of a disc: direction and half-width in radians. */
  cone?: { angle: number; width: number };
  /** Squareness of the falloff; 1 is soft, 2 is tighter. */
  falloff?: number;
  /** Height above the ground in radius units, for normal-mapped shading; 0.6 by default. */
  height?: number;
  /** Cast shadows from the layer's occluders. */
  shadows?: boolean;
  /** How dark a shadow is, 0 to 1. */
  shadowStrength?: number;
}

/** Something that contributes occluder segments to a light layer, in the layer's space. */
export interface Occluding {
  appendOccluders(layer: LightLayer, out: number[], bounds: { x: number; y: number; w: number; h: number } | null): void;
}

/**
 * A point of `node` in `target`'s space, from the nodes' own positions, rotations and scales
 * rather than the transforms of the last draw, so it is right for nodes not drawn yet this frame.
 */
export function pointIn(node: Node2D, target: Node2D, x: number, y: number): [number, number] {
  // Up from the node to the root.
  let n: Node2D | null = node;
  while (n) {
    const c = Math.cos(n.rotation);
    const s = Math.sin(n.rotation);
    const px = x * n.scaleX;
    const py = y * n.scaleY;
    x = n.x + px * c - py * s;
    y = n.y + px * s + py * c;
    n = parent2D(n);
  }
  // Down from the root into the target.
  const chain: Node2D[] = [];
  for (let t: Node2D | null = target; t; t = parent2D(t)) chain.push(t);
  for (let i = chain.length - 1; i >= 0; i--) {
    const t = chain[i];
    const c = Math.cos(t.rotation);
    const s = Math.sin(t.rotation);
    const dx = x - t.x;
    const dy = y - t.y;
    x = (dx * c + dy * s) / (t.scaleX || 1);
    y = (-dx * s + dy * c) / (t.scaleY || 1);
  }
  return [x, y];
}

function parent2D(n: Node2D): Node2D | null {
  let p = n.parent;
  while (p && !(p instanceof Node2D)) p = p.parent;
  return (p as Node2D | null) ?? null;
}

/** Add one of these to `scene.world` (usually last) and put Light2D nodes inside it. */
export class LightLayer extends Node2D {
  readonly occluders = new Set<Occluding>();
  /** Occluder segments in this layer's space, x0, y0, x1, y1 each, gathered every frame. */
  segments: number[] = [];

  constructor(public ambient = 0x404050) {
    super();
    this.name = "lights";
  }

  addOccluder(o: Occluding): void {
    this.occluders.add(o);
  }

  removeOccluder(o: Occluding): void {
    this.occluders.delete(o);
  }

  override ready(): void {
    // Occluders added before this layer existed register now: polygons, and tile maps that opt in.
    const world = this.scene?.world;
    if (!world) return;
    for (const n of world.findAll(Node2D)) {
      const o = n as Partial<Occluding> & { occlude?: boolean };
      if (typeof o.appendOccluders === "function" && o.occlude !== false) this.addOccluder(o as Occluding);
    }
  }

  /** The bounds all shadowed lights cover, in this layer's space; null when none cast. */
  shadowBounds(): { x: number; y: number; w: number; h: number } | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const l of this.findAll(Light2D)) {
      if (!l.shadows || !l.visible) continue;
      const [lx, ly] = l.positionIn(this);
      x0 = Math.min(x0, lx - l.radius);
      y0 = Math.min(y0, ly - l.radius);
      x1 = Math.max(x1, lx + l.radius);
      y1 = Math.max(y1, ly + l.radius);
    }
    return x0 < x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  private gather(): void {
    this.segments.length = 0;
    if (this.occluders.size === 0) return;
    const bounds = this.shadowBounds();
    if (!bounds) return;
    for (const o of this.occluders) o.appendOccluders(this, this.segments, bounds);
  }

  override drawTree(ctx: DrawContext): void {
    if (!this.visible || !ctx.renderer.features.lighting) return;
    this.gather();
    ctx.beginPass("light", this.ambient);
    super.drawTree(ctx);
    ctx.beginPass("world");
  }
}

export class Light2D extends Node2D {
  radius: number;
  color: number;
  intensity: number;
  flicker: number;
  cone: { angle: number; width: number } | null;
  falloff: number;
  height: number;
  shadows: boolean;
  shadowStrength: number;
  target: { x: number; y: number } | null = null;
  private t = 0;
  private seed = Math.random() * 100;

  constructor(opts: LightOptions = {}, x = 0, y = 0) {
    super(x, y);
    this.radius = opts.radius ?? 96;
    this.color = opts.color ?? 0xffffff;
    this.intensity = opts.intensity ?? 1;
    this.flicker = opts.flicker ?? 0;
    this.cone = opts.cone ?? null;
    this.falloff = opts.falloff ?? 1;
    this.height = opts.height ?? 0.6;
    this.shadows = opts.shadows ?? false;
    this.shadowStrength = opts.shadowStrength ?? 1;
  }

  /** Follow a world-space position each step. */
  follow(target: { x: number; y: number } | null): this {
    this.target = target;
    if (target) {
      this.x = target.x;
      this.y = target.y;
    }
    return this;
  }

  override update(dt: number): void {
    this.t += dt;
    if (this.target) {
      this.x = this.target.x;
      this.y = this.target.y;
    }
  }

  /** The layer this light draws into, if it sits under one. */
  get layer(): LightLayer | null {
    let n = this.parent;
    while (n) {
      if (n instanceof LightLayer) return n;
      n = n.parent;
    }
    return null;
  }

  /**
   * Shadow quads in this light's local space: each occluder segment near the light, extruded
   * away from it. Drawn with erase into the scratch target, they cut the light's shape.
   */
  shadowQuads(layer: LightLayer): number[][] {
    const [lx, ly] = this.positionIn(layer);
    const r = this.radius;
    const far = r * 3;
    const s = layer.segments;
    const out: number[][] = [];
    for (let i = 0; i + 3 < s.length; i += 4) {
      const ax = s[i] - lx;
      const ay = s[i + 1] - ly;
      const bx = s[i + 2] - lx;
      const by = s[i + 3] - ly;
      if (distanceToSegment(ax, ay, bx, by) > r) continue;
      const la = Math.hypot(ax, ay) || 1;
      const lb = Math.hypot(bx, by) || 1;
      out.push([ax, ay, bx, by, bx + (bx / lb) * far, by + (by / lb) * far, ax + (ax / la) * far, ay + (ay / la) * far]);
    }
    return out;
  }

  override render(ctx: DrawContext): void {
    let k = this.intensity;
    if (this.flicker > 0) k *= 1 + (Math.sin(this.t * 23 + this.seed) * 0.5 + Math.sin(this.t * 7.3 + this.seed * 2) * 0.5) * this.flicker * 0.5;
    if (this.cone) {
      const scale = (this.radius * 2) / 64;
      ctx.sprite("__cone", 0, 0, { sx: scale, sy: scale * Math.min(2, this.cone.width / (Math.PI / 4)), rot: this.cone.angle, tint: this.color, alpha: k, additive: true });
      return;
    }
    // (1 - d) to the power falloff + 1: the soft disc the painted blob had, by default.
    const light = { color: this.color, intensity: k, falloff: this.falloff + 1, height: this.height };
    const layer = this.shadows ? this.layer : null;
    const quads = layer && ctx.renderer.features.shadows ? this.shadowQuads(layer) : [];
    if (quads.length === 0) {
      ctx.light(0, 0, this.radius, light);
      return;
    }
    // Shadows are hard cuts in the scratch target, so overlapping wedges do not compound; the
    // shadow strength is the share of the light that goes through them. The rest is drawn plain.
    const strength = Math.max(0, Math.min(1, this.shadowStrength));
    if (strength < 1) ctx.light(0, 0, this.radius, { ...light, intensity: k * (1 - strength) });
    ctx.beginPass("scratch");
    ctx.light(0, 0, this.radius, { ...light, intensity: k * strength });
    for (const q of quads) ctx.quad(q, 0x000000, 1, true);
    ctx.beginPass("light", layer?.ambient ?? 0);
    ctx.blitScratch();
  }
}

/** Distance from the origin to the segment (ax, ay)-(bx, by). */
function distanceToSegment(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/**
 * A polygon that blocks shadowed lights. Points are in local space and the polygon is closed;
 * `LightOccluder2D.rect(w, h)` makes a centred box. Registers with the layer it finds in the scene.
 */
export class LightOccluder2D extends Node2D implements Occluding {
  points: number[];
  closed = true;
  private layerRef: LightLayer | null = null;

  constructor(points: number[] | { w: number; h: number }, x = 0, y = 0) {
    super(x, y);
    this.points = Array.isArray(points) ? points : LightOccluder2D.rect(points.w, points.h);
    this.name = "occluder";
  }

  static rect(w: number, h: number): number[] {
    return [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2];
  }

  override ready(): void {
    const layer = this.scene?.world.findAll(LightLayer)[0] ?? null;
    this.layerRef = layer;
    layer?.addOccluder(this);
  }

  override exit(): void {
    this.layerRef?.removeOccluder(this);
    this.layerRef = null;
  }

  appendOccluders(layer: LightLayer, out: number[]): void {
    if (!this.visible) return;
    const p = this.points;
    const n = p.length / 2;
    if (n < 2) return;
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = pointIn(this, layer, p[i * 2], p[i * 2 + 1]);
      pts.push(x, y);
    }
    const edges = this.closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const j = (i + 1) % n;
      out.push(pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1]);
    }
  }
}

export { TAU };
