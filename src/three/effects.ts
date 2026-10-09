import { Rng } from "../core/rng.ts";
import { Geometry3D } from "./geometry.ts";
import { Material3D } from "./material.ts";
import { Vec3 } from "./math.ts";
import { Node3D } from "./node.ts";
import { Mesh3D } from "./scene.ts";

export interface ParticleBurst3D {
  /** Position in the pool's local coordinates. */
  x: number;
  y: number;
  z: number;
  color?: number;
  count?: number;
  speed?: number;
  lifetime?: number;
  size?: number;
}
interface Particle {
  mesh: Mesh3D;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  duration: number;
  size: number;
}
/** Bounded, retained mesh particles. One shared geometry/material; simulation never uses global RNG. */
export class Particles3D extends Node3D {
  private readonly particles: Particle[] = [];
  private readonly rng: Rng;
  private readonly geometry = Geometry3D.box();
  private readonly material = new Material3D({ unlit: true, toneMapped: false });
  gravity = 12;
  /** Local floor height for bouncing debris; null disables floor collision. */
  floor: number | null = 0.035;
  constructor(readonly capacity = 128, seed: number | string = "particles3D") {
    super();
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16384)
      throw new RangeError("Particles3D capacity must be an integer from 1 to 16384");
    this.rng = new Rng(seed);
    for (let i = 0; i < capacity; i++) {
      const mesh = this.add(new Mesh3D(this.geometry, this.material));
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.particles.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0, duration: 1, size: 0 });
    }
  }
  get activeCount(): number {
    let count = 0;
    for (const p of this.particles) if (p.life > 0) count++;
    return count;
  }
  /** Returns how many particles fitted; a full pool drops excess without allocating. */
  burst(options: ParticleBurst3D): number {
    const { x, y, z, color = 0xffffff, count = 12, speed = 3, lifetime = 0.6, size = 0.1 } = options;
    if (![x, y, z, speed, lifetime, size].every(Number.isFinite) || speed < 0 || lifetime <= 0 || size <= 0 || !Number.isInteger(count) || count < 0)
      throw new RangeError("Particle burst requires finite position, nonnegative count/speed and positive lifetime/size");
    let emitted = 0;
    for (const p of this.particles) {
      if (emitted >= count) break;
      if (p.life > 0) continue;
      const a = this.rng.range(0, Math.PI * 2), velocity = this.rng.range(0.2, 1) * speed;
      p.vx = Math.sin(a) * velocity;
      p.vz = Math.cos(a) * velocity;
      p.vy = this.rng.range(0.4, 1.25) * speed;
      p.duration = p.life = this.rng.range(0.65, 1) * lifetime;
      p.size = size * this.rng.range(0.55, 1.2);
      p.mesh.position.set(x, y, z);
      p.mesh.rotation.set(a, a * 0.7, a * 0.3);
      p.mesh.scale.set(p.size, p.size, p.size);
      p.mesh.tint = color;
      p.mesh.visible = true;
      emitted++;
    }
    return emitted;
  }
  reset(): void {
    for (const p of this.particles) { p.life = 0; p.mesh.visible = false; }
  }
  /** Release the pool's owned geometry when its scene no longer uses it. */
  dispose(): void { this.reset(); this.geometry.dispose(); this.destroy(); }
  override update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Bound catch-up work without silently discarding elapsed lifetime.
    const steps = Math.min(64, Math.ceil(dt * 60));
    const step = dt / steps;
    for (let i = 0; i < steps && this.activeCount; i++) {
      for (const p of this.particles) {
        if (p.life <= 0) continue;
        p.life = Math.max(0, p.life - step);
        p.mesh.visible = p.life > 0;
        if (!p.life) continue;
        p.mesh.x += p.vx * step;
        p.mesh.z += p.vz * step;
        p.mesh.y += p.vy * step - 0.5 * this.gravity * step * step;
        p.vy -= this.gravity * step;
        if (this.floor !== null && p.mesh.y < this.floor) {
          p.mesh.y = this.floor;
          p.vy = Math.abs(p.vy) * 0.3;
          p.vx *= 0.78;
          p.vz *= 0.78;
        }
        p.mesh.rotation.x += step * 3;
        p.mesh.rotation.z += step * 2;
        const scale = p.size * Math.min(1, p.life / p.duration * 4);
        p.mesh.scale.set(scale, scale, scale);
      }
    }
  }
}

/** Camera translation sampled during simulation, with a private phase and no gameplay RNG. */
export class CameraShake3D {
  readonly offset = new Vec3();
  private elapsed = 0;
  private remaining = 0;
  private duration = 1;
  private strength = 0;
  private readonly phase: number;
  constructor(seed: number | string = "cameraShake3D") {
    this.phase = new Rng(seed).range(0, Math.PI * 2);
  }
  kick(strength: number, duration = 0.25): void {
    if (!Number.isFinite(strength) || strength < 0 || !Number.isFinite(duration) || duration <= 0)
      throw new RangeError("Camera shake strength must be nonnegative and duration positive");
    this.strength = Math.max(this.strength * this.remaining / this.duration, strength);
    this.duration = this.remaining = Math.max(this.remaining, duration);
  }
  update(dt: number): Readonly<Vec3> {
    if (!Number.isFinite(dt) || dt <= 0) return this.offset;
    this.elapsed += dt;
    this.remaining = Math.max(0, this.remaining - dt);
    const amplitude = this.strength * (this.remaining / this.duration) ** 2;
    const phase = this.phase + this.elapsed * 73;
    return this.offset.set(Math.sin(phase) * amplitude, Math.sin(phase * 1.37) * amplitude * 0.4, Math.cos(phase * 1.13) * amplitude);
  }
  reset(): void {
    this.remaining = this.strength = 0;
    this.offset.set(0, 0, 0);
  }
}
