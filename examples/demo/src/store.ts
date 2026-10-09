import { createStore } from "@kiln/engine/save";

export interface SaveData {
  best: number;
  games: number;
  muted: boolean;
}

export const saves = createStore<SaveData>({
  key: "wisp-hollow",
  version: 1,
  initial: () => ({ best: 0, games: 0, muted: false }),
  validate: (d): d is SaveData => typeof d === "object" && d !== null && typeof (d as SaveData).best === "number",
});
