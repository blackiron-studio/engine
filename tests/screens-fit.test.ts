// 0.24: a tablet tier for UI scaling, anchors that stretch or take a fraction of the screen,
// text that shrinks or is cut to fit, and the system's text size.

import { describe, expect, test } from "bun:test";
import { describeScreen } from "../src/app/screen.ts";
import { Anchor, Button, Label, Scene, ellipsize } from "../src/scene/index.ts";
import { createSettings } from "../src/shell/index.ts";
import { createTestApp, stepFrames } from "../src/testkit/index.ts";

const design = { viewport: { width: 1280, height: 720, scale: "expand" as const } };
const font = { family: "system-ui", size: 16 };

describe("tablet tier", () => {
  test("tabletPoints grows the UI on tablets only", async () => {
    const ui = { minPoints: 0.8, tabletPoints: 1.2 };
    const ipad = await createTestApp({ device: "ipad", config: { ...design, ui } });
    expect(ipad.screen.sizeClass).toBe("tablet");
    expect(ipad.screen.uiScale).toBeCloseTo(1.2 / ipad.screen.pointsPerUnit, 6);
    const scene = new Scene();
    ipad.scenes.change(scene);
    stepFrames(ipad, 1);
    expect(scene.ui.scaleX).toBeCloseTo(ipad.screen.uiScale, 6);
    expect(scene.uiWidth).toBeCloseTo(ipad.width / ipad.screen.uiScale, 4);
    const phone = await createTestApp({ device: "iphone-15", config: { ...design, ui } });
    expect(phone.screen.uiScale).toBeCloseTo(0.8 / phone.screen.pointsPerUnit, 6);
    const laptop = await createTestApp({ device: "laptop", config: { ...design, ui } });
    expect(laptop.screen.uiScale).toBe(1);
    // tabletPoints alone, without minPoints, still grows a tablet's UI.
    const only = await createTestApp({ device: "ipad", config: { ...design, ui: { tabletPoints: 1.2 } } });
    const s2 = new Scene();
    only.scenes.change(s2);
    expect(s2.ui.scaleX).toBeGreaterThan(1.2);
  });
});

describe("anchors that follow the screen", () => {
  test("stretch runs between the safe edges; fractions and limits size the box", async () => {
    const app = await createTestApp({ device: "iphone-15", config: { ...design, ui: { minPoints: 0.8 } } });
    const scene = new Scene();
    const sizes: number[][] = [];
    const bar = scene.ui.add(new Anchor({ x: "stretch", y: "bottom", h: 60, safe: 10, safeArea: true, onLayout: (w, h) => sizes.push([w, h]) }));
    const side = scene.ui.add(new Anchor({ x: "right", y: "stretch", wFrac: 0.25, minW: 200, safe: 10 }));
    const sheet = scene.ui.add(new Anchor({ x: "stretch", y: "stretch", maxW: 400, hFrac: 0.5 }));
    app.scenes.change(scene);
    stepFrames(app, 1);
    const [, r, , l] = scene.uiInsets;
    expect(bar.x).toBeCloseTo(10 + l, 0);
    expect(bar.w).toBeCloseTo(scene.uiWidth - 20 - l - r, 0);
    expect(sizes.at(-1)).toEqual([bar.w, 60]);
    expect(side.w).toBeCloseTo(Math.max(200, scene.uiWidth * 0.25), 0);
    expect(side.h).toBeCloseTo(scene.uiHeight - 20, 0);
    expect(side.x + side.w).toBeCloseTo(scene.uiWidth - 10, 0);
    expect(sheet.w).toBe(400);
    expect(Math.abs(sheet.x + 200 - scene.uiWidth / 2)).toBeLessThanOrEqual(1);
    expect(sheet.h).toBeCloseTo(scene.uiHeight * 0.5, 0);
    // The box follows the screen.
    const before = bar.w;
    app.emulateDevice("iphone-se");
    stepFrames(app, 1);
    expect(bar.w).not.toBe(before);
    expect(bar.w).toBeCloseTo(scene.uiWidth - 20, 0);
  });
});

