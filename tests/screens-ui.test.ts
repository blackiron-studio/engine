// 0.23.2: the engine's own UI on small screens. Touch screens start in touch mode; hints,
// menus, sticks and tooltips size themselves in the grown UI layer; menu rows reach 44 pt on
// touch and flow into columns when the screen is short; the audit tells scenery from UI text
// and measures tap targets a game draws itself.

import { describe, expect, test } from "bun:test";
import type { App } from "../src/app/app.ts";
import type { DrawContext } from "../src/scene/draw.ts";
import { Column, Node2D, Scene, Slider, VirtualSticks } from "../src/scene/index.ts";
import { Label } from "../src/scene/text.ts";
import { HintLayer, Hints, SettingsScene, bindShellActions, createSettings } from "../src/shell/index.ts";
import { auditUILayout, createTestApp, stepFrames } from "../src/testkit/index.ts";

const phoneDesign = { viewport: { width: 1280, height: 720, scale: "expand" as const }, ui: { minPoints: 0.8 } };

/** Every rect drawn in one frame, in logical screen units. */
function rectsDrawn(app: App): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const draw = app.draw as DrawContext;
  const rect = draw.rect.bind(draw);
  draw.rect = ((x: number, y: number, w: number, h: number, ...rest: unknown[]) => {
    const t = draw.transform;
    out.push({ x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5], w: w * Math.abs(t[0]), h: h * Math.abs(t[3]) });
    return (rect as (...a: unknown[]) => void)(x, y, w, h, ...rest);
  }) as typeof draw.rect;
  try {
    app.frame(1 / 60);
  } finally {
    draw.rect = rect;
  }
  return out;
}

describe("touch mode", () => {
  test("a touch screen starts in touch mode; keys switch it; leaving the phone goes back to keys", async () => {
    const phone = await createTestApp({ device: "iphone-15", config: phoneDesign });
    expect(phone.input.lastDevice).toBe("touch");
    phone.emulateDevice(null);
    expect(phone.input.lastDevice).toBe("keyboard");
    phone.emulateDevice("ipad");
    expect(phone.input.lastDevice).toBe("touch");
    const laptop = await createTestApp({ device: "laptop", config: phoneDesign });
    expect(laptop.input.lastDevice).toBe("keyboard");
  });
});

describe("the engine's UI in a grown UI layer", () => {
  test("the hint panel is centred above the home bar, inside the screen", async () => {
    const app = await createTestApp({ device: "iphone-15", config: phoneDesign });
    const scene = new Scene();
    const hints = new Hints(app, [{ id: "move", text: "Drag the left stick to move and tap a shrine to pray" }]);
    scene.ui.add(new HintLayer(hints));
    app.scenes.change(scene);
    stepFrames(app, 30);
    expect(scene.ui.scaleX).toBeGreaterThan(1.3);
    const rects = rectsDrawn(app);
    const panel = rects.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    expect(Math.abs(panel.x + panel.w / 2 - app.width / 2)).toBeLessThan(2);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.w).toBeLessThanOrEqual(app.width);
    expect(panel.y + panel.h).toBeLessThanOrEqual(app.height - app.safeInsets[2]);
  });

  test("settings rows are 44 pt on a phone and flow into columns that fit it", async () => {
    const app = await createTestApp({ device: "iphone-se", config: phoneDesign });
    bindShellActions(app);
    const settings = createSettings(app);
    const scene = new SettingsScene(settings);
    app.scenes.change(scene);
    stepFrames(app, 2);
    const audit = app.auditScreen();
    expect(audit.smallTargets).toEqual([]);
    expect(auditUILayout(scene).filter((i) => i.kind === "outside")).toEqual([]);
    const list = (scene as unknown as { list: Column }).list;
    expect(list.lines).toBe(2);
    // Left and right move between the columns on a row that is not a slider, level with it.
    const rows = (scene as unknown as { rows: { name: string; x: number; y: number }[] }).rows;
    const mute = rows.findIndex((r) => r.name === "muted");
    scene.focus.set(mute);
    scene.onAction("left", true);
    const to = rows[scene.focus.index];
    expect(to.x).toBeLessThan(rows[mute].x);
    expect(to.y).toBe(rows[mute].y);
  });

  test("on a laptop the settings stay one column of 44-unit rows", async () => {
    const app = await createTestApp({ device: "laptop", config: phoneDesign });
    bindShellActions(app);
    const scene = new SettingsScene(createSettings(app));
    app.scenes.change(scene);
    stepFrames(app, 2);
    expect((scene as unknown as { list: Column }).list.lines).toBe(1);
    expect(scene.ui.findAll(Slider)[0].h).toBe(44);
  });

  test("the dim covers the whole screen under a fitted UI", async () => {
    const app = await createTestApp({ device: "iphone-15", config: { viewport: { width: 1280, height: 720, scale: "expand" as const } } });
    bindShellActions(app);
    const scene = new SettingsScene(createSettings(app));
    scene.fitUI(1280, 720);
    app.scenes.change(scene);
    stepFrames(app, 1);
    expect(scene.ui.x).toBeGreaterThan(0);
    const dim = rectsDrawn(app)[0];
    expect(dim.x).toBeLessThanOrEqual(0);
    expect(dim.x + dim.w).toBeGreaterThanOrEqual(app.width);
  });

  test("virtual sticks in the grown UI read touches in UI units", async () => {
    const app = await createTestApp({ device: "iphone-15", config: phoneDesign });
    const scene = new Scene();
    const sticks = scene.ui.add(new VirtualSticks({ sticks: [{ zone: "left" }, { zone: "right" }], size: 50, always: true }));
    app.scenes.change(scene);
    stepFrames(app, 1);
    const k = scene.ui.scaleX;
    expect(k).toBeGreaterThan(1.3);
    const host = app.bindHost();
    // A finger just left of the middle of the screen is the left stick's, whatever the UI scale.
    host.pointerLogical("down", 1, app.width / 2 - 20, 500);
    stepFrames(app, 1);
    host.pointerLogical("move", 1, app.width / 2 - 20 + 25 * k, 500);
    stepFrames(app, 1);
    expect(sticks.held(0)).toBe(true);
    expect(sticks.held(1)).toBe(false);
    // 25 UI units of travel on a 50-unit stick is half deflection.
    expect(sticks.vector(0).x).toBeCloseTo(0.5, 2);
  });

  test("a slider's value text clears its knob at 100%", async () => {
    const app = await createTestApp({ config: { viewport: { width: 1280, height: 720 } } });
    app.setTheme({ font: { family: "Instrument Sans", size: 26, weight: 600 } });
    const scene = new Scene();
    const s = scene.ui.add(new Slider(0, 0, 380, 55, { label: "Music", value: 1 }));
    app.scenes.change(scene);
    stepFrames(app, 1);
    const t = (s as unknown as { track(): { x: number; w: number } }).track();
    const knob = Math.round(Math.max(4, Math.round(55 * 0.28)) * 1.6);
    const text = app.renderer.measureText("100%", { family: "Instrument Sans", size: 26, weight: 600 }).width;
    expect(t.x + t.w + knob / 2).toBeLessThan(s.w - text);
  });
});

