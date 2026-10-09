import { TAU, lerp } from "../core/math.ts";
import { Rng } from "../core/rng.ts";
import { CFG, type Kernel } from "../kernel/protocol.ts";
import type { DrawContext } from "./draw.ts";
import { Node2D } from "./node.ts";

export interface ParticleConfig {
  /** Particles per second while emitting; 0 means bursts only. */
  rate?: number;
  life: [number, number];
  speed: [number, number];
  /** Emission angle range in radians; default is all directions. */
  angle?: [number, number];
  gravity?: number;
  /** Fraction of velocity lost per second. */
  drag?: number;
  /** Pixel size range for rect particles, or scale range for sprite particles. */
  size?: [number, number];
  /** Size multiplier at end of life. */
  sizeEnd?: number;
  /** Alpha at start and end of life. */
  alpha?: [number, number];
  colors?: number[];
  additive?: boolean;
  /** Sprite name; omit to draw pixels. */
  sprite?: string;
  /** Spawn radius around the emitter. */
  spread?: number;
  /** Spin in radians per second (sprites only), applied with a random sign. */
  spin?: number;
  max?: number;
  seed?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: number;
  rot: number;
  spin: number;
}

/**
 * Particles live in the layer's root space (the world under the camera, or the screen
 * for UI), so an emitter that moves leaves a trail behind it. With a kernel, the emitter's
 * state lives there and one command per frame steps and draws it; otherwise the node
 * simulates in script.
 */
export class ParticleEmitter extends Node2D {
  emitting = true;
  private readonly pool: Particle[] = [];
  private live: Particle[] = [];
  private acc = 0;
  private readonly rng: Rng;
  readonly config: Required<Omit<ParticleConfig, "sprite">> & { sprite?: string };
  private kernel: Kernel | null = null;
  private kernelId = -1;
  private pendingDt = 0;
  private readonly pendingBursts: [number, number, number][] = [];

  constructor(config: ParticleConfig, x = 0, y = 0) {
    super(x, y);
    this.config = {
      rate: 0,
      angle: [0, TAU],
      gravity: 0,
      drag: 0,
      size: [1, 2],
      sizeEnd: 1,
      alpha: [1, 0],
      colors: [0xffffff],
      additive: false,
      spread: 0,
      spin: 0,
      max: 500,
      seed: 1,
      ...config,
    };
    this.rng = new Rng(this.config.seed);
  }

  get count(): number {
    return this.kernel && this.kernelId >= 0 ? this.kernel.emitterCount(this.kernelId) : this.live.length;
  }

  /** The kernel this emitter will run in, known as soon as the scene is attached to an App. */
  private kernelCandidate(): Kernel | null {
    return this.scene?.attachedApp?.renderer.kernel ?? null;
  }

  /** Spawn `n` particles now at the emitter, optionally offset in local space. */
  burst(n: number, dx = 0, dy = 0): void {
    const [wx, wy] = this.worldPoint(dx, dy);
    const k = this.kernelCandidate();
    if (k) {
      if (this.kernel === k && this.kernelId >= 0) k.burst(this.kernelId, n, wx, wy);
      else this.pendingBursts.push([n, wx, wy]);
      return;
    }
    for (let i = 0; i < n; i++) this.spawn(wx, wy);
  }

  private worldPoint(dx: number, dy: number): [number, number] {
    // Position in the layer root's space: undo the root transform from our world matrix.
    const root = this.scene ? this.rootMatrix() : null;
    const m = this.world;
    const sx = m[0] * dx + m[2] * dy + m[4];
    const sy = m[1] * dx + m[3] * dy + m[5];
    if (!root) return [sx, sy];
    const det = root[0] * root[3] - root[1] * root[2] || 1;
    const px = sx - root[4];
    const py = sy - root[5];
    return [(root[3] * px - root[2] * py) / det, (-root[1] * px + root[0] * py) / det];
  }

  private rootMatrix(): readonly number[] | null {
    const s = this.scene;
    if (!s) return null;
    let n: Node2D | null = this;
    let underUi = false;
    while (n) {
      if (n === s.ui) underUi = true;
      n = n.parent instanceof Node2D ? n.parent : null;
    }
    return underUi ? [1, 0, 0, 1, 0, 0] : s.cameraMatrix;
  }

  private spawn(x: number, y: number): void {
    if (this.live.length >= this.config.max) return;
    const c = this.config;
    const r = this.rng;
    const p = this.pool.pop() ?? { x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 0, color: 0, rot: 0, spin: 0 };
    const a = r.range(c.angle[0], c.angle[1]);
    const sp = r.range(c.speed[0], c.speed[1]);
    const off = c.spread > 0 ? r.range(0, c.spread) : 0;
    const oa = r.range(0, TAU);
    p.x = x + Math.cos(oa) * off;
    p.y = y + Math.sin(oa) * off;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp;
    p.maxLife = r.range(c.life[0], c.life[1]);
    p.life = p.maxLife;
    p.size = r.range(c.size[0], c.size[1]);
    p.color = r.pick(c.colors);
    p.rot = c.sprite ? r.range(0, TAU) : 0;
    p.spin = c.spin * r.sign();
    this.live.push(p);
  }

