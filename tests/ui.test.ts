// The new UI: text input editing and focus, rich text parsing and wrapping, grids,
// scroll containers and tooltips, driven through a headless App.

import { beforeAll, describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { Button, Grid, Label, RichText, Scene, ScrollContainer, TextInput, Tooltip } from "../src/scene/index.ts";

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 4, h: 4 }, (p) => p.rect(0, 0, 4, 4, "#fff"));
});

async function appWith(scene: Scene): Promise<App> {
  const app = await App.create({ headless: true, config: { seed: 1, viewport: { width: 640, height: 360 }, fps: false } });
  app.scenes.change(scene);
  app.frame(1 / 60);
  return app;
}

describe("TextInput", () => {
  test("focus, typing, editing keys and submit", async () => {
    const scene = new Scene();
    const app = await appWith(scene);
    const submitted: string[] = [];
    const input = scene.ui.add(new TextInput(10, 10, 200, 24, { placeholder: "name", maxLength: 8, onSubmit: (v) => submitted.push(v) }));
    // Press inside the field to focus it.
    app.pointer.handleMove(50, 20);
    app.pointer.handleDown(50, 20);
    app.frame(1 / 60);
    app.pointer.handleUp(50, 20);
    app.frame(1 / 60);
    expect(scene.activeInput).toBe(input);
    expect(input.focused).toBe(true);
    // Typed text goes to the field; letters no longer reach the action map.
    app.input.map({ left: ["KeyA"] });
    app.textEvent("Hel");
    app.textEvent("lo");
    expect(app.keyEvent("KeyA", true)).toBe(true);
    app.frame(1 / 60);
    expect(input.value).toBe("Hello");
    expect(app.input.isDown("left")).toBe(false);
    app.keyEvent("Backspace", true);
    app.keyEvent("ArrowLeft", true);
    app.textEvent("!");
    app.frame(1 / 60);
    expect(input.value).toBe("Hel!l");
    app.textEvent("verylongtext");
    app.frame(1 / 60);
    expect(input.value.length).toBe(8);
    app.keyEvent("Enter", true);
    expect(submitted).toEqual([input.value]);
    // Clicking elsewhere blurs.
    app.pointer.handleMove(400, 300);
    app.pointer.handleDown(400, 300);
    app.frame(1 / 60);
    expect(scene.activeInput).toBeNull();
    expect(app.keyEvent("KeyA", true)).toBe(true);
    expect(app.input.isDown("left")).toBe(true);
  });
});

describe("RichText", () => {
  test("parses tags and wraps to a width", async () => {
    const scene = new Scene();
    await appWith(scene);
    const rich = scene.ui.add(new RichText("[b]Bold[/b] and [color=#ff8800]orange[/color] text [icon=dot] here\nsecond line", 0, 0, { wrap: 60 }));
    expect(rich.lineCount).toBeGreaterThan(2);
    expect(rich.width).toBeLessThanOrEqual(60 + 5);
    rich.markup = "short";
    rich.wrap = 0;
    expect(rich.lineCount).toBe(1);
  });
});

describe("Grid and ScrollContainer", () => {
  test("a grid lays out cells and a scroll container clamps and clips hits", async () => {
    const scene = new Scene();
    const app = await appWith(scene);
    const scroll = scene.ui.add(new ScrollContainer(0, 0, 200, 100));
    const grid = scroll.content.add(new Grid({ cols: 2, gap: 4 }));
    const pressed: number[] = [];
    for (let i = 0; i < 10; i++) grid.add(new Button(`B${i}`, 0, 0, 90, 30, { onPress: () => pressed.push(i) }));
    grid.layout();
    expect(grid.w).toBe(184);
    expect(grid.h).toBe(5 * 30 + 4 * 4);
    app.frame(1 / 60);
    expect(scroll.maxScrollY).toBe(grid.h - 100);
    scroll.scrollTo(0, 1000);
    expect(scroll.scrollY).toBe(scroll.maxScrollY);
    scroll.scrollTo(0, 0);
    // The third row is below the box and must not be clickable.
    app.pointer.handleMove(20, 68 + 34 * 2);
    app.pointer.handleDown(20, 68 + 34 * 2);
    app.frame(1 / 60);
    app.pointer.handleUp(20, 68 + 34 * 2);
    app.frame(1 / 60);
    expect(pressed).toEqual([]);
    // A wheel over the box scrolls it.
    app.pointer.handleMove(20, 20);
    app.pointer.handleWheel(40);
    app.frame(1 / 60);
    expect(scroll.scrollY).toBeGreaterThan(0);
  });

  test("a tooltip appears after hovering its control", async () => {
    const scene = new Scene();
    const app = await appWith(scene);
    const button = scene.ui.add(new Button("Save", 100, 100, 80, 30));
    const tip = scene.ui.add(new Tooltip(button, "Saves the game", { delay: 0.2 }));
    scene.ui.add(new Label("x", 0, 0));
    app.pointer.handleMove(120, 110);
    for (let i = 0; i < 20; i++) app.frame(1 / 60);
    expect(tip.visibleNow).toBe(true);
    app.pointer.handleMove(300, 300);
    app.frame(1 / 60);
    expect(tip.visibleNow).toBe(false);
  });
});
