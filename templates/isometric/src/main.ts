import "./art.ts";
import type { App } from "@kiln/engine/app";
import { SettingsScene, TitleScene, bindShellActions, createSaveSlots, createSettings } from "@kiln/engine/shell";
import { HighgroundTitle } from "./scenes/title.ts";
import { PlayScene } from "./scenes/play.ts";
import { type Progress, shell } from "./shell.ts";

/** Called by the entry wrapper once the App exists, on the web and natively. */
export default async function main(app: App): Promise<void> {
  app.input.map({
    left: ["KeyA", "ArrowLeft", "GamepadDpadLeft", "GamepadLeftStickLeft"],
    right: ["KeyD", "ArrowRight", "GamepadDpadRight", "GamepadLeftStickRight"],
    up: ["KeyW", "ArrowUp", "GamepadDpadUp", "GamepadLeftStickUp"],
    down: ["KeyS", "ArrowDown", "GamepadDpadDown", "GamepadLeftStickDown"],
    jump: ["Space", "GamepadA"],
    reset: ["KeyR", "GamepadY"],
  });
  app.setTheme({ font: { family: "Instrument Sans", size: 18, weight: 600 }, accent: 0xc9dc9c });
  app.audio.defineSfx("jump", { wave: "square", freq: 300, freqEnd: 620, duration: 0.07, release: 0.09, volume: 0.18 });
  app.audio.defineSfx("land", { wave: "noise", freq: 240, freqEnd: 80, duration: 0.05, release: 0.08, volume: 0.2, lowpass: 900 });
  app.audio.defineSfx("coin", { wave: "sine", freq: 1040, freqEnd: 1560, duration: 0.06, release: 0.18, volume: 0.25, repeat: 2, repeatGap: 0.06 });
  app.audio.defineSfx("place", { wave: "triangle", freq: 200, freqEnd: 120, duration: 0.08, release: 0.1, volume: 0.25 });
  app.audio.defineMood("ridge", { tempo: 84, root: 196, scale: [0, 2, 4, 7, 9], wave: "triangle", density: 0.3, pad: true, bass: true, volume: 0.22, lowpass: 1800, seed: 9 });
  app.audio.defineMood("menu", { tempo: 60, root: 220, scale: [0, 3, 5, 7, 10], wave: "sine", density: 0.2, pad: true, bass: false, volume: 0.2, lowpass: 1400, seed: 3 });
  // The shell: menu bindings the game has not mapped, persisted settings, one autosave slot.
  bindShellActions(app);
  shell.settings = createSettings(app);
  shell.saves = createSaveSlots<Progress>({ key: "highground", version: 1, slots: 1, initial: () => ({ coins: 0, crates: 0 }), summarize: (d) => `${d.coins} coins, ${d.crates} crates` });
  app.scenes.change(title(app));
}

/** The title screen; Continue appears once there is a save. */
export function title(app: App): TitleScene {
  const saves = shell.saves;
  const entries = [{ label: "Play", onPick: () => app.scenes.change(new PlayScene(), { transition: "fade", duration: 0.5 }) }];
  if (saves?.has(0)) entries.push({ label: `Continue (${saves.list()[0].summary})`, onPick: () => app.scenes.change(new PlayScene(saves.load(0)), { transition: "fade", duration: 0.5 }) });
  if (shell.settings) {
    const settings = shell.settings;
    entries.push({ label: "Settings", onPick: () => app.scenes.push(new SettingsScene(settings), { overlay: true }) });
  }
  const scene = new HighgroundTitle({ title: "Highground", subtitle: "Find the sun coins. Build a foothold. Explore the sunlit terraces.", entries, version: "Kiln · 2.5D", background: 0x174f53 });
  return scene;
}
