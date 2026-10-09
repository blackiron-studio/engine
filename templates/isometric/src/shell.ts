// The shell pieces the scenes share: settings and the save slot, created in main.ts.

import type { SaveSlots, Settings } from "@kiln/engine/shell";

export interface Progress {
  coins: number;
  crates: number;
  mapSeed?: number;
  collectedCells?: number[];
  crateCells?: number[];
  exploredCells?: number[];
  player?: { x: number; y: number };
  effectsState?: number;
}

export const shell: { settings: Settings | null; saves: SaveSlots<Progress> | null } = { settings: null, saves: null };
