import type * as Rapier from "@dimforge/rapier3d-compat";
import { NativeBody3D, NativePhysicsWorld3D } from "./physics-native.ts";
import { PhysicsWorld3D, type PhysicsBackend3D } from "./physics.ts";
import { Vec3 } from "./math.ts";

export interface CharacterOptions3D {
  radius?: number;
  height?: number;
  stepHeight?: number;
  snapDistance?: number;
  maxSlope?: number;
  speed?: number;
  sprintMultiplier?: number;
  acceleration?: number;
  airAcceleration?: number;
  gravity?: number;
  jumpSpeed?: number;
  coyoteTime?: number;
  jumpBuffer?: number;
  position?: Readonly<Vec3>;
}
/** Reusable Rapier capsule motor. Position is at the feet; move before the world's fixed step.
 * Browser/Wasm and native Rust Rapier backends. Own/dispose this controller before disposing its world.
 */
export class CharacterController3D {
  readonly body: Rapier.RigidBody | NativeBody3D;
  readonly collider: { readonly handle: number };
  readonly controller: Rapier.KinematicCharacterController | null;
  readonly position = new Vec3();
  readonly velocity = new Vec3();
  readonly options: Required<Omit<CharacterOptions3D, "position">>;
  grounded = false;
  private coyote = 0;
  private buffered = 0;
  private disposed = false;
  private unregister: () => void;
  constructor(
    readonly physics: PhysicsBackend3D,
    options: CharacterOptions3D = {},
  ) {
    this.options = {
      radius: 0.32,
      height: 1.8,
      stepHeight: 0.35,
      snapDistance: 0.22,
      maxSlope: Math.PI / 4,
      speed: 6,
      sprintMultiplier: 1.45,
      acceleration: 42,
      airAcceleration: 12,
      gravity: 22,
      jumpSpeed: 7.4,
      coyoteTime: 0.1,
      jumpBuffer: 0.12,
      ...options,
    };
    const o = this.options;
    if (
      Object.values(o).some(
        (v) => typeof v === "number" && (!Number.isFinite(v) || v < 0),
      ) ||
      o.radius <= 0 ||
      o.height < o.radius * 2 ||
      o.maxSlope >= Math.PI / 2
    )
      throw new RangeError("Invalid character dimensions or tuning");
    this.position.copy(options.position ?? new Vec3());
    this.body = physics.createBody({
      type: "kinematic",
      position: {
        x: this.position.x,
        y: this.position.y + o.height / 2,
        z: this.position.z,
      },
      shape: {
        kind: "capsule",
        radius: o.radius,
        halfHeight: o.height / 2 - o.radius,
      },
    });
    this.collider = this.body.collider(0);
    this.controller =
      physics instanceof PhysicsWorld3D
        ? physics.world.createCharacterController(0.015)
        : null;
    if (this.controller) {
      this.controller.setSlideEnabled(true);
      this.controller.setMaxSlopeClimbAngle(o.maxSlope);
      this.controller.setMinSlopeSlideAngle(o.maxSlope + 0.04);
      if (o.stepHeight > 0)
        this.controller.enableAutostep(o.stepHeight, 0.15, false);
      if (o.snapDistance > 0)
        this.controller.enableSnapToGround(o.snapDistance);
      this.controller.setApplyImpulsesToDynamicBodies(true);
      this.controller.setCharacterMass(75);
    }
    this.unregister = physics.onDispose(() => this.dispose());
  }
  move(
    direction: Readonly<Vec3>,
    dt: number,
    input: { jump?: boolean; sprint?: boolean } = {},
  ): void {
    if (this.disposed) throw new Error("Character disposed");
    if (
      ![direction.x, direction.z, dt].every(Number.isFinite) ||
      dt < 0 ||
      dt > 0.1
    )
      throw new RangeError("Invalid character step");
    if (dt === 0) return;
    const o = this.options;
    this.coyote = this.grounded ? o.coyoteTime : Math.max(0, this.coyote - dt);
    this.buffered = input.jump ? o.jumpBuffer : Math.max(0, this.buffered - dt);
    const jump = this.buffered > 0 && this.coyote > 0;
    if (jump) {
      this.velocity.y = o.jumpSpeed;
      this.buffered = this.coyote = 0;
      this.grounded = false;
    }
    const length = Math.max(1, Math.hypot(direction.x, direction.z));
    const speed = o.speed * (input.sprint ? o.sprintMultiplier : 1),
      amount = (this.grounded ? o.acceleration : o.airAcceleration) * dt;
    const approach = (a: number, b: number) =>
      a + Math.max(-amount, Math.min(amount, b - a));
    this.velocity.x = approach(this.velocity.x, (direction.x / length) * speed);
    this.velocity.z = approach(this.velocity.z, (direction.z / length) * speed);
    this.velocity.y = Math.max(-45, this.velocity.y - o.gravity * dt);
    if (this.velocity.y > 0) this.controller?.disableSnapToGround();
    else if (o.snapDistance > 0)
      this.controller?.enableSnapToGround(o.snapDistance);
    const desired = {
      x: this.velocity.x * dt,
      y: this.velocity.y * dt,
      z: this.velocity.z * dt,
    };
    let movement: { x: number; y: number; z: number }, grounded: boolean;
    if (
      this.physics instanceof NativePhysicsWorld3D &&
      this.body instanceof NativeBody3D
    ) {
      const result = this.physics.moveCharacter(this.body, desired, dt, {
        stepHeight: o.stepHeight,
        snapDistance: this.velocity.y > 0 ? 0 : o.snapDistance,
        maxSlope: o.maxSlope,
      });
      movement = result.movement;
      grounded = result.grounded;
    } else {
      const physics = this.physics as PhysicsWorld3D,
        controller = this.controller!;
      controller.computeColliderMovement(
        (this.body as Rapier.RigidBody).collider(0),
        desired,
        physics.api.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        (c) => c.parent()?.handle !== this.body.handle,
      );
      movement = controller.computedMovement();
      grounded = controller.computedGrounded();
    }
    this.grounded = grounded && this.velocity.y <= 0;
    if (
      this.grounded ||
      (this.velocity.y > 0 && movement.y < desired.y - 0.001)
    )
      this.velocity.y = 0;
    const p = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: p.x + movement.x,
      y: p.y + movement.y,
      z: p.z + movement.z,
    });
    this.position.set(
      p.x + movement.x,
      p.y + movement.y - o.height / 2,
      p.z + movement.z,
    );
  }
  teleport(feet: Readonly<Vec3>): void {
    if (this.disposed) throw new Error("Character disposed");
    if (![feet.x, feet.y, feet.z].every(Number.isFinite))
      throw new RangeError("Invalid position");
    this.position.copy(feet);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.coyote = this.buffered = 0;
    const p = { x: feet.x, y: feet.y + this.options.height / 2, z: feet.z };
    this.body.setTranslation(p, true);
    this.body.setNextKinematicTranslation(p);
    if (this.physics instanceof PhysicsWorld3D)
      this.physics.world.propagateModifiedBodyPositionsToColliders();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregister();
    if (this.body.isValid()) {
      if (this.physics instanceof PhysicsWorld3D && this.controller)
        this.physics.world.removeCharacterController(this.controller);
      this.physics.removeBody(this.body);
    }
  }
}
