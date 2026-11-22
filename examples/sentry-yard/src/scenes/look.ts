// What the yard's tiles look like: which painted sprites draw each tile id.

import type { IsoTile } from "@blackiron-studio/engine/scene";
import { BARREL, BRICK, BRICK_CRACKED, CRATE, CRATE_SPLIT, GRATE, LINE, OIL, PAD, RUBBLE, SLAB, WALL } from "../yard.ts";

export const ISO_TILES: Record<number, string | IsoTile> = {
  [SLAB]: "slab",
  [LINE]: "slab.line",
  [OIL]: "slab.oil",
  [GRATE]: "grate",
  [RUBBLE]: "rubble",
  [BARREL]: "slab",
  [WALL]: { top: "wall.top", left: "wall.left", right: "wall.right" },
  [PAD]: { top: "pad", left: "wall.left", right: "wall.right" },
  [BRICK]: { top: "brick.top", left: "brick.left", right: "brick.right" },
  [BRICK_CRACKED]: { top: "brick.cracked.top", left: "brick.cracked.left", right: "brick.cracked.right" },
  [CRATE]: { top: "crate.top", left: "crate.left", right: "crate.right" },
  [CRATE_SPLIT]: { top: "crate.split.top", left: "crate.split.left", right: "crate.split.right" },
};

