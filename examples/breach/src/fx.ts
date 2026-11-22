// Signal Breach's combat effects: muzzle flashes, tracers, impacts, drone charge-ups and bolts,
// explosions and flying wreckage. They are recipes on the engine's effect tools: pooled sprites
// that batch into one draw (Effects3D, with scorch marks in its decal ring), a few flash lights
// (LightPool3D) and debris that bounces off the level (Debris3D). Randomness comes from one seeded
// generator, so a run replays the same way.

import { Rng } from "@blackiron-studio/engine/core";
import {
  Debris3D,
  type DebrisCaster3D,
  type DebrisEmitter3D,
  type EffectHandle3D,
  Effects3D,
  Geometry3D,
  LightPool3D,
  Mesh3D,
  Node3D,
  Vec3,
  eulerFromBasis,
} from "@blackiron-studio/engine/three";

type V3 = [number, number, number];

const random = new Rng("signal-breach-fx");
/** Restart the effects' random sequence (each run of the mission starts from the same one). */
export function seedRandom(seed: number | string): void {
  random.state = new Rng(seed).state;
}
export const rand = (a: number, b: number): number => random.range(a, b);
/** A random unit vector. */
export function randDir(out = new Vec3()): Vec3 {
  const z = rand(-1, 1),
    a = rand(0, Math.PI * 2),
    r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}
export const mixColor = (a: number, b: number, t: number): number => {
  const ch = (s: number) => {
    const x = (a >> s) & 255,
      y = (b >> s) & 255;
    return Math.round(x + (y - x) * t) << s;
  };
  return ch(16) | ch(8) | ch(0);
};

/** How fast the tracers fly, in m/s; impacts wait for their tracer to land. */
export const TRACER_SPEED = { pulse: 240, pellet: 190 } as const;
/**
 * Sparks, embers and tracer cores are thin and hot. The soft streak and dot cells show only their
 * middle brightly, so these sprites are drawn a little wider than their nominal size.
 */
const SPARK = 1.4;
const DOT = 1.8;

/** A unit quad facing +z for first-person flash parts, and a flame tongue standing on y = 0. */
const QUAD = new Geometry3D([-0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3], [0, 0, 0, 1, 1, 1, 1, 0]);
const FLAME = new Geometry3D([-0.5, 1, 0, -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3], [0, 1, 0, 0, 1, 0, 1, 1]);

/** A piece of a wreck or a spent casing thrown into the level. */
export interface PieceSpec {
  vel: Vec3;
  /** Angular velocity, radians per second about each world axis. */
  spin: Vec3;
  radius: number;
  bounce?: number;
  life: number;
  /** Seconds between smoke puffs while it flies and smoulders (0 for none). */
  smoke?: number;
  /** Seconds it burns for. */
  fire?: number;
  /** Rotors that keep spinning down. */
  spinners?: Node3D[];
  spinRate?: number;
  gravity?: number;
}

export class Fx {
  readonly root: Node3D;
  readonly sprites: Effects3D;
  readonly lights: LightPool3D;
  readonly debris: Debris3D;
  private readonly timers: { t: number; fn: () => void }[] = [];

  /** The effects hang under `parent` (the world, untransformed); they update with the scene. */
  constructor(parent: Node3D) {
    this.root = parent.add(new Node3D());
    this.sprites = this.root.add(new Effects3D({ capacity: 360, decals: 72, seed: "signal-breach" }));
    this.lights = this.root.add(new LightPool3D(3));
    this.debris = this.root.add(new Debris3D(90));
  }

  /** The level ray cast the debris bounces off. */
  set cast(cast: DebrisCaster3D | null) {
    this.debris.cast = cast;
  }

