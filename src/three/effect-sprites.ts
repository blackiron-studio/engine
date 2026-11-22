// Effects3D: pooled effect sprites for 3D scenes. Each sprite is a quad that faces the camera
// (billboard), stretches along its motion while facing the camera (streak: tracers, sparks, trails)
// or lies against a surface (flat: shock rings on the floor, scorch marks). Sprites move with
// gravity and drag, change colour, size and opacity over their life, can glow into bloom and can
// ride on a moving node. All of them share one atlas material and one quad, and carry their colour,
// opacity, glow and cell per instance, so the renderer draws every visible sprite in one batch.
// Scorch marks and other long-lived marks go into a separate ring (`decal`), so a burst of sparks
// never pushes them out.

import { Rng } from "../core/rng.ts";
import { smoothstep } from "../art/noise.ts";
import { EffectAtlas3D } from "./effect-atlas.ts";
import { Geometry3D } from "./geometry.ts";
import { Vec3 } from "./math.ts";
import { Node3D } from "./node.ts";
import { Mesh3D, Scene3D } from "./scene.ts";

export type EffectSpriteKind3D = "billboard" | "streak" | "flat";

type Vec3Like = Readonly<{ x: number; y: number; z: number }>;

export interface EffectSprite3D {
  /** Atlas cell. A name with variants (the standard `smoke`, `fire`, `star`) picks one at random. */
  texture: string;
  /** Which variant of the cell; random when left out. */
  variant?: number;
  /** `billboard` (the default) faces the camera; `streak` stretches along its motion; `flat` lies on `normal`. */
  kind?: EffectSpriteKind3D;
  /** World position at birth (the head of a streak); in `follow`'s space when following a node. */
  position: Vec3Like;
  /** Metres per second. */
  velocity?: Vec3Like;
  /** Seconds. Infinity lives until its handle frees it (a sprite the game drives itself). */
  lifetime: number;
  /** Width in metres at birth, and at death (defaults to the same). */
  size: number;
  endSize?: number;
  /** How the size moves from `size` to `endSize`: 1 is even, above 1 eases out (fast, then slow), below 1 eases in. */
  grow?: number;
  /** Height ÷ width for billboards and flat sprites. */
  aspect?: number;
  /** One to three 0xRRGGBB colours across the life; the middle one sits at `mid` (0.5). White by default. */
  colors?: readonly number[];
  mid?: number;
  /** Peak opacity, 0–1 (1). */
  opacity?: number;
  /** Fractions of the life: fade in over the first `fadeIn` (0), and fade out from `fadeOut` (0.5) to the end. */
  fadeIn?: number;
  fadeOut?: number;
  /** Adds the sprite's own colour as emission at this strength, so it feeds bloom (0). */
  glow?: number;
  /** Metres per second squared, downward; negative rises (smoke). */
  gravity?: number;
  /** Speed lost per second, as a rate: velocity × e^(−drag·dt). */
  drag?: number;
  /** Radians per second about the facing axis (billboards and flat sprites). */
  spin?: number;
  /** Starting turn about the facing axis; random when left out. */
  angle?: number;
  /** Streaks: seconds of travel drawn behind the head (0.03), capped at `maxLength` metres. */
  stretch?: number;
  maxLength?: number;
  /** Streaks: never longer than the distance travelled since birth (a tracer leaving the muzzle). */
  fromOrigin?: boolean;
  /** Streaks that do not move: their direction and length. */
  direction?: Vec3Like;
  length?: number;
  /** Flat sprites: the surface normal they lie against (up by default). */
  normal?: Vec3Like;
  /** Keep the sprite at `position` in this node's space (a glow riding a drone); it ends with the node. */
  follow?: Node3D;
}

