// Highground: an island of plateaus seen from the classic isometric angle. Walk with WASD,
// jump onto ledges with Space, collect coins, click a cell to drop a crate on it. The map,
// the hero's height, the shadows, the coin pool and the sparks all go through the kernel's
// projected, depth-sorted pass; the script only moves the hero and keeps score.

import { Rng, TileMapData } from "@kiln/engine/core";
import { Anchor, Button, IsoTileMap, Label, Node2D, Panel, Scene, Sprite, SpritePool, type DrawContext } from "@kiln/engine/scene";
import { HintLayer, Hints, PauseScene, glyphFor, keyName } from "@kiln/engine/shell";
import { TILE } from "../art.ts";
import { title } from "../main.ts";
import { type Progress, shell } from "../shell.ts";

const COLS = 26;
const ROWS = 26;
const CELL = TILE.w / 2;
const GRAVITY = 560;
const JUMP = 175;
const SPEED = 118;
const JUMP_BUFFER = 0.12;
const COYOTE_TIME = 0.10;

const GRASS = 1;
const SAND = 2;
const WATER = 3;
const STONE = 4;

const FOG_HIDDEN = 0x8bada6;
const FOG_SEEN = 0xc0d5be;
const ISLAND_SEED = 5;

/** Smooth value noise on a coarse grid, for plateaus that read as terraces. */
function noise(rng: Rng, cols: number, rows: number, period: number): number[][] {
  const gw = Math.ceil(cols / period) + 2;
  const gh = Math.ceil(rows / period) + 2;
  const g: number[][] = [];
  for (let y = 0; y < gh; y++) g.push(Array.from({ length: gw }, () => rng.next()));
  const out: number[][] = [];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const fx = c / period;
      const fy = r / period;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const a = g[y0][x0] + (g[y0][x0 + 1] - g[y0][x0]) * tx;
      const b = g[y0 + 1][x0] + (g[y0 + 1][x0 + 1] - g[y0 + 1][x0]) * tx;
      row.push(a + (b - a) * ty);
    }
    out.push(row);
  }
  return out;
}

export class PlayScene extends Scene {
  private map!: IsoTileMap;
  private hero!: Sprite;
  private contact!: Sprite;
  private footRing!: Sprite;
  private readonly cameraGround = { x: 0, y: 0, z: 0 };
  private readonly trees: Sprite[] = [];
  private readonly coinShadows = new Map<number, Sprite>();
  private coins!: SpritePool;
  private sparks!: SpritePool;
  private marker!: Sprite;
  private hud!: Label;
  private crateHud!: Label;
  private readonly pickupLabels: { label: Label; age: number }[] = [];
  private jumpBuffer = 0;
  private coyote = COYOTE_TIME;
  private landingPulse = 0;
  private scorePulse = 0;
  private stride = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private vz = 0;
  private grounded = true;
  private facing: "s" | "n" | "e" | "w" = "s";
  private score = 0;
  private placed = 0;
  private readonly explored = new Set<number>();
  private readonly coinCells: number[] = [];
  private walked = false;
  private jumped = false;
  private completed = false;
  private elapsed = 0;
  private lastReveal = -1;
  private visibleCells = new Set<number>();
  private readonly collected = new Set<number>();
  private readonly coinKeys = new Map<number, number>();
  private readonly crateCells = new Set<number>();
  private readonly effects = new Rng(51);
  private readonly restored: Progress | null;
  private readonly mapSeed: number;
  private totalCoins = 30;

  constructor(progress: Progress | null = null) {
    super();
    this.restored = progress;
    this.mapSeed = progress?.mapSeed ?? ISLAND_SEED;
    if (progress?.collectedCells) for (const cell of progress.collectedCells) this.collected.add(cell);
    if (progress?.exploredCells) for (const cell of progress.exploredCells) this.explored.add(cell);
    if (progress?.effectsState) this.effects.state = progress.effectsState;
    if (progress) {
      this.score = progress.coins;
      this.placed = progress.crates;
    }
  }

