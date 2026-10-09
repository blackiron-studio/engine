import { Node3D } from "./node.ts";
import { Geometry3D } from "./geometry.ts";
import { Mesh3D } from "./scene.ts";
import {
  mat4Identity,
  mat4Invert,
  mat4Multiply,
  mat4Point,
  Vec3,
  type Mat4,
} from "./math.ts";

export type Quaternion = [number, number, number, number];
export function normalizeQuaternion(q: ArrayLike<number>): Quaternion {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(n) || n < 1e-12)
    throw new RangeError("Invalid quaternion");
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
export function slerp(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  t: number,
): Quaternion {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  const theta = Math.acos(dot),
    sin = Math.sin(theta);
  const x = sin < 1e-6 ? 1 - t : Math.sin((1 - t) * theta) / sin;
  const y = (sin < 1e-6 ? t : Math.sin(t * theta) / sin) * sign;
  return normalizeQuaternion([
    a[0] * x + b[0] * y,
    a[1] * x + b[1] * y,
    a[2] * x + b[2] * y,
    a[3] * x + b[3] * y,
  ]);
}
/** glTF-compatible transform node. Euler nodes elsewhere retain their existing behavior. */
export class Transform3D extends Node3D {
  quaternion: Quaternion = [0, 0, 0, 1];
  matrix: Mat4 | null = null;
  protected override composeLocal(): void {
    if (this.matrix) {
      this.localMatrix.set(this.matrix);
      return;
    }
    const [x, y, z, w] = normalizeQuaternion(this.quaternion),
      m = this.localMatrix,
      s = this.scale;
    m.set([
      (1 - 2 * (y * y + z * z)) * s.x,
      2 * (x * y + z * w) * s.x,
      2 * (x * z - y * w) * s.x,
      0,
      2 * (x * y - z * w) * s.y,
      (1 - 2 * (x * x + z * z)) * s.y,
      2 * (y * z + x * w) * s.y,
      0,
      2 * (x * z + y * w) * s.z,
      2 * (y * z - x * w) * s.z,
      (1 - 2 * (x * x + y * y)) * s.z,
      0,
      this.x,
      this.y,
      this.z,
      1,
    ]);
  }
}
export interface AnimationChannel3D {
  target: Transform3D;
  path: "translation" | "rotation" | "scale";
  times: Float32Array;
  values: Float32Array;
  interpolation: "LINEAR" | "STEP" | "CUBICSPLINE";
}
export class AnimationClip3D {
  readonly duration: number;
  constructor(
    readonly name: string,
    readonly channels: AnimationChannel3D[],
  ) {
    let duration = 0;
    for (const c of channels) {
      const size = c.path === "rotation" ? 4 : 3;
      if (
        !c.times.length ||
        c.values.length !==
          c.times.length * size * (c.interpolation === "CUBICSPLINE" ? 3 : 1)
      )
        throw new Error("Invalid animation channel length");
      for (let i = 0; i < c.times.length; i++)
        if (
          !Number.isFinite(c.times[i]) ||
          c.times[i] < 0 ||
          (i > 0 && c.times[i] <= c.times[i - 1])
        )
          throw new Error("Animation times must increase");
      if (c.values.some((v) => !Number.isFinite(v)))
        throw new Error("Invalid animation values");
      duration = Math.max(duration, c.times[c.times.length - 1]);
    }
    this.duration = duration;
  }
  sample(time: number): void {
    if (!Number.isFinite(time)) throw new RangeError("Invalid animation time");
    for (const c of this.channels) {
      let lo = 0,
        hi = c.times.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (c.times[mid] <= time) lo = mid;
        else hi = mid - 1;
      }
      const a = lo,
        b = Math.min(a + 1, c.times.length - 1),
        span = c.times[b] - c.times[a];
      const t =
          span > 0 ? Math.max(0, Math.min(1, (time - c.times[a]) / span)) : 0,
        size = c.path === "rotation" ? 4 : 3;
      const stride = size * (c.interpolation === "CUBICSPLINE" ? 3 : 1),
        offset = c.interpolation === "CUBICSPLINE" ? size : 0;
      const av = c.values.subarray(
          a * stride + offset,
          a * stride + offset + size,
        ),
        bv = c.values.subarray(b * stride + offset, b * stride + offset + size);
      let v: number[];
      if (c.interpolation === "STEP" || a === b) v = Array.from(av);
      else if (c.interpolation === "CUBICSPLINE") {
        const t2 = t * t,
          t3 = t2 * t;
        v = Array.from(
          { length: size },
          (_, i) =>
            (2 * t3 - 3 * t2 + 1) * av[i] +
            (t3 - 2 * t2 + t) * span * c.values[a * stride + 2 * size + i] +
            (-2 * t3 + 3 * t2) * bv[i] +
            (t3 - t2) * span * c.values[b * stride + i],
        );
      } else if (c.path === "rotation") v = slerp(av, bv, t);
      else v = Array.from(av, (n, i) => n + (bv[i] - n) * t);
      c.target.matrix = null;
      if (c.path === "rotation") c.target.quaternion = normalizeQuaternion(v);
      else
        (c.path === "translation" ? c.target.position : c.target.scale).set(
          v[0],
          v[1],
          v[2],
        );
    }
  }
}
export class AnimationPlayer3D extends Node3D {
  time = 0;
  speed = 1;
  loop = true;
  playing = false;
  clip: AnimationClip3D | null = null;
  onFinished: (() => void) | null = null;
  play(clip: AnimationClip3D, loop = true): void {
    this.clip = clip;
    this.time = 0;
    this.loop = loop;
    this.playing = true;
    clip.sample(0);
  }
  override update(dt: number): void {
    const c = this.clip;
    if (!c || !this.playing) return;
    if (
      !Number.isFinite(dt) ||
      dt < 0 ||
      !Number.isFinite(this.speed) ||
      this.speed < 0
    )
      throw new RangeError("Invalid animation step");
    this.time += dt * this.speed;
    if (this.loop && c.duration > 0) this.time %= c.duration;
    else if (this.time >= c.duration) {
      this.time = c.duration;
      this.playing = false;
    }
    c.sample(this.time);
    if (!this.playing) this.onFinished?.();
  }
}
/** Four-weight CPU skinning. Portable across renderers; each instance owns its deformed geometry. */
export class Skin3D {
  private readonly basePositions: Float32Array;
  private readonly baseNormals: Float32Array;
  private readonly matrices: Mat4[];
  private readonly normals: Mat4[];
  constructor(
    readonly mesh: Mesh3D,
    readonly joints: Node3D[],
    readonly inverseBind: Mat4[],
    readonly indices: Float32Array,
    readonly weights: Float32Array,
  ) {
    const g = mesh.geometry,
      count = g.positions.length / 3;
    if (
      indices.length !== count * 4 ||
      weights.length !== count * 4 ||
      joints.length !== inverseBind.length
    )
      throw new Error("Invalid skin dimensions");
    for (let i = 0; i < indices.length; i++)
      if (
        !Number.isInteger(indices[i]) ||
        indices[i] < 0 ||
        indices[i] >= joints.length ||
        !Number.isFinite(weights[i]) ||
        weights[i] < 0
      )
        throw new Error("Invalid joint weights");
    for (let i = 0; i < count; i++)
      if (weights.subarray(i * 4, i * 4 + 4).reduce((a, b) => a + b, 0) <= 0)
        throw new Error("Zero skin weights");
    this.basePositions = g.positions.slice();
    this.baseNormals = g.normals.slice();
    mesh.geometry = new Geometry3D(g.positions, g.normals, g.indices, g.uvs);
    mesh.frustumCulled = false;
    this.matrices = joints.map(() => mat4Identity());
    this.normals = joints.map(() => mat4Identity());
  }
  update(): void {
    const inv = mat4Identity();
    if (!mat4Invert(inv, this.mesh.updateWorldMatrix()))
      throw new Error("Singular skin transform");
    for (let i = 0; i < this.joints.length; i++) {
      const m = this.matrices[i];
      mat4Multiply(m, this.joints[i].updateWorldMatrix(), this.inverseBind[i]);
      mat4Multiply(m, inv, m);
      if (!mat4Invert(this.normals[i], m))
        throw new Error("Singular joint transform");
    }
    const p = new Vec3(),
      v = new Vec3(),
      g = this.mesh.geometry;
    for (let i = 0; i < g.positions.length / 3; i++) {
      let x = 0,
        y = 0,
        z = 0,
        nx = 0,
        ny = 0,
        nz = 0,
        sum = 0;
      p.set(
        this.basePositions[i * 3],
        this.basePositions[i * 3 + 1],
        this.basePositions[i * 3 + 2],
      );
      const ax = this.baseNormals[i * 3],
        ay = this.baseNormals[i * 3 + 1],
        az = this.baseNormals[i * 3 + 2];
      for (let j = 0; j < 4; j++) {
        const weight = this.weights[i * 4 + j];
        if (!weight) continue;
        sum += weight;
        const bone = this.indices[i * 4 + j],
          m = this.matrices[bone],
          n = this.normals[bone];
        mat4Point(m, p, v);
        x += weight * v.x;
        y += weight * v.y;
        z += weight * v.z;
        nx += weight * (n[0] * ax + n[1] * ay + n[2] * az);
        ny += weight * (n[4] * ax + n[5] * ay + n[6] * az);
        nz += weight * (n[8] * ax + n[9] * ay + n[10] * az);
      }
      g.positions[i * 3] = x / sum;
      g.positions[i * 3 + 1] = y / sum;
      g.positions[i * 3 + 2] = z / sum;
      const length = Math.hypot(nx, ny, nz) || 1;
      g.normals[i * 3] = nx / length;
      g.normals[i * 3 + 1] = ny / length;
      g.normals[i * 3 + 2] = nz / length;
    }
    g.touch();
  }
  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
