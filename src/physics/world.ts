// PhysicsWorld: the game-facing API over a physics backend. Bodies, colliders and joints
// are ids; the world keeps the last step's transforms so nodes can read them, and hands
// out collision events to whoever registered for a collider.

import { type BodyKind, BODY_KIND, EVENT_STRIDE, PHYSICS_OP as OP, type PhysicsBackend, TRANSFORM_STRIDE } from "./protocol.ts";

export interface BodyOptions {
  kind?: BodyKind;
  x?: number;
  y?: number;
  rotation?: number;
  /** Keep the body upright. */
  lockRotation?: boolean;
  /** Continuous collision detection for fast, small bodies. */
  ccd?: boolean;
  /** Never let the body fall asleep. */
  noSleep?: boolean;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
}

export type Shape =
  | { rect: [number, number] }
  | { circle: number }
  | { capsule: [number, number] }
  | { polygon: [number, number][] };

export interface ColliderOptions {
  shape: Shape;
  /** Offset from the body's origin, in pixels. */
  x?: number;
  y?: number;
  rotation?: number;
  density?: number;
  friction?: number;
  restitution?: number;
  /** A sensor reports overlaps but has no physical response. */
  sensor?: boolean;
  /** Collision layer bits this collider belongs to (default all). */
  layers?: number;
  /** Collision layer bits this collider collides with (default all). */
  mask?: number;
  /** A platform a character passes through from below and when moving up; it only stops a landing. */
  oneWay?: boolean;
}

export interface JointOptions {
  kind: "fixed" | "revolute" | "prismatic" | "spring" | "rope";
  a: number;
  b: number;
  /** Anchors in each body's local space, pixels. */
  anchorA?: [number, number];
  anchorB?: [number, number];
  /** Prismatic axis. */
  axis?: [number, number];
  /** Revolute limits in radians, prismatic limits in pixels. */
  limits?: [number, number];
  /** Spring rest length in pixels, stiffness and damping; rope maximum length. */
  length?: number;
  stiffness?: number;
  damping?: number;
}

export interface BodyState {
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  angularVelocity: number;
  sleeping: boolean;
}

export interface RayHit {
  collider: number;
  body: number;
  x: number;
  y: number;
  nx: number;
  ny: number;
  distance: number;
}

/** Where a swept shape first touches something: the shape's centre at impact and the surface normal. */
export type ShapeHit = RayHit;

export interface CollisionEvent {
  kind: "start" | "end";
  a: number;
  b: number;
  sensor: boolean;
}

export interface CharacterMoveOptions {
  /** Distance to snap down onto the ground while walking, pixels. */
  snap?: number;
  /** Steepest walkable slope in degrees. */
  maxSlope?: number;
  /** Step height that is climbed automatically, pixels. */
  autostep?: number;
}

export interface CharacterMove {
  x: number;
  y: number;
  grounded: boolean;
  slidingDownSlope: boolean;
  dx: number;
  dy: number;
}

const ALL = 0xffffffff;

export class PhysicsWorld {
  /** Scene nodes by body id, kept in step by the App around each physics step. */
  readonly nodes = new Map<number, { beforeStep(): void; afterStep(): void }>();
  /** Called after every step with the new transforms in place (sprite pools bind here). */
  readonly stepListeners = new Set<() => void>();
  /** Who owns each collider, for routing collision events. */
  readonly owners = new Map<number, unknown>();
  private readonly states = new Map<number, BodyState>();
  private readonly listeners = new Set<(e: CollisionEvent) => void>();
  private lastEvents: CollisionEvent[] = [];
  private destroyed = false;

  constructor(
    readonly backend: PhysicsBackend,
    gravity: [number, number] = [0, 980],
  ) {
    this.setGravity(gravity[0], gravity[1]);
  }

  private args(...values: number[]): number {
    const s = this.backend.scratch;
    for (let i = 0; i < values.length; i++) s[i] = values[i];
    return values.length;
  }

  setGravity(x: number, y: number): void {
    this.backend.call(OP.SET_GRAVITY, this.args(x, y));
  }

  createBody(o: BodyOptions = {}): number {
    const flags = (o.lockRotation ? 1 : 0) | (o.ccd ? 2 : 0) | (o.noSleep ? 4 : 0);
    return this.backend.call(OP.BODY_CREATE, this.args(BODY_KIND[o.kind ?? "dynamic"], o.x ?? 0, o.y ?? 0, o.rotation ?? 0, flags, o.linearDamping ?? 0, o.angularDamping ?? 0, o.gravityScale ?? 1));
  }

  destroyBody(id: number): void {
    this.backend.call(OP.BODY_DESTROY, this.args(id));
    this.states.delete(id);
  }

  setPosition(id: number, x: number, y: number, rotation = 0): void {
    this.backend.call(OP.BODY_SET_POSITION, this.args(id, x, y, rotation));
  }

  setVelocity(id: number, vx: number, vy: number, angular = 0): void {
    this.backend.call(OP.BODY_SET_VELOCITY, this.args(id, vx, vy, angular));
  }

