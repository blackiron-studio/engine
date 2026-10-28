// Lowline's presentation: the city's layers, vehicles and people drawn from the painted
// sprites in art.ts, plus the night lighting. Nothing here touches game logic.
import "./art.ts";
import { Node2D, Light2D, LightLayer, ParticleEmitter, type DrawContext } from "@blackiron-studio/engine/scene";
import { Rng } from "@blackiron-studio/engine/core";
import { SIZE, XS, YS, buildings, type Car } from "./city.ts";
import { ASPHALT_TILES, PAVING_TILES, PALMS, TREES, HEADS, ROOF_LIGHTS, BIG_ROOFS, SMALL_ROOFS, SHADOWS, shadowName, LIGHT } from "./art.ts";

export const C = {
  ink: 0x0d1724,
  ink2: 0x16243a,
  paper: 0xf6ecd8,
  muted: 0x93a4b4,
  mint: 0x7ce8cf,
  gold: 0xf3b863,
  coral: 0xff6f6a,
  pink: 0xff4fa0,
  cyan: 0x45e3f0,
};
export function text(
  ctx: DrawContext,
  s: string,
  x: number,
  y: number,
  size = 14,
  color = C.paper,
  align: "left" | "center" | "right" = "left",
  weight = 600,
  alpha = 1,
) {
  ctx.text(s, x, y, { font: { family: "Arial", size, weight }, color, align, alpha });
}

const LAND = { x0: 140, y0: 140, x1: 2328, y1: 2008 };
const ROAD = 56; // half width
const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Street lamps on the sidewalks, each arm reaching over its road. */
export const LAMPS: { x: number; y: number; rot: number; hx: number; hy: number }[] = [];
{
  const add = (x: number, y: number, rot: number) => LAMPS.push({ x, y, rot, hx: x - Math.cos(rot) * 27, hy: y - Math.sin(rot) * 27 });
  for (let i = 0; i < 18; i++) add(XS[i % 5] + 62, YS[Math.floor(i / 5)] + 110, 0);
  for (let i = 0; i < XS.length; i++)
    for (let j = 0; j < YS.length - 1; j++) if ((i + j) % 2 === 0) add(XS[i] - 62, YS[j] + 330, Math.PI);
  for (let j = 0; j < YS.length; j++)
    for (let i = 0; i < XS.length - 1; i++) {
      add(XS[i] + 300, YS[j] - 62, -Math.PI / 2);
      if ((i + j) % 2) add(XS[i] + 180, YS[j] + 62, Math.PI / 2);
    }
}

/** The night: one dusk-blue ambient level for the whole city. */
export const AMBIENT = 0x666e9e;

// --- Ground ---------------------------------------------------------------------------

interface Decal {
  s: string;
  x: number;
  y: number;
  rot: number;
  sx?: number;
  sy?: number;
  alpha?: number;
  tint?: number;
}

