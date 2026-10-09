import "./art.ts";
import type { App } from "@kiln/engine/app";
import { Rng, TileMapData } from "@kiln/engine/core";
import { Anchor, Label, Light2D, LightLayer, Node2D, ParticleEmitter, Scene, Sprite, SpritePool, TileMap } from "@kiln/engine/scene";

interface Params {
  sprites: number;
  particles: number;
  cols: number;
  rows: number;
  /** Move the sprites in the kernel's node table (default) or as script nodes (`?pool=0`). */
  pool: boolean;
}

const TILE = 32;
const FONT = { family: "system-ui", size: 18, weight: 600 as const };

/** Parameters from `bench` in kiln.json, overridden by the URL on the web. */
function params(): Params {
  const cfg = (globalThis as { KILN_CONFIG?: { bench?: Partial<Params> } }).KILN_CONFIG?.bench ?? {};
  const p: Params = { sprites: 2000, particles: 1000, cols: 120, rows: 80, pool: true, ...cfg };
  const loc = (globalThis as { location?: { search: string } }).location;
  if (loc) {
    const q = new URLSearchParams(loc.search);
    const num = (k: string, v: number) => (q.has(k) ? Number(q.get(k)) || v : v);
    p.sprites = num("n", p.sprites);
    p.particles = num("p", p.particles);
    p.cols = num("cols", p.cols);
    p.rows = num("rows", p.rows);
    if (q.has("pool")) p.pool = q.get("pool") !== "0";
  }
  return p;
}

interface Bug {
  node: Sprite;
  vx: number;
  vy: number;
}

class BenchScene extends Scene {
  private readonly p = params();
  private readonly bugs: Bug[] = [];
  private readonly emitters: ParticleEmitter[] = [];
  private pool: SpritePool | null = null;
  private hud!: Label;
  private t = 0;

  override ready(): void {
    this.name = "bench";
    this.background = 0x0e1216;
    const { cols, rows } = this.p;
    const rng = new Rng(7);
    const data = new TileMapData(cols, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const path = Math.sin(c * 0.21) * Math.cos(r * 0.17) > 0.35 || rng.chance(0.04);
        data.set(c, r, path ? 4 : 1 + rng.int(0, 2));
      }
    }
    this.world.add(new TileMap({ data, tileSize: TILE, tiles: { 1: "grass.0", 2: "grass.1", 3: "grass.2", 4: { autotile: "path" } } }));

    const W = cols * TILE;
    const H = rows * TILE;
    const layer = this.world.add(new Node2D());
    if (this.p.pool) {
      // Every bug is a kernel node: the script spawns once and never touches them again.
      this.pool = layer.add(new SpritePool({ capacity: this.p.sprites, bounds: { x: 0, y: 0, w: W, h: H }, boundsMode: "bounce" }));
      for (let i = 0; i < this.p.sprites; i++) {
        const a = rng.range(0, Math.PI * 2);
        const s = rng.range(30, 90);
        this.pool.spawn({ sprite: `bug.${i % 4}`, x: rng.range(0, W), y: rng.range(0, H), vx: Math.cos(a) * s, vy: Math.sin(a) * s, flipX: Math.cos(a) < 0 });
      }
    } else {
      for (let i = 0; i < this.p.sprites; i++) {
        const node = layer.add(new Sprite(`bug.${i % 4}`, rng.range(0, W), rng.range(0, H)));
        const a = rng.range(0, Math.PI * 2);
        const s = rng.range(30, 90);
        this.bugs.push({ node, vx: Math.cos(a) * s, vy: Math.sin(a) * s });
      }
    }

    for (let i = 0; i < 3; i++) {
      const e = this.world.add(
        new ParticleEmitter(
          { rate: this.p.particles, life: [1, 2], speed: [20, 70], gravity: -25, drag: 0.4, size: [0.6, 1.4], sizeEnd: 0.2, alpha: [1, 0], colors: [0xffd070, 0xff9040, 0xfff0c0], additive: true, sprite: "spark", spread: 24, max: this.p.particles * 3, seed: 11 + i },
          W / 2 + (i - 1) * 260,
          H / 2 + (i % 2) * 140,
        ),
      );
      this.emitters.push(e);
    }

    const lights = this.world.add(new LightLayer(0x5a6a88));
    for (let i = 0; i < 3; i++) lights.add(new Light2D({ radius: 360, color: [0xffc080, 0x80c0ff, 0xc0ff90][i], flicker: 0.05 }, W / 2 + (i - 1) * 260, H / 2 + (i % 2) * 140));

    this.camera.bounds = { x: 0, y: 0, w: W, h: H };
    const top = this.ui.add(new Anchor({ x: "left", y: "top", safe: 12 }));
    this.hud = top.add(new Label("", 0, 0, { font: FONT, shadow: 0x000000 }));
    const bottom = this.ui.add(new Anchor({ x: "center", y: "bottom", safe: 12 }));
    bottom.add(new Label(this.p.pool ? "Kiln bench: sprites move in the kernel node table (?pool=0 for script nodes)" : "Kiln bench: sprites move as script nodes (?pool=1 for the kernel node table)", 0, 0, { font: FONT, align: "center", shadow: 0x000000 }));
  }

  override update(dt: number): void {
    this.t += dt;
    const W = this.p.cols * TILE;
    const H = this.p.rows * TILE;
    for (const b of this.bugs) {
      const n = b.node;
      n.x += b.vx * dt;
      n.y += b.vy * dt;
      if (n.x < 0 || n.x > W) b.vx = -b.vx;
      if (n.y < 0 || n.y > H) b.vy = -b.vy;
      n.flipX = b.vx < 0;
    }
    this.camera.x = W / 2 + Math.cos(this.t * 0.25) * 420;
    this.camera.y = H / 2 + Math.sin(this.t * 0.2) * 300;
    let live = 0;
    for (const e of this.emitters) live += e.count;
    if ((this.app.frames & 7) === 0) this.hud.text = `${this.p.sprites} sprites (${this.p.pool ? "kernel" : "script"})   ${live} particles   ${this.p.cols}x${this.p.rows} tiles   ${this.app.cpuMs.toFixed(1)} ms script`;
  }
}

/** Called by the entry wrapper once the App exists, on the web and natively. */
export default async function main(app: App): Promise<void> {
  app.scenes.change(new BenchScene());
}
