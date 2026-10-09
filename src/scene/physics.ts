// Physics nodes: bodies that live in their Scene's PhysicsWorld and keep their Node2D transform
// in step with it. Dynamic bodies are driven by the simulation; kinematic and static ones
// are driven by the node. Colliders come from `shape` or `shapes` in the options.

import type { BodyKind } from "../physics/protocol.ts";
import type { BodyOptions, CharacterMoveOptions, ColliderOptions, CollisionEvent, PhysicsWorld, Shape } from "../physics/world.ts";
import { matCompose, matIdentity, matInvert, matMul, type Mat } from "../render/types.ts";
import { Node2D } from "./node.ts";

export interface PhysicsNodeOptions extends Omit<BodyOptions, "x" | "y" | "rotation"> {
  /** One collider centred on the body. */
  shape?: Shape;
  /** Several colliders with their own offsets. */
  shapes?: ColliderOptions[];
  /** Defaults applied to every collider made from `shape`. */
  collider?: Omit<ColliderOptions, "shape">;
  /** A sensor body reports overlaps and never pushes anything. */
  sensor?: boolean;
}

/** A node backed by a body in the physics world. */
export class PhysicsBody2D extends Node2D {
  body = -1;
  readonly colliders: number[] = [];
  /** The world this body lives in once attached. */
  physicsWorld: PhysicsWorld | null = null;
  readonly kind: BodyKind;
  /** Called when a collider of this body starts or stops touching another body's collider. */
  onCollide: ((other: PhysicsBody2D | null, event: CollisionEvent) => void) | null = null;
  onSeparate: ((other: PhysicsBody2D | null, event: CollisionEvent) => void) | null = null;
  private pushedX = NaN;
  private pushedY = NaN;
  private pushedRot = NaN;
  private readonly parentMatrix = matIdentity();
  private readonly parentLocal = matIdentity();

  constructor(
    readonly options: PhysicsNodeOptions = {},
    x = 0,
    y = 0,
    kind: BodyKind = "dynamic",
  ) {
    super(x, y);
    this.kind = options.kind ?? kind;
  }

  override ready(): void {
    const world = this.scene?.physics ?? null;
    if (!world) {
      console.warn(`[kiln] ${this.name || "PhysicsBody2D"} needs physics; set "physics" in kiln.json or call app.enablePhysics()`);
      return;
    }
    this.attach(world);
  }

  /** Create the body and colliders in `world` at the node's current position. */
  attach(world: PhysicsWorld): void {
    if (this.body >= 0) return;
    this.physicsWorld = world;
    const o = this.options;
    const [wx, wy] = this.worldPosition();
    const rotation = this.worldRotation();
    this.body = world.createBody({ ...o, kind: this.kind, x: wx, y: wy, rotation });
    const shapes: ColliderOptions[] = o.shapes ? [...o.shapes] : o.shape ? [{ shape: o.shape, ...(o.collider ?? {}) }] : [];
    for (const c of shapes) {
      const id = world.createCollider(this.body, { ...c, sensor: c.sensor ?? o.sensor ?? false });
      this.colliders.push(id);
      world.owners.set(id, this);
    }
    world.nodes.set(this.body, this);
    this.pushedX = wx;
    this.pushedY = wy;
    this.pushedRot = rotation;
  }

  override exit(): void {
    this.detach();
  }

  detach(): void {
    if (this.physicsWorld && this.body >= 0) {
      for (const c of this.colliders) this.physicsWorld.owners.delete(c);
      this.physicsWorld.nodes.delete(this.body);
      this.physicsWorld.destroyBody(this.body);
    }
    this.colliders.length = 0;
    this.body = -1;
    this.physicsWorld = null;
  }

  /** Position in the world layer's space, which is what the physics world uses. */
  protected worldPosition(): [number, number] {
    const m = this.parentTransform();
    return [m[0] * this.x + m[2] * this.y + m[4], m[1] * this.x + m[3] * this.y + m[5]];
  }

  /** Parent-to-world transform, independent of the last render and camera. Collider dimensions remain world units. */
  private parentTransform(): Mat {
    const out = this.parentMatrix;
    out[0] = out[3] = 1;
    out[1] = out[2] = out[4] = out[5] = 0;
    const layer = this.scene?.world;
    for (let p = this.parent; p && p !== layer; p = p.parent) {
      if (!(p instanceof Node2D)) continue;
      matCompose(this.parentLocal, p.x, p.y, p.scaleX, p.scaleY, p.rotation);
      matMul(out, this.parentLocal, out);
    }
    if (Math.abs(out[0] * out[3] - out[1] * out[2]) < 1e-10) {
      throw new Error("PhysicsBody2D cannot have a parent with a zero scale");
    }
    return out;
  }

  private worldRotation(): number {
    const m = this.parentTransform();
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return Math.atan2(m[1] * c + m[3] * s, m[0] * c + m[2] * s);
  }

  protected setWorldPosition(x: number, y: number, rotation?: number): void {
    const inv = matInvert(this.parentTransform());
    this.x = inv[0] * x + inv[2] * y + inv[4];
    this.y = inv[1] * x + inv[3] * y + inv[5];
    if (rotation !== undefined) {
      const c = Math.cos(rotation), s = Math.sin(rotation);
      this.rotation = Math.atan2(inv[1] * c + inv[3] * s, inv[0] * c + inv[2] * s);
    }
  }

