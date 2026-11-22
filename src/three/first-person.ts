import { Vec3 } from "./math.ts";
import type { Camera3D } from "./camera.ts";
import { Spring } from "../core/spring.ts";

/** Right-handed FPS look. yaw=0 looks down -Z, positive yaw turns right, positive pitch looks up. */
export class FirstPersonLook {
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  invertY = false;
  maxPitch = Math.PI * 0.485;
  /**
   * The view kick (recoil, a hit, a blast): pitch and yaw offsets in radians that spring back to 0.
   * They move the camera, not `yaw`/`pitch`, so aim and movement stay on the player's own look.
   */
  readonly punchPitch = new Spring(220, 22);
  readonly punchYaw = new Spring(220, 22);
  /** The eye dipping on a landing, in metres, springing back to 0. */
  readonly dip = new Spring(160, 16);
  mouse(dx: number, dy: number): void {
    if (
      ![dx, dy, this.sensitivity].every(Number.isFinite) ||
      this.sensitivity < 0
    )
      throw new RangeError("Invalid mouse look");
    this.turn(
      dx * this.sensitivity,
      dy * this.sensitivity * (this.invertY ? 1 : -1),
    );
  }
  turn(yaw: number, pitch: number): void {
    if (![yaw, pitch].every(Number.isFinite))
      throw new RangeError("Invalid look angles");
    this.yaw =
      ((((this.yaw + yaw + Math.PI) % (Math.PI * 2)) + Math.PI * 2) %
        (Math.PI * 2)) -
      Math.PI;
    this.pitch = Math.max(
      -this.maxPitch,
      Math.min(this.maxPitch, this.pitch + pitch),
    );
  }
  forward(out = new Vec3()): Vec3 {
    return out.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
  }
  right(out = new Vec3()): Vec3 {
    return out.set(Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }
  movement(strafe: number, forward: number, out = new Vec3()): Vec3 {
    const k = 1 / Math.max(1, Math.hypot(strafe, forward));
    return out.set(
      (Math.cos(this.yaw) * strafe + Math.sin(this.yaw) * forward) * k,
      0,
      (Math.sin(this.yaw) * strafe - Math.cos(this.yaw) * forward) * k,
    );
  }
  /**
   * Kick the view: speeds in radians per second (positive pitch kicks up, positive yaw right). About
   * 1 gives a punch of a few degrees that settles in a fifth of a second. Call `update` every frame.
   */
  punch(pitch: number, yaw = 0): void {
    this.punchPitch.kick(pitch);
    this.punchYaw.kick(yaw);
  }
  /** Dip the eye: a landing at `speed` metres per second (scaled down) pushes it down and back up. */
  land(speed: number, scale = 0.035): void {
    if (!Number.isFinite(speed) || !Number.isFinite(scale)) throw new RangeError("Invalid landing");
    this.dip.kick(-Math.max(0, speed) * scale * 10);
  }
  /** Settle the punch and the dip. */
  update(dt: number): void {
    this.punchPitch.step(dt);
    this.punchYaw.step(dt);
    this.dip.step(dt);
  }
  /** Look direction including the punch. */
  viewForward(out = new Vec3()): Vec3 {
    const yaw = this.yaw + this.punchYaw.value,
      pitch = Math.max(-this.maxPitch, Math.min(this.maxPitch, this.pitch + this.punchPitch.value));
    return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  }
  /** Put the camera at `eye` (plus the dip), looking along the look plus the punch. */
  apply(camera: Camera3D, eye: Readonly<Vec3>): void {
    camera.position.copy(eye);
    camera.position.y += this.dip.value;
    camera.target.copy(camera.position).add(this.viewForward());
    camera.autoLookAt = true;
  }
}

/** Camera-relative stereo positioning for the existing audio backend; no HRTF implied. */
export function spatialAudio3D(
  listener: Readonly<Vec3>,
  right: Readonly<Vec3>,
  source: Readonly<Vec3>,
  range = 30,
): { pan: number; volume: number } {
  if (!Number.isFinite(range) || range <= 0)
    throw new RangeError("Invalid audio range");
  const dx = source.x - listener.x,
    dy = source.y - listener.y,
    dz = source.z - listener.z;
  const distance = Math.hypot(dx, dy, dz),
    attenuation = Math.max(0, 1 - distance / range);
  return {
    pan:
      distance > 0
        ? Math.max(
            -1,
            Math.min(
              1,
              (dx * right.x + dy * right.y + dz * right.z) / distance,
            ),
          )
        : 0,
    volume: attenuation * attenuation,
  };
}
