// Skinned meshes: one sprite cut into a grid of triangles, each vertex weighted to the bones
// nearest it, deformed by those bones each frame. This is Godot's Polygon2D with a Skeleton2D
// and Unity's sprite skinning, without the editor: bones are line segments a game places over
// the sprite (or takes from a Rig2D), weights come from distance, and the mesh follows.

import type { Rect } from "../core/math.ts";
import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";
import type { Rig2D } from "./rig.ts";

export interface SkinBone {
  name: string;
  /** Rest segment in the sprite's local space (origin at the sprite's anchor). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SkinOptions {
  /** Sprite to cut up. */
  sprite: string;
  bones: SkinBone[];
  /** Grid subdivision; more cells bend more smoothly. */
  cols?: number;
  rows?: number;
  /** How many bones a vertex follows; 2 by default. */
  influences?: number;
  /** Falloff of distance weights; higher makes joints sharper. */
  falloff?: number;
  tint?: number;
  alpha?: number;
  smooth?: boolean;
}

interface Vertex {
  /** Rest position in local space. */
  x: number;
  y: number;
  u: number;
  v: number;
  bones: number[];
  weights: number[];
}

/** A bone's current transform: where its start moved to and how it turned, relative to rest. */
interface BonePose {
  dx: number;
  dy: number;
  rot: number;
  scale: number;
}

/**
 * Pose bones with `setBone(name, { rot, dx, dy })` in the sprite's local space, or `follow(rig)` to
 * copy the rotations and offsets of a Rig2D's bones of the same names each frame. Rest is the
 * sprite as drawn.
 */
export class Skin2D extends Node2D {
  readonly spriteName: string;
  readonly bones: SkinBone[];
  tint: number;
  smooth: boolean;
  private readonly cols: number;
  private readonly rows: number;
  private readonly influences: number;
  private readonly falloff: number;
  private vertices: Vertex[] = [];
  private indices: number[] = [];
  private region: Rect & { u0: number; v0: number; u1: number; v1: number; ox: number; oy: number } | null = null;
  private readonly poses = new Map<string, BonePose>();
  private buffer = new Float32Array(0);
  private rig: Rig2D | null = null;
  private rigRest = new Map<string, { rot: number; x: number; y: number }>();

  constructor(opts: SkinOptions, x = 0, y = 0) {
    super(x, y);
    this.spriteName = opts.sprite;
    this.bones = opts.bones;
    this.cols = Math.max(1, opts.cols ?? 4);
    this.rows = Math.max(1, opts.rows ?? 6);
    this.influences = Math.max(1, Math.min(4, opts.influences ?? 2));
    this.falloff = opts.falloff ?? 2;
    this.tint = opts.tint ?? 0xffffff;
    this.alpha = opts.alpha ?? 1;
    this.smooth = opts.smooth ?? false;
    this.name = "skin";
  }

  override ready(): void {
    const app = this.scene?.attachedApp;
    if (!app) return;
    const r = app.atlas.region(this.spriteName);
    this.region = r;
    this.build();
  }

  /** Cut the sprite into a grid and weight every vertex to its nearest bones. */
  private build(): void {
    const r = this.region;
    if (!r) return;
    const cols = this.cols;
    const rows = this.rows;
    this.vertices = [];
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const fx = i / cols;
        const fy = j / rows;
        const x = fx * r.w - r.ox;
        const y = fy * r.h - r.oy;
        const { bones, weights } = this.weightsAt(x, y);
        this.vertices.push({ x, y, u: r.u0 + (r.u1 - r.u0) * fx, v: r.v0 + (r.v1 - r.v0) * fy, bones, weights });
      }
    }
    this.indices = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        this.indices.push(a, b, c, b, d, c);
      }
    }
    this.buffer = new Float32Array(this.indices.length * 4);
  }

  /** Bones by inverse distance to their rest segments. */
  weightsAt(x: number, y: number): { bones: number[]; weights: number[] } {
    const scored = this.bones.map((b, i) => ({ i, d: distToSegment(x, y, b.x0, b.y0, b.x1, b.y1) }));
    scored.sort((p, q) => p.d - q.d);
    const picked = scored.slice(0, this.influences);
    const raw = picked.map((p) => 1 / (p.d + 1) ** this.falloff);
    const sum = raw.reduce((s, v) => s + v, 0) || 1;
    return { bones: picked.map((p) => p.i), weights: raw.map((v) => v / sum) };
  }

  /** Pose one bone relative to rest: turn about its start, and move its start. */
  setBone(name: string, pose: { rot?: number; dx?: number; dy?: number; scale?: number }): void {
    const cur = this.poses.get(name) ?? { dx: 0, dy: 0, rot: 0, scale: 1 };
    this.poses.set(name, { dx: pose.dx ?? cur.dx, dy: pose.dy ?? cur.dy, rot: pose.rot ?? cur.rot, scale: pose.scale ?? cur.scale });
  }

  /** Copy a rig's bone rotations and pivot offsets (relative to the rig's rest) each frame. */
  follow(rig: Rig2D | null): void {
    this.rig = rig;
    this.rigRest.clear();
    if (!rig) return;
    for (const [name, node] of rig.bones) this.rigRest.set(name, { rot: node.rotation, x: node.x, y: node.y });
  }

  override update(): void {
    if (!this.rig) return;
    for (const b of this.bones) {
      const node = this.rig.bones.get(b.name);
      const rest = this.rigRest.get(b.name);
      if (!node || !rest) continue;
      this.setBone(b.name, { rot: node.rotation - rest.rot, dx: node.x - rest.x, dy: node.y - rest.y });
    }
  }

  /** The deformed position of a rest point, for tests and attachments. */
  deform(x: number, y: number, bones?: number[], weights?: number[]): [number, number] {
    const w = bones && weights ? { bones, weights } : this.weightsAt(x, y);
    let ox = 0;
    let oy = 0;
    for (let k = 0; k < w.bones.length; k++) {
      const b = this.bones[w.bones[k]];
      const p = this.poses.get(b.name);
      let px = x;
      let py = y;
      if (p) {
        const c = Math.cos(p.rot);
        const s = Math.sin(p.rot);
        const rx = (x - b.x0) * p.scale;
        const ry = (y - b.y0) * p.scale;
        px = b.x0 + p.dx + rx * c - ry * s;
        py = b.y0 + p.dy + rx * s + ry * c;
      }
      ox += px * w.weights[k];
      oy += py * w.weights[k];
    }
    return [ox, oy];
  }

  override render(ctx: DrawContext): void {
    if (!this.region || this.vertices.length === 0) return;
    const buf = this.buffer;
    let o = 0;
    for (const idx of this.indices) {
      const v = this.vertices[idx];
      const [x, y] = this.deform(v.x, v.y, v.bones, v.weights);
      buf[o++] = x;
      buf[o++] = y;
      buf[o++] = v.u;
      buf[o++] = v.v;
    }
    ctx.mesh(buf, this.indices.length, { tint: this.tint, alpha: this.alpha, smooth: this.smooth });
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
