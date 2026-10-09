// Colour lookup tables: 256 RGB entries applied per channel in the composite pass.
// Presets are generated, so there is nothing to load.

export type LutName = "none" | "dusk" | "warm" | "cool" | "noir" | "vivid" | "faded";

const cache = new Map<string, Uint8Array>();

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Smooth S-curve around 0.5 with the given strength. */
function contrast(t: number, k: number): number {
  return 0.5 + (t - 0.5) * k + (t - 0.5) ** 3 * (1 - k) * 2;
}

/** Build a LUT from a per-channel function of t in [0, 1]. */
export function buildLut(fn: (t: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = fn(i / 255);
    out[i * 3] = clamp(r * 255);
    out[i * 3 + 1] = clamp(g * 255);
    out[i * 3 + 2] = clamp(b * 255);
  }
  return out;
}

export function lutPreset(name: string): Uint8Array | null {
  const hit = cache.get(name);
  if (hit) return hit;
  let lut: Uint8Array | null = null;
  switch (name as LutName) {
    case "none":
      lut = buildLut((t) => [t, t, t]);
      break;
    case "dusk":
      // Shadows cooler and lifted a touch, highlights warmer, mild contrast.
      lut = buildLut((t) => {
        const c = contrast(t, 1.08);
        const shadow = 1 - t;
        return [c - 0.03 * shadow + 0.03 * t, c - 0.01 * shadow, c + 0.06 * shadow - 0.03 * t];
      });
      break;
    case "warm":
      lut = buildLut((t) => [t + 0.04 * t, t + 0.01, t - 0.05 * t]);
      break;
    case "cool":
      lut = buildLut((t) => [t - 0.04 * t, t, t + 0.05 * (1 - t) + 0.02]);
      break;
    case "noir":
      lut = buildLut((t) => {
        const c = contrast(t, 1.35);
        return [c, c, c + 0.02];
      });
      break;
    case "vivid":
      lut = buildLut((t) => {
        const c = contrast(t, 1.18);
        return [c, c, c];
      });
      break;
    case "faded":
      lut = buildLut((t) => {
        const c = 0.06 + t * 0.9;
        return [c + 0.01, c, c + 0.02];
      });
      break;
    default:
      return null;
  }
  cache.set(name, lut);
  return lut;
}

export function resolveLut(lut: string | Uint8Array | null): Uint8Array | null {
  if (!lut) return null;
  if (lut instanceof Uint8Array) return lut.length === 768 ? lut : null;
  const preset = lutPreset(lut);
  if (!preset) console.warn(`[kiln] unknown LUT "${lut}"`);
  return preset;
}
