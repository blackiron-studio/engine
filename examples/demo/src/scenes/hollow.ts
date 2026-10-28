// The hollow itself: painted ground, the trail, undergrowth, trees, the moon shrine,
// atmosphere and the light layer. Shared by the title backdrop, play and game over so all
// three look the same. Purely presentation: the rules' tiles and obstacles drive placement.

import { Rng } from "@blackiron-studio/engine/core";
import { CloudShadows, Light2D, LightLayer, LightOccluder2D, Node2D, Sprite } from "@blackiron-studio/engine/scene";
import { GROUND_GRID, GROUND_TILE } from "../look.ts";
import { DARK_ID, type GameState, PATH_ID, WORLD, WORLD_H, WORLD_W } from "../game.ts";
import { Fireflies, FogBanks, Pulse } from "../scenery.ts";

export interface Hollow {
  ground: Node2D;
  /** Ground-level layer under the actors: shadows, light washes. */
  shadows: Node2D;
  clouds: CloudShadows;
  actors: Node2D;
  lights: LightLayer;
  /** Tree sprites, so a scene can fade a canopy the keeper walks behind. */
  trees: Sprite[];
}

/** Where the moon shrine stands. */
export const SHRINE = { x: WORLD_W / 2, y: WORLD_H / 2 - 100 } as const;

const hashOf = (x: number, y: number): number => Math.abs(Math.floor(x * 19 + y * 7)) >>> 0;

/** The trail's centre line, smoothed from the rules' generated path tiles. */
function trailCenters(state: GameState): number[] {
  const centers: number[] = [];
  for (let x = 0; x < WORLD.cols; x++) {
    let total = 0,
      count = 0;
    for (let y = 0; y < WORLD.rows; y++)
      if (state.tiles[y * WORLD.cols + x] === PATH_ID) {
        total += (y + 0.5) * WORLD.tile;
        count++;
      }
    centers.push(count ? total / count : WORLD_H / 2);
  }
  return centers.map((_, i) => {
    let sum = 0,
      n = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(centers.length - 1, i + 3); j++) {
      sum += centers[j];
      n++;
    }
    return sum / n;
  });
}