  override update(dt: number): void {
    if (this.kernelCandidate()) {
      // The kernel steps at draw time with the accumulated time.
      this.pendingDt += dt;
      return;
    }
    const c = this.config;
    if (this.emitting && c.rate > 0) {
      this.acc += c.rate * dt;
      const n = Math.floor(this.acc);
      if (n > 0) {
        this.acc -= n;
        const [wx, wy] = this.worldPoint(0, 0);
        for (let i = 0; i < n; i++) this.spawn(wx, wy);
      }
    }
    const dragK = c.drag > 0 ? Math.max(0, 1 - c.drag * dt) : 1;
    let write = 0;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.pool.push(p);
        continue;
      }
      p.vy += c.gravity * dt;
      p.vx *= dragK;
      p.vy *= dragK;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      this.live[write++] = p;
    }
    this.live.length = write;
  }

  override exit(): void {
    this.release();
  }

  private release(): void {
    if (this.kernel && this.kernelId >= 0) this.kernel.destroyEmitter(this.kernelId);
    this.kernel = null;
    this.kernelId = -1;
  }

  /** Create the kernel emitter from the config, resolving the sprite region through the atlas. */
  private attach(ctx: DrawContext, k: Kernel): void {
    this.release();
    const c = this.config;
    const s = k.scratch;
    s.fill(0, 0, CFG.COLORS + c.colors.length);
    s[CFG.RATE] = c.rate;
    s[CFG.LIFE0] = c.life[0];
    s[CFG.LIFE1] = c.life[1];
    s[CFG.SPEED0] = c.speed[0];
    s[CFG.SPEED1] = c.speed[1];
    s[CFG.ANGLE0] = c.angle[0];
    s[CFG.ANGLE1] = c.angle[1];
    s[CFG.GRAVITY] = c.gravity;
    s[CFG.DRAG] = c.drag;
    s[CFG.SIZE0] = c.size[0];
    s[CFG.SIZE1] = c.size[1];
    s[CFG.SIZE_END] = c.sizeEnd;
    s[CFG.ALPHA0] = c.alpha[0];
    s[CFG.ALPHA1] = c.alpha[1];
    s[CFG.SPREAD] = c.spread;
    s[CFG.SPIN] = c.spin;
    s[CFG.MAX] = c.max;
    s[CFG.ADDITIVE] = c.additive ? 1 : 0;
    s[CFG.SEED] = (typeof c.seed === "number" ? c.seed : 1) >>> 0;
    if (c.sprite) {
      const r = ctx.region(c.sprite);
      s[CFG.HAS_SPRITE] = 1;
      s[CFG.SPRITE_W] = r.w;
      s[CFG.SPRITE_H] = r.h;
      s[CFG.SPRITE_OX] = r.ox;
      s[CFG.SPRITE_OY] = r.oy;
      s[CFG.SPRITE_U0] = r.u0;
      s[CFG.SPRITE_V0] = r.v0;
      s[CFG.SPRITE_U1] = r.u1;
      s[CFG.SPRITE_V1] = r.v1;
    }
    s[CFG.COLOR_COUNT] = c.colors.length;
    for (let i = 0; i < c.colors.length; i++) s[CFG.COLORS + i] = c.colors[i] & 0xffffff;
    this.kernelId = k.createEmitter(CFG.COLORS + c.colors.length);
    this.kernel = k;
  }

  override render(ctx: DrawContext): void {
    const k = ctx.kernel;
    if (k) {
      if (this.kernel !== k || this.kernelId < 0) this.attach(ctx, k);
      for (const [n, x, y] of this.pendingBursts) k.burst(this.kernelId, n, x, y);
      this.pendingBursts.length = 0;
      const [wx, wy] = this.worldPoint(0, 0);
      ctx.setTransform(ctx.rootTransform, this.worldAlpha);
      ctx.particles(this.kernelId, this.pendingDt, this.emitting, wx, wy);
      this.pendingDt = 0;
      return;
    }
    if (this.live.length === 0) return;
    const c = this.config;
    ctx.setTransform(ctx.rootTransform, this.worldAlpha);
    for (const p of this.live) {
      const t = 1 - p.life / p.maxLife;
      const alpha = lerp(c.alpha[0], c.alpha[1], t);
      const size = p.size * lerp(1, c.sizeEnd, t);
      if (c.sprite) {
        ctx.sprite(c.sprite, p.x, p.y, { sx: size, sy: size, rot: p.rot, alpha, tint: p.color, additive: c.additive });
      } else {
        const s = Math.max(1, Math.round(size));
        ctx.rect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s, p.color, alpha, c.additive);
      }
    }
  }

  clearParticles(): void {
    if (this.kernel && this.kernelId >= 0) this.kernel.clearEmitter(this.kernelId);
    for (const p of this.live) this.pool.push(p);
    this.live.length = 0;
  }
}
