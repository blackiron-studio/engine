import { createStore } from "@kiln/engine/save";

export interface SaveData {
  best: number;
}

export const saves = createStore<SaveData>({
  key: "kiln-topdown",
  version: 1,
  initial: () => ({ best: 0 }),
  validate: (d): d is SaveData => typeof (d as SaveData)?.best === "number",
});
