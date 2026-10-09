// The meadow itself: tiles, decorations, atmosphere and the light layer. Shared by the
// title backdrop and the play scene so both look the same.

import { TileMapData } from "@blackiron-studio/engine/core";
import {
  CloudShadows,
  Graphics2D,
  LightLayer,
  LightOccluder2D,
  Motes,
  Node2D,
  Sprite,
  TileMap,
} from "@blackiron-studio/engine/scene";
import { groveTree, moonShrine } from "../scenery.ts";
import {
  DARK_ID,
  GROUND,
  type GameState,
  PATH_ID,
  WORLD,
  WORLD_H,
  WORLD_W,
} from "../game.ts";

export interface Hollow {
  map: TileMap;
  clouds: CloudShadows;
  actors: Node2D;
  motes: Motes;
  lights: LightLayer;
}

/** Build the world layers for a game state into `parent`, in draw order. */
export function buildHollow(
  parent: Node2D,
  state: GameState,
  ambient = 0x8eaaa3,
): Hollow {
  const tiles: Record<number, string | { autotile: string }> = {};
  GROUND.forEach((name, i) => {
    if (name) tiles[i] = name;
  });
  tiles[6] = "grass.2";
  tiles[7] = "grass.3";
  tiles[DARK_ID] = "grass.0";
  tiles[PATH_ID] = "grass.1";
  // The rules keep tiles as a flat array; wrap it without copying so the map stays in sync.
  const map = parent.add(
    new TileMap({
      data: new TileMapData(WORLD.cols, WORLD.rows, state.tiles),
      tileSize: WORLD.tile,
      tiles,
    }),
  );
  // A continuous ribbon follows the original generated trail, without tile stair steps.
  const centers: number[] = [];
  for (let x = 0; x < WORLD.cols; x++) {
    let total = 0,
      count = 0;
    for (let y = 0; y < WORLD.rows; y++)
      if (state.tiles[y * WORLD.cols + x] === PATH_ID) {
        total += (y + 0.5) * WORLD.tile;
        count++;
      }
    centers.push(count ? total / count : WORLD_H / 2);
  }
  const trail = parent.add(new Graphics2D());
  const smooth = centers.map((_, i) => {
    let sum = 0,
      n = 0;
    for (
      let j = Math.max(0, i - 3);
      j <= Math.min(centers.length - 1, i + 3);
      j++
    ) {
      sum += centers[j];
      n++;
    }
    return sum / n;
  });
  for (const [width, color] of [
    [29, 0x466c62],
    [24, 0x887f69],
    [19, 0xa29779],
  ] as const) {
    const edge: [number, number][] = smooth.map((y, x) => [
      x * WORLD.tile,
      y - width,
    ]);
    for (let x = smooth.length - 1; x >= 0; x--)
      edge.push([x * WORLD.tile, smooth[x] + width]);
    trail.polygon(edge, color);
  }
  const clouds = parent.add(
    new CloudShadows({
      area: { x: 0, y: 0, w: WORLD_W, h: WORLD_H },
      count: 8,
      alpha: 0.18,
      scale: [6, 12],
      speed: [14, 28],
    }),
  );
  const actors = parent.add(new Node2D());
  actors.ySort = true;
  for (const o of state.obstacles) {
    if (o.sprite.startsWith("tree"))
      actors.add(groveTree(o.x, o.y, Math.floor(o.x * 19 + o.y)));
    else if (o.sprite.startsWith("bush")) {
      const b = actors.add(new Graphics2D(o.x, o.y));
      b.ellipse(0, 2, 19, 6, { color: 0x142c36, alpha: 0.4 }, 16)
        .ellipse(-8, -8, 12, 10, 0x356d61, 16)
        .ellipse(7, -10, 14, 12, 0x528670, 16)
        .ellipse(3, -16, 9, 6, 0x7eaa83, 14);
      for (let i = 0; i < 4; i++)
        b.ellipse(-10 + i * 6, -7 - (i % 2) * 6, 2, 2, 0xd7ae99, 8);
    } else if (o.sprite.startsWith("rock")) {
      actors.add(
        new Graphics2D(o.x, o.y)
          .ellipse(1, 2, 16, 5, { color: 0x152e37, alpha: 0.35 }, 12)
          .polygon(
            [
              [-14, 0],
              [-10, -13],
              [0, -18],
              [11, -12],
              [15, 0],
            ],
            0x536d77,
          )
          .polygon(
            [
              [-14, 0],
              [-10, -13],
              [0, -18],
              [3, -8],
              [-3, -1],
            ],
            0x97a9a2,
          )
          .polygon(
            [
              [0, -18],
              [11, -12],
              [3, -8],
            ],
            0xb5bbae,
          ),
      );
    } else actors.add(new Sprite(o.sprite, o.x, o.y));
    // Trunks block the lantern: a small box where the tree meets the ground.
    if (o.sprite.startsWith("tree"))
      actors.add(new LightOccluder2D({ w: 10, h: 8 }, o.x, o.y - 6));
  }
  actors.add(moonShrine(WORLD_W / 2, WORLD_H / 2 - 100));
  const motes = parent.add(
    new Motes({
      area: { x: 0, y: 0, w: WORLD_W, h: WORLD_H },
      count: 160,
      color: 0xffe9a3,
      size: [2, 4],
      speed: 10,
      alpha: 0.7,
    }),
  );
  const lights = parent.add(new LightLayer(ambient));
  return { map, clouds, actors, motes, lights };
}