  /** Before a step: static and kinematic bodies follow the node when it moved. */
  beforeStep(): void {
    if (!this.physicsWorld || this.body < 0 || this.kind === "dynamic") return;
    const [wx, wy] = this.worldPosition();
    const rotation = this.worldRotation();
    if (wx === this.pushedX && wy === this.pushedY && rotation === this.pushedRot) return;
    if (this.kind === "kinematic") this.physicsWorld.kinematicTarget(this.body, wx, wy, rotation);
    else this.physicsWorld.setPosition(this.body, wx, wy, rotation);
    this.pushedX = wx;
    this.pushedY = wy;
    this.pushedRot = rotation;
  }

  /** After a step: dynamic bodies move the node. */
  afterStep(): void {
    if (!this.physicsWorld || this.body < 0 || this.kind !== "dynamic") return;
    const st = this.physicsWorld.state(this.body);
    if (!st) return;
    this.setWorldPosition(st.x, st.y, st.rotation);
    this.pushedX = st.x;
    this.pushedY = st.y;
    this.pushedRot = st.rotation;
  }

  /** The simulation's current velocity for this body, pixels per second. */
  currentVelocity(): { x: number; y: number } {
    const st = this.physicsWorld?.state(this.body);
    return st ? { x: st.vx, y: st.vy } : { x: 0, y: 0 };
  }

  setVelocity(vx: number, vy: number, angular = 0): void {
    this.physicsWorld?.setVelocity(this.body, vx, vy, angular);
  }

  impulse(ix: number, iy: number, torque = 0): void {
    this.physicsWorld?.impulse(this.body, ix, iy, torque);
  }

  force(fx: number, fy: number): void {
    this.physicsWorld?.force(this.body, fx, fy);
  }

  /** Move the body somewhere else, clearing any physics momentum. */
  teleport(x: number, y: number, rotation = this.rotation): void {
    this.x = x;
    this.y = y;
    this.rotation = rotation;
    if (this.physicsWorld && this.body >= 0) {
      const [wx, wy] = this.worldPosition();
      const worldRotation = this.worldRotation();
      this.physicsWorld.setPosition(this.body, wx, wy, worldRotation);
      this.physicsWorld.setVelocity(this.body, 0, 0, 0);
      this.pushedX = wx;
      this.pushedY = wy;
      this.pushedRot = worldRotation;
    }
  }
}

export class RigidBody2D extends PhysicsBody2D {
  constructor(options: PhysicsNodeOptions = {}, x = 0, y = 0) {
    super(options, x, y, "dynamic");
  }
}

export class StaticBody2D extends PhysicsBody2D {
  constructor(options: PhysicsNodeOptions = {}, x = 0, y = 0) {
    super(options, x, y, "static");
  }
}

export class KinematicBody2D extends PhysicsBody2D {
  constructor(options: PhysicsNodeOptions = {}, x = 0, y = 0) {
    super(options, x, y, "kinematic");
  }
}

/** A sensor: reports bodies entering and leaving without touching them. */
export class Area2D extends PhysicsBody2D {
  onEnter: ((other: PhysicsBody2D | null) => void) | null = null;
  onExit: ((other: PhysicsBody2D | null) => void) | null = null;
  private readonly inside = new Set<PhysicsBody2D | null>();

  constructor(options: PhysicsNodeOptions = {}, x = 0, y = 0) {
    super({ ...options, sensor: true }, x, y, options.kind ?? "static");
    this.onCollide = (other) => {
      this.inside.add(other);
      this.onEnter?.(other);
    };
    this.onSeparate = (other) => {
      this.inside.delete(other);
      this.onExit?.(other);
    };
  }

  /** Bodies currently overlapping. */
  get overlapping(): PhysicsBody2D[] {
    return [...this.inside].filter((b): b is PhysicsBody2D => b !== null);
  }
}

export interface CharacterOptions extends PhysicsNodeOptions, CharacterMoveOptions {}

/**
 * A kinematic body moved by `velocity` with `moveAndSlide`, sliding along walls and
 * floors, with `grounded` reported after each move. Gravity is the game's to apply.
 */
export class CharacterBody2D extends PhysicsBody2D {
  velocity = { x: 0, y: 0 };
  grounded = false;
  slidingDownSlope = false;
  readonly move: CharacterMoveOptions;

  constructor(options: CharacterOptions = {}, x = 0, y = 0) {
    super({ ...options, kind: "kinematic" }, x, y, "kinematic");
    this.move = { snap: options.snap, maxSlope: options.maxSlope, autostep: options.autostep };
  }

  /** Apply `velocity` for `dt` seconds, sliding along whatever the body touches. */
  moveAndSlide(dt: number): void {
    if (!this.physicsWorld || this.body < 0 || this.colliders.length === 0) {
      this.x += this.velocity.x * dt;
      this.y += this.velocity.y * dt;
      return;
    }
    this.beforeStep();
    const r = this.physicsWorld.characterMove(this.body, this.colliders[0], this.velocity.x * dt, this.velocity.y * dt, dt, this.move);
    this.grounded = r.grounded;
    this.slidingDownSlope = r.slidingDownSlope;
    if (this.grounded && this.velocity.y > 0) this.velocity.y = 0;
    this.setWorldPosition(r.x, r.y);
    this.beforeStep();
  }
}

/** Route the world's collision events to the nodes that own the colliders. */
export function dispatchCollisions(world: PhysicsWorld, events: CollisionEvent[]): void {
  for (const ev of events) {
    const a = world.owners.get(ev.a) as PhysicsBody2D | undefined;
    const b = world.owners.get(ev.b) as PhysicsBody2D | undefined;
    if (ev.kind === "start") {
      a?.onCollide?.(b ?? null, ev);
      b?.onCollide?.(a ?? null, ev);
    } else {
      a?.onSeparate?.(b ?? null, ev);
      b?.onSeparate?.(a ?? null, ev);
    }
  }
}
