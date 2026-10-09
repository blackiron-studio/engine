import "./art.ts";
import type { App } from "@kiln/engine/app";
import { TitleScene } from "./scenes/title.ts";

/** Called by the entry wrapper once the App exists, on the web and natively. */
export default async function main(app: App): Promise<void> {
  app.input.map({
    left: ["KeyA", "ArrowLeft", "GamepadDpadLeft", "GamepadLeftStickLeft"],
    right: ["KeyD", "ArrowRight", "GamepadDpadRight", "GamepadLeftStickRight"],
    jump: ["Space", "KeyW", "ArrowUp", "GamepadA"],
    reset: ["KeyR", "GamepadY"],
    confirm: ["Enter", "GamepadStart"],
  });
  app.setTheme({ font: { family: "Instrument Sans", size: 20, weight: 600 }, accent: 0xffc857 });
  app.audio.defineSfx("thud", { wave: "noise", freq: 300, freqEnd: 60, duration: 0.08, release: 0.12, volume: 0.35, lowpass: 700 });
  app.audio.defineSfx("jump", { wave: "square", freq: 320, freqEnd: 640, duration: 0.08, release: 0.1, volume: 0.2 });
  app.audio.defineSfx("star", { wave: "sine", freq: 880, freqEnd: 1760, duration: 0.1, release: 0.25, volume: 0.3, repeat: 2, repeatGap: 0.05 });
  app.audio.defineSfx("click", { wave: "square", freq: 660, duration: 0.03, release: 0.05, volume: 0.15 });
  app.audio.defineMood("yard", { tempo: 96, root: 196, scale: [0, 2, 4, 5, 7, 9, 11], wave: "triangle", density: 0.4, pad: true, bass: true, volume: 0.28, lowpass: 2200, seed: 4 });
  app.audio.defineMood("menu", { tempo: 72, root: 220, scale: [0, 2, 3, 5, 7, 8, 10], wave: "sine", density: 0.25, pad: true, bass: false, volume: 0.25, lowpass: 1500, seed: 2 });
  app.scenes.change(new TitleScene());
}
