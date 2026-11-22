import "./art.ts";
import type { App } from "@blackiron-studio/engine/app";
import { SettingsScene, bindShellActions, createSaveSlots, createSettings } from "@blackiron-studio/engine/shell";
import { PlayScene } from "./scenes/play.ts";
import { YardTitle } from "./scenes/title.ts";
import { type Progress, shell } from "./shell.ts";

export const UI_FONT = { family: "Chakra Petch", size: 16, weight: 600 } as const;

/** Called by the entry wrapper once the App exists, on the web and natively. */
export default async function main(app: App): Promise<void> {
  app.input.map({
    left: ["KeyA", "ArrowLeft", "GamepadDpadLeft"],
    right: ["KeyD", "ArrowRight", "GamepadDpadRight"],
    up: ["KeyW", "ArrowUp", "GamepadDpadUp"],
    down: ["KeyS", "ArrowDown", "GamepadDpadDown"],
    fire: ["Space", "GamepadR2"],
    grenade: ["KeyG", "GamepadL2"],
    reload: ["KeyR", "GamepadX"],
    swap: ["KeyQ", "GamepadY", "GamepadR1"],
    rifle: ["Digit1"],
    shotgun: ["Digit2"],
    restart: ["KeyT", "GamepadSelect"],
  });
  app.setTheme({
    font: { ...UI_FONT, size: 18 },
    accent: 0xffb547,
    text: 0xe9edf0,
    muted: 0x8d9aa6,
    panel: { fill: 0x161c22, fillAlpha: 0.94, border: 0x3d4a56, bevel: null },
    button: { fill: 0x26313b, fillAlpha: 1, border: 0x52606d, bevel: null, text: 0xe9edf0, hover: 0x34424f, pressedFill: 0x1a2229 },
  });
  // Every sound is synthesised: no sample files.
  app.audio.defineSfx("rifle", { wave: "noise", freq: 1800, freqEnd: 400, duration: 0.04, release: 0.06, volume: 0.16, lowpass: 5200 });
  app.audio.defineSfx("shotgun", { wave: "noise", freq: 900, freqEnd: 120, duration: 0.09, release: 0.18, volume: 0.3, lowpass: 2600 });
  app.audio.defineSfx("zap", { wave: "square", freq: 880, freqEnd: 330, duration: 0.06, release: 0.06, volume: 0.08 });
  app.audio.defineSfx("boom", { wave: "noise", freq: 260, freqEnd: 40, duration: 0.3, release: 0.6, volume: 0.45, lowpass: 900 });
  app.audio.defineSfx("crack", { wave: "noise", freq: 700, freqEnd: 200, duration: 0.05, release: 0.08, volume: 0.14, lowpass: 2400 });
  app.audio.defineSfx("smash", { wave: "noise", freq: 500, freqEnd: 90, duration: 0.12, release: 0.2, volume: 0.24, lowpass: 1600 });
  app.audio.defineSfx("ping", { wave: "triangle", freq: 2400, freqEnd: 1800, duration: 0.03, release: 0.05, volume: 0.07 });
  app.audio.defineSfx("hurt", { wave: "square", freq: 220, freqEnd: 110, duration: 0.08, release: 0.1, volume: 0.16 });
  app.audio.defineSfx("alert", { wave: "square", freq: 980, freqEnd: 980, duration: 0.05, release: 0.04, volume: 0.1, repeat: 2, repeatGap: 0.07 });
  app.audio.defineSfx("kill", { wave: "sawtooth", freq: 420, freqEnd: 60, duration: 0.22, release: 0.25, volume: 0.2, lowpass: 1800 });
  app.audio.defineSfx("reload", { wave: "triangle", freq: 320, freqEnd: 520, duration: 0.05, release: 0.06, volume: 0.12, repeat: 2, repeatGap: 0.12 });
  app.audio.defineSfx("throw", { wave: "noise", freq: 1200, freqEnd: 600, duration: 0.05, release: 0.05, volume: 0.08, lowpass: 3000 });
  app.audio.defineSfx("clink", { wave: "triangle", freq: 1500, freqEnd: 1100, duration: 0.02, release: 0.05, volume: 0.08 });
  app.audio.defineSfx("click", { wave: "square", freq: 1200, freqEnd: 1200, duration: 0.015, release: 0.02, volume: 0.06 });
  app.audio.defineMood("yard", { tempo: 92, root: 110, scale: [0, 3, 5, 7, 10], wave: "triangle", density: 0.22, pad: true, bass: true, volume: 0.18, lowpass: 1300, seed: 17 });
  app.audio.defineMood("menu", { tempo: 70, root: 98, scale: [0, 3, 7, 10], wave: "sine", density: 0.15, pad: true, bass: false, volume: 0.18, lowpass: 1100, seed: 4 });
  bindShellActions(app);
  shell.settings = createSettings(app);
  shell.saves = createSaveSlots<Progress>({ key: "sentry-yard", version: 1, slots: 1, initial: () => ({ yard: null, cleared: 0 }), summarize: (d) => (d.yard ? `${6 - d.yard.dead.length} sentries left` : "new yard") });
  app.scenes.change(title(app));
}

/** The title: Continue appears while a run is saved. */
export function title(app: App): YardTitle {
  const saves = shell.saves;
  const entries = [{ label: "Clear the yard", onPick: () => app.scenes.change(new PlayScene(), { transition: "fade", duration: 0.4 }) }];
  const saved = saves?.has(0) ? saves.load(0) : null;
  if (saved?.yard) entries.push({ label: `Continue (${saves!.list()[0].summary})`, onPick: () => app.scenes.change(new PlayScene(saved.yard), { transition: "fade", duration: 0.4 }) });
  if (shell.settings) {
    const settings = shell.settings;
    entries.push({ label: "Settings", onPick: () => app.scenes.push(new SettingsScene(settings), { overlay: true }) });
  }
  return new YardTitle({
    title: "Sentry Yard",
    subtitle: "Six turrets hold the yard. Break their lines of sight, blow the barrels, take them down.",
    entries,
    version: "Blackiron · combat, line of sight, destructibles, iso aim",
    background: 0x1b2128,
  });
}
