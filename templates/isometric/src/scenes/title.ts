import { TileMapData } from "@kiln/engine/core";
import {
  Anchor,
  Button,
  Graphics2D,
  IsoTileMap,
  Sprite,
} from "@kiln/engine/scene";
import { TitleScene } from "@kiln/engine/shell";
import { TILE } from "../art.ts";

/** The regular shell menu, dressed with the same projected art as the game. */
export class HighgroundTitle extends TitleScene {
  override ready(): void {
    super.ready();
    const data = new TileMapData(22, 22);
    const elevation: number[][] = [];
    for (let r = 0; r < 22; r++) {
      const row: number[] = [];
      for (let c = 0; c < 22; c++) {
        const distance = Math.hypot((c - 10.5) * 0.9, (r - 10.5) * 1.05);
        const level = distance < 4 ? 2 : distance < 6 ? 1 : 0;
        data.set(
          c,
          r,
          distance > 9 ? 3 : distance > 7.8 ? 2 : level === 2 ? 4 : 1,
        );
        row.push(level);
      }
      elevation.push(row);
    }
    const map = this.world.add(
      new IsoTileMap({
        data,
        elevation,
        tile: TILE,
        tiles: {
          1: "grass.top",
          2: "sand.top",
          3: "water.top",
          4: "stone.top",
        },
        faces: { left: "cliff.left", right: "cliff.right" },
      }),
    );
    for (const [c, r] of [
      [5, 7],
      [5, 10],
      [7, 15],
      [13, 16],
      [16, 12],
      [16, 8],
      [12, 5],
      [8, 4],
      [6, 13],
      [15, 14],
    ]) {
      const [x, y] = map.cellCenter(c, r);
      const tree = this.world.add(new Sprite("tree", x, y));
      tree.z = map.heightAt(x, y);
      const shadow = this.world.add(new Sprite("contact", x, y));
      shadow.z = tree.z;
      shadow.depthBias = -1;
      shadow.scaleX = shadow.scaleY = 1.2;
    }
    this.camera.projection = { kind: "isometric", tile: TILE };
    this.camera.x = this.camera.y = (11 * TILE.w) / 2;
    this.camera.z = 16;
    this.camera.zoom = 1.45;
    this.post.vignette = 0.28;
    const plate = this.ui.add(new Anchor({ x: "center", y: "center" }));
    plate.zIndex = -1;
    plate.add(
      new Graphics2D().roundedRect(-374, -177, 748, 354, 20, {
        color: 0x163e45,
        alpha: 0.96,
      }),
    );
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (!(row instanceof Button)) continue;
      row.style.fill = i === 0 ? 0xc9dc9c : 0x28565a;
      row.style.hover = i === 0 ? 0xe5eac0 : 0x3a7070;
      row.style.text = i === 0 ? 0x163e45 : 0xe4ecd4;
      row.style.textShadow = null;
      row.style.border = null;
      row.style.bevel = null;
    }
  }
}
