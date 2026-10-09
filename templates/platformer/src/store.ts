import { createStore } from "@blackiron-studio/engine/save";

export interface SaveData {
  bestTime: number;
}

export const saves = createStore<SaveData>({
  key: "blackiron-platformer",
  version: 1,
  initial: () => ({ bestTime: 0 }),
  validate: (d): d is SaveData => typeof (d as SaveData)?.bestTime === "number",
});
