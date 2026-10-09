// Colour parsing and palette helpers. Colours are hex strings ("#rgb", "#rrggbb",
// "#rrggbbaa") or packed 0xRRGGBB numbers. Parsed results are cached.

export type ColorInput = string | number;

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const cache = new Map<ColorInput, RGBA>();

export function parseColor(c: ColorInput): RGBA {
  const hit = cache.get(c);
  if (hit) return hit;
  let out: RGBA;
  if (typeof c === "number") {
    out = { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255, a: 255 };
  } else {
    let s = c.startsWith("#") ? c.slice(1) : c;
    if (s.length === 3 || s.length === 4) s = [...s].map((ch) => ch + ch).join("");
    if (s.length !== 6 && s.length !== 8) throw new Error(`Bad colour: ${c}`);
    const n = parseInt(s, 16);
    out =
      s.length === 8
        ? { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: n & 255 }
        : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
  }
  cache.set(c, out);
  return out;
}

export const packRGB = (r: number, g: number, b: number): number => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);

export const toHex = (r: number, g: number, b: number, a = 255): string => {
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return a >= 255 ? `#${h(r)}${h(g)}${h(b)}` : `#${h(r)}${h(g)}${h(b)}${h(a)}`;
};

/** Packed 0xRRGGBB of any colour input, alpha dropped. */
export function rgbOf(c: ColorInput): number {
  if (typeof c === "number") return c & 0xffffff;
  const { r, g, b } = parseColor(c);
  return packRGB(r, g, b);
}

/** Alpha in [0, 1] of any colour input. */
export function alphaOf(c: ColorInput): number {
  return typeof c === "number" ? 1 : parseColor(c).a / 255;
}

export function withAlpha(c: ColorInput, alpha: number): string {
  const { r, g, b } = parseColor(c);
  return toHex(r, g, b, Math.round(alpha * 255));
}

/** Add `amt` to each channel. Negative darkens. */
export function shade(c: ColorInput, amt: number): string {
  const { r, g, b, a } = parseColor(c);
  return toHex(r + amt, g + amt, b + amt, a);
}

export function mix(a: ColorInput, b: ColorInput, t: number): string {
  const A = parseColor(a);
  const B = parseColor(b);
  return toHex(A.r + (B.r - A.r) * t, A.g + (B.g - A.g) * t, A.b + (B.b - A.b) * t, A.a + (B.a - A.a) * t);
}

// --- HSL ------------------------------------------------------------------------

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Colour from hue (degrees), saturation and lightness in [0, 1]. */
export function hsl(h: number, s: number, l: number, a = 1): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return toHex(r, g, b, Math.round(a * 255));
}

/** Five-tone palette ramp: [deep shadow, shadow, base, light, highlight]. */
export type Ramp = [string, string, string, string, string];

/** Seven-tone ramp for larger sprites: two extra steps at each end of a five-tone ramp. */
export type Ramp7 = [string, string, string, string, string, string, string];

export function ramp7(base: ColorInput, spread = 1): Ramp7 {
  const { r, g, b } = parseColor(base);
  const [h, s, l] = rgbToHsl(r, g, b);
  const toward = (from: number, to: number, amount: number) => {
    const d = ((to - from + 540) % 360) - 180;
    return from + d * amount;
  };
  const tone = (dl: number, hueTo: number, hueAmt: number, ds: number): string => {
    const [rr, gg, bb] = hslToRgb(toward(h, hueTo, hueAmt), Math.max(0, Math.min(1, s + ds)), Math.max(0, Math.min(1, l + dl)));
    return toHex(rr, gg, bb);
  };
  return [
    tone(-0.34 * spread, 250, 0.3, 0.12),
    tone(-0.24 * spread, 250, 0.2, 0.09),
    tone(-0.12 * spread, 250, 0.1, 0.04),
    toHex(r, g, b),
    tone(0.1 * spread, 50, 0.08, -0.04),
    tone(0.2 * spread, 50, 0.16, -0.1),
    tone(0.3 * spread, 50, 0.24, -0.16),
  ];
}

/** The middle five tones of a seven-tone ramp, for helpers that take a five-tone ramp. */
export const mid5 = (r: Ramp7): Ramp => [r[1], r[2], r[3], r[4], r[5]];

/**
 * Build a ramp the way pixel artists do by hand: shadows go darker *and* cooler
 * (hue rotated toward blue-violet, a touch more saturated), highlights go lighter
 * and warmer (toward yellow, a touch less saturated). `spread` widens the contrast.
 */
export function ramp(base: ColorInput, spread = 1): Ramp {
  const { r, g, b } = parseColor(base);
  const [h, s, l] = rgbToHsl(r, g, b);
  const coolHue = 250;
  const warmHue = 50;
  const toward = (from: number, to: number, amount: number) => {
    let d = ((to - from + 540) % 360) - 180;
    return from + d * amount;
  };
  const tone = (dl: number, hueTo: number, hueAmt: number, ds: number): string => {
    const [rr, gg, bb] = hslToRgb(toward(h, hueTo, hueAmt), Math.max(0, Math.min(1, s + ds)), Math.max(0, Math.min(1, l + dl)));
    return toHex(rr, gg, bb);
  };
  return [
    tone(-0.26 * spread, coolHue, 0.22, 0.1),
    tone(-0.13 * spread, coolHue, 0.11, 0.05),
    toHex(r, g, b),
    tone(0.12 * spread, warmHue, 0.1, -0.05),
    tone(0.24 * spread, warmHue, 0.2, -0.12),
  ];
}
