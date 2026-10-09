// Physics runs in the kernel (rapier2d). Every host exposes the same call-style backend:
// arguments go into the scratch buffer, results come back in it, and each step fills the
// transform and event buffers. Games work in pixels; the kernel converts.

export const PHYSICS_OP = {
  SET_GRAVITY: 1, BODY_CREATE: 2, BODY_DESTROY: 3, BODY_SET_POSITION: 4, BODY_SET_VELOCITY: 5,
  BODY_APPLY_IMPULSE: 6, BODY_APPLY_FORCE: 7, BODY_KINEMATIC_TARGET: 8, BODY_GET: 9, BODY_SET: 10,
  COLLIDER_CREATE: 11, COLLIDER_DESTROY: 12, COLLIDER_SET: 13, JOINT_CREATE: 14, JOINT_DESTROY: 15,
  STEP: 16, RAYCAST: 17, POINT_QUERY: 18, AABB_QUERY: 19, CHARACTER_MOVE: 20, BODY_COUNT: 21, SHAPE_CAST: 22,
} as const;

export const TRANSFORM_STRIDE = 8;
export const EVENT_STRIDE = 4;

export type BodyKind = "static" | "dynamic" | "kinematic" | "kinematicVelocity";
export const BODY_KIND: Record<BodyKind, number> = { static: 0, dynamic: 1, kinematic: 2, kinematicVelocity: 3 };

export interface PhysicsBackend {
  readonly kind: "wasm" | "native";
  readonly scratch: Float32Array;
  call(op: number, words: number): number;
  /** The transforms written by the last step: 8 floats per body (id, x, y, rot, vx, vy, w, sleeping). */
  transforms(): Float32Array;
  /** The collision events of the last step: 4 floats each (kind 1 start / 2 end, collider a, collider b, sensor). */
  events(): Float32Array;
  destroy(): void;
}
