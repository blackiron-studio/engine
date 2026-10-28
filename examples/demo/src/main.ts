// Wisp Hollow: a night-time meadow game that shows the engine's parts working together.
// Rules live in game.ts; this file wires input and scenes. The CLI's entry wrapper
// creates the App for the target (web page or native host) and calls `main`.

import "./art.ts";
import type { App } from "@blackiron-studio/engine/app";
import { buildLut } from "@blackiron-studio/engine/render";
import { defineAudio } from "./audio.ts";
import { TitleScene } from "./scenes/title.ts";

export default async function main(app: App): Promise<void> {
  app.input.map({
    left: ["KeyA", "ArrowLeft", "GamepadDpadLeft", "GamepadLeftStickLeft"],
    right: ["KeyD", "ArrowRight", "GamepadDpadRight", "GamepadLeftStickRight"],
    up: ["KeyW", "ArrowUp", "GamepadDpadUp", "GamepadLeftStickUp"],
    down: ["KeyS", "ArrowDown", "GamepadDpadDown", "GamepadLeftStickDown"],
    confirm: ["Enter", "Space", "GamepadA"],
    pause: ["Escape", "KeyP", "GamepadStart"],
    mute: ["KeyM"],
    swap: ["KeyK", "GamepadY"],
  });
  defineAudio(app.audio);
  // Colour grade: moonlit blue lifted into the shadows, a warm roll-off in the highlights.
  app.basePost.lut = buildLut((t) => [Math.min(1, t ** 1.06 + 0.06 * t ** 3), t ** 1.02, Math.min(1, t * 0.94 + 0.05 + 0.08 * t * (1 - t))]);
  app.scenes.change(new TitleScene());
}