  /** A kick in pixels per second, independent of mass. */
  impulse(id: number, ix: number, iy: number, torque = 0): void {
    this.backend.call(OP.BODY_APPLY_IMPULSE, this.args(id, ix, iy, torque));
  }

  /** A force for this step, in pixels per second squared. */
  force(id: number, fx: number, fy: number): void {
    this.backend.call(OP.BODY_APPLY_FORCE, this.args(id, fx, fy));
  }

  /** Where a kinematic body should be after the next step. */
  kinematicTarget(id: number, x: number, y: number, rotation = 0): void {
    this.backend.call(OP.BODY_KINEMATIC_TARGET, this.args(id, x, y, rotation));
  }

  getBody(id: number): BodyState | null {
    if (!this.backend.call(OP.BODY_GET, this.args(id))) return null;
    const s = this.backend.scratch;
    return { x: s[0], y: s[1], rotation: s[2], vx: s[3], vy: s[4], angularVelocity: s[5], sleeping: s[6] !== 0 };
  }

  wake(id: number): void {
    this.backend.call(OP.BODY_SET, this.args(id, 0, 0));
  }

  sleep(id: number): void {
    this.backend.call(OP.BODY_SET, this.args(id, 1, 0));
  }

  setGravityScale(id: number, scale: number): void {
    this.backend.call(OP.BODY_SET, this.args(id, 2, scale));
  }

  setDamping(id: number, linear: number, angular = linear): void {
    this.backend.call(OP.BODY_SET, this.args(id, 3, linear));
    this.backend.call(OP.BODY_SET, this.args(id, 4, angular));
  }

  setLockRotation(id: number, locked: boolean): void {
    this.backend.call(OP.BODY_SET, this.args(id, 5, locked ? 1 : 0));
  }

  setKind(id: number, kind: BodyKind): void {
    this.backend.call(OP.BODY_SET, this.args(id, 6, BODY_KIND[kind]));
  }

  /** A shape as the kernel words: type, two sizes, and polygon points when there are any. */
  private encodeShape(sh: Shape): { shape: number; a: number; b: number; extra: number[] } {
    let shape = 0;
    let a = 0;
    let b = 0;
    const extra: number[] = [];
    if ("rect" in sh) {
      a = sh.rect[0];
      b = sh.rect[1];
    } else if ("circle" in sh) {
      shape = 1;
      a = sh.circle;
    } else if ("capsule" in sh) {
      shape = 2;
      a = sh.capsule[0];
      b = sh.capsule[1];
    } else {
      shape = 3;
      b = sh.polygon.length;
      for (const [px, py] of sh.polygon) extra.push(px, py);
    }
    return { shape, a, b, extra };
  }

  createCollider(body: number, o: ColliderOptions): number {
    const { shape, a, b, extra } = this.encodeShape(o.shape);
    const head = [body, shape, a, b, o.x ?? 0, o.y ?? 0, o.rotation ?? 0, o.density ?? 1, o.friction ?? 0.5, o.restitution ?? 0, o.sensor ? 1 : 0, o.layers ?? ALL, o.mask ?? ALL, 0];
    const id = this.backend.call(OP.COLLIDER_CREATE, this.args(...head, ...extra));
    if (o.oneWay) this.setOneWay(id, true);
    return id;
  }

  /** Make a collider a one-way platform: characters pass through from below and when moving up. */
  setOneWay(id: number, oneWay: boolean): void {
    this.backend.call(OP.COLLIDER_SET, this.args(id, 5, oneWay ? 1 : 0));
  }

  destroyCollider(id: number): void {
    this.backend.call(OP.COLLIDER_DESTROY, this.args(id));
  }

  setSensor(id: number, sensor: boolean): void {
    this.backend.call(OP.COLLIDER_SET, this.args(id, 0, sensor ? 1 : 0));
  }

  setLayers(id: number, layers: number, mask: number): void {
    this.backend.call(OP.COLLIDER_SET, this.args(id, 1, layers, mask));
  }

  setFriction(id: number, friction: number): void {
    this.backend.call(OP.COLLIDER_SET, this.args(id, 2, friction));
  }

  setRestitution(id: number, restitution: number): void {
    this.backend.call(OP.COLLIDER_SET, this.args(id, 3, restitution));
  }

  createJoint(o: JointOptions): number {
    const kind = { fixed: 0, revolute: 1, prismatic: 2, spring: 3, rope: 4 }[o.kind];
    const [ax, ay] = o.anchorA ?? [0, 0];
    const [bx, by] = o.anchorB ?? [0, 0];
    let p = [0, 0, 0, 0];
    if (o.kind === "prismatic") p = [o.axis?.[0] ?? 1, o.axis?.[1] ?? 0, o.limits?.[0] ?? 0, o.limits?.[1] ?? 0];
    else if (o.kind === "revolute") p = [0, 0, o.limits?.[0] ?? 0, o.limits?.[1] ?? 0];
    else if (o.kind === "spring") p = [o.length ?? 0, o.stiffness ?? 100, o.damping ?? 1, 0];
    else if (o.kind === "rope") p = [o.length ?? 0, 0, 0, 0];
    return this.backend.call(OP.JOINT_CREATE, this.args(kind, o.a, o.b, ax, ay, bx, by, ...p));
  }