/** Water, sidewalks, roads, kerbs, markings and decals, drawn as culled tiles every frame. */
class Ground extends Node2D {
  t = 0;
  readonly decals: Decal[] = [];
  readonly kerbs: Decal[] = [];
  readonly marks: Decal[] = [];
  readonly boards: { x0: number; y0: number; x1: number; y1: number }[] = [
    { x0: 2262, y0: LAND.y0, x1: LAND.x1, y1: LAND.y1 },
    { x0: LAND.x0, y0: 1950, x1: 2262, y1: LAND.y1 },
  ];
  constructor() {
    super();
    const rng = new Rng(907);
    const segs = (list: number[], lo: number, hi: number) => {
      const out: [number, number][] = [];
      let a = lo;
      for (const v of list) {
        out.push([a, v - ROAD]);
        a = v + ROAD;
      }
      out.push([a, hi]);
      return out;
    };
    // Kerbs along every road edge; local +y of a kerb points at the road.
    const kerbRun = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      let dx = ny,
        dy = -nx;
      // Start so the run moves along (dx, dy) and covers the segment.
      let sx = (x1 - x0) * dx + (y1 - y0) * dy > 0 ? x0 : x1,
        sy = (x1 - x0) * dx + (y1 - y0) * dy > 0 ? y0 : y1;
      sx -= nx * 5;
      sy -= ny * 5;
      const rot = Math.atan2(dy, dx);
      for (let d = 0; d < len; d += 64) {
        const k = Math.min(64, len - d) / 64;
        this.kerbs.push({ s: "ll.kerb", x: sx + dx * d, y: sy + dy * d, rot, sx: k });
      }
    };
    for (const X of XS)
      for (const [a, b] of segs(YS, LAND.y0, LAND.y1)) {
        kerbRun(X - ROAD, a, X - ROAD, b, 1, 0);
        kerbRun(X + ROAD, a, X + ROAD, b, -1, 0);
      }
    for (const Y of YS)
      for (const [a, b] of segs(XS, LAND.x0, LAND.x1)) {
        kerbRun(a, Y - ROAD, b, Y - ROAD, 0, 1);
        kerbRun(a, Y + ROAD, b, Y + ROAD, 0, -1);
      }
    // Markings: centre lines, edge lines, crosswalks, stop lines, arrows.
    const roadMarks = (horizontal: boolean, c: number, a: number, b: number, atStart: boolean, atEnd: boolean) => {
      const P = (along: number, across: number) => (horizontal ? { x: along, y: c + across } : { x: c + across, y: along });
      const rot = horizontal ? 0 : Math.PI / 2;
      const s = a + (atStart ? 34 : 0),
        e = b - (atEnd ? 34 : 0);
      for (let d = s; d < e; d += 64) {
        const k = Math.min(64, e - d) / 64;
        const p0 = P(d, 0),
          p1 = P(d, -47),
          p2 = P(d, 47);
        this.marks.push({ s: "ll.mark.center", ...p0, rot, sx: k });
        this.marks.push({ s: "ll.mark.edge", ...p1, rot, sx: k });
        this.marks.push({ s: "ll.mark.edge", ...p2, rot, sx: k });
      }
      if (atStart) {
        this.marks.push({ s: "ll.mark.zebra", ...P(a + 14, 0), rot: rot + Math.PI / 2 });
        this.marks.push({ s: "ll.mark.stop", ...P(a + 32, -25), rot: rot + Math.PI / 2 });
        this.marks.push({ s: "ll.mark.arrow", ...P(a + 62, -24), rot: rot - Math.PI / 2 });
      }
      if (atEnd) {
        this.marks.push({ s: "ll.mark.zebra", ...P(b - 14, 0), rot: rot + Math.PI / 2 });
        this.marks.push({ s: "ll.mark.stop", ...P(b - 32, 25), rot: rot + Math.PI / 2 });
        this.marks.push({ s: "ll.mark.arrow", ...P(b - 62, 24), rot: rot + Math.PI / 2 });
      }
      // Wear and utilities.
      const len = b - a;
      for (let i = 0; i < Math.round(len / 130); i++) {
        const along = a + rng.range(20, len - 20),
          across = rng.range(-44, 44);
        const pick = rng.int(0, 9);
        if (pick < 3) this.decals.push({ s: `ll.decal.crack.${rng.int(0, 3)}`, ...P(along, across), rot: rng.range(0, 6.28), alpha: 0.8 });
        else if (pick < 5) this.decals.push({ s: `ll.decal.patch.${rng.int(0, 2)}`, ...P(along, across * 0.6), rot: rot + rng.range(-0.05, 0.05), alpha: 0.35 });
        else if (pick < 8) this.decals.push({ s: `ll.decal.oil.${rng.int(0, 2)}`, ...P(along, rng.pick([-24, 24]) + rng.range(-4, 4)), rot, alpha: 0.9 });
      }
      if (len > 200) this.decals.push({ s: "ll.decal.manhole", ...P(a + len * rng.range(0.3, 0.7), rng.pick([-24, 24])), rot: 0 });
      for (let d = a + 50; d < b - 30; d += 150) {
        this.decals.push({ s: "ll.decal.grate", ...P(d, -51.5), rot });
        this.decals.push({ s: "ll.decal.grate", ...P(d + 75, 51.5), rot });
      }
    };
    const xs = segs(XS, LAND.x0, LAND.x1),
      ys = segs(YS, LAND.y0, LAND.y1);
    for (const X of XS) ys.forEach(([a, b], i) => roadMarks(false, X, a, b, i > 0, i < ys.length - 1));
    for (const Y of YS) xs.forEach(([a, b], i) => roadMarks(true, Y, a, b, i > 0, i < xs.length - 1));
    for (const X of XS) for (const Y of YS) this.decals.push({ s: "ll.decal.manhole", x: X + rng.range(-20, 20), y: Y + rng.range(-20, 20), rot: 0 });
  }
  override update(dt: number) {
    this.t += dt;
  }
  private view() {
    const r = this.scene!.camera.visibleRect();
    return { x0: r.x - 140, y0: r.y - 140, x1: r.x + r.w + 140, y1: r.y + r.h + 140 };
  }
  override render(ctx: DrawContext) {
    const v = this.view();
    const inside = (x: number, y: number) => x > v.x0 && x < v.x1 && y > v.y0 && y < v.y1;
    // Water with two drifting layers of glints.
    const T = 128;
    for (let y = Math.floor(Math.max(0, v.y0) / T) * T; y < Math.min(SIZE.h + T, v.y1); y += T)
      for (let x = Math.floor(Math.max(0, v.x0) / T) * T; x < Math.min(SIZE.w + T, v.x1); x += T) {
        if (x >= LAND.x0 && x + T <= LAND.x1 && y >= LAND.y0 && y + T <= LAND.y1) continue;
        ctx.sprite(`ll.water.base.${(x / T + y / T) % 2}`, x + 64, y + 64, { smooth: true });
      }
    const g = (this.t * 7) % T,
      g2 = (this.t * 4.3) % T;
    for (let y = Math.floor(Math.max(-T, v.y0 - T) / T) * T; y < Math.min(SIZE.h + T, v.y1); y += T)
      for (let x = Math.floor(Math.max(-T, v.x0 - T) / T) * T; x < Math.min(SIZE.w + T, v.x1); x += T) {
        if (x >= LAND.x0 && x + T <= LAND.x1 && y >= LAND.y0 && y + T <= LAND.y1) continue;
        ctx.sprite("ll.water.glint.0", x + 64 + g, y + 64 + g * 0.3, { smooth: true, additive: true, alpha: 0.2 });
        ctx.sprite("ll.water.glint.1", x + 64 - g2 * 0.4, y + 64 + g2, { smooth: true, additive: true, alpha: 0.14 });
      }
    // Sidewalk paving across all land.
    const P = 64;
    for (let y = LAND.y0; y < LAND.y1; y += P)
      for (let x = LAND.x0; x < LAND.x1; x += P) {
        if (!inside(x, y)) continue;
        const sx = Math.min(P, LAND.x1 - x) / P,
          sy = Math.min(P, LAND.y1 - y) / P;
        ctx.sprite(PAVING_TILES[Math.floor(hash(x, y) * 4)], x, y, { sx, sy, ox: 0, oy: 0, smooth: true });
      }
    // Waterfront boardwalks.
    for (const b of this.boards)
      for (let y = b.y0; y < b.y1; y += P)
        for (let x = b.x0; x < b.x1; x += P) {
          if (!inside(x, y)) continue;
          ctx.sprite(`ll.ground.boards.${Math.floor(hash(y, x) * 2)}`, x, y, { sx: Math.min(P, b.x1 - x) / P, sy: Math.min(P, b.y1 - y) / P, ox: 0, oy: 0, smooth: true });
        }
    // Alleys between buildings: darker, older asphalt.
    for (const b of buildings)
      if (b.w === 90 && inside(b.x, b.y)) {
        for (let y = b.y; y < b.y + b.h; y += 112)
          ctx.sprite(ASPHALT_TILES[2], b.x - 24, y, { sx: 24 / 128, sy: Math.min(112, b.y + b.h - y) / 128, ox: 0, oy: 0, tint: 0xa8a8b0, smooth: true });
      }
    // Roads.
    const A = 112;
    for (const X of XS)
      for (let y = LAND.y0; y < LAND.y1; y += A)
        if (inside(X, y)) ctx.sprite(ASPHALT_TILES[(X + y) % 4], X - ROAD, y, { sx: A / 128, sy: Math.min(A, LAND.y1 - y) / 128, ox: 0, oy: 0, smooth: true });
    for (const Y of YS)
      for (let x = LAND.x0; x < LAND.x1; x += A)
        if (inside(x, Y)) ctx.sprite(ASPHALT_TILES[(x + Y * 3) % 4], x, Y - ROAD, { sx: Math.min(A, LAND.x1 - x) / 128, sy: A / 128, ox: 0, oy: 0, smooth: true });
    for (const d of this.decals) if (inside(d.x, d.y)) ctx.sprite(d.s, d.x, d.y, { rot: d.rot, alpha: d.alpha, smooth: true });
    for (const d of this.marks) if (inside(d.x, d.y)) ctx.sprite(d.s, d.x, d.y, { rot: d.rot, sx: d.sx, smooth: true });
    for (const d of this.kerbs) if (inside(d.x, d.y)) ctx.sprite(d.s, d.x, d.y, { rot: d.rot, sx: d.sx, smooth: true });
    // The sea wall around the island, foam lapping at its foot.
    const wall = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0),
        dx = (x1 - x0) / len,
        dy = (y1 - y0) / len,
        rot = Math.atan2(dy, dx);
      for (let d = 0; d < len; d += 64) {
        const x = x0 + dx * d,
          y = y0 + dy * d;
        if (inside(x, y)) ctx.sprite("ll.seawall", x, y, { rot, sx: Math.min(64, len - d) / 64, smooth: true });
      }
      void nx;
      void ny;
    };
    wall(LAND.x0, LAND.y0, LAND.x1, LAND.y0, 0, -1);
    wall(LAND.x1, LAND.y0, LAND.x1, LAND.y1, 1, 0);
    wall(LAND.x1, LAND.y1, LAND.x0, LAND.y1, 0, 1);
    wall(LAND.x0, LAND.y1, LAND.x0, LAND.y0, -1, 0);
    // Street names stencilled on the asphalt.
    for (const [s, x, y] of [
      ["PALM BOULEVARD", 980, 1250],
      ["NORTH QUAY", 1930, 284],
      ["THE LOWLINE", 498, 1730],
    ] as const)
      if (inside(x, y)) text(ctx, s, x, y - 7, 13, 0xe6e2d4, "center", 800, 0.2);
  }
}

