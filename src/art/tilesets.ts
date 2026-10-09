// Tile sets: a sheet of tiles plus a manifest `kiln art tileset` writes. Frames become
// `${prefix}.${index}`; a set imported with a terrain mode becomes an autotile set, so a
// TileMap entry `{ autotile: prefix }` picks the right tile from each cell's neighbours.

import { BLOB_MASKS } from "../core/tilemap.ts";
import { type ImageItem, type ImageSpriteSpec, registerAssetLoader } from "./images.ts";
import { type AutotileMode, setAutotileMode } from "./sprites.ts";

export interface TileSetManifest {
  frames: { filename?: string; frame: { x: number; y: number; w: number; h: number }; duration?: number }[];
  meta: {
    image: string;
    tiles: {
      size: number;
      cols: number;
      rows: number;
      /** "blob" (47 tiles in `BLOB_MASKS` order), "edges" (16 by edge mask) or none. */
      terrain?: AutotileMode | null;
      /** Source pixels per game pixel the sheet was imported at. */
      pitch?: number;
    };
  };
}

/** How many tiles a terrain mode needs. */
export const terrainTileCount = (mode: AutotileMode): number => (mode === "blob" ? BLOB_MASKS.length : 16);

/**
 * Register a tile set. Tiles are `${prefix}.${index}`; with a terrain the set is also an
 * autotile set of that mode under `prefix`.
 */
export function defineTileSet(prefix: string, jsonUrl: string, spec: ImageSpriteSpec = {}): void {
  registerAssetLoader(async (platform) => {
    const json = await platform.loadJson<TileSetManifest>(jsonUrl);
    const base = jsonUrl.slice(0, jsonUrl.lastIndexOf("/") + 1);
    const imageUrl = json.meta.image.startsWith("http") || json.meta.image.startsWith("/") ? json.meta.image : base + json.meta.image;
    const img = await platform.loadImage(imageUrl);
    const items: ImageItem[] = json.frames.map((f, i) => {
      const data = new Uint8ClampedArray(f.frame.w * f.frame.h * 4);
      for (let row = 0; row < f.frame.h; row++) {
        const src = ((f.frame.y + row) * img.width + f.frame.x) * 4;
        data.set(img.data.subarray(src, src + f.frame.w * 4), row * f.frame.w * 4);
      }
      return { name: `${prefix}.${i}`, w: f.frame.w, h: f.frame.h, data, origin: spec.origin ?? [0, 0], style: spec.style, normal: spec.normal === "bevel" ? "bevel" : undefined, edge: spec.edge };
    });
    const terrain = json.meta.tiles.terrain;
    if (terrain) {
      if (items.length < terrainTileCount(terrain)) console.warn(`[kiln] tile set "${prefix}" has ${items.length} tiles; a ${terrain} terrain needs ${terrainTileCount(terrain)}`);
      setAutotileMode(prefix, terrain);
    }
    return items;
  });
}

/** The eight-bit neighbour mask a terrain tile at `index` stands for. */
export function terrainMaskOf(mode: AutotileMode, index: number): number {
  if (mode === "blob") return BLOB_MASKS[index] ?? 0;
  const m = index & 15;
  return (m & 1 ? 1 : 0) | (m & 2 ? 4 : 0) | (m & 4 ? 16 : 0) | (m & 8 ? 64 : 0);
}