  /** Run `fn` after `delay` seconds of game time. */
  after(delay: number, fn: () => void): void {
    if (delay <= 0) fn();
    else this.timers.push({ t: delay, fn });
  }
  /** Run due timers. Sprites, lights and debris update themselves with the scene. */
  update(dt: number): void {
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.t -= dt;
      if (t.t <= 0) {
        this.timers.splice(i, 1);
        t.fn();
      }
    }
  }

  /** A brief point light (three at most; the one closest to finished gives way). */
  light(at: Readonly<Vec3>, color: number, intensity: number, range: number, life: number): void {
    this.lights.flash(at, { color, intensity, range, lifetime: life });
  }

  /**
   * Take `node` out of its model into the world, keeping where it is and how it is turned, and let
   * it fly: it tumbles, bounces off the level, smokes or burns, then sinks away.
   */
  throwPiece(node: Node3D, spec: PieceSpec): void {
    const emit: DebrisEmitter3D[] = [];
    const r = spec.radius;
    if (spec.smoke)
      emit.push({
        every: spec.smoke,
        slowdown: 0.8,
        spawn: (at) =>
          this.sprites.spawn({
            texture: "smoke",
            position: new Vec3(at.x + rand(-0.08, 0.08), at.y + 0.05, at.z + rand(-0.08, 0.08)),
            velocity: new Vec3(rand(-0.2, 0.2), rand(0.6, 1.1), rand(-0.2, 0.2)),
            lifetime: rand(1.2, 2.0),
            size: r * 0.7,
            endSize: r * 3,
            opacity: 0.65,
            fadeIn: 0.12,
            fadeOut: 0.35,
            colors: [0x5a5456, 0x8a888e, 0xa4a4ac],
            drag: 0.8,
            spin: rand(-0.8, 0.8),
          }),
      });
    const fire = spec.fire ?? 0;
    if (fire > 0)
      emit.push({
        every: 0.06,
        until: fire,
        spawn: (at, age) => {
          const k = 1 - age / fire;
          this.sprites.spawn({
            texture: "fire",
            position: new Vec3(at.x + rand(-0.06, 0.06), at.y, at.z + rand(-0.06, 0.06)),
            velocity: new Vec3(rand(-0.3, 0.3), rand(0.8, 1.6), rand(-0.3, 0.3)),
            lifetime: rand(0.22, 0.38),
            size: r * (0.65 + 0.7 * k),
            endSize: r * 0.15,
            colors: [0xfff0c0, 0xff8a30, 0x6a1c08],
            mid: 0.35,
            glow: 1.1,
            opacity: 0.95,
            fadeOut: 0.4,
            spin: rand(-3, 3),
          });
        },
      });
    const spinners = spec.spinners ?? [];
    let spinRate = spec.spinRate ?? 0;
    this.debris.launch(node, {
      velocity: spec.vel,
      spin: spec.spin,
      radius: r,
      bounce: spec.bounce,
      gravity: spec.gravity,
      lifetime: spec.life,
      emit,
      onStep: spinners.length
        ? (_node, _age, dt) => {
            for (const s of spinners) s.rotation.y += spinRate * dt;
            spinRate *= Math.exp(-dt * 1.2);
          }
        : undefined,
    });
  }

  // -------------------------------------------------------------- the player's guns

  /** A first-person muzzle flash on `parent` (the gun) at `at`, in the gun's space. */
  muzzle(parent: Node3D, at: V3, style: "pulse" | "scatter"): MuzzleFlash {
    return new MuzzleFlash(this, parent, at, style);
  }
  /** @internal A flash part on the first-person layer, drawn with the shared effects material. */
  viewSprite(parent: Node3D, flame: boolean, cell: string, variant = 0): Mesh3D {
    const mesh = parent.add(new Mesh3D(flame ? FLAME : QUAD, this.sprites.atlas.material));
    this.sprites.atlas.apply(mesh, cell, variant);
    mesh.renderLayer = "viewmodel";
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
  }

  /** Smoke curling off the muzzle (world space), carried along with the player. */
  muzzleSmoke(at: Readonly<Vec3>, forward: Readonly<Vec3>, scatter: boolean, carry: Readonly<Vec3>): void {
    const n = scatter ? 5 : 1;
    for (let i = 0; i < n; i++) {
      const push = scatter ? rand(1.2, 3.4) : rand(0.3, 0.7);
      this.sprites.spawn({
        texture: "smoke",
        position: new Vec3().copy(at).add(new Vec3().copy(forward).multiplyScalar(scatter ? 0.12 : 0.04)),
        velocity: new Vec3().copy(forward).multiplyScalar(push).add(new Vec3(rand(-0.25, 0.25), rand(0.25, 0.55), rand(-0.25, 0.25))).add(new Vec3().copy(carry).multiplyScalar(0.8)),
        lifetime: scatter ? rand(0.9, 1.5) : rand(0.5, 0.8),
        size: scatter ? 0.16 : 0.05,
        endSize: scatter ? rand(0.8, 1.2) : 0.3,
        opacity: scatter ? 0.62 : 0.32,
        fadeIn: 0.08,
        fadeOut: 0.3,
        colors: scatter ? [0xb4a490, 0x9a9aa2] : [0xb8d0d4, 0x9aa0a8],
        drag: scatter ? 2.6 : 1.2,
        gravity: -0.35,
        spin: rand(-1.2, 1.2),
      });
    }
    if (scatter)
      for (let i = 0; i < 7; i++)
        this.sprites.spawn({
          texture: "streak",
          kind: "streak",
          position: at,
          velocity: new Vec3().copy(forward).multiplyScalar(rand(5, 11)).add(randDir().multiplyScalar(2.2)),
          lifetime: rand(0.12, 0.26),
          size: 0.018 * SPARK,
          stretch: 0.025,
          maxLength: 0.3,
          colors: [0xffffff, 0xffb050, 0xff5a1a],
          glow: 1.4,
          gravity: 6,
          fadeOut: 0.5,
        });
  }

  /** A tracer from the muzzle to `to`; returns how long it takes to land. */
  tracer(from: Readonly<Vec3>, to: Readonly<Vec3>, style: "pulse" | "pellet"): number {
    const d = new Vec3().copy(to).sub(from),
      dist = d.length;
    if (dist < 1e-3) return 0;
    d.multiplyScalar(1 / dist);
    const speed = TRACER_SPEED[style],
      time = dist / speed;
    const vel = d.clone().multiplyScalar(speed);
    if (style === "pulse") {
      // A white-hot slug in a cyan sheath, and a faint ionised line left behind it.
      this.sprites.spawn({ texture: "streak", kind: "streak", position: from, velocity: vel, lifetime: time, size: 0.05 * SPARK, stretch: 0.02, maxLength: 4.5, fromOrigin: true, colors: [0xeafffb], glow: 1.6 });
      this.sprites.spawn({ texture: "streak", kind: "streak", position: from, velocity: vel, lifetime: time, size: 0.2, stretch: 0.025, maxLength: 6, fromOrigin: true, colors: [0x48e6d0], glow: 1.1, opacity: 0.55 });
      this.sprites.spawn({ texture: "streak", kind: "streak", position: to, direction: d, length: dist, lifetime: 0.16 + time, size: 0.016, colors: [0x7ff5e4, 0x3fa8a0], glow: 1, opacity: 0.35, fadeOut: 0 });
    } else {
      this.sprites.spawn({ texture: "streak", kind: "streak", position: from, velocity: vel, lifetime: time, size: 0.028 * SPARK, stretch: 0.012, maxLength: 2.2, fromOrigin: true, colors: [0xfff2c8], glow: 1.5 });
      this.sprites.spawn({ texture: "streak", kind: "streak", position: from, velocity: vel, lifetime: time, size: 0.09, stretch: 0.012, maxLength: 2.2, fromOrigin: true, colors: [0xff9a3a], glow: 1, opacity: 0.45 });
    }
    return time;
  }

  /** A shot landing on the level: flash, sparks off the surface, dust and a scorch mark. */
  impact(p: Readonly<Vec3>, n: Readonly<Vec3>, dir: Readonly<Vec3>, style: "pulse" | "pellet" | "bolt"): void {
    const hot = style === "pulse" ? 0x9ffff0 : style === "pellet" ? 0xffc070 : 0xff5040;
    const tip = style === "pulse" ? 0x2ad0c0 : style === "pellet" ? 0xff5a1a : 0xc01808;
    const out = new Vec3().copy(p).add(new Vec3().copy(n).multiplyScalar(0.03));
    const big = style === "bolt" ? 1.5 : style === "pellet" ? 0.6 : 1;
    this.sprites.spawn({ texture: "glow", position: out, lifetime: 0.11, size: 0.25 * big, endSize: 1.0 * big, colors: [0xffffff, hot], glow: 1.6, fadeOut: 0.2 });
    this.sprites.spawn({ texture: "star", position: out, lifetime: 0.06, size: 0.6 * big * SPARK, endSize: 0.8 * big, colors: [hot], glow: 1.5, fadeOut: 0.1 });
    if (style === "bolt")
      this.sprites.spawn({ texture: "ring", kind: "flat", normal: n, position: new Vec3().copy(p).add(new Vec3().copy(n).multiplyScalar(0.012)), lifetime: 0.22, size: 0.06, endSize: 0.55 * big, grow: 2.5, colors: [hot, tip], glow: 1.1, opacity: 0.8, fadeOut: 0.2 });
    // Sparks leave around the mirror of the shot.
    const refl = new Vec3().copy(dir).sub(new Vec3().copy(n).multiplyScalar(2 * dir.x * n.x + 2 * dir.y * n.y + 2 * dir.z * n.z));
    const count = style === "pulse" ? 10 : style === "pellet" ? 4 : 12;
    for (let i = 0; i < count; i++) {
      const v = new Vec3().copy(refl).multiplyScalar(0.6).add(new Vec3().copy(n).multiplyScalar(0.6)).add(randDir().multiplyScalar(0.7)).normalize();
      if (v.dot(n) < 0.05) v.add(new Vec3().copy(n).multiplyScalar(0.5)).normalize();
      this.sprites.spawn({
        texture: "streak",
        kind: "streak",
        position: out,
        velocity: v.multiplyScalar(rand(2.5, 8)),
        lifetime: rand(0.15, 0.42),
        size: rand(0.02, 0.032) * SPARK,
        stretch: 0.04,
        maxLength: 0.5,
        colors: [0xffffff, hot, tip],
        mid: 0.3,
        glow: 1.4,
        gravity: 9.8,
        drag: 0.6,
        fadeOut: 0.55,
      });
    }
    // Dust and smoke kicked off the surface.
    const puffs = style === "bolt" ? 2 : style === "pellet" ? (random.next() < 0.4 ? 1 : 0) : 1;
    for (let i = 0; i < puffs; i++)
      this.sprites.spawn({
        texture: "smoke",
        position: new Vec3().copy(p).add(new Vec3().copy(n).multiplyScalar(0.08)),
        velocity: new Vec3().copy(n).multiplyScalar(rand(0.4, 0.9)).add(new Vec3(rand(-0.15, 0.15), rand(0.1, 0.35), rand(-0.15, 0.15))),
        lifetime: rand(0.7, 1.2),
        size: 0.1 * big,
        endSize: rand(0.45, 0.7) * big,
        opacity: 0.58,
        fadeIn: 0.06,
        fadeOut: 0.3,
        colors: [0xa89c90, 0x8c8c94],
        drag: 1.8,
        spin: rand(-1, 1),
      });
    this.scorch(p, n, style === "bolt" ? rand(0.32, 0.42) : style === "pellet" ? rand(0.07, 0.1) : rand(0.14, 0.2), style === "pulse" ? 0x5ff3d8 : 0xff7a30);
  }

  /** A burn mark on a surface that cools from `ember` to soot. */
  scorch(p: Readonly<Vec3>, n: Readonly<Vec3>, size: number, ember = 0xff7a30, life = 18): void {
    this.sprites.decal({
      texture: "scorch",
      normal: n,
      position: p,
      lifetime: life,
      size,
      colors: [ember, 0x14100e, 0x14100e],
      mid: 0.04,
      glow: 0.9,
      opacity: 0.88,
      fadeOut: 0.8,
    });
  }

  /** A shot striking a drone's armour: a hot flash and sparks off the plating. */
  hitDrone(p: Readonly<Vec3>, n: Readonly<Vec3>, dir: Readonly<Vec3>, pellet: boolean): void {
    const out = new Vec3().copy(p).add(new Vec3().copy(n).multiplyScalar(0.04));
    this.sprites.spawn({ texture: "glow", position: out, lifetime: 0.07, size: 0.2, endSize: pellet ? 0.5 : 0.75, colors: [0xffffff, 0xffb060], glow: 1.6, fadeOut: 0.2 });
    this.sprites.spawn({ texture: "star", position: out, lifetime: 0.05, size: pellet ? 0.35 : 0.55, colors: [0xffd8a0], glow: 1.5, fadeOut: 0.1 });
    const refl = new Vec3().copy(dir).sub(new Vec3().copy(n).multiplyScalar(2 * (dir.x * n.x + dir.y * n.y + dir.z * n.z)));
    for (let i = 0; i < (pellet ? 4 : 9); i++)
      this.sprites.spawn({
        texture: "streak",
        kind: "streak",
        position: out,
        velocity: new Vec3().copy(refl).add(randDir().multiplyScalar(0.8)).normalize().multiplyScalar(rand(3, 10)),
        lifetime: rand(0.18, 0.5),
        size: rand(0.016, 0.026) * SPARK,
        stretch: 0.03,
        maxLength: 0.45,
        colors: [0xffffff, 0xffc060, 0xff4a10],
        mid: 0.3,
        glow: 1.5,
        gravity: 9.8,
        drag: 0.5,
        fadeOut: 0.55,
      });
    if (!pellet || random.next() < 0.4)
      this.sprites.spawn({
        texture: "smoke",
        position: out,
        velocity: new Vec3().copy(n).multiplyScalar(0.6).add(new Vec3(0, 0.4, 0)),
        lifetime: 0.8,
        size: 0.12,
        endSize: 0.5,
        opacity: 0.4,
        fadeIn: 0.08,
        colors: [0x6a6460, 0x8a8a92],
        drag: 1.5,
      });
  }

  // -------------------------------------------------------------- drones

  /** A drone's shot leaving its twin barrels. */
  droneFlash(at: Readonly<Vec3>, dir: Readonly<Vec3>): void {
    this.sprites.spawn({ texture: "glow", position: at, lifetime: 0.1, size: 0.5, endSize: 1.4, colors: [0xffffff, 0xff4a36], glow: 1.6, fadeOut: 0.2 });
    this.sprites.spawn({ texture: "star", position: at, lifetime: 0.08, size: 1.0, endSize: 1.3, colors: [0xff8070], glow: 1.5, fadeOut: 0.1 });
    for (let i = 0; i < 4; i++)
      this.sprites.spawn({
        texture: "streak",
        kind: "streak",
        position: at,
        velocity: new Vec3().copy(dir).add(randDir().multiplyScalar(0.45)).normalize().multiplyScalar(rand(4, 9)),
        lifetime: rand(0.1, 0.22),
        size: 0.02 * SPARK,
        stretch: 0.03,
        maxLength: 0.35,
        colors: [0xffffff, 0xff5040],
        glow: 1.4,
        fadeOut: 0.4,
      });
    this.sprites.spawn({
      texture: "smoke",
      position: at,
      velocity: new Vec3().copy(dir).multiplyScalar(0.8).add(new Vec3(0, 0.35, 0)),
      lifetime: 0.7,
      size: 0.1,
      endSize: 0.45,
      opacity: 0.3,
      fadeIn: 0.1,
      colors: [0x9a8a8a, 0x8a8a92],
      drag: 2,
    });
  }

  /** The glow gathering in a drone's eye before it fires (rides on `node` at `at`). */
  charge(node: Node3D, at: Readonly<Vec3>, life: number): void {
    this.sprites.spawn({ texture: "glow", follow: node, position: at, lifetime: life, size: 0.3, endSize: 1.6, grow: 0.5, colors: [0xff2a1a, 0xff6a50, 0xffd0c0], mid: 0.7, glow: 1.4, opacity: 0.95, fadeIn: 0.15, fadeOut: 0.92 });
    this.sprites.spawn({ texture: "star", follow: node, position: at, lifetime: life, size: 0.15, endSize: 1.3, grow: 0.4, colors: [0xff5a40, 0xffe0d0], glow: 1.4, opacity: 0.8, fadeIn: 0.5, fadeOut: 0.95, spin: 6 });
  }
  /** Motes drawn in toward a charging eye. */
  converge(center: Readonly<Vec3>, time: number): void {
    for (let i = 0; i < 2; i++) {
      const off = randDir().multiplyScalar(rand(0.5, 0.8));
      this.sprites.spawn({
        texture: "streak",
        kind: "streak",
        position: new Vec3().copy(center).add(off),
        velocity: off.clone().multiplyScalar(-1 / time),
        lifetime: time,
        size: 0.02 * SPARK,
        stretch: 0.08,
        maxLength: 0.25,
        colors: [0xff4a36, 0xffc0b0],
        glow: 1.4,
        opacity: 0.9,
        fadeIn: 0.3,
        fadeOut: 0.85,
      });
    }
  }

  /** A drone bolt: hot core, red halo and a trail; the game moves it and ends it. */
  bolt(at: Readonly<Vec3>, vel: Readonly<Vec3>, heavy: boolean): BoltFx {
    const k = heavy ? 1.25 : 1;
    return new BoltFx(
      this,
      this.sprites.spawn({ texture: "glow", position: at, velocity: vel, lifetime: Infinity, size: 0.34 * k, colors: [0xffe6e0], glow: 1.7 }),
      this.sprites.spawn({ texture: "glow", position: at, velocity: vel, lifetime: Infinity, size: 1.25 * k, colors: [0xff3020], glow: 1.2, opacity: 0.75 }),
      this.sprites.spawn({ texture: "streak", kind: "streak", position: at, velocity: vel, lifetime: Infinity, size: 0.14 * k, stretch: 0.12, maxLength: 1.8, fromOrigin: true, colors: [0xff4a36], glow: 1.2, opacity: 0.85 }),
    );
  }
  /** @internal */
  spark(at: Readonly<Vec3>, color: number): void {
    this.sprites.spawn({ texture: "dot", position: at, velocity: randDir().multiplyScalar(0.5), lifetime: rand(0.2, 0.35), size: 0.09 * DOT, endSize: 0.01, colors: [color], glow: 1.3, opacity: 0.9, drag: 2 });
  }

  /** Smoke (and, when badly hurt, sparks and flame) pouring off a damaged drone. */
  damage(at: Readonly<Vec3>, severe: boolean): void {
    this.sprites.spawn({
      texture: "smoke",
      position: at,
      velocity: new Vec3(rand(-0.15, 0.15), rand(0.7, 1.2), rand(-0.15, 0.15)),
      lifetime: rand(1.0, 1.6),
      size: 0.24,
      endSize: severe ? 1.4 : 0.95,
      opacity: severe ? 0.85 : 0.6,
      fadeIn: 0.1,
      fadeOut: 0.35,
      colors: [0x5a5456, 0x8a888e, 0xa4a4ac],
      drag: 0.6,
      spin: rand(-1, 1),
    });
    if (severe && random.next() < 0.45)
      this.sprites.spawn({ texture: "fire", position: at, velocity: new Vec3(0, rand(0.6, 1.2), 0), lifetime: rand(0.18, 0.3), size: 0.3, endSize: 0.08, colors: [0xfff0c0, 0xff8030, 0x601808], glow: 1.1, fadeOut: 0.4, spin: rand(-3, 3) });
    if (severe && random.next() < 0.25)
      for (let i = 0; i < 3; i++)
        this.sprites.spawn({ texture: "streak", kind: "streak", position: at, velocity: randDir().multiplyScalar(rand(2, 5)), lifetime: rand(0.15, 0.35), size: 0.016 * SPARK, stretch: 0.03, maxLength: 0.3, colors: [0xffffff, 0xffa040], glow: 1.4, gravity: 9.8 });
  }

  /** A drone blowing apart at `p`: flash, fireball, shock ring, sparks, embers and smoke. */
  explode(p: Readonly<Vec3>, scale: number): void {
    const s = scale;
    this.light(p, 0xff9248, 70 * s, 15 * s, 0.75);
    this.sprites.spawn({ texture: "glow", position: p, lifetime: 0.16, size: 1 * s, endSize: 4.2 * s, grow: 3, colors: [0xffffff, 0xffe0a0], glow: 1.6, fadeOut: 0.25 });
    this.sprites.spawn({ texture: "star", position: p, lifetime: 0.1, size: 3.2 * s, endSize: 4.4 * s, colors: [0xfff0c8], glow: 1.6, fadeOut: 0.2 });
    this.sprites.spawn({ texture: "ring", position: p, lifetime: 0.26, size: 0.6 * s, endSize: 6 * s, grow: 2.5, colors: [0xffe2b0, 0xff8a40], glow: 0.9, opacity: 0.45, fadeOut: 0.1 });
    // A hot core that holds while the billows roll out round it.
    this.sprites.spawn({ texture: "glow", position: p, lifetime: 0.4, size: 1.6 * s, endSize: 2.6 * s, colors: [0xfff6d0, 0xffb040, 0xff5a10], glow: 1.5, opacity: 0.9, fadeOut: 0.3 });
    // Fireball: hot billows that roll outward, cool to embers and hand over to the smoke.
    for (let i = 0; i < 8; i++) {
      const d = randDir();
      this.sprites.spawn({
        texture: "fire",
        position: new Vec3().copy(p).add(d.clone().multiplyScalar(rand(0.05, 0.35) * s)),
        velocity: d.multiplyScalar(rand(1.2, 3.4) * s).add(new Vec3(0, 0.9, 0)),
        lifetime: rand(0.45, 0.85),
        size: rand(0.55, 0.9) * s,
        endSize: rand(1.6, 2.5) * s,
        grow: 2.2,
        colors: [0xfff4cc, 0xff7a26, 0x3a160c],
        mid: 0.32,
        glow: 1.1,
        opacity: 1,
        fadeOut: 0.45,
        drag: 3.2,
        spin: rand(-2, 2),
      });
    }
    for (let i = 0; i < 8; i++) {
      const d = randDir();
      this.sprites.spawn({
        texture: "smoke",
        position: new Vec3().copy(p).add(d.clone().multiplyScalar(rand(0.1, 0.5) * s)),
        velocity: d.multiplyScalar(rand(0.6, 1.6) * s).add(new Vec3(0, rand(0.5, 1.2), 0)),
        lifetime: rand(2, 3.4),
        size: rand(0.7, 1.0) * s,
        endSize: rand(2.8, 3.8) * s,
        opacity: 0.85,
        fadeIn: 0.12,
        fadeOut: 0.35,
        colors: [0x3a2a20, 0x4a474c, 0x76767f],
        mid: 0.3,
        drag: 1.3,
        gravity: -0.5,
        spin: rand(-0.7, 0.7),
      });
    }
    // Sparks flung out on burning arcs.
    for (let i = 0; i < 34; i++) {
      const d = randDir();
      d.y = Math.abs(d.y) * 0.8 + 0.2;
      this.sprites.spawn({
        texture: "streak",
        kind: "streak",
        position: p,
        velocity: d.normalize().multiplyScalar(rand(5, 15) * s),
        lifetime: rand(0.4, 1.1),
        size: rand(0.025, 0.045) * SPARK,
        stretch: 0.04,
        maxLength: 0.9,
        colors: [0xffffff, 0xffc060, 0xff4a10],
        mid: 0.25,
        glow: 1.5,
        gravity: 9.8,
        drag: 0.7,
        fadeOut: 0.6,
      });
    }
    // Embers drifting down after it.
    for (let i = 0; i < 16; i++)
      this.sprites.spawn({
        texture: "dot",
        position: new Vec3().copy(p).add(randDir().multiplyScalar(0.4 * s)),
        velocity: randDir().multiplyScalar(rand(1.5, 4.5)).add(new Vec3(0, 1.5, 0)),
        lifetime: rand(1.2, 2.4),
        size: rand(0.06, 0.1) * DOT,
        endSize: 0.015,
        colors: [0xffe0a0, 0xff7a20, 0x801808],
        glow: 1.3,
        gravity: 2.5,
        drag: 1.4,
        fadeOut: 0.6,
      });
  }
}

