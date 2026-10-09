/** Right-handed coordinates: X right, Y up, cameras look along local -Z. */
export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v: Readonly<Vec3>): this {
    return this.set(v.x, v.y, v.z);
  }
  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }
  add(v: Readonly<Vec3>): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  sub(v: Readonly<Vec3>): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  multiplyScalar(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  get length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }
  normalize(): this {
    const n = this.length;
    return n > 1e-12 ? this.multiplyScalar(1 / n) : this;
  }
  dot(v: Readonly<Vec3>): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v: Readonly<Vec3>): this {
    return this.set(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }
  distanceTo(v: Readonly<Vec3>): number {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  lerp(v: Readonly<Vec3>, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }
}
export type Mat4 = Float32Array;
export const mat4Identity = (): Mat4 =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Column-major out = a * b. Both inputs may alias out. */
export function mat4Multiply(
  out: Mat4,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): Mat4 {
  const aa = out === a ? new Float32Array(a) : a;
  const bb = out === b ? new Float32Array(b) : b;
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      out[col * 4 + row] =
        aa[row] * bb[col * 4] +
        aa[4 + row] * bb[col * 4 + 1] +
        aa[8 + row] * bb[col * 4 + 2] +
        aa[12 + row] * bb[col * 4 + 3];
  return out;
}
/** Translation * Euler XYZ rotation * scale; angles in radians. */
export function mat4Compose(
  out: Mat4,
  p: Readonly<Vec3>,
  r: Readonly<Vec3>,
  s: Readonly<Vec3>,
): Mat4 {
  const a = Math.cos(r.x),
    b = Math.sin(r.x),
    c = Math.cos(r.y),
    d = Math.sin(r.y),
    e = Math.cos(r.z),
    f = Math.sin(r.z);
  out[0] = c * e * s.x;
  out[1] = (a * f + b * e * d) * s.x;
  out[2] = (b * f - a * e * d) * s.x;
  out[3] = 0;
  out[4] = -c * f * s.y;
  out[5] = (a * e - b * f * d) * s.y;
  out[6] = (b * e + a * f * d) * s.y;
  out[7] = 0;
  out[8] = d * s.z;
  out[9] = -b * c * s.z;
  out[10] = a * c * s.z;
  out[11] = 0;
  out[12] = p.x;
  out[13] = p.y;
  out[14] = p.z;
  out[15] = 1;
  return out;
}
export function mat4Invert(out: Mat4, a: ArrayLike<number>): boolean {
  const m = Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) =>
      col < 4 ? a[col * 4 + row] : Number(col - 4 === row),
    ),
  );
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++)
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-12) return false;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const d = m[col][col];
    for (let k = 0; k < 8; k++) m[col][k] /= d;
    for (let row = 0; row < 4; row++)
      if (row !== col) {
        const f = m[row][col];
        for (let k = 0; k < 8; k++) m[row][k] -= f * m[col][k];
      }
  }
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) out[col * 4 + row] = m[row][col + 4];
  return true;
}
export function mat4Point(
  m: ArrayLike<number>,
  p: Readonly<Vec3>,
  out = new Vec3(),
): Vec3 {
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  return out.set(
    (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w,
    (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w,
    (m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]) / w,
  );
}
export function mat4Perspective(
  out: Mat4,
  fov: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  if (!(fov > 0 && fov < Math.PI && aspect > 0 && near > 0 && far > near))
    throw new RangeError("Invalid perspective camera volume");
  out.fill(0);
  const f = 1 / Math.tan(fov / 2);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}
export function mat4Orthographic(
  out: Mat4,
  height: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  if (!(height > 0 && aspect > 0 && near >= 0 && far > near))
    throw new RangeError("Invalid orthographic camera volume");
  out.fill(0);
  out[0] = 2 / (height * aspect);
  out[5] = 2 / height;
  out[10] = -2 / (far - near);
  out[14] = -(far + near) / (far - near);
  out[15] = 1;
  return out;
}
/** Camera-to-world orientation with a stable fallback when forward is parallel to up. */
export function mat4LookAt(
  out: Mat4,
  eye: Readonly<Vec3>,
  target: Readonly<Vec3>,
  up = new Vec3(0, 1, 0),
): Mat4 {
  const z = new Vec3(eye.x - target.x, eye.y - target.y, eye.z - target.z);
  if (z.length < 1e-9) z.z = 1;
  z.normalize();
  const x = up.clone().cross(z);
  if (x.length < 1e-9)
    x.set(Math.abs(z.y) > 0.99 ? 1 : 0, Math.abs(z.y) > 0.99 ? 0 : 1, 0).cross(
      z,
    );
  x.normalize();
  const y = z.clone().cross(x);
  out.set([
    x.x,
    x.y,
    x.z,
    0,
    y.x,
    y.y,
    y.z,
    0,
    z.x,
    z.y,
    z.z,
    0,
    eye.x,
    eye.y,
    eye.z,
    1,
  ]);
  return out;
}
export class Ray3 {
  constructor(
    public origin = new Vec3(),
    public direction = new Vec3(0, 0, -1),
  ) {}
  at(t: number, out = new Vec3()): Vec3 {
    return out.copy(this.direction).multiplyScalar(t).add(this.origin);
  }
  /** Intersection in front of the ray with y = height, or null when parallel/behind. */
  intersectGround(height = 0): Vec3 | null {
    if (Math.abs(this.direction.y) < 1e-9) return null;
    const t = (height - this.origin.y) / this.direction.y;
    return t < 0 ? null : this.at(t);
  }
}