  override ready(): void {
    this.name = "play";
    this.background = 0x1b666b;
    this.post.bloom = 0.16;
    this.post.bloomThreshold = 0.86;
    this.post.vignette = 0.14;
    const rng = new Rng(this.mapSeed);

    // The island: height from noise, water round the edge, sand at the shore, stone up high.
    const height = noise(rng, COLS, ROWS, 5);
    const data = new TileMapData(COLS, ROWS);
    const elevation: number[][] = [];
    for (let r = 0; r < ROWS; r++) {
      const row: number[] = [];
      for (let c = 0; c < COLS; c++) {
        const edge = Math.min(c, r, COLS - 1 - c, ROWS - 1 - r);
        const n = height[r][c] - Math.max(0, 3 - edge) * 0.22;
        let e = n < 0.34 ? -1 : n < 0.55 ? 0 : n < 0.72 ? 1 : n < 0.86 ? 2 : 3;
        if (e < 0) {
          data.set(c, r, WATER);
          e = 0;
        } else data.set(c, r, e === 0 && n < 0.42 ? SAND : e >= 2 ? STONE : GRASS);
        row.push(e);
      }
      elevation.push(row);
    }
    this.map = this.world.add(new IsoTileMap({ data, elevation, tile: TILE, tiles: { [GRASS]: "grass.top", [SAND]: "sand.top", [WATER]: "water.top", [STONE]: "stone.top" }, faces: { left: "cliff.left", right: "cliff.right" } }));
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) this.map.setTint(c, r, this.explored.has(r * COLS + c) ? FOG_SEEN : FOG_HIDDEN);

