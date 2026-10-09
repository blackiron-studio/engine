import { Vec3 } from "./math.ts";
import type { Camera3D } from "./camera.ts";

/** Right-handed FPS look. yaw=0 looks down -Z, positive yaw turns right, positive pitch looks up. */
export class FirstPersonLook {
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  invertY = false;
  maxPitch = Math.PI * 0.485;
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
  apply(camera: Camera3D, eye: Readonly<Vec3>): void {
    camera.position.copy(eye);
    camera.target.copy(eye).add(this.forward());
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
