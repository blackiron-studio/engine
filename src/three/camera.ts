import { Node3D } from "./node.ts";
import {
  Ray3,
  Vec3,
  mat4Identity,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Orthographic,
  mat4Perspective,
  mat4Point,
} from "./math.ts";
export class Camera3D extends Node3D {
  projection: "perspective" | "orthographic" = "perspective";
  /** Vertical field of view in degrees. */
  fov = 50;
  /** Vertical world-space span of an orthographic view. */
  orthoHeight = 20;
  /** Optional minimum horizontal span. Keeps a fixed arena visible in narrow viewports. */
  orthoWidth = 0;
  near = 0.1;
  far = 300;
  aspect = 16 / 9;
  readonly target = new Vec3();
  readonly up = new Vec3(0, 1, 0);
  /** When true, target is in the camera parent's coordinates; false uses Euler rotation. */
  autoLookAt = true;
  readonly viewMatrix = mat4Identity();
  readonly projectionMatrix = mat4Identity();
  readonly viewProjection = mat4Identity();
  readonly inverseViewProjection = mat4Identity();
  constructor() {
    super();
    this.position.set(12, 10, 14);
  }
  lookAt(x: number | Readonly<Vec3>, y = 0, z = 0): this {
    if (typeof x === "number") this.target.set(x, y, z);
    else this.target.copy(x);
    this.autoLookAt = true;
    return this;
  }
  /** Classic equal-axis isometric view around the current target; spans are world units. */
  setIsometric(height = 26.8, width = 39, distance = 35): this {
    if (![height, width, distance].every(Number.isFinite) || height <= 0 || width < 0 || distance <= 0)
      throw new RangeError("Isometric spans and distance must be finite and positive (width may be zero)");
    this.projection = "orthographic";
    this.orthoHeight = height;
    this.orthoWidth = width;
    const offset = distance / Math.sqrt(3);
    this.position.copy(this.target).add(new Vec3(offset, offset, offset));
    this.autoLookAt = true;
    return this;
  }
  /** Yaw-relative XZ movement: screen X right, screen Y down; preserves analog magnitude up to 1. */
  groundDirection(x: number, y: number, out = new Vec3()): Vec3 {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return out.set(0, 0, 0);
    const m = this.updateWorldMatrix();
    let rx = m[0], rz = m[2];
    const length = Math.hypot(rx, rz);
    if (length < 1e-8) { rx = 1; rz = 0; }
    else { rx /= length; rz /= length; }
    const magnitude = Math.max(1, Math.hypot(x, y));
    return out.set((rx * x - rz * y) / magnitude, 0, (rz * x + rx * y) / magnitude);
  }
  /** Pick a horizontal gameplay/weapon plane in logical viewport coordinates. */
  screenToGround(x: number, y: number, width: number, height: number, elevation = 0): Vec3 | null {
    return this.screenRay(x, y, width, height).intersectGround(elevation);
  }
  protected override composeLocal(): void {
    if (this.autoLookAt)
      mat4LookAt(this.localMatrix, this.position, this.target, this.up);
    else super.composeLocal();
  }
  updateMatrices(aspect = this.aspect): void {
    this.aspect = aspect;
    if (!mat4Invert(this.viewMatrix, this.updateWorldMatrix()))
      throw new Error("Camera3D transform must be invertible");
    if (this.projection === "perspective")
      mat4Perspective(
        this.projectionMatrix,
        (this.fov * Math.PI) / 180,
        aspect,
        this.near,
        this.far,
      );
    else
      mat4Orthographic(
        this.projectionMatrix,
        Math.max(this.orthoHeight, this.orthoWidth / aspect),
        aspect,
        this.near,
        this.far,
      );
    mat4Multiply(this.viewProjection, this.projectionMatrix, this.viewMatrix);
    mat4Invert(this.inverseViewProjection, this.viewProjection);
  }
  /** Logical screen position and normalized depth (-1 near, 1 far). */
  project(point: Readonly<Vec3>, width: number, height: number): Vec3 {
    this.updateMatrices(width / height);
    const p = mat4Point(this.viewProjection, point);
    return p.set(((p.x + 1) * width) / 2, ((1 - p.y) * height) / 2, p.z);
  }
  screenRay(x: number, y: number, width: number, height: number): Ray3 {
    this.updateMatrices(width / height);
    const near = mat4Point(
      this.inverseViewProjection,
      new Vec3((x * 2) / width - 1, 1 - (y * 2) / height, -1),
    );
    const far = mat4Point(
      this.inverseViewProjection,
      new Vec3((x * 2) / width - 1, 1 - (y * 2) / height, 1),
    );
    return new Ray3(near, far.sub(near).normalize());
  }
}