// --- Buildings, trees, props ------------------------------------------------------------

interface Placed {
  s: string;
  x: number;
  y: number;
  rot?: number;
  sx?: number;
  tint?: number;
  alpha?: number;
}

/** Everything that stands above the street: shadows, roofs, trees, lamps, signs. */
class Skyline extends Node2D {
  readonly shadows: Placed[] = [];
  readonly roofs: Placed[] = [];
  readonly trees: Placed[] = [];
  readonly props: Placed[] = [];
  readonly glows: { x: number; y: number; w: number; h: number; color: number; blink: boolean; neon: boolean; alpha: number }[] = [];
  readonly signs: { x: number; y: number; w: number; label: string; color: number }[] = [];
  t = 0;
  constructor() {
    super();
    const rng = new Rng(311);
    let bi = 0,
      si = 0;
    for (const b of buildings) {
      const big = b.w > 100;
      const name = big ? BIG_ROOFS[(bi++ * 3 + 1) % BIG_ROOFS.length] : SMALL_ROOFS[si++ % SMALL_ROOFS.length];
      const opts = SHADOWS.filter(([w]) => w === b.w);
      const [w, h, len] = opts[Math.floor(hash(b.x, b.y) * opts.length)];
      this.shadows.push({ s: shadowName(w, h, len), x: b.x, y: b.y });
      this.roofs.push({ s: name, x: b.x, y: b.y });
      for (const l of ROOF_LIGHTS[name] ?? [])
        this.glows.push({ x: b.x + l.x + l.w / 2, y: b.y + l.y + l.h / 2, w: l.w, h: l.h, color: l.color, blink: l.kind === "blink", neon: l.kind === "neon", alpha: l.kind === "neon" ? 1 : l.kind === "dot" ? 0.9 : 0.7 });
      if (b.label) this.signs.push({ x: b.x + b.w / 2, y: b.y + b.h + 4, w: Math.min(176, b.label.length * 11 + 30), label: b.label, color: [C.pink, C.cyan, C.gold, 0xb48cff][hash(b.x, 3) * 4 | 0] });
      if (!big) this.props.push({ s: `ll.awning.${rng.int(0, 3)}`, x: b.x + b.w / 2, y: b.y + b.h, sx: 1.25 });
      // Palms along the north sidewalk of every block.
      if (big) for (let k = 0; k < 2; k++) this.trees.push({ s: PALMS[(k + bi) % 3], x: b.x + 34 + k * 122, y: b.y - 18, rot: hash(b.x, k) * 6.28 });
      else this.trees.push({ s: TREES[(si % 2) * 2], x: b.x + 45, y: b.y - 18, rot: hash(b.y, 2) * 6.28 });
      // Street furniture by the shopfronts.
      this.props.push({ s: "ll.bin", x: b.x + 8, y: b.y + b.h + 30 });
      if (big) this.props.push({ s: "ll.bench", x: b.x + b.w - 30, y: b.y + b.h + 40 });
      if (rng.chance(0.6)) this.props.push({ s: "ll.hydrant", x: b.x + b.w - 8, y: b.y - 30 });
    }
    // Park: lawns, trees and palms around the fountain.
    this.props.push({ s: "ll.park", x: 812, y: 812 });
    for (let i = 0; i < 8; i++) this.trees.push({ s: TREES[i % 3], x: 855 + (i % 2) * 250, y: 855 + Math.floor(i / 2) * 76, rot: i });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.39;
      this.trees.push({ s: PALMS[i % 3], x: 980 + Math.cos(a) * 92, y: 980 + Math.sin(a) * 92, rot: i * 1.3 });
    }
    // Waterfront: palms along the promenades, the pier kiosk, piers and boats.
    for (let y = 300; y < 1960; y += 150) if (y < 1480 || y > 1800) this.trees.push({ s: PALMS[(y / 150) % 3 | 0], x: 2300, y, rot: y });
    for (let x = 320; x < 2200; x += 160) this.trees.push({ s: PALMS[(x / 160) % 3 | 0], x, y: 1985, rot: x });
    for (let x = 230; x < 2200; x += 240) this.props.push({ s: "ll.bench", x: x + 80, y: 1972 });
    for (let x = 400; x < 2200; x += 480) this.trees.push({ s: TREES[1], x, y: 172, rot: x });
    for (const l of LAMPS) this.props.push({ s: "ll.lamp", x: l.x, y: l.y, rot: l.rot });
    // The south promenade: planters and benches in front of the harbour.
    for (let x = 300; x < 2200; x += 240) {
      this.props.push({ s: "ll.planter", x, y: 1846 });
      this.trees.push({ s: TREES[(x / 240) % 3 | 0], x, y: 1846, rot: x * 0.7 });
      this.props.push({ s: "ll.bench", x: x + 120, y: 1830 });
      this.props.push({ s: "ll.bin", x: x + 150, y: 1830 });
    }
  }
  override update(dt: number) {
    this.t += dt;
  }
  override render(ctx: DrawContext) {
    const r = this.scene!.camera.visibleRect();
    const near = (x: number, y: number, m = 360) => x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m;
    for (const s of this.shadows) if (near(s.x, s.y)) ctx.sprite(s.s, s.x, s.y, { tint: 0x060a1a, alpha: 0.55, smooth: true });
    for (const t of this.trees) if (near(t.x, t.y)) ctx.sprite(t.s, t.x + LIGHT.x * 26, t.y + LIGHT.y * 26, { rot: t.rot, tint: 0x060a1a, alpha: 0.38, sx: 0.96, sy: 0.96, smooth: true });
    for (const p of this.props) if (near(p.x, p.y)) ctx.sprite(p.s, p.x, p.y, { rot: p.rot, sx: p.sx, smooth: true });
    for (const l of LAMPS)
      if (near(l.x, l.y)) {
        ctx.sprite("ll.fx.dot", l.hx, l.hy, { sx: 0.8, sy: 0.8, tint: 0xfff0c8, emissive: true, additive: true, smooth: true });
        ctx.sprite("ll.fx.glow", l.hx, l.hy, { sx: 0.7, sy: 0.7, tint: 0xffb35e, alpha: 0.5, emissive: true, additive: true, smooth: true });
      }
    for (const s of this.roofs) if (near(s.x, s.y)) ctx.sprite(s.s, s.x, s.y, { smooth: true });
    // Lit skylights, neon billboards and aircraft warning lights glow through the dark.
    for (const g of this.glows) {
      if (!near(g.x, g.y)) continue;
      if (g.blink && Math.sin(this.t * 3 + g.x) < 0.3) continue;
      ctx.sprite("ll.fx.softbox", g.x, g.y, { sx: (g.w + 10) / 32, sy: (g.h + 10) / 32, tint: g.color, alpha: g.alpha * 0.4, additive: true, emissive: true, smooth: true });
    }
    // Neon shop signs on the facades.
    for (const s of this.signs) {
      if (!near(s.x, s.y)) continue;
      ctx.rect(s.x - s.w / 2 - 2, s.y - 2, s.w + 4, 24, 0x05080f, 0.9);
      ctx.rect(s.x - s.w / 2, s.y, s.w, 20, 0x0f1522, 1);
      ctx.sprite("ll.fx.softbox", s.x, s.y + 10, { sx: (s.w + 20) / 32, sy: 30 / 32, tint: s.color, alpha: 0.35, additive: true, emissive: true, smooth: true });
      text(ctx, s.label, s.x, s.y + 3, 12, 0xffffff, "center", 800);
    }
    for (const t of this.trees) if (near(t.x, t.y)) ctx.sprite(t.s, t.x, t.y, { rot: t.rot, sx: t.s.startsWith("ll.tree.palm") ? 1.2 : 1, sy: t.s.startsWith("ll.tree.palm") ? 1.2 : 1, smooth: true });
  }
}

