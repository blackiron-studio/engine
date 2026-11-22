// The shell pieces the scenes share: settings and the save slot, created in main.ts.

import type { SaveSlots, Settings } from "@blackiron-studio/engine/shell";
import type { YardSave } from "./yard.ts";

export interface Progress {
  yard: YardSave | null;
  cleared: number;
}

export const shell: { settings: Settings | null; saves: SaveSlots<Progress> | null } = { settings: null, saves: null };