  destroyJoint(id: number): void {
    this.backend.call(OP.JOINT_DESTROY, this.args(id));
  }

  /** Advance the simulation, refresh body states and deliver collision events. */
  step(dt: number): CollisionEvent[] {
    this.backend.call(OP.STEP, this.args(dt));
    const t = this.backend.transforms();
    for (let i = 0; i + TRANSFORM_STRIDE <= t.length; i += TRANSFORM_STRIDE) {
      const id = t[i];
      const st = this.states.get(id) ?? { x: 0, y: 0, rotation: 0, vx: 0, vy: 0, angularVelocity: 0, sleeping: false };
      st.x = t[i + 1];
      st.y = t[i + 2];
      st.rotation = t[i + 3];
      st.vx = t[i + 4];
      st.vy = t[i + 5];
      st.angularVelocity = t[i + 6];
      st.sleeping = t[i + 7] !== 0;
      this.states.set(id, st);
    }
    const e = this.backend.events();
    const events: CollisionEvent[] = [];
    for (let i = 0; i + EVENT_STRIDE <= e.length; i += EVENT_STRIDE) {
      events.push({ kind: e[i] === 1 ? "start" : "end", a: e[i + 1], b: e[i + 2], sensor: e[i + 3] !== 0 });
    }
    this.lastEvents = events;
    for (const ev of events) for (const l of this.listeners) l(ev);
    for (const l of this.stepListeners) l();
    return events;
  }

  /** The last step's raw transforms, 8 floats per body, for bulk consumers such as SpritePool. */
  rawTransforms(): Float32Array {
    return this.backend.transforms();
  }

  onStep(cb: () => void): () => void {
    this.stepListeners.add(cb);
    return () => this.stepListeners.delete(cb);
  }

  /** The state of a non-static body after the last step; static bodies are not tracked. */
  state(id: number): BodyState | undefined {
    return this.states.get(id);
  }

  get events(): CollisionEvent[] {
    return this.lastEvents;
  }

  onCollision(cb: (e: CollisionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  raycast(x: number, y: number, dx: number, dy: number, maxDistance = 10000, mask = ALL, solid = true): RayHit | null {
    if (!this.backend.call(OP.RAYCAST, this.args(x, y, dx, dy, maxDistance, mask, solid ? 1 : 0))) return null;
    const s = this.backend.scratch;
    return { collider: s[0], x: s[1], y: s[2], nx: s[3], ny: s[4], distance: s[5], body: s[6] };
  }

  /**
   * Sweep a shape (rect, circle or capsule; polygons cast as their box) from (x, y) along
   * (dx, dy) for up to `maxDistance` pixels; the hit's x, y is the shape's centre at impact.
   */
  shapeCast(shape: Shape, x: number, y: number, dx: number, dy: number, maxDistance = 10000, mask = ALL): ShapeHit | null {
    const e = this.encodeShape(shape);
    if (!this.backend.call(OP.SHAPE_CAST, this.args(e.shape, e.a, e.b, x, y, dx, dy, maxDistance, mask))) return null;
    const s = this.backend.scratch;
    return { collider: s[0], x: s[1], y: s[2], nx: s[3], ny: s[4], distance: s[5], body: s[6] };
  }

  /** Colliders under a point. */
  pointQuery(x: number, y: number, mask = ALL, max = 32): number[] {
    const n = this.backend.call(OP.POINT_QUERY, this.args(x, y, mask, max));
    return Array.from(this.backend.scratch.subarray(0, Math.max(0, n)));
  }

  /** Colliders whose bounds touch a rect. */
  aabbQuery(x: number, y: number, w: number, h: number, mask = ALL, max = 32): number[] {
    const n = this.backend.call(OP.AABB_QUERY, this.args(x, y, w, h, mask, max));
    return Array.from(this.backend.scratch.subarray(0, Math.max(0, n)));
  }

  /** Move a kinematic body's shape by (dx, dy), sliding along whatever it hits. */
  characterMove(body: number, collider: number, dx: number, dy: number, dt: number, o: CharacterMoveOptions = {}): CharacterMove {
    this.backend.call(OP.CHARACTER_MOVE, this.args(body, collider, dx, dy, dt, o.snap ?? 4, o.maxSlope ?? 46, o.autostep ?? 0));
    const s = this.backend.scratch;
    return { x: s[0], y: s[1], grounded: s[2] !== 0, slidingDownSlope: s[3] !== 0, dx: s[4], dy: s[5] };
  }

  get bodyCount(): number {
    return this.backend.call(OP.BODY_COUNT, 0);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.backend.destroy();
    this.states.clear();
    this.listeners.clear();
    this.nodes.clear();
    this.owners.clear();
    this.stepListeners.clear();
    this.lastEvents = [];
  }
}