/** Build the world layers for a game state into `parent`, in draw order. */
export function buildHollow(parent: Node2D, state: GameState, ambient = 0x5a7294): Hollow {
  const rng = new Rng(`${state.seed}:scenery`);

  // Ground: a seamless painted texture in 160-unit tiles.
  const ground = parent.add(new Node2D());
  for (let r = 0; r * GROUND_TILE < WORLD_H; r++)
    for (let c = 0; c * GROUND_TILE < WORLD_W; c++) ground.add(new Sprite(`wh.ground.${(r % GROUND_GRID) * GROUND_GRID + (c % GROUND_GRID)}`, c * GROUND_TILE, r * GROUND_TILE));

  // Soft patches: dark hollows where the rules put dark grass, plus scattered moss and litter.
  const patches = parent.add(new Node2D());
  for (let y = 0; y < WORLD.rows; y += 2)
    for (let x = 0; x < WORLD.cols; x += 2) {
      if (state.tiles[y * WORLD.cols + x] !== DARK_ID || !rng.chance(0.45)) continue;
      const s = patches.add(new Sprite(`wh.patch.${rng.int(0, 1)}`, (x + 0.5) * WORLD.tile, (y + 0.5) * WORLD.tile));
      s.scaleX = rng.range(0.6, 1);
      s.scaleY = s.scaleX * rng.range(0.8, 1.1);
    }
  for (let i = 0; i < 46; i++) {
    const s = patches.add(new Sprite(`wh.patch.${rng.int(2, 5)}`, rng.range(0, WORLD_W), rng.range(0, WORLD_H)));
    s.scale = rng.range(0.7, 1.5);
  }

  // The trail: a worn edge, then packed earth, then pebbles, all soft-edged stamps.
  const centers = trailCenters(state);
  const trailY = (x: number): number => {
    const f = x / WORLD.tile - 0.5;
    const i = Math.max(0, Math.min(centers.length - 2, Math.floor(f)));
    const t = Math.max(0, Math.min(1, f - i));
    const k = t * t * (3 - 2 * t);
    return centers[i] + (centers[i + 1] - centers[i]) * k;
  };
  const trail = parent.add(new Node2D());
  for (let x = -20; x < WORLD_W + 30; x += 15) {
    const s = trail.add(new Sprite(`wh.path.edge.${rng.int(0, 2)}`, x + rng.range(-4, 4), trailY(x) + rng.range(-5, 5)));
    s.scale = rng.range(1.05, 1.3);
    s.rotation = rng.range(-0.3, 0.3);
  }
  for (let x = -20; x < WORLD_W + 30; x += 12) {
    const s = trail.add(new Sprite(`wh.path.dirt.${rng.int(0, 3)}`, x + rng.range(-3, 3), trailY(x) + rng.range(-4, 4)));
    s.scale = rng.range(0.9, 1.15);
    s.rotation = rng.range(-0.25, 0.25);
  }
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, WORLD_W);
    trail.add(new Sprite(`wh.pebbles.${rng.int(0, 2)}`, x, trailY(x) + rng.range(-20, 20)));
  }
  const nearTrail = (x: number, y: number, pad: number): boolean => Math.abs(y - trailY(x)) < pad;

  // The moon shrine's dais and runes sit on the ground.
  const dais = parent.add(new Sprite("shrine.dais", SHRINE.x, SHRINE.y + 4));
  void dais;
  const runes = parent.add(new Pulse("shrine.runes", SHRINE.x, SHRINE.y + 4, 0.75, 0.25, 1.3));
  runes.emissive = true;
  const nearShrine = (x: number, y: number, pad = 0): boolean => ((x - SHRINE.x) / (118 + pad)) ** 2 + ((y - SHRINE.y) / (50 + pad)) ** 2 < 1;

  // Shadows cast by everything that stands, under the actors.
  const shadows = parent.add(new Node2D());
  const clouds = parent.add(new CloudShadows({ area: { x: 0, y: 0, w: WORLD_W, h: WORLD_H }, count: 7, alpha: 0.13, scale: [7, 13], speed: [10, 20] }));

  const actors = parent.add(new Node2D());
  actors.ySort = true;
  const lights = new LightLayer(ambient);

  const blocked = (x: number, y: number, pad: number): boolean => state.obstacles.some((o) => o.r > 0 && Math.hypot(o.x - x, (o.y - y) * 1.4) < o.r + pad);

  const trees: Sprite[] = [];
  for (const o of state.obstacles) {
    const h = hashOf(o.x, o.y);
    if (o.sprite.startsWith("tree")) {
      const s = 0.8 + (h % 7) * 0.04;
      const tree = actors.add(new Sprite(`tree.${h % 4}`, o.x, o.y));
      tree.scale = s;
      trees.push(tree);
      const cs = shadows.add(new Sprite(`wh.shadow.canopy.${h % 2}`, o.x + 34 * s, o.y + 6 * s));
      cs.scaleX = s * 0.8;
      cs.scaleY = s * 0.7;
      actors.add(new LightOccluder2D({ w: 10, h: 8 }, o.x, o.y - 6));
      // Ferns and tufts gather at the roots.
      if (h % 3 === 0) actors.add(new Sprite(`fern.${h % 2}`, o.x + (h % 2 ? 26 : -28) * s, o.y + 4));
      if (h % 4 === 1) actors.add(new Sprite(`tuft.${h % 3}`, o.x - 18 * s, o.y + 6));
    } else if (o.sprite.startsWith("bush")) {
      const sh = shadows.add(new Sprite("wh.shadow.soft", o.x + 6, o.y + 2));
      sh.scaleX = 0.9;
      sh.scaleY = 0.5;
      const b = actors.add(new Sprite(`bush.${h % 3}`, o.x, o.y));
      b.scale = 0.85 + (h % 5) * 0.06;
    } else if (o.sprite.startsWith("rock")) {
      const i = Number(o.sprite.slice(5)) || 0;
      const sh = shadows.add(new Sprite("wh.shadow.soft", o.x + 5, o.y + 1));
      sh.scaleX = 0.6 + i * 0.08;
      sh.scaleY = 0.38;
      actors.add(new Sprite(`rock.${i}`, o.x, o.y));
    } else {
      // Glowing mushrooms: painted caps, an emissive glaze and a cool halo of light.
      const v = h % 3;
      actors.add(new Sprite(`shroom.${v}`, o.x, o.y)).scale = 1.4;
      const glow = actors.add(new Pulse(`shroom.glow.${v}`, o.x, o.y + 0.01, 0.7, 0.25, 1.1 + (h % 5) * 0.2, h));
      glow.scale = 1.4;
      glow.emissive = true;
      const halo = lights.add(new Pulse("__blob", o.x, o.y - 10, 0.35, 0.12, 1.1 + (h % 5) * 0.2, h));
      halo.tint = 0x5aa8ff;
      halo.additive = true;
      halo.scale = 0.9;
    }
  }

  // The shrine's standing stone and its guardian menhirs.
  actors.add(new Sprite("shrine.stone", SHRINE.x, SHRINE.y + 2));
  const stoneGlow = actors.add(new Pulse("shrine.glow", SHRINE.x, SHRINE.y + 2.01, 0.85, 0.15, 1.2));
  stoneGlow.emissive = true;
  for (const a of [0.75, 2.4, 3.6, 5.6]) {
    const x = SHRINE.x + Math.cos(a) * 104;
    const y = SHRINE.y + Math.sin(a) * 42 + 4;
    actors.add(new Sprite(`menhir.${Math.round(a) % 2}`, x, y));
    const g = actors.add(new Pulse("menhir.glow", x, y + 0.01, 0.6, 0.3, 1.3, a * 3));
    g.emissive = true;
  }

  // Undergrowth: tufts, night flowers on the rules' flower tiles, ferns.
  for (let i = 0; i < 420; i++) {
    const x = rng.range(0, WORLD_W);
    const y = rng.range(0, WORLD_H);
    if (nearTrail(x, y, 30) || nearShrine(x, y, 6) || blocked(x, y, 4)) continue;
    const t = actors.add(new Sprite(`tuft.${rng.int(0, 2)}`, x, y));
    t.scale = rng.range(0.8, 1.25);
  }
  for (let y = 0; y < WORLD.rows; y++)
    for (let x = 0; x < WORLD.cols; x++) {
      const id = state.tiles[y * WORLD.cols + x];
      if (id !== 6 && id !== 7) continue;
      const px = (x + rng.range(0.2, 0.8)) * WORLD.tile;
      const py = (y + rng.range(0.3, 0.9)) * WORLD.tile;
      if (nearTrail(px, py, 26) || nearShrine(px, py) || blocked(px, py, 2)) continue;
      actors.add(new Sprite(`tuft.${id === 6 ? 3 : 4}`, px, py));
    }
  for (let i = 0; i < 60; i++) {
    const x = rng.range(0, WORLD_W);
    const y = rng.range(0, WORLD_H);
    if (nearTrail(x, y, 34) || nearShrine(x, y, 10) || blocked(x, y, 10)) continue;
    const f = actors.add(new Sprite(`fern.${rng.int(0, 1)}`, x, y));
    f.scale = rng.range(0.8, 1.15);
  }

  // Atmosphere over everything: drifting fog and fireflies.
  parent.add(new FogBanks(WORLD_W, WORLD_H, 14, 31));
  parent.add(new Fireflies(WORLD_W, WORLD_H, 110, 17));

  // Light: moonbeams slanting from the top left, the shrine's moonstone glow.
  parent.add(lights);
  for (let i = 0; i < 9; i++) {
    const beam = lights.add(new Pulse("wh.moonbeam", rng.range(0, WORLD_W), rng.range(-200, WORLD_H - 300), 0.32, 0.08, 0.3, i));
    beam.additive = true;
    beam.tint = 0xa8d0ff;
    beam.rotation = -0.5;
    beam.scaleX = rng.range(0.8, 1.6);
  }
  lights.add(new Light2D({ radius: 320, color: 0x7fd8ff, intensity: 0.9, flicker: 0.04, falloff: 1.6 }, SHRINE.x, SHRINE.y - 40));
  return { ground, shadows, clouds, actors, lights, trees };
}