/** Built-in sprites keep only what they need from a spec, so pooled sprites allocate nothing per frame. */
class SpriteMesh extends Mesh3D {
  /** Orthonormal basis, column after column (x, y, z axes). */
  readonly basis = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  protected override composeLocal(): void {
    const m = this.localMatrix,
      b = this.basis,
      s = this.scale,
      p = this.position;
    m[0] = b[0] * s.x;
    m[1] = b[1] * s.x;
    m[2] = b[2] * s.x;
    m[3] = 0;
    m[4] = b[3] * s.y;
    m[5] = b[4] * s.y;
    m[6] = b[5] * s.y;
    m[7] = 0;
    m[8] = b[6] * s.z;
    m[9] = b[7] * s.z;
    m[10] = b[8] * s.z;
    m[11] = 0;
    m[12] = p.x;
    m[13] = p.y;
    m[14] = p.z;
    m[15] = 1;
  }
}

const KIND = { billboard: 0, streak: 1, flat: 2 } as const;

class Sprite {
  live = false;
  gen = 0;
  t = 0;
  kind = 0;
  life = 1;
  size = 1;
  endSize = 1;
  grow = 1;
  aspect = 1;
  c0 = 0xffffff;
  c1 = 0xffffff;
  c2 = 0xffffff;
  colors = 1;
  mid = 0.5;
  opacity = 1;
  fadeIn = 0;
  fadeOut = 0.5;
  glow = 0;
  gravity = 0;
  drag = 0;
  spin = 0;
  angle = 0;
  stretch = 0.03;
  maxLength = Infinity;
  fromOrigin = false;
  length = -1;
  follow: Node3D | null = null;
  /** The game moved it this step: skip one step of integration. */
  held = false;
  /** Current width and streak length, set by the update and used to orient it. */
  width = 0;
  len = 0;
  readonly pos = new Vec3();
  readonly vel = new Vec3();
  readonly origin = new Vec3();
  readonly dir = new Vec3(0, 1, 0);
  readonly normal = new Vec3(0, 1, 0);
  readonly local = new Vec3();
  constructor(readonly mesh: SpriteMesh) {}
  kill(): void {
    this.live = false;
    this.follow = null;
    this.mesh.visible = false;
  }
}

/** A sprite the game drives or ends itself. It goes stale (`alive` false) once the sprite ends or the pool reuses it. */
export class EffectHandle3D {
  /** @internal */
  constructor(
    private readonly sprite: Sprite,
    private readonly gen: number,
  ) {}
  get alive(): boolean {
    return this.sprite.live && this.sprite.gen === this.gen;
  }
  /** Where it is now (world space). */
  get position(): Readonly<Vec3> {
    return this.sprite.pos;
  }
  /**
   * Put it at `position` this step, and optionally give it a new velocity (a streak also turns
   * along it). Its own motion skips this step, so a sprite moved every frame sits exactly there.
   */
  moveTo(position: Vec3Like, velocity?: Vec3Like): this {
    if (!this.alive) return this;
    const s = this.sprite;
    s.pos.set(position.x, position.y, position.z);
    if (velocity) s.vel.set(velocity.x, velocity.y, velocity.z);
    s.held = true;
    return this;
  }
  /** Change its peak opacity (flicker, pulse). */
  set opacity(value: number) {
    if (this.alive && Number.isFinite(value)) this.sprite.opacity = Math.max(0, Math.min(1, value));
  }
  get opacity(): number {
    return this.sprite.opacity;
  }
  /** End it now. */
  free(): void {
    if (this.alive) this.sprite.kill();
  }
}

export interface Effects3DOptions {
  /** Pooled sprites (256). When all are busy the next one that ends by itself is reused. */
  capacity?: number;
  /** Decal ring (64): the oldest mark gives way. */
  decals?: number;
  /** Atlas the sprites draw from; the standard one by default. */
  atlas?: EffectAtlas3D;
  /** Seed for the random variants and angles. */
  seed?: number | string;
  /** The eye sprites face; the scene's camera by default. */
  camera?: Node3D | null;
}

let quad: Geometry3D | null = null;
/** One unit quad facing +z, v = 0 at its top: shared by every effect sprite so they batch. */
function spriteQuad(): Geometry3D {
  return (quad ??= new Geometry3D(
    [-0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 1, 2, 0, 2, 3],
    [0, 0, 0, 1, 1, 1, 1, 0],
  ));
}

