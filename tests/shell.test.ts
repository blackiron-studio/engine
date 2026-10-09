// The shell: settings reach the engine and persist, save slots keep documents and an index,
// hints follow their conditions and the player's device, and the menus navigate by action.

import { describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { Scene, Slider, wrapText } from "../src/scene/index.ts";
import { auditUILayout, createTestApp, stepFrames } from "../src/testkit/index.ts";
import { ConfirmScene, ControlsScene, Hints, HintLayer, MenuScene, PauseScene, SaveSlotsScene, SettingsScene, TitleScene, bindShellActions, createSaveSlots, createSettings, glyphFor, keyName } from "../src/shell/index.ts";

async function makeApp(): Promise<App> {
  const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
  app.input.map({ jump: ["Space", "GamepadA"], left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"] });
  bindShellActions(app);
  app.setTheme({ font: { family: "Instrument Sans", size: 20, weight: 600 } });
  return app;
}

describe("Settings", () => {
  test("apply to audio, accessibility, theme and bindings, and persist", async () => {
    const app = await makeApp();
    const settings = createSettings(app);
    expect(app.audio.masterVolume).toBe(1);
    settings.set({ masterVolume: 0.5, musicVolume: 0.3, screenShake: 0, reducedMotion: true, textScale: 1.2 });
    expect(app.audio.masterVolume).toBe(0.5);
    expect(app.audio.musicVolume).toBe(0.3);
    expect(app.accessibility.shakeScale).toBe(0);
    expect(app.accessibility.reducedMotion).toBe(true);
    expect((app.theme.font as { size: number }).size).toBe(24);
    // Camera shake honours the scale once the scene runs a frame.
    const scene = new Scene();
    app.scenes.change(scene);
    app.frame(1 / 60);
    scene.camera.shake(10);
    expect(scene.camera.shakeX).toBe(0);
    // Rebinding replaces the action's keys and survives a reload of the store.
    settings.rebind("jump", ["KeyJ", "GamepadA"]);
    expect(app.input.bindingsOf("jump")).toEqual(["KeyJ", "GamepadA"]);
    const again = createSettings(app);
    expect(again.data.masterVolume).toBe(0.5);
    expect(again.data.bindings.jump).toEqual(["KeyJ", "GamepadA"]);
    settings.resetBindings();
    expect(app.input.bindingsOf("jump")).toEqual(["Space", "GamepadA"]);
    expect(again.defaultBindingsOf("left")).toEqual(["KeyA", "ArrowLeft"]);
    settings.setExtra("difficulty", "hard");
    expect(createSettings(app).get<string>("difficulty", "easy")).toBe("hard");
  });

  test("reduced motion shortens transitions", async () => {
    const app = await makeApp();
    const settings = createSettings(app);
    settings.set({ reducedMotion: true });
    const a = new Scene();
    app.scenes.change(a);
    app.frame(1 / 60);
    app.scenes.change(new Scene(), { transition: "fade", duration: 1 });
    // A one-second fade at 30% is done well inside 25 frames.
    for (let i = 0; i < 25; i++) app.frame(1 / 60);
    expect(app.scenes.depth).toBe(1);
    expect(app.scenes.current?.name).not.toBe("transition");
  });
});

describe("SaveSlots", () => {
  test("save, list, load, newest, autosave and delete", async () => {
    const slots = createSaveSlots<{ level: number }>({ key: "test-game", version: 1, slots: 3, initial: () => ({ level: 1 }), summarize: (d) => `level ${d.level}` });
    slots.clearAll();
    expect(slots.list().every((s) => s.empty)).toBe(true);
    expect(slots.newest()).toBe(-1);
    expect(slots.load(1)).toEqual({ level: 1 });
    expect(slots.current).toBe(1);
    slots.autosave({ level: 4 });
    expect(slots.has(1)).toBe(true);
    expect(slots.list()[1].summary).toBe("level 4");
    slots.save(2, { level: 9 }, "boss");
    expect(slots.newest()).toBe(2);
    expect(slots.load(1)).toEqual({ level: 4 });
    expect(slots.list()[2].summary).toBe("boss");
    slots.delete(2);
    expect(slots.has(2)).toBe(false);
    expect(slots.newest()).toBe(1);
  });
});

describe("Hints", () => {
  test("show when their condition holds, end on the action, and remember once", async () => {
    const app = await makeApp();
    const settings = createSettings(app);
    settings.resetHints();
    let moved = false;
    const hints = new Hints(app, [
      { id: "move", text: "Press {left} or {right} to walk", until: () => moved },
      { id: "jump", text: "Press {jump} to jump", action: "jump", when: () => moved, delay: 0.1 },
    ], settings);
    hints.update(1 / 60);
    expect(hints.current?.id).toBe("move");
    expect(hints.text()).toBe("Press A or D to walk");
    app.input.lastDevice = "gamepad";
    app.input.bind("left", ["KeyA", "GamepadDpadLeft"]);
    expect(hints.text()).toBe("Press D-pad ← or D to walk");
    moved = true;
    hints.update(1 / 60);
    expect(hints.current).toBeNull();
    for (let i = 0; i < 5; i++) hints.update(1 / 60);
    expect(hints.current).toBeNull();
    for (let i = 0; i < 4; i++) hints.update(1 / 60);
    expect(hints.current?.id).toBe("jump");
    app.input.keyDown("Space");
    hints.update(1 / 60);
    expect(hints.current).toBeNull();
    expect(settings.hintSeen("jump")).toBe(true);
    // A fresh Hints over the same settings skips what was seen.
    const later = new Hints(app, hints.specs, settings);
    later.update(1);
    expect(later.current).toBeNull();
    expect(keyName("ArrowUp")).toBe("↑");
    app.input.lastDevice = "gamepad";
    expect(glyphFor(app, "jump")).toBe("A");
  });

  test("the layer draws the current hint in the UI", async () => {
    const app = await makeApp();
    const scene = new Scene();
    const hints = new Hints(app, [{ id: "hi", text: "Hello there", duration: 0.5 }]);
    scene.ui.add(new HintLayer(hints));
    app.scenes.change(scene);
    for (let i = 0; i < 5; i++) app.frame(1 / 60);
    const ops = (app.renderer as unknown as { ops: { op: string; text?: string }[] }).ops;
    expect(ops.some((o) => o.op === "text" && o.text === "Hello there")).toBe(true);
    for (let i = 0; i < 40; i++) app.frame(1 / 60);
    expect(hints.current).toBeNull();
  });
});

describe("Menus", () => {
  test("title controls stay inside portrait and landscape viewports without overlap", async () => {
    for (const [width, height] of [[640, 360], [360, 640]] as const) {
      const title = new TitleScene({ title: "Game", entries: [{ label: "Play" }, { label: "Settings" }], version: "0.1" });
      const app = await createTestApp({ scene: title, config: { viewport: { width, height } } });
      app.setTheme({ font: { family: "Instrument Sans", size: 20, weight: 600 } });
      stepFrames(app);
      expect(auditUILayout(title)).toEqual([]);
      app.destroy();
    }
  });

  test("a title menu navigates with actions and picks entries", async () => {
    const app = await makeApp();
    const picked: string[] = [];
    const title = new TitleScene({ title: "Game", entries: [{ label: "Play", onPick: () => picked.push("play") }, { label: "Settings", onPick: () => picked.push("settings") }], version: "0.1" });
    app.scenes.change(title);
    app.frame(1 / 60);
    expect(title.name).toBe("title");
    expect(title.focus.index).toBe(0);
    title.onAction("down", true);
    title.onAction("confirm", true);
    expect(picked).toEqual(["settings"]);
    title.onAction("up", true);
    title.onAction("confirm", true);
    expect(picked).toEqual(["settings", "play"]);
  });

  test("pause ducks audio, resumes on back, and settings sliders nudge values", async () => {
    const app = await makeApp();
    const settings = createSettings(app);
    settings.reset();
    const play = new Scene();
    play.name = "play";
    app.scenes.change(play);
    app.frame(1 / 60);
    let quit = false;
    app.scenes.push(new PauseScene({ settings, onQuit: () => (quit = true) }), { overlay: true });
    app.frame(1 / 60);
    expect(app.scenes.current?.name).toBe("pause");
    expect(app.audio.paused).toBe(true);
    const pause = app.scenes.current as PauseScene;
    pause.onAction("down", true);
    pause.onAction("confirm", true);
    app.frame(1 / 60);
    expect(app.scenes.current?.name).toBe("settings");
    const s = app.scenes.current as SettingsScene;
    const master = s.ui.findAll(Slider).find((x) => x.name === "masterVolume") as Slider;
    expect(master.value).toBe(1);
    s.onAction("left", true);
    expect(master.value).toBeCloseTo(0.95, 6);
    expect(settings.data.masterVolume).toBeCloseTo(0.95, 6);
    s.onAction("back", true);
    app.frame(1 / 60);
    expect(app.scenes.current?.name).toBe("pause");
    // Focus stays on the entry the player came from (Settings); one step down is Quit.
    expect(pause.focus.index).toBe(1);
    pause.onAction("down", true);
    pause.onAction("confirm", true);
    expect(quit).toBe(true);
    pause.onAction("back", true);
    app.frame(1 / 60);
    expect(app.scenes.current).toBe(play);
    expect(app.audio.paused).toBe(false);
  });

  test("settings sliders align and pointer positions match their drawn tracks", async () => {
    const app = await makeApp();
    const settings = createSettings(app);
    const scene = new SettingsScene(settings);
    app.scenes.change(scene);
    app.frame(1 / 60);
    const sliders = scene.ui.findAll(Slider);
    expect(sliders).toHaveLength(4);
    const track = (slider: Slider) => (slider as unknown as { track(): { x: number; w: number } }).track();
    expect(new Set(sliders.map((slider) => track(slider).x)).size).toBe(1);
    const normalX = track(sliders[0]).x;
    settings.set({ textScale: 1.2 });
    app.frame(1 / 60);
    expect(new Set(sliders.map((slider) => track(slider).x)).size).toBe(1);
    expect(track(sliders[0]).x).toBeGreaterThan(normalX);
    expect((sliders[0].font as { size: number }).size).toBe(24);

    // Exercise the pointer math at the exact midpoint of a rendered track. The old
    // 40%-width hit-test guess made this click select a different value.
    const bare = new Scene();
    const slider = bare.ui.add(new Slider(20, 20, 380, 44, { label: "Music", labelWidth: 160, value: 0 }));
    app.scenes.change(bare);
    app.frame(1 / 60);
    const t = track(slider);
    app.pointer.handleDown(20 + t.x + t.w / 2, 42);
    slider.onPress();
    expect(slider.value).toBeCloseTo(0.5, 6);
  });

  test("controls capture the next key for the picked action", async () => {
    const app = await makeApp();
    const settings = createSettings(app);
    settings.reset();
    const controls = new ControlsScene(settings, { actions: ["jump"], labels: { jump: "Jump" } });
    app.scenes.change(controls);
    app.frame(1 / 60);
    controls.onAction("confirm", true);
    expect(app.keyEvent("KeyJ", true)).toBe(true);
    expect(app.input.bindingsOf("jump")).toEqual(["KeyJ", "GamepadA"]);
    // A controller button replaces the controller binding, keeping the key.
    controls.onAction("confirm", true);
    app.keyEvent("GamepadB", true);
    expect(app.input.bindingsOf("jump")).toEqual(["GamepadB", "KeyJ"]);
  });

  test("save slots scene lists, picks and deletes", async () => {
    const app = await makeApp();
    const slots = createSaveSlots<{ n: number }>({ key: "menu-test", version: 1, slots: 2, initial: () => ({ n: 0 }), summarize: (d) => `n ${d.n}` });
    slots.clearAll();
    slots.save(1, { n: 7 });
    const picks: [number, { n: number } | null][] = [];
    const scene = new SaveSlotsScene(slots, { onPick: (i, d) => picks.push([i, d]), allowDelete: true });
    app.scenes.change(scene);
    app.frame(1 / 60);
    scene.onAction("down", true);
    scene.onAction("confirm", true);
    expect(picks).toEqual([[1, { n: 7 }]]);
    // Delete slot 1 is disabled, so focus moves directly to Delete slot 2.
    scene.onAction("down", true);
    scene.onAction("confirm", true);
    expect(slots.has(1)).toBe(false);
    expect(scene instanceof MenuScene).toBe(true);
  });
});

describe("ConfirmScene", () => {
  test("the first row confirms, back cancels, and it pops itself either way", async () => {
    const app = await makeApp();
    const game = new Scene();
    game.name = "game";
    app.scenes.change(game);
    app.frame(1 / 60);
    let yes = 0;
    let no = 0;
    app.scenes.push(new ConfirmScene({ title: "Leave?", message: "Nothing is saved.", onConfirm: () => yes++, onCancel: () => no++ }), { overlay: true });
    app.frame(1 / 60);
    expect(app.scenes.current?.name).toBe("confirm");
    app.scenes.current?.onAction("confirm", true);
    app.frame(1 / 60);
    expect(yes).toBe(1);
    expect(app.scenes.current?.name).toBe("game");
    app.scenes.push(new ConfirmScene({ onConfirm: () => yes++, onCancel: () => no++ }), { overlay: true });
    app.frame(1 / 60);
    app.scenes.current?.onAction("back", true);
    app.frame(1 / 60);
    expect(no).toBe(1);
    expect(yes).toBe(1);
    expect(app.scenes.current?.name).toBe("game");
  });
});

describe("wrapText", () => {
  test("breaks on spaces within the width and keeps an oversized word on its own line", () => {
    const measure = (t: string) => t.length * 10;
    expect(wrapText("one two three four", 90, measure)).toEqual(["one two", "three", "four"]);
    expect(wrapText("supercalifragilistic is long", 50, measure)).toEqual(["supercalifragilistic", "is", "long"]);
    expect(wrapText("short", 500, measure)).toEqual(["short"]);
  });
});
