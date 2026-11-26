import { describe, expect, test } from "bun:test";
import { describeScreen, devicePreset, legibleScale } from "../src/app/screen.ts";
import { Anchor } from "../src/scene/layout.ts";
import { Scene } from "../src/scene/scene.ts";
import { Label } from "../src/scene/text.ts";
import { Button } from "../src/scene/ui.ts";
import { createTestApp, stepFrames } from "../src/testkit/index.ts";

const desktopDesign = { viewport: { width: 1280, height: 720, scale: "expand" as const } };

class Hud extends Scene {
  resizes = 0;
  readonly corner = this.ui.add(new Anchor({ x: "right", y: "top", w: 100, h: 40, safe: 8, safeArea: true }));
  readonly label = this.ui.add(new Label("AMMO 24", 20, 20, { font: { family: "system-ui", size: 14 } }));
  readonly button = this.ui.add(new Button("Fire", 20, 60, 60, 30));
  override onResize(): void {
    this.resizes++;
  }
}

describe("screen description", () => {
  test("device presets give points, insets and orientation", () => {
    const p = devicePreset("iphone-15");
    expect([p.width, p.height, p.touch, p.name]).toEqual([852, 393, true, "iphone-15-landscape"]);
    expect(p.insets).toEqual([0, 59, 21, 59]);
    const q = devicePreset("iphone-15-portrait");
    expect([q.width, q.height]).toEqual([393, 852]);
    expect(q.insets).toEqual([59, 0, 34, 0]);
    expect(devicePreset("ipad", "portrait").height).toBe(1180);
    expect(() => devicePreset("nokia-3310")).toThrow(RangeError);
  });

  test("size classes and the legible scale", () => {
    const phone = describeScreen({ width: 852, height: 393, pixelRatio: 3, insets: [0, 59, 21, 59], touch: true, pointsPerUnit: 393 / 720 }, { minPoints: 0.8 });
    expect(phone.sizeClass).toBe("phone");
    expect(phone.compact).toBe(true);
    expect(phone.orientation).toBe("landscape");
    expect(phone.uiScale).toBeCloseTo(0.8 / (393 / 720), 6);
    const tablet = describeScreen({ width: 1180, height: 820, pixelRatio: 2, insets: [0, 0, 20, 0], touch: true, pointsPerUnit: 0.92 }, { minPoints: 0.8 });
    expect([tablet.sizeClass, tablet.compact, tablet.uiScale]).toEqual(["tablet", false, 1]);
    const small = describeScreen({ width: 900, height: 500, pixelRatio: 2, insets: [0, 0, 0, 0], touch: false, pointsPerUnit: 0.69 });
    expect([small.sizeClass, small.compact, small.uiScale]).toEqual(["desktop", true, 1]);
    expect(legibleScale(0.3, 0.8)).toBe(2);
    expect(legibleScale(0.3, 0.8, 1.5)).toBe(1.5);
    expect(legibleScale(1.2, 0.8)).toBe(1);
    expect(legibleScale(0.5, 0)).toBe(1);
  });
});

