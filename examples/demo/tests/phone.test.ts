// On phones and tablets every screen of Wisp Hollow reads at 11 pt or more and every control is
// at least 44 pt across: the title, the play HUD with its touch controls, pause and the end of a
// run. The devices run the game's own `ui` settings from blackiron.json; a laptop keeps UI scale 1.

import { afterEach, describe, expect, test } from "bun:test";
import type { App } from "../../../src/app/app.ts";
import { resetImageRegistry } from "../../../src/art/images.ts";
import { resetSpriteRegistry, spriteDefs } from "../../../src/art/sprites.ts";
import { HeadlessPlatform } from "../../../src/platform/headless.ts";
import type { Scene } from "../../../src/scene/scene.ts";
import { Label } from "../../../src/scene/text.ts";
import { Button } from "../../../src/scene/ui.ts";
import { auditUILayout, createTestApp, drawnText, stepFrames } from "../../../src/testkit/index.ts";
import { defineAudio } from "../src/audio.ts";
import { OverScene } from "../src/scenes/over.ts";
import { PlayScene } from "../src/scenes/play.ts";
import { TitleScene } from "../src/scenes/title.ts";

const project = (await Bun.file(new URL("../blackiron.json", import.meta.url)).json()) as {
  name: string;
  viewport: { width: number; height: number; scale: "fit" };
  ui: { minPoints: number; tabletPoints: number };
};

// Each app paints the art afresh. The sprite registry is shared by every test file in the run and
// another file may have reset it; Bun keeps one copy of art.ts whatever the query string, so the
// module is dropped from the cache to make it define its sprites again.
const ART = new URL("../src/art.ts", import.meta.url).pathname;
async function paintArt(): Promise<void> {
  resetSpriteRegistry();
  resetImageRegistry();
  delete require.cache[ART];
  await import(ART);
  expect(spriteDefs().length).toBeGreaterThan(50);
}

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
});

async function on(device: string): Promise<App> {
  await paintArt();
  const platform = new HeadlessPlatform({ root: new URL("..", import.meta.url).pathname });
  const app = await createTestApp({ device, platform, config: { name: project.name, seed: 1, fps: false, viewport: project.viewport, ui: project.ui, render: { snap: "none", scale: "native" } } });
  apps.push(app);
  defineAudio(app.audio);
  return app;
}

/** What is too small on this frame, readable in a failure. */
function tooSmall(app: App): string[] {
  const a = app.auditScreen();
  return [
    ...a.smallText.map((t) => `text "${t.text}" ${t.points.toFixed(1)} pt`),
    ...a.smallTargets.map((t) => `target ${t.name ?? "?"} ${t.width.toFixed(0)}x${t.height.toFixed(0)} pt`),
  ];
}

/** Controls that leave the screen (overlaps between decorative layers are allowed). */
function offScreen(scene: Scene): string[] {
  return auditUILayout(scene)
    .filter((i) => i.kind !== "overlap")
    .map((i) => `${i.kind}: ${i.controls.map((c) => c.name || c.constructor.name).join(", ")}`);
}

/** Every visible button lies inside the UI layer, in UI units. */
function buttonsInside(scene: Scene): void {
  for (const b of scene.ui.findAll(Button)) {
    if (!isShown(b)) continue;
    const [x, y] = b.positionIn(scene.ui);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + b.w).toBeLessThanOrEqual(scene.uiWidth + 1e-6);
    expect(y + b.h).toBeLessThanOrEqual(scene.uiHeight + 1e-6);
  }
}

/** Visible buttons, as the player sees them. */
const shownButtons = (scene: Scene): Button[] => scene.ui.findAll(Button).filter((b) => scene.areaOf(b).ui && isShown(b));
function isShown(node: { visible: boolean; parent: unknown }): boolean {
  for (let n: { visible: boolean; parent: unknown } | null = node; n; n = n.parent as typeof n) if (n.visible === false) return false;
  return true;
}

for (const device of ["iphone-se", "iphone-15", "ipad"]) {
  describe(`Wisp Hollow on ${device}`, () => {
    test("title, play HUD, pause and the end of a run are readable and tappable, in touch wording", async () => {
      const app = await on(device);
      expect(app.screen.touch).toBe(true);
      expect(app.screen.uiScale).toBeGreaterThan(1);

      const title = app.scenes.change(new TitleScene());
      stepFrames(app, 3);
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(title)).toEqual([]);
      buttonsInside(title);
      let said = drawnText(app).join("\n");
      expect(said).toContain("Drag on the left to walk");
      expect(said).not.toContain("WASD");
      if (app.screen.compact) {
        // The phone layout: 14-unit captions and 56-unit buttons.
        expect(title.ui.findAll(Button).map((b) => b.h)).toEqual([56, 56]);
        const caption = title.ui.findAll(Label).find((l) => l.text.startsWith("BLACKIRON"))!;
        expect((caption.font as { size: number }).size).toBe(14);
      }

      const play = app.scenes.change(new PlayScene(1)) as PlayScene;
      stepFrames(app, 3);
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(play)).toEqual([]);
      // The stick and buttons show before the first touch, and the key hints stay out of their way.
      const targets = app.auditScreen().targets.map((t) => t.name);
      expect(targets).toContain("Pause");
      expect(targets).toContain("Hero");
      expect(drawnText(app)).toContain("HERO");
      expect(drawnText(app)).not.toContain("WASD");

      play.onAction("pause", true);
      stepFrames(app, 2);
      expect(shownButtons(play).map((b) => b.text)).toEqual(["RESUME", "QUIT TO TITLE"]);
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(play)).toEqual([]);
      buttonsInside(play);

      const over = app.scenes.change(new OverScene(12, true, 1));
      stepFrames(app, 3);
      expect(tooSmall(app)).toEqual([]);
      expect(offScreen(over)).toEqual([]);
      buttonsInside(over);
      said = drawnText(app).join("\n");
      expect(said).toContain("NEW BEST!");
      expect(said).not.toContain("Enter to play again");
    });
  });
}

test("a laptop keeps UI scale 1, the designed sizes and key hints", async () => {
  const app = await on("laptop");
  const title = app.scenes.change(new TitleScene());
  stepFrames(app, 3);
  expect(app.screen.uiScale).toBe(1);
  expect(title.ui.scaleX).toBe(1);
  expect([title.uiWidth, title.uiHeight]).toEqual([1280, 720]);
  expect(title.ui.findAll(Button).map((b) => [b.w, b.h])).toEqual([[280, 54], [220, 44]]);
  expect(drawnText(app).join("\n")).toContain("WASD or arrows to move");
  expect(app.auditScreen().ok).toBe(true);

  const play = app.scenes.change(new PlayScene(1)) as PlayScene;
  stepFrames(app, 3);
  expect(play.ui.scaleX).toBe(1);
  expect(drawnText(app)).toContain("WASD");
  expect(drawnText(app)).not.toContain("HERO");
  expect(app.auditScreen().targets.map((t) => t.name)).not.toContain("Pause");
  play.onAction("pause", true);
  stepFrames(app, 2);
  expect(shownButtons(play).map((b) => [b.w, b.h])).toEqual([[300, 48], [300, 48]]);

  const over = app.scenes.change(new OverScene(12, false, 1));
  stepFrames(app, 3);
  expect(over.ui.findAll(Button).map((b) => [b.w, b.h])).toEqual([[200, 46], [200, 46]]);
  expect(drawnText(app)).toContain("Enter to play again");
});
