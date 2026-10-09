// Writes the per-frame command stream a kernel executes. Renderers own one of these and
// turn sprite, rect, glyph, batch and particle calls into stream words.

import type { Mat, SpriteDraw, SpriteMaterial } from "../render/types.ts";
import { BLEND, type Kernel, MATERIAL, OP, type ProjectionMatrix, SLOT, drawFlags } from "./protocol.ts";

const MATERIAL_CODE: Record<SpriteMaterial["kind"], number> = { none: MATERIAL.NONE, flash: MATERIAL.FLASH, dissolve: MATERIAL.DISSOLVE, outline: MATERIAL.OUTLINE, silhouette: MATERIAL.SILHOUETTE };

/** The flags word for a sprite draw. */
export function spriteFlags(d: { additive?: boolean; erase?: boolean; smooth?: boolean; material?: SpriteMaterial | null }): number {
  const blend = d.erase ? BLEND.ERASE : d.additive ? BLEND.ADDITIVE : BLEND.NORMAL;
  return drawFlags(blend, d.smooth ? SLOT.LINEAR : SLOT.NEAREST, d.material ? MATERIAL_CODE[d.material.kind] : 0);
}

const plainFlags = (additive: boolean, smooth: boolean): number => drawFlags(additive ? BLEND.ADDITIVE : BLEND.NORMAL, smooth ? SLOT.LINEAR : SLOT.NEAREST, 0);

export class StreamWriter {
  /** Words written this frame. */
  length = 0;
  private warned = false;

  constructor(readonly kernel: Kernel) {}

