import { Transform3D } from "./animation.ts";
import { Node3D } from "./node.ts";
import type { Body3DOptions, PhysicsBody3D } from "./physics.ts";
type Vector = { x: number; y: number; z: number };
interface Pose {
  id: number;
  position: Vector;
  rotation: Vector & { w: number };
  velocity: Vector;
}
export class NativeBody3D {
  constructor(
    readonly world: NativePhysicsWorld3D,
    private pose: Pose,
  ) {}
  get handle(): number {
    return this.pose.id;
  }
  collider(index: number): { handle: number } {
    if (index !== 0 || !this.isValid())
      throw Error("Invalid native collider index");
    return { handle: this.handle };
  }
  setTranslation(value: Vector, _wakeUp = true): void {
    this.world.command("translation", { body: this.handle, value });
    this.pose.position = { ...value };
  }
  translation(): Vector {
    return { ...this.pose.position };
  }
  rotation(): Vector & { w: number } {
    return { ...this.pose.rotation };
  }
  linvel(): Vector {
    return { ...this.pose.velocity };
  }
  isValid(): boolean {
    return this.world.has(this.handle);
  }
  setLinvel(value: Vector, _wakeUp = true): void {
    this.world.command("velocity", { body: this.handle, value });
    this.pose.velocity = { ...value };
  }
  applyImpulse(value: Vector, _wakeUp = true): void {
    this.world.command("impulse", { body: this.handle, value });
  }
  setNextKinematicTranslation(value: Vector): void {
    this.world.command("target", { body: this.handle, value });
  }
  /** @internal */ sync(pose: Pose): void {
    this.pose = pose;
  }
}
/** Native Rust Rapier world. Basic body API matches the browser wrapper; raw Wasm APIs remain browser-specific. */
export class NativePhysicsWorld3D {
  private id: number;
  private disposed = false;
  private cleanups = new Set<() => void>();
  onDispose(cleanup: () => void): () => void {
    if (this.disposed) throw Error("PhysicsWorld3D is disposed");
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }
  onBodyCollision:
    | ((a: PhysicsBody3D, b: PhysicsBody3D, started: boolean) => void)
    | null = null;
  private bodies = new Map<
    number,
    { body: NativeBody3D; node?: Transform3D }
  >();
  constructor(
    private bridge: (command: string) => string,
    gravity: Vector = { x: 0, y: -9.81, z: 0 },
  ) {
    const result = JSON.parse(
      bridge(JSON.stringify({ op: "create", gravity })),
    );
    if (result.error) throw new Error(result.error);
    this.id = result.value;
  }
  command(op: string, args: Record<string, unknown> = {}): any {
    if (this.disposed) throw new Error("PhysicsWorld3D is disposed");
    const validate = (v: unknown): void => {
      if (typeof v === "number" && !Number.isFinite(v))
        throw new RangeError("Non-finite physics value");
      if (v && typeof v === "object")
        for (const item of Object.values(v)) validate(item);
    };
    validate(args);
    const result = JSON.parse(
      this.bridge(
        JSON.stringify({ op, world: this.id, ...args }, (_, v) =>
          ArrayBuffer.isView(v)
            ? Array.from(v as unknown as ArrayLike<number>)
            : v,
        ),
      ),
    );
    if (result.error) throw new Error(result.error);
    return result.value;
  }
  createBody(options: Body3DOptions, node?: Transform3D): NativeBody3D {
    if (node?.parent) {
      if (!(node.parent instanceof Node3D))
        throw new Error("Physics visual requires an identity world parent");
      const m = node.parent.updateWorldMatrix();
      if (
        m.some(
          (v, i) => Math.abs(v - ([0, 5, 10, 15].includes(i) ? 1 : 0)) > 1e-6,
        )
      )
        throw new Error(
          "Physics3D visuals require an identity parent transform",
        );
    }
    const position =
      options.position ??
      (node ? { x: node.x, y: node.y, z: node.z } : undefined);
    const pose = this.command("createBody", {
      options: { ...options, position },
      rotation: node?.quaternion,
    }) as Pose;
    const body = new NativeBody3D(this, pose);
    this.bodies.set(body.handle, { body, node });
    return body;
  }
  has(id: number): boolean {
    return !this.disposed && this.bodies.has(id);
  }
  removeBody(body: PhysicsBody3D): void {
    if (!(body instanceof NativeBody3D) || body.world !== this)
      throw new Error("Body belongs to a different world");
    this.command("removeBody", { body: body.handle });
    this.bodies.delete(body.handle);
  }
  step(dt: number): void {
    if (this.disposed) throw new Error("PhysicsWorld3D is disposed");
    if (dt === 0) return;
    const result = this.command("step", { dt }) as {
      poses: Pose[];
      events: [number, number, boolean][];
    };
    const poses = result.poses;
    for (const pose of poses) {
      const binding = this.bodies.get(pose.id);
      if (!binding) continue;
      binding.body.sync(pose);
      if (binding.node) {
        const p = pose.position,
          q = pose.rotation;
        binding.node.position.set(p.x, p.y, p.z);
        binding.node.quaternion = [q.x, q.y, q.z, q.w];
        binding.node.matrix = null;
      }
    }
    for (const [a, b, started] of result.events) {
      const aa = this.bodies.get(a)?.body,
        bb = this.bodies.get(b)?.body;
      if (aa && bb) this.onBodyCollision?.(aa, bb, started);
    }
  }
  raycast(
    origin: Vector,
    direction: Vector,
    distance: number,
    ignore?: number,
  ): {
    collider: { handle: number };
    body: number | null;
    timeOfImpact: number;
    normal: Vector;
  } | null {
    return this.command("raycast", { origin, direction, distance, ignore });
  }
  moveCharacter(
    body: NativeBody3D,
    desired: Vector,
    dt: number,
    options: { stepHeight: number; snapDistance: number; maxSlope: number },
  ): { movement: Vector; grounded: boolean } {
    if (body.world !== this || !body.isValid())
      throw Error("Invalid character body");
    return this.command("characterMove", {
      body: body.handle,
      desired,
      dt,
      ...options,
    });
  }
  get stats(): { bodies: number; colliders: number; joints: number } {
    return this.disposed
      ? { bodies: 0, colliders: 0, joints: 0 }
      : this.command("stats");
  }
  dispose(): void {
    if (this.disposed) return;
    const errors: unknown[] = [];
    for (const cleanup of [...this.cleanups]) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    this.cleanups.clear();
    this.command("dispose");
    this.disposed = true;
    this.bodies.clear();
    if (errors.length)
      throw new AggregateError(errors, "Physics dependent cleanup failed");
  }
}
