import { NativePhysicsWorld3D } from "./physics-native.ts";
import type * as Rapier from "@dimforge/rapier3d-compat";
import { Node3D } from "./node.ts";
import { Transform3D } from "./animation.ts";

let initializing: Promise<typeof Rapier> | null = null;
async function module3D(): Promise<typeof Rapier> {
  if (!initializing)
    initializing = import("@dimforge/rapier3d-compat")
      .then(async (r) => {
        await r.init();
        return r;
      })
      .catch((error) => {
        initializing = null;
        throw error;
      });
  return initializing;
}
export interface Body3DOptions {
  type?: "dynamic" | "fixed" | "kinematic";
  position?: { x: number; y: number; z: number };
  shape:
    | { kind: "box"; halfExtents: [number, number, number] }
    | { kind: "sphere"; radius: number }
    | { kind: "capsule"; halfHeight: number; radius: number }
    | { kind: "trimesh"; vertices: Float32Array; indices: Uint32Array };
  sensor?: boolean;
  friction?: number;
  restitution?: number;
  density?: number;
  groups?: number;
  ccd?: boolean;
}
/** Scene-owned Rapier 3D world. Distances are metres, time is seconds; descriptors expose advanced Rapier APIs. */
export class PhysicsWorld3D {
  private disposed = false;
  private cleanups = new Set<() => void>();
  /** Register dependent native/Wasm handles that must be released before the world. */
  onDispose(cleanup: () => void): () => void { this.alive(); this.cleanups.add(cleanup); return () => this.cleanups.delete(cleanup); }
  private bindings = new Map<Rapier.RigidBody, Transform3D>();
  readonly world: Rapier.World;
  readonly events: Rapier.EventQueue;
  onBodyCollision:
    | ((a: PhysicsBody3D, b: PhysicsBody3D, started: boolean) => void)
    | null = null;
  onCollision:
    | ((a: Rapier.Collider, b: Rapier.Collider, started: boolean) => void)
    | null = null;
  private constructor(
    readonly api: typeof Rapier,
    gravity: { x: number; y: number; z: number },
  ) {
    this.world = new api.World(gravity);
    this.events = new api.EventQueue(true);
  }
  static async create(
    gravity = { x: 0, y: -9.81, z: 0 },
  ): Promise<PhysicsWorld3D> {
    if (!Object.values(gravity).every(Number.isFinite))
      throw new RangeError("Invalid gravity");
    return new PhysicsWorld3D(await module3D(), gravity);
  }
  private alive(): void {
    if (this.disposed) throw new Error("PhysicsWorld3D is disposed");
  }
  createBody(options: Body3DOptions, node?: Transform3D): Rapier.RigidBody {
    this.alive();
    const R = this.api,
      type = options.type ?? "dynamic";
    if (node?.parent && !(node.parent instanceof Node3D))
      throw new Error("Physics visual requires an identity world parent");
    if (node?.parent) {
      const parent = node.parent as Transform3D;
      const m = parent.updateWorldMatrix();
      if (
        m.some(
          (v, i) => Math.abs(v - ([0, 5, 10, 15].includes(i) ? 1 : 0)) > 1e-6,
        )
      )
        throw new Error(
          "Physics3D visuals require an identity parent transform",
        );
    }
    const desc =
      type === "fixed"
        ? R.RigidBodyDesc.fixed()
        : type === "kinematic"
          ? R.RigidBodyDesc.kinematicPositionBased()
          : R.RigidBodyDesc.dynamic();
    const position = options.position ?? node?.position ?? { x: 0, y: 0, z: 0 };
    if (!Object.values(position).every(Number.isFinite))
      throw new RangeError("Invalid body position");
    desc
      .setTranslation(position.x, position.y, position.z)
      .setCcdEnabled(options.ccd ?? false);
    if (node) {
      const q = node.quaternion;
      desc.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
    }
    const positive = (...n: number[]) => {
      if (n.some((v) => !Number.isFinite(v) || v <= 0))
        throw new RangeError("Invalid collider dimensions");
    };
    const shape = options.shape;
    let collider: Rapier.ColliderDesc;
    switch (shape.kind) {
      case "box":
        positive(...shape.halfExtents);
        collider = R.ColliderDesc.cuboid(...shape.halfExtents);
        break;
      case "sphere":
        positive(shape.radius);
        collider = R.ColliderDesc.ball(shape.radius);
        break;
      case "capsule":
        positive(shape.radius);
        if (!Number.isFinite(shape.halfHeight) || shape.halfHeight < 0)
          throw new RangeError("Invalid capsule");
        collider = R.ColliderDesc.capsule(shape.halfHeight, shape.radius);
        break;
      case "trimesh":
        if (type !== "fixed")
          throw new Error(
            "Triangle mesh colliders must be fixed; use convex primitives for dynamic bodies",
          );
        if (
          !shape.vertices.length ||
          shape.vertices.length % 3 ||
          shape.indices.length % 3 ||
          shape.vertices.some((v) => !Number.isFinite(v)) ||
          shape.indices.some((i) => i >= shape.vertices.length / 3)
        )
          throw new RangeError("Invalid collision mesh");
        collider = R.ColliderDesc.trimesh(shape.vertices, shape.indices);
        break;
    }
    collider
      .setSensor(options.sensor ?? false)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    for (const [key, value] of [
      ["friction", options.friction],
      ["restitution", options.restitution],
      ["density", options.density],
    ] as const)
      if (value !== undefined) {
        if (!Number.isFinite(value) || value < 0)
          throw new RangeError(`Invalid ${key}`);
        if (key === "friction") collider.setFriction(value);
        else if (key === "restitution") collider.setRestitution(value);
        else collider.setDensity(value);
      }
    if (options.groups !== undefined)
      collider.setCollisionGroups(options.groups);
    const body = this.world.createRigidBody(desc);
    try {
      this.world.createCollider(collider, body);
    } catch (error) {
      this.world.removeRigidBody(body);
      throw error;
    }
    if (node) this.bindings.set(body, node);
    return body;
  }
  removeBody(body: PhysicsBody3D): void {
    this.alive();
    if (
      !(body instanceof this.api.RigidBody) ||
      this.world.getRigidBody(body.handle) !== body
    )
      throw new Error("Body belongs to a different world");
    this.bindings.delete(body);
    this.world.removeRigidBody(body);
  }
  step(dt: number): void {
    this.alive();
    if (dt === 0) return;
    if (!Number.isFinite(dt) || dt < 0 || dt > 0.1)
      throw new RangeError("Physics step must be within (0, 0.1] seconds");
    this.world.timestep = dt;
    this.world.step(this.events);
    this.events.drainCollisionEvents((a, b, started) => {
      const ca = this.world.getCollider(a),
        cb = this.world.getCollider(b);
      if (ca && cb) {
        this.onCollision?.(ca, cb, started);
        const a = ca.parent(),
          b = cb.parent();
        if (a && b) this.onBodyCollision?.(a, b, started);
      }
    });
    for (const [body, node] of this.bindings) {
      if (!body.isValid()) {
        this.bindings.delete(body);
        continue;
      }
      const p = body.translation(),
        q = body.rotation();
      node.position.set(p.x, p.y, p.z);
      node.quaternion = [q.x, q.y, q.z, q.w];
      node.matrix = null;
    }
  }
  raycast(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    distance: number,
  ): Rapier.RayColliderIntersection | null {
    this.alive();
    if (
      ![...Object.values(origin), ...Object.values(direction), distance].every(
        Number.isFinite,
      ) ||
      distance < 0
    )
      throw new RangeError("Invalid ray");
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!length) throw new RangeError("Zero ray direction");
    return this.world.castRayAndGetNormal(
      new this.api.Ray(origin, {
        x: direction.x / length,
        y: direction.y / length,
        z: direction.z / length,
      }),
      distance,
      true,
    );
  }
  get stats() {
    return this.disposed
      ? { bodies: 0, colliders: 0, joints: 0 }
      : {
          bodies: this.world.bodies.len(),
          colliders: this.world.colliders.len(),
          joints: this.world.impulseJoints.len(),
        };
  }
  dispose(): void {
    if (this.disposed) return;
    const errors: unknown[] = [];
    for (const cleanup of [...this.cleanups]) { try { cleanup(); } catch(error) { errors.push(error); } }
    this.cleanups.clear();
    this.disposed = true;
    this.bindings.clear();
    this.events.free();
    this.world.free();
    if(errors.length) throw new AggregateError(errors, "Physics dependent cleanup failed");
  }
}

