// The shell's title menu over the yard itself, seen at dusk with the camera drifting.

import { TileMapData } from "@blackiron-studio/engine/core";
import { type DrawContext, IsoTileMap, Node2D, Sprite } from "@blackiron-studio/engine/scene";
import { TitleScene } from "@blackiron-studio/engine/shell";
import { TILE } from "../art.ts";
import { BARREL, LAYOUT, LEGEND, levelsOf } from "../yard.ts";
import { ISO_TILES } from "./look.ts";

export class YardTitle extends TitleScene {

  override ready(): void {
    super.ready();
    this.background = 0x1b2128;
    this.post.bloom = 0.2;
    this.post.vignette = 0.3;
    const data = TileMapData.fromAscii(LAYOUT, LEGEND);
    this.world.add(new IsoTileMap({ data, elevation: (c, r) => levelsOf(data.get(c, r)), tile: TILE, tiles: ISO_TILES, faces: { left: "wall.left", right: "wall.right" } }));
    LAYOUT.forEach((line, r) => {
      for (let c = 0; c < line.length; c++) {
        const x = (c + 0.5) * (TILE.w / 2), y = (r + 0.5) * (TILE.w / 2);
        if (data.get(c, r) === BARREL) this.world.add(new Sprite("barrel", x, y));
        if (line[c] === "S" || line[c] === "T") {
          const s = this.world.add(new Sprite(`sentry.${(c + r) % 8}`, x, y));
          s.z = levelsOf(data.get(c, r)) * TILE.rise;
        }
      }
    });
    this.camera.projection = { kind: "isometric", tile: { w: TILE.w, h: TILE.h } };
    this.camera.zoom = 0.9;
    this.camera.x = 12 * 32;
    this.camera.y = 12 * 32;
    for (const n of this.world.children) if (n instanceof IsoTileMap) for (let r = 0; r < data.rows; r++) for (let c = 0; c < data.cols; c++) n.setTint(c, r, 0x5d6672);
    this.world.add(new Drift(this));
    for (const n of this.world.children) if (n instanceof Sprite) n.tint = 0x7a8592;
    this.add(new Veil());
    this.app.audio.setMood("menu", { crossfade: 1 });
  }
}

/** A dark band behind the menu so its text reads over the yard. */
class Veil extends Node2D {
  override render(ctx: DrawContext): void {
    const w = ctx.width, h = ctx.height;
    for (let i = 0; i < 24; i++) {
      const t = i / 23;
      const a = 0.62 * Math.sin(t * Math.PI) ** 0.6;
      ctx.rect(0, h * 0.22 + i * (h * 0.56) / 24, w, (h * 0.56) / 24 + 1, 0x0c1116, a);
    }
  }
}

/** Drifts the camera slowly over the yard. */
class Drift extends Node2D {
  private time = 0;
  constructor(private readonly title: YardTitle) {
    super();
  }
  override update(dt: number): void {
    this.time += dt;
    this.title.camera.x = 12 * 32 + Math.sin(this.time * 0.12) * 70;
    this.title.camera.y = 12 * 32 + Math.cos(this.time * 0.1) * 50;
  }
}
