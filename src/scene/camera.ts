import { type Rect, clamp, damp } from "../core/math.ts";
import type { ProjectionMatrix } from "../kernel/protocol.ts";
import { type Mat, matIdentity } from "../render/types.ts";

export interface FollowTarget {
  x: number;
  y: number;
}

/** A 2D camera: centre position, zoom, optional bounds, smoothed follow and shake. */
/**
 * How ground (x, y, z) reaches the screen. Null keeps the flat 2D world; "topDown" adds
 * height (things rise on screen) with a depth sort; "isometric" projects 2:1 diamonds; "tilt"
 * is a three-quarter view where a tile of height y*cos(angle) rises by z*sin(angle).
 */
export type ProjectionSpec =
  | { kind: "topDown" }
  | { kind: "isometric"; tile: { w: number; h: number }; /** World units per cell; defaults to half the tile width. */ cell?: number }
  | { kind: "tilt"; angle: number };

export class Camera2D {
  x = 0;
  y = 0;
  /** Height the camera looks at, in projected worlds. */
  z = 0;
  zoom = 1;
  /** Ground-to-screen projection for the world layer; null keeps the flat 2D world. */
  projection: ProjectionSpec | null = null;
  /** World-space rectangle the view is kept inside, if set. */
  bounds: Rect | null = null;
  target: FollowTarget | null = null;
  /** Follow smoothing per second; higher is tighter. 0 snaps immediately. */
  followRate = 6;
  /** Round the translation to whole pixels so pixel art stays crisp. */
  snap = true;
  /** Multiplies every shake; the App's accessibility setting drives it. */
  shakeScale = 1;
  private shakeAmp = 0;
  private shakeTime = 0;
  private shakeDuration = 0;
  private t = 0;
  shakeX = 0;
  shakeY = 0;

  constructor(
    public width: number,
    public height: number,
  ) {}

  follow(target: FollowTarget | null, rate = this.followRate): void {
    this.target = target;
    this.followRate = rate;
    if (target) {
      this.x = target.x;
      this.y = target.y;
      this.clampToBounds();
    }
  }

  shake(amplitude: number, duration = 0.3): void {
    amplitude *= this.shakeScale;
    if (amplitude <= 0) return;
    this.shakeAmp = Math.max(this.shakeAmp, amplitude);
    this.shakeDuration = Math.max(this.shakeDuration, duration);
    this.shakeTime = this.shakeDuration;
  }

  update(dt: number): void {
    this.t += dt;
    if (this.target) {
      if (this.followRate <= 0) {
        this.x = this.target.x;
        this.y = this.target.y;
      } else {
        this.x = damp(this.x, this.target.x, this.followRate, dt);
        this.y = damp(this.y, this.target.y, this.followRate, dt);
      }
      const tz = (this.target as { worldZ?: number; z?: number }).worldZ ?? (this.target as { z?: number }).z;
      if (typeof tz === "number") this.z = this.followRate <= 0 ? tz : damp(this.z, tz, this.followRate, dt);
    }
    this.clampToBounds();
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt);
      const k = this.shakeAmp * (this.shakeTime / Math.max(1e-6, this.shakeDuration));
      this.shakeX = Math.sin(this.t * 71.3) * k;
      this.shakeY = Math.cos(this.t * 53.7) * k;
      if (this.shakeTime === 0) {
        this.shakeAmp = 0;
        this.shakeX = 0;
        this.shakeY = 0;
      }
    }
  }

  clampToBounds(): void {
    const b = this.bounds;
    if (!b) return;
    const hw = this.width / 2 / this.zoom;
    const hh = this.height / 2 / this.zoom;
    this.x = b.w <= hw * 2 ? b.x + b.w / 2 : clamp(this.x, b.x + hw, b.x + b.w - hw);
    this.y = b.h <= hh * 2 ? b.y + b.h / 2 : clamp(this.y, b.y + hh, b.y + b.h - hh);
  }

  /** The projection as the twelve numbers the kernel takes, or null for a flat world. */
  projectionMatrix(): ProjectionMatrix | null {
    const s = this.projection;
    if (!s) return null;
    if (s.kind === "isometric") {
      const cell = s.cell ?? s.tile.w / 2;
      const k = s.tile.w / 2 / cell;
      const kh = s.tile.h / 2 / cell;
      return [k, -k, 0, 0, kh, kh, -1, 0, 1, 1, 0, 0];
    }
    if (s.kind === "tilt") {
      const c = Math.cos(s.angle);
      const sn = Math.sin(s.angle);
      return [1, 0, 0, 0, 0, c, -sn, 0, 0, 1, 0, 0];
    }
    return [1, 0, 0, 0, 0, 1, -1, 0, 0, 1, 0, 0];
  }

  /** A ground point through the projection alone (before the camera). */
  private projected(x: number, y: number, z: number): [number, number] {
    const p = this.projectionMatrix();
    if (!p) return [x, y];
    return [p[0] * x + p[1] * y + p[2] * z + p[3], p[4] * x + p[5] * y + p[6] * z + p[7]];
  }

  /** World-to-screen matrix. */
  matrix(out: Mat = matIdentity()): Mat {
    const [cx, cy] = this.projected(this.x, this.y, this.z);
    let tx = this.width / 2 - cx * this.zoom;
    let ty = this.height / 2 - cy * this.zoom;
    if (this.snap) {
      tx = Math.round(tx);
      ty = Math.round(ty);
    }
    tx += Math.round(this.shakeX);
    ty += Math.round(this.shakeY);
    out[0] = this.zoom;
    out[1] = 0;
    out[2] = 0;
    out[3] = this.zoom;
    out[4] = tx;
    out[5] = ty;
    return out;
  }

  /** World-space rectangle currently visible; under a projection, the ground rectangle around the screen's corners. */
  visibleRect(): Rect {
    if (this.projection) {
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (const [sx, sy] of [[0, 0], [this.width, 0], [0, this.height], [this.width, this.height]]) {
        const [wx, wy] = this.screenToWorld(sx, sy, 0);
        x0 = Math.min(x0, wx);
        y0 = Math.min(y0, wy);
        x1 = Math.max(x1, wx);
        y1 = Math.max(y1, wy);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const w = this.width / this.zoom;
    const h = this.height / this.zoom;
    return { x: this.x - w / 2, y: this.y - h / 2, w, h };
  }

  /** Ground position under a screen point, at height `z` in projected worlds. */
  screenToWorld(sx: number, sy: number, z = 0): [number, number] {
    const p = this.projectionMatrix();
    if (!p) return [(sx - this.width / 2) / this.zoom + this.x, (sy - this.height / 2) / this.zoom + this.y];
    const m = this.matrix();
    const ux = (sx - m[4]) / m[0];
    const uy = (sy - m[5]) / m[3];
    const a = ux - p[2] * z - p[3];
    const b = uy - p[6] * z - p[7];
    const det = p[0] * p[5] - p[1] * p[4] || 1e-9;
    return [(a * p[5] - p[1] * b) / det, (p[0] * b - p[4] * a) / det];
  }

  /** Screen point of a ground position, at height `z` in projected worlds. */
  worldToScreen(wx: number, wy: number, z = 0): [number, number] {
    const p = this.projectionMatrix();
    if (!p) return [(wx - this.x) * this.zoom + this.width / 2, (wy - this.y) * this.zoom + this.height / 2];
    const m = this.matrix();
    const [px, py] = this.projected(wx, wy, z);
    return [m[0] * px + m[4], m[3] * py + m[5]];
  }
}
