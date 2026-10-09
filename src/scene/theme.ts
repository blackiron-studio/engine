// A theme is the set of defaults UI nodes fall back to when a game passes no style: font,
// colours, panel and button looks. `app.theme` holds the active one; `app.setTheme` merges.

import type { FontSpec } from "../render/types.ts";

export interface ThemePanel {
  fill: number;
  fillAlpha: number;
  border: number | null;
  bevel: number | null;
}

export interface ThemeButton extends ThemePanel {
  text: number;
  hover: number;
  pressedFill: number;
  /** Optional nine-slice sprites for normal, hover, pressed and disabled states. */
  skin?: ButtonSkin;
}

export interface ButtonSkin {
  normal: string;
  hover?: string;
  pressed?: string;
  disabled?: string;
  inset?: number;
}

export interface ThemeInput extends ThemePanel {
  text: number;
  placeholder: number;
  caret: number;
  focusBorder: number;
}

export interface Theme {
  /** Font for labels, buttons and inputs that do not name one. */
  font: FontSpec | "pixel";
  text: number;
  muted: number;
  accent: number;
  panel: ThemePanel;
  button: ThemeButton;
  input: ThemeInput;
  tooltip: { fill: number; text: number; border: number | null };
  scrollbar: { track: number; thumb: number; width: number };
}

export const defaultTheme: Theme = {
  font: "pixel",
  text: 0xffffff,
  muted: 0x9a96b8,
  accent: 0xffc857,
  panel: { fill: 0x141225, fillAlpha: 0.85, border: 0x6b6a8a, bevel: 0x08070f },
  button: { fill: 0x1d1a33, fillAlpha: 0.95, border: 0x8a86b8, bevel: 0x0a0912, text: 0xf1ecff, hover: 0x2b2750, pressedFill: 0x120f22 },
  input: { fill: 0x0f0d1c, fillAlpha: 0.95, border: 0x6b6a8a, bevel: null, text: 0xf1ecff, placeholder: 0x6f6b8a, caret: 0xffc857, focusBorder: 0xffc857 },
  tooltip: { fill: 0x0a0912, text: 0xf1ecff, border: 0x8a86b8 },
  scrollbar: { track: 0x0a0912, thumb: 0x6b6a8a, width: 4 },
};

export type ThemePatch = {
  [K in keyof Theme]?: Theme[K] extends object ? Partial<Theme[K]> : Theme[K];
};

export function mergeTheme(base: Theme, patch: ThemePatch): Theme {
  const out: Record<string, unknown> = { ...base };
  for (const [key, v] of Object.entries(patch)) {
    const b = (base as unknown as Record<string, unknown>)[key];
    if (v && typeof v === "object" && b && typeof b === "object") out[key] = { ...(b as object), ...(v as object) };
    else if (v !== undefined) out[key] = v;
  }
  return out as unknown as Theme;
}
