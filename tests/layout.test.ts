// The viewport picks its design size by the container's orientation and fills it in expand mode.

import { describe, expect, test } from "bun:test";
import { layoutFor, viewportBaseFor } from "../src/app/app.ts";

describe("viewport layout", () => {
  const vp = { width: 720, height: 1280, scale: "expand" as const, maxWidth: 1000, landscape: { width: 1280, height: 800, maxWidth: 1900 } };

  test("a tall container uses the main size and grows its height only up to the limit", () => {
    const l = layoutFor(vp, 375, 812);
    expect(l.lw).toBe(720);
    expect(l.lh).toBe(Math.round(720 / (375 / 812)));
    expect(l.cssW).toBe(375);
  });

  test("a wide container takes the landscape size and fills the width", () => {
    expect(viewportBaseFor(vp, 1600, 900).width).toBe(1280);
    const l = layoutFor(vp, 1600, 900);
    expect(l.lh).toBe(800);
    expect(l.lw).toBe(Math.round(800 * (1600 / 900)));
    expect(Math.abs(l.cssW - 1600)).toBeLessThanOrEqual(1);
    expect(Math.abs(l.cssH - 900)).toBeLessThanOrEqual(1);
  });

  test("fit letterboxes and integer snaps to whole multiples", () => {
    const fit = layoutFor({ width: 640, height: 360, scale: "fit" }, 1300, 1000);
    expect(fit.cssW).toBe(1300);
    expect(fit.lw).toBe(640);
    const int = layoutFor({ width: 640, height: 360, scale: "integer" }, 1300, 1000);
    expect(int.cssW).toBe(1280);
  });
});