export interface PhysicsBody3D {
  readonly handle: number;
  translation(): { x: number; y: number; z: number };
  rotation(): { x: number; y: number; z: number; w: number };
  linvel(): { x: number; y: number; z: number };
  setLinvel(value: { x: number; y: number; z: number }, wakeUp: boolean): void;
  applyImpulse(
    value: { x: number; y: number; z: number },
    wakeUp: boolean,
  ): void;
  setNextKinematicTranslation(value: { x: number; y: number; z: number }): void;
  isValid(): boolean;
}
export interface ScenePhysics3D {
  createBody(options: Body3DOptions, node?: Transform3D): PhysicsBody3D;
  removeBody(body: PhysicsBody3D): void;
  step(dt: number): void;
  raycast(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    distance: number,
  ): {
    timeOfImpact: number;
    normal: { x: number; y: number; z: number };
  } | null;
  onBodyCollision:
    | ((a: PhysicsBody3D, b: PhysicsBody3D, started: boolean) => void)
    | null;
  readonly stats: { bodies: number; colliders: number; joints: number };
  dispose(): void;
}
export type PhysicsBackend3D = PhysicsWorld3D | NativePhysicsWorld3D;
export async function createPhysics3D(
  gravity = { x: 0, y: -9.81, z: 0 },
): Promise<PhysicsBackend3D> {
  const host = (
    globalThis as { __kilnHost?: { physics3D?: (command: string) => string } }
  ).__kilnHost;
  if (host) {
    if (!host.physics3D) throw new Error("Native host lacks physics3D support");
    return new NativePhysicsWorld3D(host.physics3D.bind(host), gravity);
  }
  return PhysicsWorld3D.create(gravity);
}