/** Glows in the light pass: shop signs, roof lights and lamps lift the dark around them. */
class CityGlow extends Node2D {
  t = 0;
  constructor(readonly sky: Skyline) {
    super();
  }
  override update(dt: number) {
    this.t += dt;
  }
  override render(ctx: DrawContext) {
    const r = this.scene!.camera.visibleRect();
    const near = (x: number, y: number) => x > r.x - 300 && x < r.x + r.w + 300 && y > r.y - 300 && y < r.y + r.h + 300;
    for (const s of this.sky.signs) {
      if (!near(s.x, s.y)) continue;
      ctx.light(s.x, s.y + 20, 120, { color: s.color, intensity: 0.75, falloff: 1.6 });
      text(ctx, s.label, s.x, s.y + 3, 12, s.color, "center", 800);
    }
    for (const g of this.sky.glows) {
      if (!near(g.x, g.y) || g.blink) continue;
      if (g.neon) ctx.light(g.x, g.y + 30, 150, { color: g.color, intensity: 0.7, falloff: 1.5 });
    }
  }
}

export interface City {
  ground: Node2D;
  above: Node2D;
  lights: LightLayer;
  fountain: ParticleEmitter;
}

export function buildCity(): City {
  const ground = new Ground();
  const above = new Skyline();
  const lights = new LightLayer(AMBIENT);
  lights.add(new CityGlow(above));
  for (const l of LAMPS) lights.add(new Light2D({ radius: 165, color: 0xffb35e, intensity: 2, falloff: 1.6 }, l.hx, l.hy));
  // Waterfront and pier lamps.
  for (let y = 380; y < 1960; y += 300) lights.add(new Light2D({ radius: 150, color: 0xffd9a0, intensity: 0.8 }, 2300, y));
  for (let i = 0; i < 3; i++) lights.add(new Light2D({ radius: 120, color: 0x9fe8ff, intensity: 0.6 }, 2500, 1543 + i * 100));
  lights.add(new Light2D({ radius: 260, color: 0x7fd6ff, intensity: 0.6 }, 980, 980));
  const fountain = new ParticleEmitter(
    { rate: 70, life: [0.5, 1], speed: [12, 30], size: [1.2, 2.4], sizeEnd: 0.4, alpha: [0.7, 0], colors: [0xd9f6ff, 0xffffff, 0x9fdcf0], additive: true, drag: 0.6, spread: 3, seed: 5 },
    980,
    980,
  );
  return { ground, above, lights, fountain };
}

