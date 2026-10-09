// Wisp Hollow: a night-time meadow game that shows the engine's parts working together.
// Rules live in game.ts; this file wires input and scenes. The CLI's entry wrapper
// creates the App for the target (web page or native host) and calls `main`.

import "./art.ts";
import type { App } from "@blackiron-studio/engine/app";
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
  app.scenes.change(new TitleScene());
}
