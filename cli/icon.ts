// The app icon every export shares: a sprite from the atlas, scaled with whole pixels over
// the game's background colour. `ios.icon` names the sprite; otherwise the hero, else the
// largest sprite.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./project.ts";

export function hexRgb(hex: string | number | undefined, fallback: [number, number, number]): [number, number, number] {
  if (typeof hex === "number") return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  if (typeof hex !== "string") return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** RGBA pixels of a square icon of `size`, read from a native build's atlas files. */
export async function renderIcon(project: Project, nativeDir: string, size: number): Promise<{ rgba: Uint8Array; sprite: string | null }> {
  const ios = project.config.ios ?? {};
  const bg = hexRgb(project.config.background as string | number | undefined, [16, 16, 24]);
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  const manifestFile = join(nativeDir, "atlas.json");
  if (!existsSync(manifestFile)) return { rgba, sprite: null };
  const manifest = JSON.parse(await Bun.file(manifestFile).text()) as { width: number; height: number; sprites: Record<string, { x: number; y: number; w: number; h: number }> };
  const data = new Uint8Array(await Bun.file(join(nativeDir, "atlas.bin")).arrayBuffer());
  const names = Object.keys(manifest.sprites).filter((n) => !n.startsWith("__"));
  const largest = [...names].sort((a, b) => manifest.sprites[b].w * manifest.sprites[b].h - manifest.sprites[a].w * manifest.sprites[a].h)[0];
  const pick = ios.icon ?? ["icon", "hero", "hero.idle", "hero.idle.0", "player"].find((n) => manifest.sprites[n]) ?? largest;
  const r = pick ? manifest.sprites[pick] : undefined;
  if (!r) return { rgba, sprite: null };
  const scale = Math.max(1, Math.floor((size * 0.72) / Math.max(r.w, r.h)));
  const dw = r.w * scale;
  const dh = r.h * scale;
  const ox = Math.floor((size - dw) / 2);
  const oy = Math.floor((size - dh) / 2);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const si = ((r.y + Math.floor(y / scale)) * manifest.width + r.x + Math.floor(x / scale)) * 4;
      const a = data[si + 3] / 255;
      if (a <= 0) continue;
      const di = ((oy + y) * size + ox + x) * 4;
      rgba[di] = Math.round(data[si] * a + rgba[di] * (1 - a));
      rgba[di + 1] = Math.round(data[si + 1] * a + rgba[di + 1] * (1 - a));
      rgba[di + 2] = Math.round(data[si + 2] * a + rgba[di + 2] * (1 - a));
    }
  }
  return { rgba, sprite: pick };
}

/** Project name as an identifier: "Wisp Hollow" becomes "WispHollow". */
export function pascal(name: string): string {
  return name
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}