describe("wrapping stacks", () => {
  test("a column flows into side-by-side columns past `wrap`", async () => {
    const app = await createTestApp();
    const scene = new Scene();
    const col = scene.ui.add(new Column({ gap: 10, lineGap: 20, wrap: 110 }));
    const boxes = [0, 1, 2, 3, 4].map(() => col.add(new Box(40, 30)));
    app.scenes.change(scene);
    col.layout();
    expect(col.lines).toBe(2);
    expect(boxes.map((b) => [b.x, b.y])).toEqual([[0, 0], [0, 40], [0, 80], [60, 0], [60, 40]]);
    expect([col.w, col.h]).toEqual([100, 110]);
    col.wrap = 0;
    col.layout();
    expect([col.lines, col.w, col.h]).toEqual([1, 40, 190]);
  });
});

class Box extends Node2D {
  constructor(
    public w: number,
    public h: number,
  ) {
    super();
  }
}

class Street extends Scene {
  drawButton = true;
  override ready(): void {
    // A sign painted in the world, a label in the HUD, scenery drawn over the world by hand.
    this.world.add(new Label("MARKET ST", 100, 100, { font: { family: "system-ui", size: 9 } }));
    this.ui.add(new Label("CASH 120", 20, 20, { font: { family: "system-ui", size: 16 } }));
    const scene = this;
    this.ui.add(
      new (class extends Node2D {
        override render(ctx: DrawContext): void {
          ctx.text("GARAGE", 300, 300, { font: { family: "system-ui", size: 8 }, scenery: true });
          if (scene.drawButton) {
            ctx.rect(40, 300, 30, 30, 0xffffff);
            scene.reportTarget("Horn", 40, 300, 30, 30);
          }
        }
      })(),
    );
  }
}

describe("auditScreen: scenery and reported targets", () => {
  test("small scenery is reported apart and does not fail the screen", async () => {
    const app = await createTestApp({ device: "iphone-15", config: phoneDesign });
    const scene = new Street();
    scene.drawButton = false;
    app.scenes.change(scene);
    stepFrames(app, 1);
    const a = app.auditScreen();
    expect(a.smallText).toEqual([]);
    expect(a.smallWorldText.map((t) => t.text).sort()).toEqual(["GARAGE", "MARKET ST"]);
    expect(a.text.find((t) => t.text === "CASH 120")?.layer).toBe("ui");
    expect(a.ok).toBe(true);
  });

  test("targets a game draws itself are measured with the controls, and only while drawn", async () => {
    const app = await createTestApp({ device: "iphone-15", config: phoneDesign });
    const scene = new Street();
    app.scenes.change(scene);
    stepFrames(app, 1);
    const a = app.auditScreen();
    const horn = a.smallTargets.find((t) => t.name === "Horn");
    expect(horn?.width).toBeCloseTo(30 * 0.8, 0);
    expect(a.ok).toBe(false);
    expect(scene.reportedTargets).toEqual([{ name: "Horn", x: 40, y: 300, w: 30, h: 30 }]);
    scene.drawButton = false;
    const b = app.auditScreen();
    expect(b.targets.find((t) => t.name === "Horn")).toBeUndefined();
    expect(b.ok).toBe(true);
  });
});