  private room(words: number): Float32Array | null {
    const s = this.kernel.stream;
    if (this.length + words > s.length) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`[blackiron] kernel stream full (${s.length} words); raise kernel.streamWords in blackiron.json`);
      }
      return null;
    }
    return s;
  }

  begin(clear: number, viewW: number, viewH: number): void {
    this.length = 0;
    const s = this.room(4);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.BEGIN;
    s[i++] = clear & 0xffffff;
    s[i++] = viewW;
    s[i++] = viewH;
    this.length = i;
  }

  pass(id: number, clear: number): void {
    const s = this.room(3);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.PASS;
    s[i++] = id;
    s[i++] = clear & 0xffffff;
    this.length = i;
  }

  transform(m: Readonly<Mat>): void {
    const s = this.room(7);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.TRANSFORM;
    s[i++] = m[0];
    s[i++] = m[1];
    s[i++] = m[2];
    s[i++] = m[3];
    s[i++] = m[4];
    s[i++] = m[5];
    this.length = i;
  }

  sprite(d: SpriteDraw): void {
    const s = this.room(19);
    if (!s) return;
    const r = d.region;
    let i = this.length;
    s[i++] = OP.SPRITE;
    s[i++] = d.x;
    s[i++] = d.y;
    s[i++] = d.sx ?? 1;
    s[i++] = d.sy ?? 1;
    s[i++] = d.rot ?? 0;
    s[i++] = d.ox ?? r.ox;
    s[i++] = d.oy ?? r.oy;
    s[i++] = r.w;
    s[i++] = r.h;
    s[i++] = r.u0;
    s[i++] = r.v0;
    s[i++] = r.u1;
    s[i++] = r.v1;
    s[i++] = d.tint ?? 0xffffff;
    s[i++] = d.alpha ?? 1;
    s[i++] = spriteFlags(d);
    s[i++] = d.material?.p0 ?? 0;
    s[i++] = d.material?.p1 ?? 0;
    this.length = i;
  }

  /** A filled rect; `flags` is a boolean for additive or a full draw flags word. */
  rect(x: number, y: number, w: number, h: number, color: number, alpha: number, flags: boolean | number): void {
    const s = this.room(8);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.RECT;
    s[i++] = x;
    s[i++] = y;
    s[i++] = w;
    s[i++] = h;
    s[i++] = color & 0xffffff;
    s[i++] = alpha;
    s[i++] = typeof flags === "number" ? flags : flags ? BLEND.ADDITIVE : 0;
    this.length = i;
  }

  /** A procedural point light: colour and intensity, falloff exponent, height in radius units for normal maps. */
  light(x: number, y: number, radius: number, color: number, intensity: number, falloff: number, height: number): void {
    const s = this.room(9);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.LIGHT;
    s[i++] = x;
    s[i++] = y;
    s[i++] = radius;
    s[i++] = color & 0xffffff;
    s[i++] = intensity;
    s[i++] = falloff;
    s[i++] = height;
    s[i++] = BLEND.ADDITIVE;
    this.length = i;
  }

  /** Four points (x0, y0 … x3, y3) filled with one colour; `erase` multiplies the target by 1 - alpha instead. */
  quad(p: ArrayLike<number>, color: number, alpha: number, erase = false, additive = false): void {
    const s = this.room(12);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.QUAD;
    for (let k = 0; k < 8; k++) s[i++] = p[k];
    s[i++] = color & 0xffffff;
    s[i++] = alpha;
    s[i++] = drawFlags(erase ? BLEND.ERASE : additive ? BLEND.ADDITIVE : BLEND.NORMAL);
    this.length = i;
  }

  /** Textured triangles: `count` vertices of (x, y, u, v) from `verts`, in the current space. */
  mesh(verts: ArrayLike<number>, count: number, tint: number, alpha: number, additive = false, smooth = false): void {
    const n = count - (count % 3);
    const s = this.room(5 + n * 4);
    if (!s || n < 3) return;
    let i = this.length;
    s[i++] = OP.MESH;
    s[i++] = n;
    s[i++] = tint & 0xffffff;
    s[i++] = alpha;
    s[i++] = plainFlags(additive, smooth);
    for (let k = 0; k < n * 4; k++) s[i++] = verts[k];
    this.length = i;
  }

  /** Copy the light scratch target onto the current target, additively, over the whole view. */
  blitScratch(viewW: number, viewH: number): void {
    this.transform([1, 0, 0, 1, 0, 0]);
    this.rect(0, 0, viewW, viewH, 0xffffff, 1, drawFlags(BLEND.ADDITIVE, SLOT.SCRATCH));
  }

  glyph(x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number, color: number, alpha: number, additive: boolean, page = 0): void {
    const s = this.room(12);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.GLYPH;
    s[i++] = x;
    s[i++] = y;
    s[i++] = w;
    s[i++] = h;
    s[i++] = u0;
    s[i++] = v0;
    s[i++] = u1;
    s[i++] = v1;
    s[i++] = color & 0xffffff;
    s[i++] = alpha;
    s[i++] = (additive ? BLEND.ADDITIVE : 0) | (page << 9);
    this.length = i;
  }

  /** Draw a retained batch under the current transform; `cull` is in the batch's own space. */
  batch(id: number, alpha: number, tint: number, cull: { x: number; y: number; w: number; h: number } | null, additive: boolean, smooth: boolean): void {
    const s = this.room(9);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.BATCH;
    s[i++] = id;
    s[i++] = alpha;
    s[i++] = tint & 0xffffff;
    s[i++] = cull ? cull.x : 0;
    s[i++] = cull ? cull.y : 0;
    s[i++] = cull ? cull.w : 0;
    s[i++] = cull ? cull.h : 0;
    s[i++] = plainFlags(additive, smooth);
    this.length = i;
  }

  /** Step an emitter by `dt` (spawning at ex, ey in the current space) and draw it. */
  particles(id: number, dt: number, emitting: boolean, ex: number, ey: number, alpha: number, snap: boolean): void {
    const s = this.room(8);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.PARTICLES;
    s[i++] = id;
    s[i++] = dt;
    s[i++] = emitting ? 1 : 0;
    s[i++] = ex;
    s[i++] = ey;
    s[i++] = alpha;
    s[i++] = snap ? 1 : 0;
    this.length = i;
  }

  /** Draw every live node of a table under the current transform. */
  nodes(id: number, alpha: number, tint: number, additive: boolean, smooth: boolean): void {
    const s = this.room(5);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.NODES;
    s[i++] = id;
    s[i++] = alpha;
    s[i++] = tint & 0xffffff;
    s[i++] = plainFlags(additive, smooth);
    this.length = i;
  }

  /** Start a projected layer: ground (x, y, z) maps through `p`, then the camera affine `cam`. */
  projection(p: ProjectionMatrix, cam: Readonly<Mat>, sorted: boolean): void {
    const s = this.room(20);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.PROJECTION;
    for (let k = 0; k < 12; k++) s[i++] = p[k];
    for (let k = 0; k < 6; k++) s[i++] = cam[k];
    s[i++] = sorted ? 1 : 0;
    this.length = i;
  }

  projectionEnd(): void {
    const s = this.room(1);
    if (!s) return;
    s[this.length++] = OP.PROJECTION_END;
  }

  /** A node's transform under the projection: screen-space linear part, ground position. */
  transform3(a: number, b: number, c: number, d: number, gx: number, gy: number, gz: number, depthBias: number, shadow: boolean, shadowAlpha: number): void {
    const s = this.room(11);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.TRANSFORM3;
    s[i++] = a;
    s[i++] = b;
    s[i++] = c;
    s[i++] = d;
    s[i++] = gx;
    s[i++] = gy;
    s[i++] = gz;
    s[i++] = depthBias;
    s[i++] = shadow ? 1 : 0;
    s[i++] = shadowAlpha;
    this.length = i;
  }

  /** Draw a world-space batch under the current node's ground position. */
  batch3(id: number, alpha: number, tint: number, additive: boolean, smooth: boolean): void {
    const s = this.room(5);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.BATCH3;
    s[i++] = id;
    s[i++] = alpha;
    s[i++] = tint & 0xffffff;
    s[i++] = plainFlags(additive, smooth);
    this.length = i;
  }

  /** Clip subsequent draws to a rect in the current space until `clipEnd`. */
  clip(x: number, y: number, w: number, h: number): void {
    const s = this.room(5);
    if (!s) return;
    let i = this.length;
    s[i++] = OP.CLIP;
    s[i++] = x;
    s[i++] = y;
    s[i++] = w;
    s[i++] = h;
    this.length = i;
  }

  clipEnd(): void {
    const s = this.room(1);
    if (!s) return;
    s[this.length++] = OP.CLIP_END;
  }

  end(): void {
    const s = this.room(1);
    if (!s) return;
    s[this.length++] = OP.END;
  }
}
