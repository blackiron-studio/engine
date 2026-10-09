import "./art.ts";
import type { App } from "@kiln/engine/app";
import { TitleScene } from "./scenes/title.ts";

/** Called by the entry wrapper once the App exists, on the web and natively. */
export default async function main(app: App): Promise<void> {
  app.input.map({
    left: ["KeyA", "ArrowLeft", "GamepadDpadLeft", "GamepadLeftStickLeft"],
    right: ["KeyD", "ArrowRight", "GamepadDpadRight", "GamepadLeftStickRight"],
    up: ["KeyW", "ArrowUp", "GamepadDpadUp", "GamepadLeftStickUp"],
    down: ["KeyS", "ArrowDown", "GamepadDpadDown", "GamepadLeftStickDown"],
    confirm: ["Enter", "Space", "GamepadA"],
  });
  app.scenes.change(new TitleScene());
}
