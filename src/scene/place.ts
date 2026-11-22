// Helpers for nodes that draw many separate things at their own world points: beams, trails,
// light flashes, decals. In a projected layer each item gets its own depth key, so it sorts
// with the walls and actors around it rather than with the node. Item positions are ground
// offsets from the node's position; the node's own rotation and scale are not applied.

import type { Region } from "../art/atlas.ts";
import type { Mat } from "../render/types.ts";
import type { DrawContext } from "./draw.ts";
import type { Node2D } from "./node.ts";

const M: Mat = [1, 0, 0, 1, 0, 0];

/**
 * Point the context at ground offset (x, y, z) from `node`. Local drawing units become the
 * projection's screen units before zoom, through `linear` when given (a 2x2 basis, column
 * major, in those units). `bias` is the node's depth bias as of its render.
 */
export function placeAt(ctx: DrawContext, node: Node2D, bias: number, x: number, y: number, z: number, extraBias = 0, linear?: readonly [number, number, number, number]): void {
  if (ctx.projection) {
    const g = node.ground;
    M[0] = linear ? linear[0] : 1;
    M[1] = linear ? linear[1] : 0;
    M[2] = linear ? linear[2] : 0;
    M[3] = linear ? linear[3] : 1;
    M[4] = g[4] + x;
    M[5] = g[5] + y;
    ctx.setTransform3(M, node.worldZ + z, node.worldAlpha, bias + extraBias);
    return;
  }
  // Flat layers: compose with the node's screen transform; heights are not drawn.
  const w = node.world;
  const a = linear ? linear[0] : 1;
  const b = linear ? linear[1] : 0;
  const c = linear ? linear[2] : 0;
  const d = linear ? linear[3] : 1;
  M[0] = w[0] * a + w[2] * b;
  M[1] = w[1] * a + w[3] * b;
  M[2] = w[0] * c + w[2] * d;
  M[3] = w[1] * c + w[3] * d;
  M[4] = w[0] * x + w[2] * y + w[4];
  M[5] = w[1] * x + w[3] * y + w[5];
  ctx.setTransform(M, node.worldAlpha);
}

/** Put the node's own transform back after placing items, so its children draw where they should. */
export function restorePlace(ctx: DrawContext, node: Node2D, bias: number): void {
  if (ctx.projection) ctx.setTransform3(node.ground, node.worldZ, node.worldAlpha, bias);
  else ctx.setTransform(node.world, node.worldAlpha);
}

/** A ground direction in the units `placeAt` draws in: the projection's linear part, or as is when flat. */
export function projectDir(ctx: DrawContext, dx: number, dy: number, dz: number): [number, number] {
  const pr = ctx.projection;
  if (!pr) return [dx, dy];
  const p = pr.p;
  return [p[0] * dx + p[1] * dy + p[2] * dz, p[4] * dx + p[5] * dy + p[6] * dz];
}

/** The projection's depth key of a ground point, or 0 in a flat layer. */
export function depthOf(ctx: DrawContext, x: number, y: number, z: number): number {
  const pr = ctx.projection;
  if (!pr) return 0;
  const p = pr.p;
  return p[8] * x + p[9] * y + p[10] * z + p[11];
}

const strips = new WeakMap<object, { soft: Region; solid: Region }>();

/**
 * One-pixel-wide strips cut from the engine's built-in sprites, constant along x: `soft` is the
 * centre column of `__blob` (a smooth falloff across, 64 units tall, origin at its middle) and
 * `solid` a column of `__white`. Stretched along x they draw beams and ribbons with no seams.
 */
export function stripRegions(ctx: DrawContext): { soft: Region; solid: Region } {
  const atlas = ctx.atlas as object;
  let s = strips.get(atlas);
  if (s) return s;
  const blob = ctx.atlas.region("__blob");
  const white = ctx.atlas.region("__white");
  const bu = (blob.u0 + blob.u1) / 2;
  const wu = (white.u0 + white.u1) / 2;
  const wv = (white.v0 + white.v1) / 2;
  s = {
    soft: { ...blob, name: "__strip.soft", w: 1, ox: 0.5, oy: blob.h / 2, u0: bu, u1: bu },
    solid: { ...white, name: "__strip.solid", w: 1, h: 64, ox: 0.5, oy: 32, u0: wu, u1: wu, v0: wv, v1: wv },
  };
  strips.set(atlas, s);
  return s;
}

/** Linear mix of two 0xRRGGBB colours. */
export function mixColor(a: number, b: number, t: number): number {
  if (a === b || t <= 0) return a;
  if (t >= 1) return b;
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