    // Start on the highest cell near the middle.
    let best = -1;
    for (let r = 8; r < ROWS - 8; r++) {
      for (let c = 8; c < COLS - 8; c++) {
        if (data.get(c, r) !== WATER && elevation[r][c] > best) {
          best = elevation[r][c];
          [this.gx, this.gy] = this.map.cellCenter(c, r);
        }
      }
    }
    // Save the connected playable component before restoring the player's location.
    const origin = this.map.cellAt(this.gx, this.gy);
    const reachable = new Set<number>([origin.row * COLS + origin.col]);
    const queue = [...reachable];
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i], c = key % COLS, r = Math.floor(key / COLS);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr, next = nr * COLS + nc;
        if (!this.map.inBounds(nc, nr) || reachable.has(next) || data.get(nc, nr) === WATER || Math.abs(elevation[nr][nc] - elevation[r][c]) > 1) continue;
        reachable.add(next); queue.push(next);
      }
    }
    if (this.restored?.player) {
      const { x, y } = this.restored.player, cell = this.map.cellAt(x, y);
      if (Number.isFinite(x) && Number.isFinite(y) && reachable.has(cell.row * COLS + cell.col)) [this.gx, this.gy] = [x, y];
    }
    this.gz = this.map.heightAt(this.gx, this.gy);

    this.contact = this.surfaceShadow(this.gx, this.gy, this.gz, 0.8);
    this.footRing = this.world.add(new Sprite("hero.ring", this.gx, this.gy));
    this.footRing.z = this.gz;
    this.footRing.depthBias = -0.5;
    this.footRing.alpha = 0.85;
    this.hero = this.world.add(new Sprite("hero.s", this.gx, this.gy));
    this.hero.z = this.gz;

    // Every coin belongs to the same reachable component; stable cell IDs survive a save/load.
    this.coins = this.world.add(new SpritePool({ capacity: 64, sprite: "coin" }));
    const coinRng = new Rng(this.mapSeed ^ 0xc01);
    const candidates = coinRng.shuffle([...reachable]);
    this.totalCoins = Math.min(30, candidates.length);
    if (this.restored && !this.restored.collectedCells) {
      // Legacy saves kept only a total. Retire that many deterministic coin cells once.
      for (const key of candidates.slice(0, Math.min(this.score, this.totalCoins))) this.collected.add(key);
    }
    const coinLocations = new Set(candidates.slice(0, this.totalCoins));
    this.score = 0;
    for (const key of coinLocations) {
      if (this.collected.has(key)) { this.score++; continue; }
      const c = key % COLS, r = Math.floor(key / COLS), [x, y] = this.map.cellCenter(c, r);
      const handle = this.coins.spawn({ x, y, z: this.map.heightAt(x, y) + 10 });
      if (handle >= 0) {
        this.coinCells.push(handle); this.coinKeys.set(handle, key);
        this.coinShadows.set(handle, this.surfaceShadow(x, y, this.map.heightAt(x, y), 0.42));
      }
    }

    // Trees have consistent, layered canopies; ground dressing leaves the coin paths readable.
    const occupied = new Set<number>();
    for (let i = 0; i < 170; i++) {
      const c = rng.int(1, COLS - 2), r = rng.int(1, ROWS - 2), key = r * COLS + c;
      const id = data.get(c, r);
      if (id === WATER || occupied.has(key) || coinLocations.has(key) || (Math.abs(c - origin.col) <= 1 && Math.abs(r - origin.row) <= 1)) continue;
      occupied.add(key);
      const [x, y] = this.map.cellCenter(c, r);
      const sprite = id === STONE ? "rock" : rng.chance(0.48) ? "tree" : rng.chance(0.4) ? "flowers" : "grass.tuft";
      const prop = this.world.add(new Sprite(sprite, x + rng.range(-5, 5), y + rng.range(-5, 5)));
      prop.z = this.map.heightAt(x, y);
      if (sprite === "tree") {
        prop.scaleX = prop.scaleY = rng.range(0.85, 1.15);
        this.trees.push(prop);
      }
      if (sprite === "tree" || sprite === "rock") this.surfaceShadow(prop.x, prop.y, prop.z, sprite === "tree" ? prop.scaleX * 1.2 : 0.65);
    }
    for (const key of this.restored?.crateCells ?? []) this.addCrate(key, false);

    // A sparse layer of sunlit pollen moves entirely in the retained kernel pool.
    const pollen = this.world.add(new SpritePool({ capacity: 36, sprite: "spark", additive: true, bounds: { x: 0, y: 0, w: COLS * CELL, h: ROWS * CELL }, boundsMode: "wrap" }));
    const breeze = new Rng(this.mapSeed ^ 0xb2ee);
    for (let i = 0; i < 36; i++) {
      const x = breeze.range(0, COLS * CELL), y = breeze.range(0, ROWS * CELL);
      pollen.spawn({ x, y, z: this.map.heightAt(x, y) + breeze.range(22, 58), vx: breeze.range(3, 7), vy: -3, scale: breeze.range(0.3, 0.6), alpha: 0.36 });
    }
    // Short rising bursts expire above the surface; a global z=0 bounce floor is wrong on terraces.
    this.sparks = this.world.add(new SpritePool({ capacity: 192, sprite: "spark", gravityZ: -120, additive: true }));

    this.marker = this.world.add(new Sprite("marker", 0, 0));
    this.marker.alpha = 0.6;
    this.marker.depthBias = -CELL / 2 + 1;

    this.camera.projection = { kind: "isometric", tile: { w: TILE.w, h: TILE.h } };
    this.camera.zoom = 1.45;
    Object.assign(this.cameraGround, { x: this.gx, y: this.gy, z: this.gz });
    this.camera.follow(this.cameraGround, 7);
    this.camera.x = this.gx;
    this.camera.y = this.gy;
    this.camera.z = this.gz;

    const top = this.ui.add(new Anchor({ x: "left", y: "top", safe: 24 }));
    top.add(new Panel(0, 0, 304, 160, { fill: 0x103a3d, fillAlpha: 0.94, border: 0x83b6a3, bevel: null }));
    top.add(new Label("HIGHGROUND  /  SUNLIT TERRACES", 18, 15, { color: 0xbcd6c1, font: { family: "Instrument Sans", size: 12, weight: 700 } }));
    const coinIcon = top.add(new Sprite("coin", 32, 67));
    coinIcon.scaleX = coinIcon.scaleY = 2;
    this.hud = top.add(new Label("", 56, 40, { color: 0xffdc80, font: { family: "Instrument Sans", size: 34, weight: 700 } }));
    top.add(new Label("SUN COINS FOUND", 57, 83, { color: 0xe4ead3, font: { family: "Instrument Sans", size: 11, weight: 700 } }));
    top.add(new CoinProgress(this, 18, 110));
    this.crateHud = top.add(new Label("", 18, 129, { color: 0xabc7b9, font: { family: "Instrument Sans", size: 12, weight: 500 } }));
    const chart = this.ui.add(new Anchor({ x: "right", y: "top", safe: 24 }));
    chart.add(new IslandChart(this));
    chart.add(new Button("Pause", -162, 202, 162, 38, { onPress: () => this.pauseGame(), style: { fill: 0x103a3d, hover: 0x28575a, text: 0xe4ead3, border: 0x83b6a3, bevel: null } }));
    const controls = this.ui.add(new Anchor({ x: "left", y: "bottom", safe: 24 }));
    controls.add(new ControlGuide());
    // Tutorial hints from the shell: each names when it applies and what ends it.
    const hints = new Hints(this.app, [
      { id: "walk", text: "Follow the gold. Explore every terrace.", until: () => this.walked },
      { id: "jump", text: "{jump} to jump onto a ledge", action: "jump", when: () => this.walked, delay: 0.6 },
      { id: "crate", text: "Click a cell to drop a crate on it", when: () => this.jumped, delay: 1, duration: 8 },
      { id: "pause", text: "{pause} pauses · {reset} starts a fresh island", when: () => this.score > 0, delay: 1, duration: 6 },
    ], shell.settings);
    this.ui.add(new HintLayer(hints));
    this.reveal();
    this.app.audio.setMood("ridge", { crossfade: 1 });
    this.updateHud();
    if (this.coinCells.length === 0) this.finish();
  }

  /** Fog touches only cells entering/leaving visibility, and only after a cell crossing. */
  private reveal(): void {
    const { col, row } = this.map.cellAt(this.gx, this.gy), center = row * COLS + col;
    if (center === this.lastReveal) return;
    this.lastReveal = center;
    const next = new Set<number>();
    for (let r = Math.max(0, row - 7); r <= Math.min(ROWS - 1, row + 7); r++) {
      for (let c = Math.max(0, col - 7); c <= Math.min(COLS - 1, col + 7); c++) {
        if ((c - col) ** 2 + (r - row) ** 2 > 6.5 ** 2) continue;
        const key = r * COLS + c;
        next.add(key); this.explored.add(key);
        if (!this.visibleCells.has(key)) this.map.setTint(c, r, 0xffffff);
      }
    }
    for (const key of this.visibleCells) if (!next.has(key)) this.map.setTint(key % COLS, Math.floor(key / COLS), FOG_SEEN);
    this.visibleCells = next;
  }

  private updateHud(): void {
    this.hud.text = `${String(this.score).padStart(2, "0")} / ${this.totalCoins}`;
    this.crateHud.text = `${this.placed} crates placed  ·  Click to place a crate`;
  }

  get coinProgress(): number { return this.score / Math.max(1, this.totalCoins); }

  /** The generic projected blob uses sea level. Terrace actors supply their real surface. */
  private surfaceShadow(x: number, y: number, z: number, scale = 1): Sprite {
    const shadow = this.world.add(new Sprite("contact", x, y));
    shadow.z = z; shadow.depthBias = -1;
    shadow.scaleX = shadow.scaleY = scale;
    return shadow;
  }

  private beginJump(): void {
    this.jumpBuffer = 0; this.coyote = 0;
    this.vz = JUMP; this.grounded = false; this.jumped = true;
    this.landingPulse = 0;
    this.app.audio.play("jump");
    this.surfaceBurst(this.gx, this.gy, this.map.heightAt(this.gx, this.gy), 6);
  }

  private surfaceBurst(x: number, y: number, z: number, count: number): void {
    for (let k = 0; k < count; k++) {
      const a = this.effects.next() * Math.PI * 2, speed = 12 + this.effects.next() * 34;
      this.sparks.spawn({ x, y, z: z + 2, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, vz: 28 + this.effects.next() * 22, life: 0.3 + this.effects.next() * 0.1, scale: 0.35 + this.effects.next() * 0.55 });
    }
  }

  private pauseGame(): void {
    this.jumpBuffer = 0;
    this.app.scenes.push(new PauseScene({ settings: shell.settings ?? undefined, onQuit: () => this.quit() }), { overlay: true });
  }

  /** Fade only canopies in front of and covering the hero, preserving the island's depth. */
  private updateOcclusion(dt: number): void {
    const hx = this.gx - this.gy, hy = (this.gx + this.gy) * 0.5 - this.hero.z - 20;
    const rate = 1 - Math.exp(-14 * dt);
    for (const tree of this.trees) {
      const tx = tree.x - tree.y, ty = (tree.x + tree.y) * 0.5 - tree.z;
      const covers = tree.x + tree.y > this.gx + this.gy + 0.5
        && Math.abs(tx - hx) < 24 * tree.scaleX + 9
        && hy > ty - 67 * tree.scaleY - 9 && hy < ty - 7 * tree.scaleY + 12;
      tree.alpha += ((covers ? 0.22 : 1) - tree.alpha) * rate;
    }
  }

  private updateFeedback(dt: number): void {
    this.scorePulse = Math.max(0, this.scorePulse - dt * 3);
    this.hud.scaleX = this.hud.scaleY = 1 + Math.sin(this.scorePulse * Math.PI) * 0.08;
    for (let i = this.pickupLabels.length - 1; i >= 0; i--) {
      const item = this.pickupLabels[i];
      item.age += dt;
      item.label.z += dt * 23;
      item.label.alpha = Math.min(1, (0.7 - item.age) * 4);
      if (item.age >= 0.7) { item.label.destroy(); this.pickupLabels.splice(i, 1); }
    }
  }

  /** Small untextured map: terrain, remaining coin positions and the player's position. */
  drawChart(ctx: DrawContext): void {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const id = this.map.get(c, r);
      const color = id === WATER ? 0x246d70 : id === STONE ? 0xb1c2b4 : id === SAND ? 0xdbc28b : 0x8cae67;
      ctx.rect(15 + c * 5, 44 + r * 5, 5, 5, color, this.explored.has(r * COLS + c) ? 1 : 0.48);
    }
    for (const handle of this.coinCells) {
      const key = this.coinKeys.get(handle)!;
      ctx.rect(16 + (key % COLS) * 5, 45 + Math.floor(key / COLS) * 5, 3, 3, 0xffdc69);
    }
    const cell = this.map.cellAt(this.gx, this.gy);
    ctx.rect(14 + cell.col * 5, 43 + cell.row * 5, 7, 7, 0x123c3e);
    ctx.rect(16 + cell.col * 5, 45 + cell.row * 5, 3, 3, 0xffffff);
  }

  /** The cell under a screen point, trying each level from the top so ledges pick correctly. */
  private pick(sx: number, sy: number): { col: number; row: number } | null {
    for (let level = 3; level >= 0; level--) {
      const [wx, wy] = this.camera.screenToWorld(sx, sy, level * TILE.rise);
      const cell = this.map.cellAt(wx, wy);
      if (this.map.inBounds(cell.col, cell.row) && this.map.elevationAt(cell.col, cell.row) === level && this.map.get(cell.col, cell.row) !== WATER) return cell;
    }
    return null;
  }

  override onAction(name: string, pressed: boolean): void {
    if (!pressed) return;
    if (name === "jump" && !this.completed) this.jumpBuffer = JUMP_BUFFER;
    if (name === "reset") this.app.scenes.change(new PlayScene(), { transition: "fade", duration: 0.5 });
    if (name === "pause") this.pauseGame();
  }

  private progress(): Progress {
    return { coins: this.score, crates: this.placed, mapSeed: this.mapSeed, collectedCells: [...this.collected], crateCells: [...this.crateCells], exploredCells: [...this.explored], player: { x: this.gx, y: this.gy }, effectsState: this.effects.state };
  }

  private quit(): void {
    shell.saves?.autosave(this.progress());
    this.app.scenes.change(title(this.app), { transition: "fade", duration: 0.5 });
  }

  override update(dt: number): void {
    this.elapsed += dt;
    this.updateFeedback(dt);
    if (this.completed) return;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? COYOTE_TIME : Math.max(0, this.coyote - dt);
    this.landingPulse = Math.max(0, this.landingPulse - dt * 4);
    if (this.jumpBuffer > 0 && this.coyote > 0) this.beginJump();
    const input = this.app.input;
    // Screen-relative input: right on the keyboard is right on the screen, which is +x, -y on the ground.
    let ix = input.axis("left", "right"), iy = input.axis("up", "down");
    const stick = this.app.gamepad.leftStick, magnitude = Math.min(1, Math.hypot(stick.x, stick.y));
    let strength = 1;
    if (this.app.gamepad.connected && magnitude > 0.25) {
      // Radial remapping keeps light stick travel slow; digital stick bindings still serve menus.
      ix = stick.x; iy = stick.y; strength = (magnitude - 0.25) / 0.75;
      input.lastDevice = "gamepad";
    }
    const beforeX = this.gx, beforeY = this.gy;
    if (ix || iy) {
      const len = Math.hypot(ix, iy);
      const dx = ((ix + iy) / len) * SPEED * strength * dt * Math.SQRT1_2;
      const dy = ((iy - ix) / len) * SPEED * strength * dt * Math.SQRT1_2;
      this.tryMove(dx, 0);
      this.tryMove(0, dy);
      this.walked = true;
      this.facing = Math.abs(ix) >= Math.abs(iy) ? (ix > 0 ? "e" : "w") : iy > 0 ? "s" : "n";
    }
    // Height: gravity, landing on whatever the ground is here.
    const floor = this.map.heightAt(this.gx, this.gy);
    this.vz -= GRAVITY * dt;
    this.gz += this.vz * dt;
    if (this.gz <= floor) {
      if (!this.grounded && this.vz < -60) {
        this.app.audio.play("land");
        this.landingPulse = 1;
        this.surfaceBurst(this.gx, this.gy, floor, 10);
        this.camera.shake(0.8, 0.12);
      }
      this.gz = floor;
      this.vz = 0;
      this.grounded = true;
      if (this.jumpBuffer > 0) this.beginJump();
    } else this.grounded = false;
    const moved = Math.hypot(this.gx - beforeX, this.gy - beforeY);
    this.stride += moved * 0.13;
    const walking = this.grounded && moved > 0.01;
    this.hero.sprite = `hero.${this.facing}${walking ? Math.sin(this.stride) < 0 ? ".stepL" : ".stepR" : ""}`;
    this.hero.setPosition(this.gx, this.gy);
    this.hero.z = this.gz + (walking ? Math.abs(Math.sin(this.stride)) * 1.2 : 0);
    const stretch = this.grounded ? -Math.sin(this.landingPulse * Math.PI) * 0.15 : Math.max(-0.05, Math.min(0.12, this.vz / 1400));
    this.hero.scaleX = 1 - stretch * 0.5; this.hero.scaleY = 1 + stretch;
    this.contact.setPosition(this.gx, this.gy); this.contact.z = floor;
    const aboveGround = Math.max(0, this.gz - floor);
    this.contact.scaleX = this.contact.scaleY = Math.max(0.45, 0.8 - aboveGround / 110);
    this.contact.alpha = Math.max(0.4, 1 - aboveGround / 70);
    this.footRing.setPosition(this.gx, this.gy); this.footRing.z = floor;
    this.footRing.scaleX = this.footRing.scaleY = 1 + this.landingPulse * 0.25;
    this.cameraGround.x = this.gx; this.cameraGround.y = this.gy; this.cameraGround.z = floor;
    this.updateOcclusion(dt);

    // Coins: the pool keeps them; the script only checks the ones near the hero.
    for (let i = this.coinCells.length - 1; i >= 0; i--) {
      const h = this.coinCells[i];
      const c = this.coins.get(h);
      if (!c.alive) continue;
      const surface = this.map.heightAt(c.x, c.y);
      this.coins.set(h, { z: surface + 12 + Math.sin(this.elapsed * 3 + h * 1.7) * 3, sx: 0.65 + Math.abs(Math.sin(this.elapsed * 2 + h)) * 0.35 });
      if (Math.hypot(c.x - this.gx, c.y - this.gy) < 16 && Math.abs(surface - this.gz) < 20) {
        this.coins.free(h);
        this.coinCells.splice(i, 1);
        this.score++;
        this.collected.add(this.coinKeys.get(h)!);
        this.coinKeys.delete(h);
        this.coinShadows.get(h)?.destroy(); this.coinShadows.delete(h);
        this.updateHud();
        this.scorePulse = 1;
        const label = this.world.add(new Label("+1", c.x, c.y, { color: 0xffe5a0, align: "center", shadow: 0x163f3f, font: { family: "Instrument Sans", size: 16, weight: 700 } }));
        label.z = c.z + 30; label.depthBias = 1;
        this.pickupLabels.push({ label, age: 0 });
        this.app.audio.play("coin");
        this.app.haptic("light");
        this.surfaceBurst(c.x, c.y, c.z, 14);
        shell.saves?.autosave(this.progress());
      }
    }
    // The marker follows the pointer's cell; a click drops a crate there.
    const p = this.app.pointer;
    const cell = this.pick(p.x, p.y);
    this.marker.visible = cell !== null;
    if (cell) {
      const [x, y] = this.map.cellCenter(cell.col, cell.row);
      this.marker.setPosition(x, y);
      this.marker.z = this.map.heightAt(x, y);

    }
    this.reveal();
    if (this.coinCells.length === 0) this.finish();
  }

  override onPointerDown(x: number, y: number): void {
    if (this.completed) return;
    const cell = this.pick(x, y);
    if (!cell) return;
    const key = cell.row * COLS + cell.col;
    if (this.crateCells.has(key)) return;
    this.addCrate(key, true);
    this.placed++;
    this.updateHud();
    shell.saves?.autosave(this.progress());
  }

  private addCrate(key: number, animate: boolean): void {
    const col = key % COLS, row = Math.floor(key / COLS);
    if (!Number.isInteger(key) || !this.map.inBounds(col, row) || this.map.get(col, row) === WATER || this.crateCells.has(key)) return;
    this.crateCells.add(key);
    const [x, y] = this.map.cellCenter(col, row), floor = this.map.heightAt(x, y);
    const crate = this.world.add(new Sprite("crate", x, y));
    crate.z = floor + (animate ? 40 : 0); crate.depthBias = 0.5;
    this.surfaceShadow(x, y, floor, 0.9);
    if (animate) {
      this.tweens.to(crate, { z: floor }, 0.35, { ease: "outBack" });
      this.app.audio.play("place");
    }
  }

  private finish(): void {
    if (this.completed) return;
    this.completed = true; this.marker.visible = false;
    shell.saves?.autosave(this.progress());
    const card = this.ui.add(new Anchor({ x: "center", y: "center" }));
    card.add(new Panel(-230, -112, 460, 224, { fill: 0x123d3f, fillAlpha: 0.98, border: 0xdcc378, bevel: null }));
    card.add(new Label("THE ISLAND IS YOURS", 0, -81, { align: "center", color: 0xffdc80, font: { family: "Instrument Sans", size: 26, weight: 700 } }));
    card.add(new Label(`All ${this.totalCoins} sun coins found. A little higher, a little brighter.`, 0, -30, { align: "center", color: 0xe0ead2, font: { family: "Instrument Sans", size: 15, weight: 500 } }));
    card.add(new Button("Explore again", -116, 26, 232, 48, { onPress: () => this.app.scenes.change(new PlayScene(), { transition: "fade", duration: 0.4 }), style: { fill: 0xc3d899, text: 0x173d38, hover: 0xd9e6bb, border: null, bevel: null } }));
  }

  /** Walk unless the next cell is water, off the island, or a wall too high to step onto. */
  private tryMove(dx: number, dy: number): void {
    const nx = this.gx + dx;
    const ny = this.gy + dy;
    const { col, row } = this.map.cellAt(nx, ny);
    if (!this.map.inBounds(col, row) || this.map.get(col, row) === WATER) return;
    const h = this.map.heightAt(nx, ny);
    if (h > this.gz + 2) return;
    this.gx = nx;
    this.gy = ny;
  }
}