describe("text that fits", () => {
  test("ellipsize cuts to the width", () => {
    const measure = (s: string) => s.length * 10;
    expect(ellipsize("short", 100, measure)).toBe("short");
    const cut = ellipsize("REVEALS SHADES NEARBY", 120, measure);
    expect(cut.endsWith("…")).toBe(true);
    expect(measure(cut)).toBeLessThanOrEqual(120);
    expect(ellipsize("abc def", 50, measure)).toBe("abc…");
  });

  test("a label shrinks to its maxWidth, then is cut", async () => {
    const app = await createTestApp({ config: design });
    const scene = new Scene();
    const free = scene.ui.add(new Label("REVEALS SHADES", 0, 0, { font }));
    const fit = scene.ui.add(new Label("REVEALS SHADES", 0, 40, { font, maxWidth: 1 }));
    const cut = scene.ui.add(new Label("REVEALS SHADES", 0, 80, { font, maxWidth: 1, overflow: "ellipsis" }));
    app.scenes.change(scene);
    stepFrames(app, 1);
    const w = free.width;
    fit.maxWidth = w * 0.85;
    fit.text = "REVEALS SHADES ";
    fit.text = "REVEALS SHADES";
    expect(fit.fitScale).toBeCloseTo(0.85, 2);
    expect(fit.width).toBeLessThanOrEqual(w * 0.85 + 0.5);
    // Narrower than the smallest size allows: shrunk to 70% and cut.
    fit.maxWidth = w * 0.4;
    fit.text = "x";
    fit.text = "REVEALS SHADES";
    expect(fit.fitScale).toBeCloseTo(0.7, 6);
    expect(fit.width).toBeLessThanOrEqual(w * 0.4 + 0.5);
    cut.maxWidth = w * 0.6;
    cut.text = "x";
    cut.text = "REVEALS SHADES";
    expect(cut.fitScale).toBe(1);
    expect(cut.width).toBeLessThanOrEqual(w * 0.6 + 0.5);
    expect(free.fitScale).toBe(1);
  });

  test("a button's label never draws wider than the button", async () => {
    const app = await createTestApp({ config: design });
    app.setTheme({ font });
    const scene = new Scene();
    scene.ui.add(new Button("Recruit every available creature", 0, 0, 120, 44));
    app.scenes.change(scene);
    stepFrames(app, 1);
    const seen: { text: string; size: number }[] = [];
    const draw = app.draw;
    const text = draw.text.bind(draw);
    draw.text = ((t: string, x: number, y: number, o: { font?: { size: number } } = {}) => {
      seen.push({ text: t, size: (o.font as { size: number }).size });
      return (text as (...a: unknown[]) => number)(t, x, y, o);
    }) as typeof draw.text;
    stepFrames(app, 1);
    draw.text = text;
    const label = seen[0];
    expect(label.size).toBeCloseTo(16 * 0.7, 4);
    expect(label.text.endsWith("…")).toBe(true);
    expect(app.renderer.measureText(label.text, { ...font, size: label.size }).width).toBeLessThanOrEqual(108.5);
  });
});

describe("the system's text size", () => {
  test("is clamped, can be turned off, and multiplies the player's own setting", async () => {
    const facts = { width: 852, height: 393, pixelRatio: 3, insets: [0, 0, 0, 0] as [number, number, number, number], touch: true, pointsPerUnit: 0.55 };
    expect(describeScreen(facts).systemTextScale).toBe(1);
    expect(describeScreen({ ...facts, textScale: 1.35 }).systemTextScale).toBe(1.35);
    expect(describeScreen({ ...facts, textScale: 3.1 }).systemTextScale).toBe(2);
    expect(describeScreen({ ...facts, textScale: 1.35 }, { systemText: false }).systemTextScale).toBe(1);

    const app = await createTestApp({ device: { name: "big-text", width: 852, height: 393, pixelRatio: 3, insets: [0, 0, 0, 0], touch: true, textScale: 1.25 }, config: design });
    app.setTheme({ font: { family: "system-ui", size: 20 } });
    const settings = createSettings(app);
    expect(app.screen.systemTextScale).toBe(1.25);
    expect(app.accessibility.textScale).toBeCloseTo(1.25, 6);
    expect((app.theme.font as { size: number }).size).toBe(25);
    settings.set({ textScale: 1.2 });
    expect(app.accessibility.textScale).toBeCloseTo(1.5, 6);
    // The system setting changes while the game runs.
    app.emulateDevice({ name: "normal-text", width: 852, height: 393, pixelRatio: 3, insets: [0, 0, 0, 0], touch: true });
    expect(app.accessibility.textScale).toBeCloseTo(1.2, 6);
    expect((app.theme.font as { size: number }).size).toBe(24);
  });
});