describe("App.screen and the UI on small screens", () => {
  test("a device sets the screen, the logical size and the safe insets", async () => {
    const app = await createTestApp({ device: "iphone-15", config: desktopDesign });
    expect(app.screen.sizeClass).toBe("phone");
    expect(app.screen.touch).toBe(true);
    expect(app.width).toBe(Math.round((720 * 852) / 393));
    expect(app.height).toBe(720);
    expect(app.screen.pointsPerUnit).toBeCloseTo(393 / 720, 2);
    // 59-point notch on the left: 59 × 720 / 393 logical units.
    expect(app.safeInsets[3]).toBeCloseTo((59 * 720) / 393, 0);
    expect(app.safeInsets[0]).toBe(0);
    app.destroy();
  });

  test("ui.minPoints grows the UI layer and shrinks the UI size to match", async () => {
    const app = await createTestApp({ device: "iphone-15", config: { ...desktopDesign, ui: { minPoints: 0.8 } } });
    const scene = new Hud();
    app.scenes.change(scene);
    const k = 0.8 / app.screen.pointsPerUnit;
    expect(scene.ui.scaleX).toBeCloseTo(k, 6);
    expect(scene.uiWidth).toBeCloseTo(app.width / k, 6);
    expect(scene.uiHeight).toBeCloseTo(720 / k, 6);
    // Insets in UI units, and the safe rectangle inside them.
    const [, right, bottom, left] = scene.uiInsets;
    expect(left).toBeCloseTo(app.safeInsets[3] / k, 6);
    expect(right).toBeCloseTo(app.safeInsets[1] / k, 6);
    expect(bottom).toBeCloseTo(app.safeInsets[2] / k, 6);
    expect(scene.safeRect.x).toBeCloseTo(left, 6);
    expect(scene.safeRect.w).toBeCloseTo(scene.uiWidth - left - right, 6);
    // The anchored corner keeps clear of the notch on the right.
    stepFrames(app, 1);
    expect(scene.corner.x).toBeCloseTo(scene.uiWidth - 8 - right - 100, 6);
    expect(scene.corner.y).toBe(8);
    // Back on a desktop the UI is full size again.
    app.emulateDevice("desktop");
    expect(scene.ui.scaleX).toBe(1);
    expect(scene.uiWidth).toBe(app.width);
    app.destroy();
  });

  test("without ui.minPoints a scene's own UI scale is left alone", async () => {
    const app = await createTestApp({ device: "iphone-se", config: desktopDesign });
    const scene = new Hud();
    scene.ui.scale = 1.5;
    app.scenes.change(scene);
    app.emulateDevice("iphone-15");
    expect(scene.ui.scaleX).toBe(1.5);
    expect(app.screen.uiScale).toBe(1);
    app.destroy();
  });

  test("scenes hear about screen changes that keep the logical size", async () => {
    // "fit" keeps 1280 × 720 everywhere, so only the screen changes between devices.
    const app = await createTestApp({ device: "iphone-se", config: { viewport: { width: 1280, height: 720, scale: "fit" } } });
    const scene = new Hud();
    app.scenes.change(scene);
    const before = scene.resizes;
    app.emulateDevice("ipad");
    expect(app.width).toBe(1280);
    expect(scene.resizes).toBe(before + 1);
    expect(scene.compact).toBe(false);
    app.emulateDevice("iphone-se");
    expect(scene.compact).toBe(true);
    expect(scene.resizes).toBe(before + 2);
    app.emulateDevice("iphone-se");
    expect(scene.resizes).toBe(before + 2);
    app.destroy();
  });
});

test("a scene may keep its own `screen` field", async () => {
  // Games often name their menu state `screen`; the engine's getter is `screenInfo`.
  class Menu extends Scene {
    screen: "title" | "play" = "title";
  }
  const app = await createTestApp({ device: "iphone-15", config: desktopDesign });
  const scene = new Menu();
  app.scenes.change(scene);
  scene.screen = "play";
  expect(scene.screen).toBe("play");
  expect(scene.screenInfo.sizeClass).toBe("phone");
  expect(scene.compact).toBe(true);
  app.destroy();
});

describe("auditScreen", () => {
  test("flags text and touch targets too small for a phone, and passes them once the UI grows", async () => {
    const fit = { viewport: { width: 1280, height: 720, scale: "fit" as const } };
    const app = await createTestApp({ device: "iphone-se", config: fit });
    app.scenes.change(new Hud());
    stepFrames(app, 1);
    const a = app.auditScreen();
    const ppu = app.screen.pointsPerUnit;
    expect(ppu).toBeCloseTo(375 / 720, 2);
    const ammo = a.text.find((t) => t.text === "AMMO 24")!;
    expect(ammo.points).toBeCloseTo(14 * ppu, 3);
    expect(a.smallText.map((t) => t.text)).toContain("AMMO 24");
    const fire = a.targets.find((t) => t.name.includes("Fire"))!;
    expect(fire.width).toBeCloseTo(60 * ppu, 3);
    expect(a.smallTargets.length).toBe(1);
    expect(a.ok).toBe(false);
    app.destroy();

    const grown = await createTestApp({ device: "iphone-se", config: { ...fit, ui: { minPoints: 0.8 } } });
    grown.scenes.change(new Hud());
    stepFrames(grown, 1);
    const b = grown.auditScreen();
    expect(b.text.find((t) => t.text === "AMMO 24")!.points).toBeCloseTo(14 * 0.8, 3);
    expect(b.smallText.find((t) => t.text === "AMMO 24")).toBeUndefined();
    // 60 × 30 units grow to 48 × 24 points: wide enough, still too short to tap.
    const f = b.smallTargets.find((t) => t.name.includes("Fire"))!;
    expect(f.width).toBeCloseTo(48, 3);
    expect(f.height).toBeCloseTo(24, 3);
    grown.destroy();
  });

  test("touch targets are only checked on touch screens", async () => {
    const app = await createTestApp({ device: "laptop", config: { viewport: { width: 1280, height: 720, scale: "fit" } } });
    app.scenes.change(new Hud());
    stepFrames(app, 1);
    const a = app.auditScreen();
    expect(a.screen.touch).toBe(false);
    expect(a.targets.length).toBe(1);
    expect(a.smallTargets).toEqual([]);
    app.destroy();
  });
});
