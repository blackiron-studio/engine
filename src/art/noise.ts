// Seeded, optionally tileable noise for procedural textures: gradient (Perlin) noise,
// fractal sums, ridged and turbulent variants, cellular (Worley) noise and domain warping.
// Everything is deterministic for a seed and runs headless, so baked art is reproducible.
//
// Tiling: pass `period` (in lattice cells) and sample x, y in [0, period) to get a texture
// that wraps seamlessly; fractal octaves double the period with the frequency.

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

const mod = (a: number, p: number): number => ((a % p) + p) % p;
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** A uniform random number in [0, 1) for an integer lattice point. */
export function hash01(x: number, y: number, seed = 0): number {
  return hash2(x, y, seed) / 4294967296;
}

function grad(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const a = (hash2(ix, iy, seed) / 4294967296) * Math.PI * 2;
  return Math.cos(a) * dx + Math.sin(a) * dy;
}

/** Gradient noise in roughly [-1, 1]. `period` makes it tile every `period` cells. */
export function perlin(x: number, y: number, seed = 0, period = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let ax = x0;
  let ay = y0;
  let bx = x0 + 1;
  let by = y0 + 1;
  if (period > 0) {
    ax = mod(ax, period);
    ay = mod(ay, period);
    bx = mod(bx, period);
    by = mod(by, period);
  }
  const u = fade(fx);
  const v = fade(fy);
  const n00 = grad(ax, ay, seed, fx, fy);
  const n10 = grad(bx, ay, seed, fx - 1, fy);
  const n01 = grad(ax, by, seed, fx, fy - 1);
  const n11 = grad(bx, by, seed, fx - 1, fy - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.41421356;
}

export interface FractalOptions {
  seed?: number;
  octaves?: number;
  /** Frequency multiplier per octave. */
  lacunarity?: number;
  /** Amplitude multiplier per octave. */
  gain?: number;
  /** Tile every `period` cells at the base frequency; 0 for no tiling. */
  period?: number;
}

/** Fractal Brownian motion in roughly [-1, 1]. */
export function fbm(x: number, y: number, o: FractalOptions = {}): number {
  const octaves = o.octaves ?? 5;
  const lac = o.lacunarity ?? 2;
  const gain = o.gain ?? 0.5;
  const seed = o.seed ?? 0;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const period = o.period ? Math.round(o.period * freq) : 0;
    sum += amp * perlin(x * freq, y * freq, seed + i * 101, period);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1]: sharp crests, for rock, cracks and mountain lines. */
export function ridged(x: number, y: number, o: FractalOptions = {}): number {
  const octaves = o.octaves ?? 5;
  const lac = o.lacunarity ?? 2;
  const gain = o.gain ?? 0.5;
  const seed = o.seed ?? 0;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    const period = o.period ? Math.round(o.period * freq) : 0;
    let n = 1 - Math.abs(perlin(x * freq, y * freq, seed + i * 131, period));
    n *= n * weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += amp * n;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/** Turbulence in [0, 1]: the sum of absolute octaves, for smoke, marble and grain. */
export function turbulence(x: number, y: number, o: FractalOptions = {}): number {
  const octaves = o.octaves ?? 5;
  const lac = o.lacunarity ?? 2;
  const gain = o.gain ?? 0.5;
  const seed = o.seed ?? 0;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const period = o.period ? Math.round(o.period * freq) : 0;
    sum += amp * Math.abs(perlin(x * freq, y * freq, seed + i * 173, period));
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return Math.min(1, (sum / norm) * 1.6);
}

export interface CellSample {
  /** Distance to the nearest feature point, in cells. */
  f1: number;
  /** Distance to the second nearest. */
  f2: number;
  /** A stable random value in [0, 1) for the nearest cell, for per-cell colour. */
  id: number;
}

/** Cellular (Worley) noise: stones, scales, cobbles, cracks (f2 - f1). Tiles with `period`. */
export function worley(x: number, y: number, seed = 0, period = 0, jitter = 0.9): CellSample {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const gy = cy + j;
      const hx = period > 0 ? mod(gx, period) : gx;
      const hy = period > 0 ? mod(gy, period) : gy;
      const px = gx + 0.5 + (hash01(hx, hy, seed) - 0.5) * jitter;
      const py = gy + 0.5 + (hash01(hx, hy, seed + 7) - 0.5) * jitter;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash01(hx, hy, seed + 13);
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, id };
}

/** Domain-warped fractal noise in roughly [-1, 1]: organic, marbled, painterly. */
export function warped(x: number, y: number, strength = 1.5, o: FractalOptions = {}): number {
  const seed = o.seed ?? 0;
  const qx = fbm(x, y, { ...o, seed: seed + 11, octaves: Math.min(4, o.octaves ?? 4) });
  const qy = fbm(x + 5.2, y + 1.3, { ...o, seed: seed + 23, octaves: Math.min(4, o.octaves ?? 4) });
  return fbm(x + strength * qx, y + strength * qy, o);
}

/** Map a value in [lo, hi] to [0, 1], clamped, with a smooth step. */
export function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}
