import { createStore } from "@blackiron-studio/engine/save";

export interface SaveData {
  best: number;
}

export const saves = createStore<SaveData>({
  key: "blackiron-topdown",
  version: 1,
  initial: () => ({ best: 0 }),
  validate: (d): d is SaveData => typeof (d as SaveData)?.best === "number",
});
