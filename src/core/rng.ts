// Deterministic random numbers. One algorithm (mulberry32) everywhere so that saves,
// replays, tests and any future native port agree bit for bit.

export class Rng {
  private s: number;

  constructor(seed: number | string = 1) {
    this.s = (typeof seed === "string" ? hashString(seed) : seed >>> 0) || 0x9e3779b9;
  }

  /** Current internal state; store it to resume the exact same sequence later. */
  get state(): number {
    return this.s;
  }

  set state(v: number) {
    this.s = v >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Weighted pick; weights need not sum to one. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Fisher-Yates in place. Returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = items[i];
      items[i] = items[j];
      items[j] = t;
    }
    return items;
  }

  /** Approximately normal, mean 0, standard deviation 1 (Box-Muller). */
  gaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU_ * v);
  }

  /** A child generator whose sequence depends only on this one's state and the label. */
  fork(label = ""): Rng {
    return new Rng((this.s ^ hashString(label)) >>> 0);
  }
}

const TAU_ = Math.PI * 2;

/** FNV-1a, 32-bit. Stable across platforms. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combine several integers into one seed. */
export function hashInts(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    h ^= v >>> 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
  }
  return h >>> 0;
}