/** Piers, moored boats and buoys on the harbour; drawn over the water, under everything else. */
export class Harbour extends Node2D {
  t = 0;
  override update(dt: number) {
    this.t += dt;
  }
  override render(ctx: DrawContext) {
    for (let i = 0; i < 3; i++) ctx.sprite("ll.pier", 2315, 1520 + i * 100, { smooth: true });
    const boats: [number, number, number, number][] = [
      [2440, 1490, 0, 0],
      [2470, 1596, 1, 0.04],
      [2420, 1700, 0, -0.03],
      [2440, 1810, 1, 0.02],
      [2440, 700, 0, 1.4],
    ];
    for (const [x, y, k, r] of boats) {
      const bob = Math.sin(this.t * 1.3 + x * 0.1 + y) * 0.04;
      ctx.sprite(`ll.boat.${k}`, x + 4, y + 4, { rot: r + bob, tint: 0x000000, alpha: 0.35, smooth: true });
      ctx.sprite(`ll.boat.${k}`, x, y, { rot: r + bob, smooth: true });
    }
    for (const [x, y] of [[2420, 400], [2460, 1100], [2400, 2080], [1200, 2090], [500, 2080], [60, 900]]) ctx.sprite("ll.buoy", x, y + Math.sin(this.t * 2 + x) * 1.2, { smooth: true });
    ctx.sprite("ll.kiosk", 2255, 1545, { smooth: true });
    text(ctx, "PIER 09", 2280, 1660, 18, C.paper, "center", 800, 0.9);
  }
}
export class HarbourGlow extends Node2D {
  t = 0;
  override update(dt: number) {
    this.t += dt;
  }
  override render(ctx: DrawContext) {
    for (const [x, y] of [[2420, 400], [2460, 1100], [2400, 2080], [1200, 2090], [500, 2080], [60, 900]])
      if (Math.sin(this.t * 2.2 + x) > 0.4) ctx.light(x, y, 40, { color: 0xff5040, intensity: 1.2 });
    text(ctx, "PIER 09", 2280, 1660, 18, C.gold, "center", 800);
    ctx.light(2280, 1670, 90, { color: 0xffb860, intensity: 0.6 });
  }
}

