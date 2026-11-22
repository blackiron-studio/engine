// EffectAtlas3D: the textures effect sprites draw with, packed into one image so every sprite can
// share one material and the renderer draws them in a single batch (each mesh picks its cell with
// `Mesh3D.uvRect`). Cells are painted in code: white, with the shape in alpha and a little shading
// in the grey, so sprites take their colour from the tint. The standard set covers glows, smoke,
// fire, muzzle stars and flames, shock rings, scorch marks and streaks; games can add their own.

import { fbm, smoothstep } from "../art/noise.ts";
import { Material3D } from "./material.ts";
import type { Mesh3D } from "./scene.ts";
import { Texture3D } from "./texture.ts";

/** Paints one cell: u, v in [0, 1] from the top left; returns luminance and alpha in [0, 1]. */
export type EffectPainter3D = (u: number, v: number) => readonly [luminance: number, alpha: number];

export interface EffectCell3D {
  /** Size in pixels. */
  width: number;
  height: number;
  paint: EffectPainter3D;
}

/** Transparent pixels kept around every cell, so filtering and mipmaps never bleed between cells. */
const PAD = 4;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const radial = (u: number, v: number) => Math.hypot(u - 0.5, v - 0.5) * 2;

/** A billowing puff, lit a little from above. */
function smoke(seed: number): EffectCell3D {
  return {
    width: 128,
    height: 128,
    paint: (u, v) => {
      const r = radial(u, v);
      if (r >= 1) return [0.7, 0];
      const n = fbm(u * 3, v * 3, { seed, octaves: 4, period: 3 }) * 1.4,
        fine = fbm(u * 7, v * 7, { seed: seed + 5, octaves: 3, period: 7 }) * 0.7 + 0.5;
      const body = 1 - smoothstep(0.15, 0.95, r * (1 + 0.45 * n));
      return [0.58 + 0.3 * (1 - v) + 0.12 * fine, body * (0.45 + 0.55 * fine) * (1 - smoothstep(0.85, 1, r))];
    },
  };
}

/** A ragged fire blob, brighter where it is thick. */
function fire(seed: number): EffectCell3D {
  return {
    width: 128,
    height: 128,
    paint: (u, v) => {
      const r = radial(u, v);
      if (r >= 1) return [1, 0];
      const n = fbm(u * 3.5, v * 3.5, { seed, octaves: 4, period: 3 }) * 1.4,
        fine = fbm(u * 8, v * 8, { seed: seed + 9, octaves: 3, period: 8 }) * 0.7 + 0.5;
      const body = 1 - smoothstep(0.05, 0.9, r * (1 + 0.6 * n));
      return [0.72 + 0.28 * fine, body * (0.65 + 0.35 * fine) * (1 - smoothstep(0.85, 1, r))];
    },
  };
}

