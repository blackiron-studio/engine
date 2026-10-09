import "./art.ts";
import type { App } from "@blackiron-studio/engine/app";
import { TitleScene } from "./scenes/title.ts";

/** Called by the entry wrapper once the App exists, on the web and natively. */
export default async function main(app: App): Promise<void> {
  app.input.map({
    confirm: ["Enter", "Space", "GamepadA"],
    endTurn: ["KeyE", "GamepadY"],
    left: ["ArrowLeft", "KeyA", "GamepadDpadLeft"],
    right: ["ArrowRight", "KeyD", "GamepadDpadRight"],
  });
  app.scenes.change(new TitleScene());
}
