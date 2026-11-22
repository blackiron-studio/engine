// Debris3D: pieces of a model flung into the world. Take any node (a drone's arm, a crate lid, a
// spent casing) out of its model where it is, give it a velocity and a spin, and it tumbles, falls,
// bounces off the level (through a ray cast, or a flat floor), scrapes to rest, smoulders and
// finally sinks out of sight. Emitters let a piece trail smoke or fire through any effect system.

import { Vec3, eulerFromBasis } from "./math.ts";
import { Node3D } from "./node.ts";

type Vec3Like = Readonly<{ x: number; y: number; z: number }>;

export interface DebrisHit3D {
  point: Readonly<Vec3>;
  normal: Readonly<Vec3>;
}
/** The nearest hit along a ray within `length` (direction normalised), or null. `CombatWorld3D.cast` fits. */
export type DebrisCaster3D = (origin: Readonly<Vec3>, direction: Readonly<Vec3>, length: number) => DebrisHit3D | null;

export interface DebrisEmitter3D {
  /** Seconds between calls. */
  every: number;
  /** Stop after this age in seconds (forever by default, until the piece starts to sink). */
  until?: number;
  /** The interval grows with age: every × (1 + age × slowdown), so smoke thins out (0). */
  slowdown?: number;
  /** Called at the piece's world position. */
  spawn(at: Readonly<Vec3>, age: number): void;
}

export interface DebrisPiece3D {
  /** Metres per second. */
  velocity: Vec3Like;
  /** Radians per second about the world x, y and z axes. */
  spin?: Vec3Like;
  /** Collision radius in metres (0.1). */
  radius?: number;
  /** Speed kept off a surface, along its normal (0.35). */
  bounce?: number;
  /** Sliding speed kept on each bounce (0.62); spin keeps a bit less. */
  friction?: number;
  /** Metres per second squared (9.8). */
  gravity?: number;
  /** Seconds before it is removed (6). */
  lifetime?: number;
  /** Seconds it spends sinking out of sight at the end (1.4); 0 removes it where it lies. */
  sink?: number;
  /** Smoke, fire or sparks along the way. */
  emit?: readonly DebrisEmitter3D[];
  /** Called every step with the piece, its age and the step (spin a rotor down, fade a glow). */
  onStep?(node: Node3D, age: number, dt: number): void;
  /** Called when it hits something, with the impact speed into the surface. */
  onBounce?(point: Readonly<Vec3>, normal: Readonly<Vec3>, speed: number): void;
}

interface Piece {
  node: Node3D;
  vel: Vec3;
  spin: Vec3;
  basis: number[];
  radius: number;
  bounce: number;
  friction: number;
  gravity: number;
  life: number;
  sink: number;
  emit: readonly DebrisEmitter3D[];
  timers: number[];
  onStep?: DebrisPiece3D["onStep"];
  onBounce?: DebrisPiece3D["onBounce"];
  t: number;
  rest: boolean;
}

export class Debris3D extends Node3D {
  /** Ray cast against the level; without one, pieces land on `floor`. */
  cast: DebrisCaster3D | null = null;
  /** Height of a flat floor used when there is no `cast`; null lets pieces fall forever (until removed). */
  floor: number | null = 0;
  private readonly pieces: Piece[] = [];
  private readonly step = new Vec3();
  private readonly dir = new Vec3();
  private readonly tmp = new Vec3();
  private readonly hitPoint = new Vec3();
  private readonly hitNormal = new Vec3();