// --- Vehicles ---------------------------------------------------------------------------

const MODELS: Record<string, "sedan" | "coupe" | "van"> = {};
function modelFor(c: Car, index: number): "sedan" | "coupe" | "van" | "police" {
  if (c.kind === "police") return "police";
  if (c.color === 0xefb561) return "coupe";
  const key = c.color.toString(16) + index;
  return (MODELS[key] ??= (["sedan", "van", "sedan", "coupe"] as const)[index % 4]);
}

/** A car: soft shadow, tyres, tinted paint, glass and chrome, lamps that glow at night. */
export class CarNode extends Node2D {
  readonly model: string;
  lit = false;
  braking = 0;
  t = 0;
  private lastSpeed = 0;
  constructor(
    readonly car: Car,
    index: number,
  ) {
    super();
    this.model = modelFor(car, index);
  }
  override update(dt: number) {
    this.t += dt;
    const s = Math.abs(this.car.motor.speed);
    this.braking += ((s < this.lastSpeed - 0.5 ? 1 : 0) - this.braking) * Math.min(1, dt * 8);
    this.lastSpeed = s;
  }
  override render(ctx: DrawContext) {
    const a = this.rotation,
      ox = LIGHT.x * 6,
      oy = LIGHT.y * 6;
    // The shadow falls in world space; undo the car's rotation for its offset.
    const lx = ox * Math.cos(-a) - oy * Math.sin(-a),
      ly = ox * Math.sin(-a) + oy * Math.cos(-a);
    ctx.sprite("ll.car.shadow", lx, ly, { tint: 0x03060f, alpha: 0.62, smooth: true });
    ctx.sprite("ll.car.wheels", 0, 0, { smooth: true });
    ctx.sprite(`ll.car.${this.model}.paint`, 0, 0, { tint: this.model === "police" ? 0xffffff : this.car.color, smooth: true });
    ctx.sprite(`ll.car.${this.model}.trim`, 0, 0, { smooth: true });
    if (this.lit) {
      for (const y of [-10, 10]) ctx.sprite("ll.fx.dot", 28, y, { sx: 0.7, sy: 0.9, tint: 0xfff2d0, emissive: true, additive: true, smooth: true });
      const k = 0.55 + this.braking * 0.6;
      for (const y of [-10.5, 10.5]) ctx.sprite("ll.fx.dot", -29, y, { sx: 0.55 + this.braking * 0.3, sy: 0.9, tint: 0xff2a3a, alpha: k, emissive: true, additive: true, smooth: true });
    }
    if (this.model === "police") {
      const on = Math.sin(this.t * 14) > 0;
      ctx.sprite("ll.fx.dot", -2, on ? -5.5 : 5.5, { sx: 1.3, sy: 1.3, tint: on ? 0xff3040 : 0x3a7dff, emissive: true, additive: true, smooth: true });
      ctx.sprite("ll.fx.glow", -2, on ? -5.5 : 5.5, { sx: 1.1, sy: 1.1, tint: on ? 0xff3040 : 0x3a7dff, alpha: 0.7, emissive: true, additive: true, smooth: true });
    }
  }
}

