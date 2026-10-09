import { beforeAll, expect, test } from "bun:test";
import { App } from "../../../src/app/app.ts";
import { resetSpriteRegistry } from "../../../src/art/sprites.ts";
import { resetImageRegistry } from "../../../src/art/images.ts";
import { HeadlessPlatform } from "../../../src/platform/headless.ts";
import { Rig2D } from "../../../src/scene/rig.ts";
import { Button } from "../../../src/scene/ui.ts";
import { LanternKeeper } from "../src/scenery.ts";
import { PlayScene } from "../src/scenes/play.ts";
import { TitleScene } from "../src/scenes/title.ts";
import { defineAudio } from "../src/audio.ts";

beforeAll(async () => {
  resetSpriteRegistry();
  resetImageRegistry();
  await import(new URL("../src/art.ts", import.meta.url).href + "?presentation-tests");
});

async function makeApp(): Promise<App> {
  const app = await App.create({ headless: true, platform: new HeadlessPlatform({ root: new URL("..", import.meta.url).pathname }),
    config: { seed: 1, fps: false, viewport: { width: 1280, height: 720 }, render: { snap: "none", scale: "native" } } });
  defineAudio(app.audio);
  return app;
}

test("the keeper is positioned and alternate characters hidden before the first simulation step", async () => {
  const app = await makeApp();
  try {
    const scene = app.scenes.change(new PlayScene(1)) as PlayScene;
    const keeper = scene.world.findAll(LanternKeeper)[0];
    expect([keeper.x, keeper.y]).toEqual([scene.state.player.x, scene.state.player.y]);
    expect(keeper.visible).toBe(true);
    expect(scene.world.findAll(Rig2D)[0].visible).toBe(false);
    expect(scene.state.time).toBe(0);
    app.frame(0);
    const resume = scene.ui.findAll(Button).find(b => b.text === "RESUME")!;
    const [x,y] = resume.toScreen(5,5);
    expect(resume.hitTest(x,y)).toBe(false);
    scene.onAction("pause", true);
    app.frame(0);
    const [shownX,shownY] = resume.toScreen(5,5);
    expect(resume.hitTest(shownX,shownY)).toBe(true);
    app.input.press("right");
    for (let i = 0; i < 12; i++) app.frame(1/60);
    expect(scene.state.time).toBe(0);
    expect([keeper.x, keeper.y]).toEqual([scene.state.player.x, scene.state.player.y]);
    scene.onAction("pause", true);
    app.frame(1/60);
    expect(scene.state.time).toBeGreaterThan(0);
  } finally { app.destroy(); }
});

test("a title button opens play without starting pointer movement or activating hidden pause controls", async () => {
  const app = await makeApp();
  try {
    const title = app.scenes.change(new TitleScene());
    app.frame(0);
    const enter = title.ui.findAll(Button).find(b => b.text === "ENTER THE HOLLOW")!;
    const [x,y] = enter.toScreen(50,20);
    app.pointer.handleDown(x,y);
    app.frame(1/120);
    expect(app.scene).toBe(title);
    app.pointer.handleUp(x,y);
    app.frame(1/120);
    expect(app.scene).toBeInstanceOf(PlayScene);
    const play = app.scene as PlayScene;
    expect(play.state.player.moving).toBe(false);
    expect(play.world.paused).toBe(false);
  } finally { app.destroy(); }
});