/** A drone bolt's core, halo and trail; the game moves it every step and ends it. */
export class BoltFx {
  private ember = 0;
  constructor(
    private readonly fx: Fx,
    private readonly core: EffectHandle3D,
    private readonly halo: EffectHandle3D,
    private readonly trail: EffectHandle3D,
  ) {}
  move(at: Readonly<Vec3>, vel: Readonly<Vec3>, dt: number, time: number): void {
    for (const h of [this.core, this.halo, this.trail]) h.moveTo(at, vel);
    this.halo.opacity = 0.6 + 0.25 * Math.sin(time * 40);
    this.ember -= dt;
    if (this.ember <= 0) {
      this.ember = 0.025;
      this.fx.spark(at, 0xff5a40);
    }
  }
  end(): void {
    for (const h of [this.core, this.halo, this.trail]) h.free();
  }
}

/** The first-person flash on one gun: core, star and flame prongs along the barrel. */
export class MuzzleFlash {
  private readonly parts: { mesh: Mesh3D; size: number; len: number; prong: boolean; phi: number; color: number; glow: number }[] = [];
  private t = 1;
  private readonly life: number;
  constructor(fx: Fx, parent: Node3D, at: V3, style: "pulse" | "scatter") {
    const scatter = style === "scatter";
    this.life = scatter ? 0.075 : 0.05;
    const add = (cell: string, variant: number, prong: boolean, size: number, len: number, color: number, glow: number, phi = 0) => {
      const mesh = fx.viewSprite(parent, prong, cell, variant);
      mesh.position.set(at[0], at[1], at[2] + (prong ? 0 : -0.01));
      this.parts.push({ mesh, size, len, prong, phi, color, glow });
    };
    const prongs = scatter ? 4 : 3;
    add("glow", 0, false, scatter ? 1.1 : 0.62, 0, scatter ? 0xff8a30 : 0x3fd8c4, 0.9);
    for (let i = 0; i < prongs; i++) add("flame", 0, true, scatter ? 0.26 : 0.11, scatter ? 0.72 : 0.36, scatter ? 0xffa040 : 0x6ff4e0, 1.3, (i / prongs) * Math.PI);
    add("star", scatter ? 0 : 1, false, scatter ? 0.85 : 0.5, 0, scatter ? 0xffb45a : 0x8ff7e8, 1.4);
    if (scatter) add("star", 1, false, 0.55, 0, 0xffe0a0, 1.5);
    add("glow", 0, false, scatter ? 0.5 : 0.3, 0, scatter ? 0xfff4d6 : 0xeafffb, 1.8);
  }
  fire(): void {
    this.t = 0;
    for (const p of this.parts) {
      const m = p.mesh;
      m.visible = true;
      m.tint = p.color;
      m.glow = p.glow;
      if (p.prong) {
        // The flame runs down the barrel (y along −z), its face turned `phi` (with a little jitter) about it.
        const phi = p.phi + rand(-0.3, 0.3);
        eulerFromBasis([Math.sin(phi), -Math.cos(phi), 0, 0, 0, -1, Math.cos(phi), Math.sin(phi), 0], m.rotation);
        m.setScale(p.size * rand(0.8, 1.2), p.len * rand(0.65, 1.25), 1);
      } else {
        m.rotation.set(0, 0, rand(0, Math.PI * 2));
        const k = rand(0.85, 1.2);
        m.setScale(p.size * k, p.size * k, 1);
      }
    }
    this.update(0);
  }
  update(dt: number): void {
    if (this.t >= this.life) return;
    this.t += dt;
    const x = Math.min(1, this.t / this.life);
    if (x >= 1) {
      for (const p of this.parts) p.mesh.visible = false;
      return;
    }
    const a = 1 - x * x;
    for (const p of this.parts) p.mesh.opacity = a * (p.glow < 1 ? 0.55 : 1);
  }
  get lit(): number {
    return this.t < this.life ? 1 - this.t / this.life : 0;
  }
}
