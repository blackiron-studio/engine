// Native app icons share an opaque compositor. Dedicated PNG files are resized smoothly;
// atlas sprites keep whole-pixel enlargement and can shrink to fit the icon.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePNG } from "./png.ts";
import type { Project } from "./project.ts";

export function hexRgb(hex: string | number | undefined, fallback: [number, number, number]): [number, number, number] {
  if (typeof hex === "number") return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  if (typeof hex !== "string") return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** An opaque square icon from a project PNG or the native build's sprite atlas. */
export async function renderIcon(project: Project, nativeDir: string, size: number): Promise<{ rgba: Uint8Array; sprite: string | null }> {
  if (!Number.isInteger(size) || size < 1) throw Error("Icon size must be a positive integer.");
  const ios = project.config.ios ?? {};
  if (ios.iconFile && ios.icon) throw Error("Choose ios.iconFile or ios.icon, not both.");
  const bg = hexRgb(project.config.background as string | number | undefined, [16, 16, 24]);
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }

  let data: Uint8Array, width: number;
  let r: { x: number; y: number; w: number; h: number };
  let pick: string | null = null;
  if (ios.iconFile) {
    const image = decodePNG(new Uint8Array(await Bun.file(resolve(project.root, ios.iconFile)).arrayBuffer()));
    data = image.rgba;
    width = image.width;
    r = { x: 0, y: 0, w: image.width, h: image.height };
  } else {
    const manifestFile = join(nativeDir, "atlas.json");
    if (!existsSync(manifestFile)) {
      if (ios.icon) throw Error(`App icon sprite "${ios.icon}" is missing.`);
      return { rgba, sprite: null };
    }
    const manifest = JSON.parse(await Bun.file(manifestFile).text()) as { width: number; height: number; sprites: Record<string, { x: number; y: number; w: number; h: number }> };
    const names = Object.keys(manifest.sprites).filter((n) => !n.startsWith("__"));
    const largest = [...names].sort((a, b) => manifest.sprites[b].w * manifest.sprites[b].h - manifest.sprites[a].w * manifest.sprites[a].h)[0];
    pick = ios.icon ?? ["icon", "hero", "hero.idle", "hero.idle.0", "player"].find((n) => manifest.sprites[n]) ?? largest ?? null;
    const rect = pick ? manifest.sprites[pick] : undefined;
    if (!rect) {
      if (ios.icon) throw Error(`App icon sprite "${ios.icon}" is missing.`);
      return { rgba, sprite: null };
    }
    r = rect;
    width = manifest.width;
    data = new Uint8Array(await Bun.file(join(nativeDir, "atlas.bin")).arrayBuffer());
    if (!Number.isInteger(width) || width < 1 || data.length !== width * manifest.height * 4 ||
        r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > manifest.height)
      throw Error("Invalid app icon atlas.");
  }
  if (![r.x, r.y, r.w, r.h].every(Number.isInteger) || r.w < 1 || r.h < 1)
    throw Error("Invalid app icon dimensions.");
  const fit = (size * (ios.iconFile ? 1 : 0.72)) / Math.max(r.w, r.h);
  const scale = ios.iconFile || fit < 1 ? fit : Math.floor(fit);
  const dw = Math.max(1, Math.round(r.w * scale));
  const dh = Math.max(1, Math.round(r.h * scale));
  const ox = Math.floor((size - dw) / 2), oy = Math.floor((size - dh) / 2);
  // Iterate destination coordinates only: oversized art can never wrap into adjacent rows.
  for (let y = Math.max(0, oy); y < Math.min(size, oy + dh); y++) {
    for (let x = Math.max(0, ox); x < Math.min(size, ox + dw); x++) {
      const di = (y * size + x) * 4;
      if (!ios.iconFile) {
        const si = ((r.y + Math.min(r.h - 1, Math.floor((y - oy) * r.h / dh))) * width + r.x + Math.min(r.w - 1, Math.floor((x - ox) * r.w / dw))) * 4;
        const a = data[si + 3] / 255;
        for (let c = 0; c < 3; c++) rgba[di + c] = Math.round(data[si + c] * a + rgba[di + c] * (1 - a));
      } else {
        const sx = Math.max(0, Math.min(r.w - 1, (x - ox + 0.5) * r.w / dw - 0.5));
        const sy = Math.max(0, Math.min(r.h - 1, (y - oy + 0.5) * r.h / dh - 0.5));
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        let alpha = 0;
        const colour = [0, 0, 0];
        for (const [px, py, weight] of [
          [x0, y0, (1 - fx) * (1 - fy)], [Math.min(x0 + 1, r.w - 1), y0, fx * (1 - fy)],
          [x0, Math.min(y0 + 1, r.h - 1), (1 - fx) * fy], [Math.min(x0 + 1, r.w - 1), Math.min(y0 + 1, r.h - 1), fx * fy],
        ]) {
          const si = (py * width + px) * 4, a = data[si + 3] / 255 * weight;
          alpha += a;
          for (let c = 0; c < 3; c++) colour[c] += data[si + c] * a;
        }
        for (let c = 0; c < 3; c++) rgba[di + c] = Math.round(colour[c] + rgba[di + c] * (1 - alpha));
      }
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