const mix = (a: number, b: number, t: number): number => {
  const ch = (s: number) => {
    const x = (a >> s) & 255,
      y = (b >> s) & 255;
    return Math.round(x + (y - x) * t) << s;
  };
  return ch(16) | ch(8) | ch(0);
};

/**
 * Pooled 3D effect sprites. Add it to the world (untransformed: positions are world space) and
 * spawn sprites; it moves and restyles them as the scene updates and turns them to the camera as
 * it draws.
 */
export class Effects3D extends Node3D {
  readonly atlas: EffectAtlas3D;
  readonly rng: Rng;
  camera: Node3D | null;
  private readonly sprites: Sprite[] = [];
  private readonly marks: Sprite[] = [];
  private cursor = 0;
  private markCursor = 0;
  private readonly eye = new Vec3();

  constructor(options: Effects3DOptions = {}) {
    super();
    const capacity = options.capacity ?? 256,
      decals = options.decals ?? 64;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16384 || !Number.isInteger(decals) || decals < 0 || decals > 4096)
      throw new RangeError("Effects3D capacity must be 1–16384 sprites and 0–4096 decals");
    this.atlas = options.atlas ?? EffectAtlas3D.standard();
    this.rng = new Rng(options.seed ?? "effects3D");
    this.camera = options.camera ?? null;
    const geometry = spriteQuad();
    const make = () => {
      const mesh = this.add(new SpriteMesh(geometry, this.atlas.material));
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.visible = false;
      return new Sprite(mesh);
    };
    for (let i = 0; i < capacity; i++) this.sprites.push(make());
    for (let i = 0; i < decals; i++) this.marks.push(make());
  }

  /** Sprites alive now (decals included). */
  get activeCount(): number {
    let n = 0;
    for (const s of this.sprites) if (s.live) n++;
    for (const s of this.marks) if (s.live) n++;
    return n;
  }

  /** Start a sprite. */
  spawn(spec: EffectSprite3D): EffectHandle3D {
    return this.start(spec, false);
  }

  /**
   * Leave a mark that stays (a scorch, a stain, a hot glow cooling on a wall): a flat sprite in the
   * decal ring, lifted a centimetre off the surface so it never fights with it.
   */
  decal(spec: EffectSprite3D & { normal: Vec3Like }): EffectHandle3D {
    if (!this.marks.length) throw new RangeError("This Effects3D has no decal ring");
    return this.start({ kind: "flat", ...spec }, true);
  }

  /** End every sprite and mark. */
  reset(): void {
    for (const s of this.sprites) s.kill();
    for (const s of this.marks) s.kill();
  }

  private start(spec: EffectSprite3D, mark: boolean): EffectHandle3D {
    const p = spec.position,
      kind = spec.kind ?? "billboard";
    if (
      ![p.x, p.y, p.z, spec.size, spec.endSize ?? 0, spec.gravity ?? 0, spec.drag ?? 0].every(Number.isFinite) ||
      !(spec.lifetime > 0) ||
      Number.isNaN(spec.lifetime) ||
      spec.size < 0 ||
      !(kind in KIND)
    )
      throw new RangeError("Effect sprites need a finite position and size and a positive lifetime");
    const colors = spec.colors ?? [0xffffff];
    if (colors.length < 1 || colors.length > 3) throw new RangeError("Effect sprites take one to three colours");
    const variants = this.atlas.variants(spec.texture);
    if (!variants) throw new RangeError(`Unknown effect cell "${spec.texture}"`);
    const pool = mark ? this.marks : this.sprites;
    let c = mark ? this.markCursor : this.cursor;
    let s: Sprite | undefined;
    for (let i = 0; i < pool.length && !s; i++) {
      const candidate = pool[(c + i) % pool.length];
      if (!candidate.live) {
        s = candidate;
        c = (c + i + 1) % pool.length;
      }
    }
    if (!s && !mark)
      // Full: take the next one that ends by itself, so sprites the game drives survive.
      for (let i = 0; i < pool.length && !s; i++) {
        const candidate = pool[(c + i) % pool.length];
        if (Number.isFinite(candidate.life)) {
          s = candidate;
          c = (c + i + 1) % pool.length;
        }
      }
    if (!s) {
      s = pool[c];
      c = (c + 1) % pool.length;
    }
    if (mark) this.markCursor = c;
    else this.cursor = c;

    s.live = true;
    s.gen++;
    s.t = 0;
    s.held = false;
    s.kind = KIND[kind];
    s.life = spec.lifetime;
    s.size = spec.size;
    s.endSize = spec.endSize ?? spec.size;
    s.grow = Math.max(1e-3, spec.grow ?? 1);
    s.aspect = spec.aspect ?? 1;
    s.colors = colors.length;
    s.c0 = colors[0];
    s.c1 = colors[1] ?? colors[0];
    s.c2 = colors[2] ?? s.c1;
    s.mid = Math.max(1e-3, Math.min(1 - 1e-3, spec.mid ?? 0.5));
    s.opacity = Math.max(0, Math.min(1, spec.opacity ?? 1));
    s.fadeIn = Math.max(0, spec.fadeIn ?? 0);
    s.fadeOut = Math.max(0, Math.min(1, spec.fadeOut ?? 0.5));
    s.glow = Math.max(0, spec.glow ?? 0);
    s.gravity = spec.gravity ?? 0;
    s.drag = Math.max(0, spec.drag ?? 0);
    s.spin = spec.spin ?? 0;
    s.angle = spec.angle ?? this.rng.range(0, Math.PI * 2);
    s.stretch = spec.stretch ?? 0.03;
    s.maxLength = spec.maxLength ?? Infinity;
    s.fromOrigin = spec.fromOrigin ?? false;
    s.length = spec.length ?? -1;
    s.follow = spec.follow ?? null;
    s.pos.set(p.x, p.y, p.z);
    s.local.set(p.x, p.y, p.z);
    if (s.follow) s.follow.localToWorld(s.local, s.pos);
    s.origin.copy(s.pos);
    const v = spec.velocity;
    s.vel.set(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
    const d = spec.direction;
    if (d) s.dir.set(d.x, d.y, d.z).normalize();
    else s.dir.set(0, 1, 0);
    const n = spec.normal;
    if (n) s.normal.set(n.x, n.y, n.z).normalize();
    else s.normal.set(0, 1, 0);
    if (s.normal.length < 0.5) s.normal.set(0, 1, 0);
    if (mark) s.pos.add(s.normal.clone().multiplyScalar(0.01));
    this.atlas.apply(s.mesh, spec.texture, spec.variant ?? this.rng.int(0, variants - 1));
    s.mesh.visible = true;
    this.style(s);
    return new EffectHandle3D(s, s.gen);
  }

  override update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (const pool of [this.sprites, this.marks])
      for (const s of pool) {
        if (!s.live) continue;
        s.t += dt;
        if (s.t >= s.life) {
          s.kill();
          continue;
        }
        if (s.follow) {
          if (!s.follow.parent) {
            s.kill();
            continue;
          }
          s.follow.localToWorld(s.local, s.pos);
        } else if (s.held) s.held = false;
        else {
          if (s.gravity) s.vel.y -= s.gravity * dt;
          if (s.drag) s.vel.multiplyScalar(Math.exp(-s.drag * dt));
          s.pos.x += s.vel.x * dt;
          s.pos.y += s.vel.y * dt;
          s.pos.z += s.vel.z * dt;
        }
        if (s.spin) s.angle += s.spin * dt;
        this.style(s);
      }
  }

  /** Colour, opacity, glow and size for the sprite's age. */
  private style(s: Sprite): void {
    const x = Number.isFinite(s.life) ? Math.min(1, s.t / s.life) : 0;
    const e = s.grow >= 1 ? 1 - (1 - x) ** s.grow : x ** (1 / s.grow);
    s.width = s.size + (s.endSize - s.size) * e;
    const color =
      s.colors === 1 ? s.c0 : s.colors === 2 ? mix(s.c0, s.c1, x) : x < s.mid ? mix(s.c0, s.c1, x / s.mid) : mix(s.c1, s.c2, (x - s.mid) / (1 - s.mid));
    let a = s.opacity * (s.fadeIn > 0 ? Math.min(1, x / s.fadeIn) : 1);
    if (x > s.fadeOut) a *= 1 - smoothstep(s.fadeOut, 1, x);
    const m = s.mesh;
    m.tint = color;
    m.opacity = a;
    m.glow = s.glow;
    if (s.kind === KIND.streak) {
      const speed = s.vel.length;
      let len = s.length >= 0 ? s.length : speed * s.stretch;
      if (s.fromOrigin) len = Math.min(len, s.pos.distanceTo(s.origin));
      s.len = Math.min(len, s.maxLength);
    }
  }

  /** Turn every live sprite to the eye as it is drawn. */
  override prepareRender3D(): void {
    const camera = this.camera ?? (this.scene instanceof Scene3D ? this.scene.camera3D : null);
    if (camera) camera.getWorldPosition(this.eye);
    const eye = this.eye;
    for (const pool of [this.sprites, this.marks])
      for (const s of pool) {
        if (!s.live) continue;
        const m = s.mesh,
          b = m.basis;
        if (s.kind === KIND.streak) {
          // y along the motion, z toward the eye as far as it can; the head sits at the position.
          let dx = s.dir.x,
            dy = s.dir.y,
            dz = s.dir.z;
          const speed = s.vel.length;
          if (speed > 1e-4) {
            dx = s.vel.x / speed;
            dy = s.vel.y / speed;
            dz = s.vel.z / speed;
          }
          let zx = eye.x - s.pos.x,
            zy = eye.y - s.pos.y,
            zz = eye.z - s.pos.z;
          const along = zx * dx + zy * dy + zz * dz;
          zx -= along * dx;
          zy -= along * dy;
          zz -= along * dz;
          let zl = Math.hypot(zx, zy, zz);
          if (zl < 1e-5) {
            zx = -dz;
            zy = 0;
            zz = dx;
            zl = Math.hypot(zx, zz) || 1;
            if (zl < 1e-5) (zx = 1), (zl = 1);
          }
          zx /= zl;
          zy /= zl;
          zz /= zl;
          b[3] = dx;
          b[4] = dy;
          b[5] = dz;
          b[6] = zx;
          b[7] = zy;
          b[8] = zz;
          b[0] = dy * zz - dz * zy;
          b[1] = dz * zx - dx * zz;
          b[2] = dx * zy - dy * zx;
          const len = Math.max(1e-3, s.len);
          m.scale.set(Math.max(1e-4, s.width), len, 1);
          m.position.set(s.pos.x - dx * len * 0.5, s.pos.y - dy * len * 0.5, s.pos.z - dz * len * 0.5);
        } else {
          if (s.kind === KIND.billboard) facing(eye.x - s.pos.x, eye.y - s.pos.y, eye.z - s.pos.z, s.angle, b);
          else facing(s.normal.x, s.normal.y, s.normal.z, s.angle, b);
          m.scale.set(Math.max(1e-4, s.width), Math.max(1e-4, s.width * s.aspect), 1);
          m.position.copy(s.pos);
        }
      }
  }
}

/** A basis whose z axis is (zx, zy, zz), turned `angle` about it. */
function facing(zx: number, zy: number, zz: number, angle: number, out: Float32Array): void {
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  // x = up × z, or +x based when z is nearly vertical.
  let xx: number, xy: number, xz: number;
  if (Math.abs(zy) < 0.95) {
    xx = zz;
    xy = 0;
    xz = -zx;
  } else {
    xx = 0;
    xy = -zz;
    xz = zy;
  }
  const xl = Math.hypot(xx, xy, xz);
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  out[0] = xx * c + yx * s;
  out[1] = xy * c + yy * s;
  out[2] = xz * c + yz * s;
  out[3] = -xx * s + yx * c;
  out[4] = -xy * s + yy * c;
  out[5] = -xz * s + yz * c;
  out[6] = zx;
  out[7] = zy;
  out[8] = zz;
}
