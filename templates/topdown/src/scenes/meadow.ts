// The meadow: a tile map with autotiled dark patches, and y-sorted decorations.

import { TileMapData } from "@kiln/engine/core";
import { Node2D, Sprite, TileMap } from "@kiln/engine/scene";
import { DARK_ID, FLOWERS_ID, type GameState, WORLD } from "../game.ts";

export function buildMeadow(parent: Node2D, state: GameState): { map: TileMap; actors: Node2D } {
  const map = parent.add(
    new TileMap({
      data: new TileMapData(WORLD.cols, WORLD.rows, state.tiles),
      tileSize: WORLD.tile,
      tiles: { 0: "grass.0", 1: "grass.1", 2: "grass.2", [DARK_ID]: { autotile: "dark" }, [FLOWERS_ID]: "flowers" },
    }),
  );
  const actors = parent.add(new Node2D());
  actors.ySort = true;
  for (const o of state.obstacles) actors.add(new Sprite(o.sprite, o.x, o.y));
  return { map, actors };
}