/** A muzzle-flash star: a hot core and tapering rays of uneven length. */
function star(seed: number, count: number): EffectCell3D {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const rays = Array.from({ length: count }, (_, i) => ({
    a: (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.8,
    len: 0.5 + rnd() * 0.5,
    w: 0.06 + rnd() * 0.06,
  }));
  return {
    width: 128,
    height: 128,
    paint: (u, v) => {
      const x = (u - 0.5) * 2,
        y = (v - 0.5) * 2,
        r = Math.hypot(x, y);
      if (r >= 1) return [1, 0];
      let a = Math.exp(-r * r * 14);
      for (const ray of rays) {
        const along = x * Math.cos(ray.a) + y * Math.sin(ray.a),
          across = Math.abs(-x * Math.sin(ray.a) + y * Math.cos(ray.a));
        if (along <= 0 || along >= ray.len) continue;
        const k = 1 - along / ray.len;
        a += Math.exp(-((across / (ray.w * k + 0.004)) ** 2)) * k ** 0.6;
      }
      return [1, Math.min(1, a) * (1 - smoothstep(0.9, 1, r))];
    },
  };
}

/**
 * The standard cells. Names with several entries are variants (`smoke` has three); sprites that
 * name them get one at random.
 *
 * - `glow`: a soft round glow. `dot`: a small hard-cored dot (sparks, embers).
 * - `smoke` ×3, `fire` ×2: billowing puffs.
 * - `star` ×2: muzzle-flash stars with uneven rays.
 * - `flame`: a flame tongue from the side, v = 0 at its base and 1 at its tip.
 * - `ring`: a shock ring. `scorch`: a burn mark with ragged rays.
 * - `streak`: a tapered line across u, v = 0 at its bright head and 1 at its tail (tracers, sparks).
 */
export function standardEffectCells(): Record<string, EffectCell3D | EffectCell3D[]> {
  return {
    glow: {
      width: 64,
      height: 64,
      paint: (u, v) => {
        const r = radial(u, v);
        return [1, r >= 1 ? 0 : Math.exp(-r * r * 4.5) * (1 - r * r)];
      },
    },
    dot: {
      width: 32,
      height: 32,
      paint: (u, v) => {
        const r = radial(u, v);
        return [1, r >= 1 ? 0 : Math.exp(-r * r * 9) * (1 - r)];
      },
    },
    smoke: [smoke(3), smoke(17), smoke(29)],
    fire: [fire(5), fire(41)],
    star: [star(7, 6), star(13, 5)],
    flame: {
      width: 64,
      height: 128,
      paint: (u, v) => {
        const n = fbm(u * 2, v * 5, { seed: 61, octaves: 3 }) * 1.4;
        const w = 0.42 * Math.sin(Math.PI * (0.05 + v * 0.92)) ** 0.6 * (1 - 0.45 * v) * (1 + 0.35 * n);
        const d = Math.abs(u - 0.5) / Math.max(0.01, w);
        return [
          1,
          (1 - smoothstep(0.25, 1, d)) * smoothstep(0, 0.05, v) * (1 - smoothstep(0.55, 1, v + 0.15 * n)) * (1 - smoothstep(0.9, 1, v)),
        ];
      },
    },
    ring: {
      width: 128,
      height: 128,
      paint: (u, v) => {
        const r = radial(u, v);
        return [
          1,
          (Math.exp(-(((r - 0.8) / 0.07) ** 2)) + 0.14 * smoothstep(0.3, 0.8, r) * (1 - smoothstep(0.79, 0.82, r))) * (1 - smoothstep(0.92, 1, r)),
        ];
      },
    },
    scorch: {
      width: 128,
      height: 128,
      paint: (u, v) => {
        const r = radial(u, v);
        if (r >= 1) return [1, 0];
        const n = fbm(u * 4, v * 4, { seed: 91, octaves: 5, period: 4 }) * 1.4;
        const core = 1 - smoothstep(0.1, 0.85, r * (1 + 0.35 * n));
        const th = Math.atan2(v - 0.5, u - 0.5);
        const rays = (0.5 + 0.5 * Math.sin(th * 11 + n * 4)) ** 5 * (1 - smoothstep(0.25, 0.95, r));
        return [1, clamp01(core * 0.95 + rays * 0.5) * (1 - smoothstep(0.8, 1, r))];
      },
    },
    streak: {
      width: 16,
      height: 64,
      paint: (u, v) => [1, Math.exp(-(((u - 0.5) / 0.2) ** 2)) * smoothstep(0, 0.1, v) * (1 - v) ** 1.3],
    },
  };
}

type Rect = readonly [u: number, v: number, width: number, height: number];
let standard: EffectAtlas3D | null = null;

export class EffectAtlas3D {
  readonly texture: Texture3D;
  /**
   * The shared material for sprites on this atlas: unlit, blended, two-sided and outside tone
   * mapping (their colour and glow are authored). Sprites keep their own tint, opacity and glow.
   */
  readonly material: Material3D;
  private readonly cells = new Map<string, Rect[]>();

  /** Paints and packs `cells` into one `size` × `size` image; throws if they do not fit. */
  constructor(cells: Readonly<Record<string, EffectCell3D | readonly EffectCell3D[]>>, readonly size = 512) {
    if (!Number.isInteger(size) || size < 16 || size > 4096) throw new RangeError("Effect atlas size must be an integer from 16 to 4096");
    const items: { name: string; cell: EffectCell3D }[] = [];
    for (const [name, value] of Object.entries(cells)) {
      const list = Array.isArray(value) ? (value as readonly EffectCell3D[]) : [value as EffectCell3D];
      if (!name || !list.length) throw new RangeError("Effect cells need a name and at least one image");
      for (const cell of list) {
        if (!Number.isInteger(cell.width) || !Number.isInteger(cell.height) || cell.width < 1 || cell.height < 1 || typeof cell.paint !== "function")
          throw new RangeError(`Effect cell "${name}" needs a whole-pixel size and a painter`);
        items.push({ name, cell });
      }
      this.cells.set(name, []);
    }
    // Shelf packing, tallest first; each name keeps its variants in the order given.
    const order = items.map((item, index) => ({ ...item, index })).sort((a, b) => b.cell.height - a.cell.height || a.index - b.index);
    const placed = new Map<number, Rect>();
    const data = new Uint8Array(size * size * 4);
    // Transparent white, so filtering at a cell's edge never pulls in a dark fringe.
    for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 255;
    let x = PAD,
      y = PAD,
      row = 0;
    for (const { cell, index } of order) {
      if (x + cell.width + PAD > size) {
        x = PAD;
        y += row + PAD;
        row = 0;
      }
      if (x + cell.width + PAD > size || y + cell.height + PAD > size) throw new RangeError(`Effect cells do not fit a ${size} × ${size} atlas`);
      for (let py = 0; py < cell.height; py++)
        for (let px = 0; px < cell.width; px++) {
          const [l, a] = cell.paint((px + 0.5) / cell.width, (py + 0.5) / cell.height),
            i = ((y + py) * size + x + px) * 4,
            c = Math.round(clamp01(l) * 255);
          data[i] = data[i + 1] = data[i + 2] = c;
          data[i + 3] = Math.round(clamp01(a) * 255);
        }
      placed.set(index, [x / size, y / size, cell.width / size, cell.height / size]);
      x += cell.width + PAD;
      row = Math.max(row, cell.height);
    }
    items.forEach((item, index) => this.cells.get(item.name)!.push(placed.get(index)!));
    this.texture = new Texture3D(size, size, data, "linear", "clamp", "clamp", "linear-mipmap-linear");
    this.material = new Material3D({ map: this.texture, shading: "unlit", toneMapped: false, alphaMode: "BLEND", doubleSided: true });
  }

  /** The standard cells, painted once per process and shared (never disposed). */
  static standard(): EffectAtlas3D {
    return (standard ??= new EffectAtlas3D(standardEffectCells()));
  }

  has(name: string): boolean {
    return this.cells.has(name);
  }
  /** How many variants `name` has (0 if unknown). */
  variants(name: string): number {
    return this.cells.get(name)?.length ?? 0;
  }
  names(): string[] {
    return [...this.cells.keys()];
  }
  /** The cell's texture window `[u, v, width, height]`; the variant wraps around. */
  rect(name: string, variant = 0): Rect {
    const list = this.cells.get(name);
    if (!list) throw new RangeError(`Unknown effect cell "${name}"`);
    const i = Math.floor(variant);
    return list[((i % list.length) + list.length) % list.length];
  }
  /** Point `mesh` at a cell: copies its window into `mesh.uvRect`. */
  apply(mesh: Mesh3D, name: string, variant = 0): Mesh3D {
    const r = this.rect(name, variant);
    mesh.uvRect[0] = r[0];
    mesh.uvRect[1] = r[1];
    mesh.uvRect[2] = r[2];
    mesh.uvRect[3] = r[3];
    return mesh;
  }
}
