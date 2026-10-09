// Physics: rapier2d in the kernel, one world per App, bodies as ids or as scene nodes.

export { PHYSICS_OP, BODY_KIND, TRANSFORM_STRIDE, EVENT_STRIDE, type BodyKind, type PhysicsBackend } from "./protocol.ts";
export { WasmPhysics, loadWasmPhysics } from "./wasm.ts";
export { NativePhysics, type NativePhysicsWorld } from "./native.ts";
export { PhysicsWorld, type BodyOptions, type BodyState, type CharacterMove, type CharacterMoveOptions, type ColliderOptions, type CollisionEvent, type JointOptions, type RayHit, type Shape } from "./world.ts";
export { ArcadeWorld2D, ArcadeVehicle2D, type Position2D, type VehicleTuning2D } from "./arcade2d.ts";