/** Headlight cones, tail glow and police strobes for one car, in the light layer. */
export class CarLights extends Node2D {
  readonly cone = new Light2D({ radius: 175, color: 0xfff0cc, intensity: 2, cone: { angle: 0, width: Math.PI / 4.5 } });
  readonly tail = new Light2D({ radius: 46, color: 0xff2030, intensity: 0.5 });
  readonly strobe = new Light2D({ radius: 210, color: 0xff2030, intensity: 0 });
  constructor(readonly node: CarNode) {
    super();
    this.add(this.cone);
    this.add(this.tail);
    this.add(this.strobe);
  }
  override update() {
    const n = this.node,
      a = n.rotation,
      c = Math.cos(a),
      s = Math.sin(a);
    this.visible = n.lit || n.model === "police";
    this.cone.visible = this.tail.visible = n.lit;
    this.cone.x = n.x + c * 26;
    this.cone.y = n.y + s * 26;
    this.cone.cone!.angle = a;
    this.tail.x = n.x - c * 32;
    this.tail.y = n.y - s * 32;
    this.tail.intensity = 0.35 + n.braking * 0.7;
    const police = n.model === "police" && n.lit;
    this.strobe.visible = police;
    if (police) {
      const on = Math.sin(n.t * 14) > 0;
      this.strobe.color = on ? 0xff2a3a : 0x2a6bff;
      this.strobe.intensity = 2.2;
      this.strobe.x = n.x - c * 2 + (on ? s * 6 : -s * 6);
      this.strobe.y = n.y - s * 2 + (on ? -c * 6 : c * 6);
    }
  }
}

