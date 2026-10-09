// Small numeric toolkit shared by every layer. No DOM, no allocation in hot paths
// beyond the vector helpers that return fresh objects.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const unlerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v: number, a0: number, a1: number, b0: number, b1: number): number => lerp(b0, b1, unlerp(a0, a1, v));

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Move `v` toward `target` by at most `maxDelta`. */
export function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(v + maxDelta, target);
  if (v > target) return Math.max(v - maxDelta, target);
  return v;
}

/** Exponential smoothing that is frame-rate independent: `rate` is "per second". */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function wrap(v: number, lo: number, hi: number): number {
  const range = hi - lo;
  if (range <= 0) return lo;
  let r = (v - lo) % range;
  if (r < 0) r += range;
  return r + lo;
}

/** Shortest signed difference between two angles in radians. */
export function angleDelta(from: number, to: number): number {
  return wrap(to - from + Math.PI, 0, TAU) - Math.PI;
}

export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

// --- Vectors -----------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });
export const vadd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vsub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vscale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const vdot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const vlen = (a: Vec2): number => Math.hypot(a.x, a.y);
export const vdist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const vdist2 = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const vangle = (a: Vec2): number => Math.atan2(a.y, a.x);
export const vfromAngle = (angle: number, length = 1): Vec2 => ({ x: Math.cos(angle) * length, y: Math.sin(angle) * length });

export function vnorm(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Clamp a vector's length. Useful for "max speed" on joystick input. */
export function vlimit(a: Vec2, max: number): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l > max && l > 0 ? { x: (a.x / l) * max, y: (a.y / l) * max } : { x: a.x, y: a.y };
}

// --- Rectangles and overlap ----------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export function circleRectOverlap(cx: number, cy: number, r: number, b: Rect): boolean {
  const nx = clamp(cx, b.x, b.x + b.w);
  const ny = clamp(cy, b.y, b.y + b.h);
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= r * r;
}

export const circlesOverlap = (ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean =>
  (ax - bx) ** 2 + (ay - by) ** 2 <= (ar + br) ** 2;

/** Expand or shrink a rect on every side. */
export const rectInflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 });

// --- Easing --------------------------------------------------------------------

export type EaseFn = (t: number) => number;

export const Easing = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  outElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  outBounce: (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
} satisfies Record<string, EaseFn>;

export type EaseName = keyof typeof Easing;

export function resolveEase(e: EaseName | EaseFn | undefined): EaseFn {
  if (!e) return Easing.linear;
  return typeof e === "function" ? e : Easing[e];
}