class IslandChart extends Node2D {
  constructor(private readonly play: PlayScene) { super(-162, 0); }
  override render(ctx: DrawContext): void {
    ctx.rect(0, 0, 162, 190, 0x103a3d, 0.94);
    ctx.frame(0, 0, 162, 190, 0x83b6a3);
    ctx.text("ISLAND CHART", 16, 15, { color: 0xf6edd2, font: { family: "Instrument Sans", size: 13, weight: 700 } });
    this.play.drawChart(ctx);
  }
}

class CoinProgress extends Node2D {
  constructor(private readonly play: PlayScene, x: number, y: number) { super(x, y); }
  override render(ctx: DrawContext): void {
    ctx.rect(0, 0, 268, 5, 0x315b56);
    ctx.rect(0, 0, 268 * this.play.coinProgress, 5, 0xffdc80);
  }
}

class ControlGuide extends Node2D {
  override render(ctx: DrawContext): void {
    const app = this.scene!.app;
    // Pointer taps also mark the input device as touch, but this example has no virtual stick.
    // Keep the actual keyboard bindings visible after a menu tap; gamepads get their glyphs.
    const glyph = (action: string): string => app.input.lastDevice === "gamepad" ? glyphFor(app, action) : keyName(app.input.bindingsOf(action).find((code) => !code.startsWith("Gamepad")) ?? action);
    const move = app.input.lastDevice === "gamepad" ? "Left stick / D-pad" : `${glyph("up")} ${glyph("left")} ${glyph("down")} ${glyph("right")}`;
    ctx.rect(0, -55, 304, 55, 0x103a3d, 0.9);
    ctx.text(`${move}  MOVE`, 15, -44, { color: 0xd5e4ca, font: { family: "Instrument Sans", size: 12, weight: 600 } });
    ctx.text(`${glyph("jump")}  JUMP     ${glyph("pause")}  PAUSE`, 15, -22, { color: 0xffdc80, font: { family: "Instrument Sans", size: 12, weight: 600 } });
  }
}
