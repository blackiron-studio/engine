import { TileMapData } from "@blackiron-studio/engine/core";
import { Anchor, Button, Sprite } from "@blackiron-studio/engine/scene";
import { TitleScene } from "@blackiron-studio/engine/shell";
import { TILE, WATER_FRAMES } from "../art.ts";
import { BUTTON, GOLD_BUTTON, SEA_BACKGROUND, SizedPlate, SmoothIsoTileMap, UI_FONT, cellHash, mulTint, terraceDecals } from "../look.ts";

const WATER = 3;

/** The regular shell menu, dressed with the same projected art as the game. */
export class HighgroundTitle extends TitleScene {
  private map!: SmoothIsoTileMap;
  private foam: { sprite: Sprite; phase: number }[] = [];
  private time = 0;
  private waterFrame = 0;
  private sun!: Sprite;

  override ready(): void {
    super.ready();
    this.background = SEA_BACKGROUND;
    const data = new TileMapData(22, 22);
    const elevation: number[][] = [];
    for (let r = 0; r < 22; r++) {
      const row: number[] = [];
      for (let c = 0; c < 22; c++) {
        const distance = Math.hypot((c - 10.5) * 0.9, (r - 10.5) * 1.05);
        const level = distance < 4 ? 2 : distance < 6 ? 1 : 0;
        data.set(c, r, distance > 9 ? 3 : distance > 7.8 ? 2 : level === 2 ? 4 : 1);
        row.push(level);
      }
      elevation.push(row);
    }
    this.map = this.world.add(
      new SmoothIsoTileMap({
        data,
        elevation,
        tile: TILE,
        tiles: { 1: "grass.top", 2: "sand.top", 3: "water.0", 4: { top: "stone.top", left: "stone.cliff.left", right: "stone.cliff.right" } },
        faces: { left: "cliff.left", right: "cliff.right" },
      }),
    );
    const decals = terraceDecals(this.world, this.map, WATER);
    this.foam = decals.foam;
    for (let r = 0; r < 22; r++) for (let c = 0; c < 22; c++) this.map.setTint(c, r, mulTint(decals.tints[r * 22 + c], 0xffffff));
    const prop = (name: string, c: number, r: number, scale = 1, shadow = "contact", shadowScale = 1) => {
      const [x, y] = this.map.cellCenter(c, r);
      const z = this.map.heightAt(x, y);
      const s = this.world.add(new Sprite(shadow, x, y));
      s.z = z; s.depthBias = -1; s.scaleX = s.scaleY = shadowScale;
      const sprite = this.world.add(new Sprite(name, x, y));
      sprite.z = z; sprite.scaleX = sprite.scaleY = scale;
    };
    for (const [c, r] of [[5, 7], [5, 10], [7, 15], [13, 16], [16, 12], [16, 8], [12, 5], [8, 4], [6, 13], [15, 14]]) {
      prop(cellHash(c, r, 3) < 0.34 ? "tree.pine" : "tree", c, r, 0.9 + cellHash(c, r, 4) * 0.25, "shadow.cast", 1);
    }
    for (const [c, r] of [[9, 9], [12, 12], [9, 12], [12, 9]]) prop("lamp", c, r, 1, "shadow.cast", 0.45);
    for (const [c, r, name] of [[6, 6, "bush"], [15, 6, "flowers"], [4, 12, "flowers"], [14, 16, "bush"], [17, 10, "grass.tuft"], [7, 17, "grass.tuft"]] as const) prop(name, c, r, 1, "contact", 0.5);
    this.camera.projection = { kind: "isometric", tile: TILE };
    this.camera.x = this.camera.y = (11 * TILE.w) / 2;
    this.camera.z = 16;
    this.camera.zoom = 1.45;
    this.post.vignette = 0.3;
    this.post.bloom = 0.2;
    this.post.bloomThreshold = 0.82;

    const plate = this.ui.add(new Anchor({ x: "center", y: "center" }));
    plate.zIndex = -1;
    plate.add(new SizedPlate(() => ({ w: Math.min(this.width - 40, Math.max(560, this.column.w + 120)), h: this.column.h + 96 })));
    this.sun = plate.add(new Sprite("ui.sun", 0, 0));
    this.sun.scaleX = this.sun.scaleY = 1.5;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (!(row instanceof Button)) continue;
      Object.assign(row.style, i === 0 ? GOLD_BUTTON : BUTTON);
      row.style.font = { ...UI_FONT, size: 17, weight: 700 };
    }
  }

  // MenuScene's update takes no arguments, but the scene loop still passes the frame time.
  override update(dt = 1 / 60): void {
    super.update();
    this.time += dt;
    const frame = Math.floor(this.time / 0.14) % WATER_FRAMES;
    if (frame !== this.waterFrame) {
      this.waterFrame = frame;
      this.map.tiles[WATER] = `water.${frame}`;
      this.map.invalidate();
    }
    for (const f of this.foam) f.sprite.alpha = 0.72 + Math.sin(this.time * 1.7 + f.phase) * 0.28;
    this.column.layout();
    this.sun.y = -this.column.h / 2 - 48;
    this.sun.rotation = this.time * 0.15;
  }
}
