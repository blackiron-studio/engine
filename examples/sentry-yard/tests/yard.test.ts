// The yard simulation without rendering: sentries spot and shoot, crates take the bolts,
// barrels chain, raised turrets need an aim up onto their pad, the grenade preview is where
// the grenade goes, and a save restores the yard exactly.

import { describe, expect, test } from "bun:test";
import { CELL } from "../src/units.ts";
import { BARREL, CHEST, CRATE, type Controls, OIL, RUBBLE, type Sentry, TILE_RISE, Yard } from "../src/yard.ts";

const idle = (aim = 0): Controls => ({ moveX: 0, moveY: 0, aim, fire: false });
const at = (c: number, r: number): [number, number] => [(c + 0.5) * CELL, (r + 0.5) * CELL];

function run(yard: Yard, seconds: number, input: (y: Yard) => Controls = () => idle()): void {
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) yard.step(1 / 60, input(yard));
}

function aimAt(yard: Yard, x: number, y: number, z?: number): Controls {
  const p = yard.player;
  return { moveX: 0, moveY: 0, aim: Math.atan2(y - p.y, x - p.x), aimZ: z, aimDist: Math.hypot(x - p.x, y - p.y), fire: true };
}

describe("the yard", () => {
  test("loads six sentries, three of them up on pads, and the operative at the start", () => {
    const yard = new Yard();
    expect(yard.sentries.length).toBe(6);
    expect(yard.sentries.filter((s) => s.z === TILE_RISE).length).toBe(3);
    expect(yard.player.x).toBe(at(2, 20)[0]);
    expect(yard.fog.isVisible(2, 20)).toBe(true);
    expect(yard.fog.isExplored(20, 2)).toBe(false);
  });

  test("a sentry that sees the operative turns, fires, and hurts", () => {
    const yard = new Yard();
    const s = yard.sentries.find((q) => q.col === 8 && q.row === 8)!;
    [yard.player.x, yard.player.y] = at(10, 11);
    s.base = s.facing = Math.atan2(3, 2);
    let spotted = false;
    run(yard, 2, (y) => {
      if (y.fx.some((f) => f.kind === "spotted" && f.id === s.id)) spotted = true;
      y.fx.length = 0;
      return idle();
    });
    expect(spotted).toBe(true);
    expect(s.state).toBe("alert");
    expect(yard.player.health.hp + yard.player.health.armour).toBeLessThan(140);
  });

  test("a crate between them takes the bolts", () => {
    const yard = new Yard();
    const s = yard.sentries.find((q) => q.col === 8 && q.row === 8)!;
    // Crates at (7..8, 10..11): crouch behind them, straight below the sentry.
    [yard.player.x, yard.player.y] = at(8, 12);
    yard.player.y += 6;
    s.base = s.facing = Math.PI / 2;
    expect(yard.map.get(8, 10)).toBe(CRATE);
    const before = yard.player.health.hp + yard.player.health.armour;
    run(yard, 3);
    // It may glimpse over the crate, but its bolts fly low enough to hit it.
    expect(yard.player.health.hp + yard.player.health.armour).toBe(before);
  });

  test("shooting a barrel sets off the one beside it in a chain", () => {
    const yard = new Yard();
    const blasts: number[] = [];
    // Barrel at (10, 2); put a second one beside it and shoot along the row at it.
    yard.map.set(9, 2, BARREL);
    [yard.player.x, yard.player.y] = at(5, 2);
    const [bx, by] = at(9, 2);
    run(yard, 1.5, (y) => {
      for (const f of y.fx) if (f.kind === "blast") blasts.push(y.time);
      y.fx.length = 0;
      return aimAt(y, bx, by, CHEST);
    });
    expect(yard.map.get(10, 2)).toBe(OIL);
    expect(yard.map.get(9, 2)).toBe(OIL);
    expect(blasts.length).toBeGreaterThanOrEqual(2);
    expect(blasts[1]! - blasts[0]!).toBeGreaterThan(0.1);
  });

  test("a raised sentry is hit by aiming up onto its pad, not by a level shot", () => {
    const target = (y: Yard) => y.sentries.find((q) => q.col === 19 && q.row === 17)! as Sentry;
    const level = new Yard();
    [level.player.x, level.player.y] = at(18, 21);
    const t0 = target(level);
    t0.base = t0.facing = -Math.PI / 2; // looking away
    run(level, 1, (y) => ({ ...aimAt(y, t0.x, t0.y), aimZ: undefined }));
    expect(t0.health.hp).toBe(70);
    const up = new Yard();
    [up.player.x, up.player.y] = at(18, 21);
    const t1 = target(up);
    t1.base = t1.facing = -Math.PI / 2;
    run(up, 1, (y) => aimAt(y, t1.x, t1.y, t1.z + CHEST));
    expect(t1.health.hp).toBeLessThan(70);
  });

  test("the grenade is where the preview said, bounce for bounce", () => {
    const yard = new Yard();
    [yard.player.x, yard.player.y] = at(5, 20);
    const [tx, ty] = at(8, 17); // onto the crate stack at (8, 17)
    const preview = yard.previewThrow(tx, ty, 1);
    expect(yard.throwGrenade(tx, ty)).toBe(true);
    const g = yard.grenadesInFlight[0]!;
    run(yard, 1);
    expect(g.t.x).toBeCloseTo(preview.end.x, 6);
    expect(g.t.y).toBeCloseTo(preview.end.y, 6);
    expect(g.t.z).toBeCloseTo(preview.end.z, 6);
    expect(preview.landing).not.toBeNull();
    expect(yard.grenades).toBe(4);
  });

  test("a grenade blast knocks out a crate stack and a sentry inside the brick pen", () => {
    const yard = new Yard();
    const pen = yard.sentries.find((q) => q.col === 14 && q.row === 13)!;
    [yard.player.x, yard.player.y] = at(14, 18);
    yard.throwGrenade(pen.x, pen.y);
    run(yard, 3);
    expect(pen.health.hp).toBeLessThan(70);
  });

  test("a save restores broken tiles, wrecked sentries, fog and the operative", () => {
    const yard = new Yard();
    yard.tiles.destroy(7, 10);
    yard.tiles.damage(16, 20, 10, "bullet");
    const s = yard.sentries[0]!;
    yard.world.damage(s, 500, { team: "operative" });
    [yard.player.x, yard.player.y] = at(6, 14);
    run(yard, 0.5);
    const save = JSON.parse(JSON.stringify(yard.save()));
    const again = new Yard(save);
    expect(again.map.get(7, 10)).toBe(RUBBLE);
    expect(again.tiles.hpAt(16, 20)).toBe(yard.tiles.hpAt(16, 20));
    expect(again.tiles.hpAt(16, 20)).toBeLessThan(45);
    expect(again.sentries[0]!.state).toBe("dead");
    expect(again.remaining).toBe(5);
    expect(again.player.x).toBe(yard.player.x);
    for (let r = 0; r < again.rows; r++) for (let c = 0; c < again.cols; c++) {
      expect(again.map.get(c, r)).toBe(yard.map.get(c, r));
      expect(again.fog.isExplored(c, r)).toBe(yard.fog.isExplored(c, r));
    }
  });

  test("wrecking every sentry clears the yard", () => {
    const yard = new Yard();
    for (const s of yard.sentries) yard.world.damage(s, 1000, { team: "operative" });
    expect(yard.cleared).toBe(true);
  });
});
