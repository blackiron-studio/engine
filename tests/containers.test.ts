// Containers and accessibility: reversed rows for right-to-left, margins, pages, tabs, and focus
// changes read out through the platform.

import { beforeAll, describe, expect, test } from "bun:test";
import { defineSprite, resetSpriteRegistry } from "../src/art/index.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";
import type { FakeOp } from "../src/render/fake.ts";
import { Anchor, Button, FocusGroup, Label, Margin, NineSlice, Pages, Panel, Row, Scene, ScrollContainer, Sprite, Tabs } from "../src/scene/index.ts";
import { auditUILayout, createTestApp, lastFrame, stepFrames } from "../src/testkit/index.ts";

beforeAll(() => {
  resetSpriteRegistry();
  defineSprite("dot", { w: 10, h: 10 }, (p) => p.rect(0, 0, 10, 10, "#fff"));
  defineSprite("skin.normal", { w: 12, h: 12 }, (p) => p.rect(0, 0, 12, 12, "#345"));
  defineSprite("skin.hover", { w: 12, h: 12 }, (p) => p.rect(0, 0, 12, 12, "#678"));
});

describe("Containers", () => {
  test("a reversed row lays children out from the right", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const row = scene.ui.add(new Row({ gap: 4, reverse: true }));
    const a = row.add(new Button("A", 0, 0, 60, 20, {}));
    const b = row.add(new Button("B", 0, 0, 60, 20, {}));
    stepFrames(app);
    expect(a.x).toBeGreaterThan(b.x);
    expect(row.w).toBe(124);
    row.reverse = false;
    stepFrames(app);
    expect(a.x).toBeLessThan(b.x);
  });

  test("a margin pads its child's box; pages show one child; tabs switch them", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const m = scene.ui.add(new Margin(6));
    m.add(new Button("Inner", 0, 0, 60, 20, {}));
    stepFrames(app);
    expect(m.layoutBox()).toEqual({ w: 72, h: 32, ox: 0, oy: 0 });
    const tabs = scene.ui.add(new Tabs((label, onPress) => new Button(label, 0, 0, 60, 20, { onPress })));
    tabs.tab("Sound", new Label("Volume", 0, 0)).tab("Video", new Label("Scale", 0, 0));
    stepFrames(app);
    expect(tabs.selected).toBe(0);
    expect(tabs.pages.children[0].visible).toBe(true);
    expect(tabs.pages.children[1].visible).toBe(false);
    let changed = "";
    tabs.onChange = (_, name) => (changed = name);
    tabs.onAction("right", true);
    expect(tabs.selected).toBe(1);
    expect(changed).toBe("Video");
    expect(tabs.pages.children[1].visible).toBe(true);
    const pages = new Pages();
    pages.add(new Label("a", 0, 0)).name = "a";
    pages.add(new Label("b", 0, 0)).name = "b";
    pages.show("b");
    expect(pages.index).toBe(1);
  });

  test("moving focus announces the control's text through the platform", async () => {
    const platform = new HeadlessPlatform();
    const scene = new Scene();
    const app = await createTestApp({ scene, platform });
    const play = scene.ui.add(new Button("Play", 0, 0, 80, 24, {}));
    const quit = scene.ui.add(new Button("Quit", 0, 40, 80, 24, {}));
    const focus = new FocusGroup([play, quit]);
    focus.set(0);
    focus.move(1);
    expect(platform.announcements).toEqual(["Play", "Quit"]);
    app.accessibility.announce("Level two");
    expect(platform.announcements.at(-1)).toBe("Level two");
  });

  test("themes update existing controls and preserve explicit styling", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const panel = scene.ui.add(new Panel(0, 0, 100, 40));
    const button = scene.ui.add(new Button("Play", 0, 0, 100, 40));
    const custom = scene.ui.add(new Button("Custom", 0, 50, 100, 40, { style: { fill: 0x123456 } }));
    const label = scene.ui.add(new Label("Title"));
    app.setTheme({ text: 0x224466, panel: { fill: 0x335577 }, button: { fill: 0x446688 } });
    expect(panel.fill).toBe(0x335577);
    expect(button.style.fill).toBe(0x446688);
    expect(custom.style.fill).toBe(0x123456);
    expect(label.color).toBe(0x224466);
    button.style.fill = 0xabcdef;
    app.setTheme({ button: { fill: 0x777777 } });
    expect(button.style.fill).toBe(0xabcdef);
    app.destroy();
  });

  test("fitted UI anchors use design coordinates", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene, config: { viewport: { width: 1280, height: 720 } } });
    const corner = scene.ui.add(new Anchor({ x: "right", y: "bottom", w: 100, h: 40 }));
    scene.fitUI(720, 1280);
    stepFrames(app);
    expect(corner.x).toBe(620);
    expect(corner.y).toBe(1240);
    expect(scene.ui.scale).toBe(0.5625);
    app.destroy();
  });

  test("focus never activates disabled or hidden controls", () => {
    let fired = "";
    const first = new Button("Disabled", 0, 0, 80, 24, { onPress: () => { fired = "disabled"; } });
    const second = new Button("Hidden", 0, 0, 80, 24, { onPress: () => { fired = "hidden"; } });
    const third = new Button("Ready", 0, 0, 80, 24, { onPress: () => { fired = "ready"; } });
    first.disabled = true;
    second.visible = false;
    const focus = new FocusGroup([first, second, third]);
    focus.set(0);
    expect(focus.current).toBe(third);
    focus.onAction("confirm", true);
    expect(fired).toBe("ready");
    third.disabled = true;
    expect(focus.onAction("confirm", true)).toBe(false);
    expect(fired).toBe("ready");
  });

  test("sprite atlas bounds participate in row layout", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const row = scene.ui.add(new Row({ gap: 8 }));
    const art = row.add(new Sprite("dot"));
    const button = row.add(new Button("Next", 0, 0, 100, 30));
    stepFrames(app);
    expect(art.layoutBox().w).toBe(10);
    expect(button.x).toBe(18);
    expect(row.w).toBe(118);
    app.destroy();
  });

  test("theme skins draw nine-slice button states without replacing the control", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const button = scene.ui.add(new Button("Play", 20, 20, 180, 48));
    app.setTheme({ button: { skin: { normal: "skin.normal", hover: "skin.hover", inset: 3 } } });
    stepFrames(app);
    expect(button.hovered).toBe(false);
    expect(lastFrame(app).filter((op) => op.op === "sprite" && op.name.startsWith("skin.normal#")).length).toBe(9);
    button.focused = true;
    stepFrames(app);
    expect(lastFrame(app).filter((op) => op.op === "sprite" && op.name.startsWith("skin.hover#")).length).toBe(9);
    app.destroy();
  });

  test("nine-slice corners shrink inside narrow controls", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const frame = scene.ui.add(new NineSlice("skin.normal", 0, 0, 4, 4, 3));
    scene.ui.add(new Button("", 10, 0, 4, 4, { style: { skin: { normal: "skin.normal", inset: 3 } } }));
    stepFrames(app);
    const parts = lastFrame(app).filter((op): op is Extract<FakeOp, { op: "sprite" }> => op.op === "sprite" && op.name.startsWith("skin.normal#"));
    expect(parts.length).toBe(8);
    for (const part of parts) {
      const localX = part.x;
      const localY = part.y;
      const sourceW = part.name.endsWith("0") || part.name.endsWith("2") ? 3 : 6;
      const sourceH = part.name.includes("#0") || part.name.includes("#2") ? 3 : 6;
      expect(localX).toBeGreaterThanOrEqual(0);
      expect(localY).toBeGreaterThanOrEqual(0);
      expect(localX + sourceW * part.sx).toBeLessThanOrEqual(4);
      expect(localY + sourceH * part.sy).toBeLessThanOrEqual(4);
    }
    frame.inset = 1;
    stepFrames(app);
    expect(lastFrame(app).filter((op) => op.op === "sprite" && op.name === "skin.normal#11").length).toBe(1);
    app.destroy();
  });

  test("UI audit detects off-screen and overlapping controls in fitted coordinates", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene, config: { viewport: { width: 1280, height: 720 } } });
    scene.fitUI(720, 1280);
    const a = scene.ui.add(new Button("A", 10, 10, 100, 50));
    const b = scene.ui.add(new Button("B", 80, 20, 100, 50));
    const outside = scene.ui.add(new Button("Outside", 690, 1200, 100, 50));
    const hidden = scene.ui.add(new Button("Hidden", 690, 1200, 100, 50));
    hidden.visible = false;
    stepFrames(app);
    const issues = auditUILayout(scene);
    expect(issues.filter((issue) => issue.kind === "outside").map((issue) => issue.controls[0])).toEqual([outside]);
    expect(issues.some((issue) => issue.kind === "overlap" && issue.controls.includes(a) && issue.controls.includes(b))).toBe(true);
    expect(auditUILayout(scene, { allowOverlap: (one, two) => one === a && two === b }).some((issue) => issue.kind === "overlap" && issue.controls.includes(a))).toBe(false);
    app.destroy();
  });

  test("UI audit clips scrolled children and ignores invisible pages", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const scroll = scene.ui.add(new ScrollContainer(10, 10, 100, 60, { contentHeight: 200 }));
    const visible = scroll.content.add(new Button("Visible", 0, 0, 80, 25));
    scroll.content.add(new Button("Below", 0, 120, 80, 25));
    const hiddenParent = scene.ui.add(new Panel(0, 0, 100, 40));
    hiddenParent.visible = false;
    hiddenParent.add(new Button("Hidden", 0, 0, 80, 25));
    stepFrames(app);
    expect(auditUILayout(scene)).toEqual([]);
    visible.x = 90;
    stepFrames(app);
    expect(auditUILayout(scene).filter((issue) => issue.kind === "outside")).toEqual([]);
    app.destroy();
  });

  test("scroll extents include sprites and immediate hit tests use the new offset", async () => {
    const scene = new Scene();
    const app = await createTestApp({ scene });
    const scroll = scene.ui.add(new ScrollContainer(10, 10, 100, 60));
    scroll.content.add(new Sprite("dot", 0, 100));
    expect(scroll.maxScrollY).toBe(45);
    const target = scroll.content.add(new Button("Target", 0, 120, 80, 25));
    scroll.scrollTo(0, 120);
    expect(scroll.scrollY).toBe(85);
    expect(scroll.content.y).toBe(-85);
    expect(target.hitTest(20, 50)).toBe(true);
    scroll.scrollTo(NaN, Infinity);
    expect([scroll.scrollX, scroll.scrollY]).toEqual([0, 0]);
    app.destroy();
  });
});