  /** Add it untransformed (pieces live in world space). At `capacity` the oldest piece is removed. */
  constructor(readonly capacity = 96) {
    super();
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096) throw new RangeError("Debris3D capacity must be an integer from 1 to 4096");
  }

  get count(): number {
    return this.pieces.length;
  }

  /**
   * Take `node` (and its subtree) out of its parent into this node, keeping where it is, how it is
   * turned and its scale, and let it fly.
   */
  launch(node: Node3D, spec: DebrisPiece3D): Node3D {
    const v = spec.velocity,
      w = spec.spin ?? { x: 0, y: 0, z: 0 };
    const radius = spec.radius ?? 0.1,
      lifetime = spec.lifetime ?? 6,
      sink = spec.sink ?? 1.4;
    if (
      ![v.x, v.y, v.z, w.x, w.y, w.z, radius, lifetime, sink, spec.bounce ?? 0, spec.friction ?? 0, spec.gravity ?? 0].every(Number.isFinite) ||
      radius <= 0 ||
      lifetime <= 0 ||
      sink < 0
    )
      throw new RangeError("Debris needs a finite velocity and spin, a positive radius and lifetime and a nonnegative sink");
    if (node === this) throw new RangeError("Debris3D cannot launch itself");
    const m = node.updateWorldMatrix();
    const sx = Math.hypot(m[0], m[1], m[2]) || 1,
      sy = Math.hypot(m[4], m[5], m[6]) || 1,
      sz = Math.hypot(m[8], m[9], m[10]) || 1;
    const basis = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
    const x = m[12],
      y = m[13],
      z = m[14];
    this.add(node);
    node.position.set(x, y, z);
    node.scale.set(sx, sy, sz);
    eulerFromBasis(basis, node.rotation);
    while (this.pieces.length >= this.capacity) this.pieces.shift()!.node.destroy();
    const emit = spec.emit ?? [];
    for (const e of emit)
      if (!(e.every > 0) || !Number.isFinite(e.every) || typeof e.spawn !== "function") throw new RangeError("Debris emitters need a positive interval and a spawn function");
    this.pieces.push({
      node,
      vel: new Vec3(v.x, v.y, v.z),
      spin: new Vec3(w.x, w.y, w.z),
      basis,
      radius,
      bounce: spec.bounce ?? 0.35,
      friction: spec.friction ?? 0.62,
      gravity: spec.gravity ?? 9.8,
      life: lifetime,
      sink: Math.min(sink, lifetime),
      emit,
      // Stagger the first puff a little so pieces thrown together do not puff in step.
      timers: emit.map((e, i) => e.every * (0.25 + 0.15 * ((this.pieces.length + i) % 5))),
      onStep: spec.onStep,
      onBounce: spec.onBounce,
      t: 0,
      rest: false,
    });
    return node;
  }

  /** Remove every piece. */
  reset(): void {
    for (const p of this.pieces) p.node.destroy();
    this.pieces.length = 0;
  }

  private probe(origin: Readonly<Vec3>, length: number): DebrisHit3D | null {
    if (this.cast) return this.cast(origin.clone(), this.dir.clone(), length);
    if (this.floor === null || this.dir.y >= 0) return null;
    const t = (origin.y - this.floor) / -this.dir.y;
    if (t < 0 || t > length) return null;
    this.hitPoint.copy(this.dir).multiplyScalar(t).add(origin);
    this.hitNormal.set(0, 1, 0);
    return { point: this.hitPoint, normal: this.hitNormal };
  }

  override update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i],
        n = p.node;
      p.t += dt;
      if (p.t >= p.life || !n.parent) {
        if (n.parent) n.destroy();
        this.pieces.splice(i, 1);
        continue;
      }
      if (!p.rest) {
        p.vel.y -= p.gravity * dt;
        this.step.copy(p.vel).multiplyScalar(dt);
        const len = this.step.length;
        const hit = len > 1e-6 ? (this.dir.copy(this.step).multiplyScalar(1 / len), this.probe(n.position, len + p.radius)) : null;
        if (hit && hit.normal.length > 0.5) {
          const nn = this.tmp.copy(hit.normal).normalize();
          n.position.copy(nn).multiplyScalar(p.radius).add(hit.point);
          const into = p.vel.dot(nn);
          if (into < 0) {
            // Bounce off along the normal, and scrape: lose sliding speed and spin.
            const nx = nn.x,
              ny = nn.y,
              nz = nn.z;
            const out = -into * p.bounce;
            const tx = p.vel.x - into * nx,
              ty = p.vel.y - into * ny,
              tz = p.vel.z - into * nz;
            p.vel.set(tx * p.friction + nx * out, ty * p.friction + ny * out, tz * p.friction + nz * out);
            p.spin.multiplyScalar(p.friction * 0.9);
            p.onBounce?.(hit.point, hit.normal, -into);
          }
          if (ny(hit.normal) > 0.6 && p.vel.length < 0.8) {
            p.rest = true;
            p.vel.set(0, 0, 0);
            p.spin.set(0, 0, 0);
          }
        } else n.position.add(this.step);
        const w = p.spin.length;
        if (w > 1e-4) {
          rotateBasis(p.basis, p.spin.x / w, p.spin.y / w, p.spin.z / w, w * dt);
          eulerFromBasis(p.basis, n.rotation);
        }
      }
      const sinkFrom = p.life - p.sink;
      for (let k = 0; k < p.emit.length; k++) {
        const e = p.emit[k];
        if (p.t > (e.until ?? Infinity) || p.t > sinkFrom) continue;
        p.timers[k] -= dt;
        if (p.timers[k] <= 0) {
          p.timers[k] += e.every * (1 + p.t * (e.slowdown ?? 0));
          if (p.timers[k] <= 0) p.timers[k] = e.every;
          e.spawn(n.position, p.t);
        }
      }
      p.onStep?.(n, p.t, dt);
      if (p.sink > 0 && p.t > sinkFrom) n.position.y -= dt * (0.12 + p.radius * 0.5);
    }
  }
}

const ny = (v: Readonly<Vec3>) => v.y / (Math.hypot(v.x, v.y, v.z) || 1);

/** Turn a basis (three axes, column after column) by `angle` about the unit axis (ax, ay, az), then re-square it. */
function rotateBasis(b: number[], ax: number, ay: number, az: number, angle: number): void {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    k = 1 - c;
  for (let col = 0; col < 9; col += 3) {
    const x = b[col],
      y = b[col + 1],
      z = b[col + 2];
    const d = ax * x + ay * y + az * z;
    // Rodrigues: v cos + (a × v) sin + a (a · v)(1 − cos).
    b[col] = x * c + (ay * z - az * y) * s + ax * d * k;
    b[col + 1] = y * c + (az * x - ax * z) * s + ay * d * k;
    b[col + 2] = z * c + (ax * y - ay * x) * s + az * d * k;
  }
  // Gram–Schmidt keeps it orthonormal over thousands of steps.
  let l = Math.hypot(b[0], b[1], b[2]) || 1;
  b[0] /= l;
  b[1] /= l;
  b[2] /= l;
  const d = b[0] * b[3] + b[1] * b[4] + b[2] * b[5];
  b[3] -= d * b[0];
  b[4] -= d * b[1];
  b[5] -= d * b[2];
  l = Math.hypot(b[3], b[4], b[5]) || 1;
  b[3] /= l;
  b[4] /= l;
  b[5] /= l;
  b[6] = b[1] * b[5] - b[2] * b[4];
  b[7] = b[2] * b[3] - b[0] * b[5];
  b[8] = b[0] * b[4] - b[1] * b[3];
}