export function carArt(c: Car, index = 0): CarNode {
  return new CarNode(c, index);
}

// --- People -----------------------------------------------------------------------------

/** A pedestrian seen from above: arms and feet swing with the distance walked. */
export class PersonNode extends Node2D {
  phase = 0;
  private px = NaN;
  private py = NaN;
  constructor(
    readonly color: number,
    readonly head: number,
    readonly player = false,
  ) {
    super();
    this.scale = 1.25;
  }
  override update(dt: number) {
    const d = Number.isNaN(this.px) ? 0 : Math.hypot(this.x - this.px, this.y - this.py);
    this.px = this.x;
    this.py = this.y;
    this.phase += d * 0.32;
    void dt;
  }
  override render(ctx: DrawContext) {
    const a = this.rotation,
      ox = LIGHT.x * 3,
      oy = LIGHT.y * 3,
      lx = ox * Math.cos(-a) - oy * Math.sin(-a),
      ly = ox * Math.sin(-a) + oy * Math.cos(-a);
    if (this.player) ctx.sprite("ll.fx.ring", 0, 0, { sx: 0.42, sy: 0.42, tint: C.gold, alpha: 0.55, emissive: true, smooth: true });
    ctx.sprite("ll.fx.shadow", lx, ly, { sx: 0.42, sy: 0.5, tint: 0x03060f, alpha: 0.55, smooth: true });
    const s = Math.sin(this.phase);
    ctx.sprite("ll.ped.foot", s * 3.2, -2.4, { smooth: true });
    ctx.sprite("ll.ped.foot", -s * 3.2, 2.4, { smooth: true });
    ctx.sprite("ll.ped.arm", -s * 2.6, -5.6, { tint: this.color, smooth: true });
    ctx.sprite("ll.ped.arm", s * 2.6, 5.6, { tint: this.color, smooth: true });
    ctx.sprite("ll.ped.body", 0, 0, { tint: this.color, smooth: true });
    ctx.sprite(HEADS[this.head % HEADS.length], 0.6, 0, { smooth: true });
  }
}
export function personArt(color = 0xdfbd99, head = 0, player = false): PersonNode {
  return new PersonNode(color, head, player);
}

/** The objective beacon: a pulsing ring on the ground and a bobbing chevron. */
export class Beacon extends Node2D {
  t = 0;
  override update(dt: number) {
    this.t += dt;
  }
  override render(ctx: DrawContext) {
    const k = (this.t * 0.8) % 1;
    ctx.sprite("ll.fx.ring", 0, 0, { sx: 1.45, sy: 1.45, tint: C.gold, alpha: 0.5, emissive: true, additive: true, smooth: true });
    ctx.sprite("ll.fx.ring", 0, 0, { sx: 1.45 + k * 0.9, sy: 1.45 + k * 0.9, tint: C.gold, alpha: (1 - k) * 0.4, emissive: true, additive: true, smooth: true });
    ctx.sprite("ll.fx.chevron", 0, -52 + Math.sin(this.t * 4) * 4, { emissive: true, smooth: true });
  }
}
