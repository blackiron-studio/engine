// Tile size and world units, shared by the art and the simulation (which never loads the art).

export const TILE = { w: 64, h: 32, rise: 16 };
/** World units per cell. */
export const CELL = TILE.w / 2;
