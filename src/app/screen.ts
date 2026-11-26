// The screen a game is shown on, in physical terms: its size in points (CSS pixels on the web),
// the notch and home bar, whether it is a touch screen, and how many points one logical unit
// covers. A 1280 by 720 design fills an iPhone held sideways at about half a point per unit, so
// text drawn 14 units tall shows at 7 points. `ui.minPoints` grows the UI layer until a unit is at
// least that many points (the way Unreal's DPI curve and Unity's constant physical size do), and
// `App.auditScreen` reports text and touch targets that still come out too small.

export type SizeClass = "phone" | "tablet" | "desktop";
/** Top, right, bottom, left. */
export type Insets = [top: number, right: number, bottom: number, left: number];

/** The `ui` section of blackiron.json. */
export interface UIConfig {
  /**
   * Grow the scene's `ui` layer on small screens so one UI unit shows at least this many points.
   * 0 (the default) leaves the UI alone. 0.8 keeps 14-unit text at 11 points or more and turns a
   * 44-point touch target into 55 units on every phone.
   */
  minPoints?: number;
  /** The most the UI grows (2). */
  maxScale?: number;
  /** Smallest text, in points, that `auditScreen` accepts (11, Apple's smallest text style). */
  minTextPoints?: number;
  /** Smallest touch target, in points, that `auditScreen` accepts on touch screens (44). */
  minTouchPoints?: number;
}

export interface ScreenInfo {
  /** The area the game owns, in points: the window or the native view. */
  readonly width: number;
  readonly height: number;
  /** Device pixels per point. */
  readonly pixelRatio: number;
  /** Safe-area insets in points (notch, rounded corners, home bar): top, right, bottom, left. */
  readonly insets: Readonly<Insets>;
  /** A touch screen is the main input (phones and tablets; not a laptop with a touch panel). */
  readonly touch: boolean;
  readonly orientation: "landscape" | "portrait";
  /** The shorter side in points: under 600 is a phone-sized screen. */
  readonly shortSide: number;
  /** phone: touch and under 600 points across; tablet: touch and larger; desktop: mouse and keyboard. */
  readonly sizeClass: SizeClass;
  /** Under 600 points across, whatever the input: lay the UI out for a small screen. */
  readonly compact: boolean;
  /** Points one logical unit covers on screen (0.55 for a 720-unit-tall design on a phone held sideways). */
  readonly pointsPerUnit: number;
  /** What `ui.minPoints` asks the UI to grow by here: 1 or more (1 when it is off). */
  readonly uiScale: number;
}

/** Screens shorter than this (in points) are phone-sized. */
export const COMPACT_SHORT_SIDE = 600;

/** How much to grow something so a unit shows at least `minPoints` points: 1 to `maxScale`. */
export function legibleScale(pointsPerUnit: number, minPoints: number, maxScale = 2): number {
  if (!(minPoints > 0) || !(pointsPerUnit > 0) || !Number.isFinite(pointsPerUnit)) return 1;
  return Math.max(1, Math.min(Math.max(1, maxScale), minPoints / pointsPerUnit));
}

export interface ScreenFacts {
  width: number;
  height: number;
  pixelRatio: number;
  insets: Readonly<Insets>;
  touch: boolean;
  pointsPerUnit: number;
}

/** The screen description for these facts and UI settings. Pure, so tests and tools can use it. */
export function describeScreen(f: ScreenFacts, ui: UIConfig = {}): ScreenInfo {
  const width = Math.max(0, f.width),
    height = Math.max(0, f.height);
  const shortSide = Math.min(width, height);
  const compact = shortSide > 0 && shortSide < COMPACT_SHORT_SIDE;
  return {
    width,
    height,
    pixelRatio: f.pixelRatio > 0 ? f.pixelRatio : 1,
    insets: [...f.insets].map((v) => Math.max(0, v || 0)) as Insets,
    touch: f.touch,
    orientation: width >= height ? "landscape" : "portrait",
    shortSide,
    sizeClass: !f.touch ? "desktop" : compact ? "phone" : "tablet",
    compact,
    pointsPerUnit: f.pointsPerUnit,
    uiScale: legibleScale(f.pointsPerUnit, ui.minPoints ?? 0, ui.maxScale ?? 2),
  };
}

export const sameScreen = (a: ScreenInfo, b: ScreenInfo): boolean =>
  a.width === b.width &&
  a.height === b.height &&
  a.pixelRatio === b.pixelRatio &&
  a.touch === b.touch &&
  Math.abs(a.pointsPerUnit - b.pointsPerUnit) < 1e-9 &&
  a.uiScale === b.uiScale &&
  a.insets.every((v, i) => v === b.insets[i]);

export interface DevicePreset {
  name: string;
  /** Points, in the orientation asked for. */
  width: number;
  height: number;
  pixelRatio: number;
  insets: Insets;
  touch: boolean;
}

interface DeviceSpec {
  /** Portrait size in points. */
  w: number;
  h: number;
  pixelRatio: number;
  touch: boolean;
  /** Safe-area insets with the status bar hidden, as a full-screen game sees them. */
  portrait: Insets;
  landscape: Insets;
  /** The orientation used when the name does not give one. */
  prefer: "portrait" | "landscape";
}

/**
 * Screens worth checking a game on. Sizes and insets are the ones iOS reports to a full-screen
 * app with the status bar hidden; `android-small` is the most common small Android size.
 */
export const DEVICES: Readonly<Record<string, DeviceSpec>> = {
  "iphone-se": { w: 375, h: 667, pixelRatio: 2, touch: true, portrait: [0, 0, 0, 0], landscape: [0, 0, 0, 0], prefer: "landscape" },
  "iphone-15": { w: 393, h: 852, pixelRatio: 3, touch: true, portrait: [59, 0, 34, 0], landscape: [0, 59, 21, 59], prefer: "landscape" },
  "iphone-15-pro-max": { w: 430, h: 932, pixelRatio: 3, touch: true, portrait: [59, 0, 34, 0], landscape: [0, 59, 21, 59], prefer: "landscape" },
  "android-small": { w: 360, h: 800, pixelRatio: 3, touch: true, portrait: [0, 0, 0, 0], landscape: [0, 0, 0, 0], prefer: "landscape" },
  "ipad-mini": { w: 744, h: 1133, pixelRatio: 2, touch: true, portrait: [0, 0, 20, 0], landscape: [0, 0, 20, 0], prefer: "landscape" },
  ipad: { w: 820, h: 1180, pixelRatio: 2, touch: true, portrait: [0, 0, 20, 0], landscape: [0, 0, 20, 0], prefer: "landscape" },
  laptop: { w: 800, h: 1280, pixelRatio: 2, touch: false, portrait: [0, 0, 0, 0], landscape: [0, 0, 0, 0], prefer: "landscape" },
  desktop: { w: 1080, h: 1920, pixelRatio: 1, touch: false, portrait: [0, 0, 0, 0], landscape: [0, 0, 0, 0], prefer: "landscape" },
};

/**
 * A device by name, optionally with "-portrait" or "-landscape" ("iphone-15-portrait"); without
 * one it uses `orientation`, else the device's usual one.
 */
export function devicePreset(spec: string, orientation?: "portrait" | "landscape"): DevicePreset {
  const m = /^(.*?)(?:-(portrait|landscape))?$/.exec(spec.trim().toLowerCase())!;
  const d = DEVICES[m[1]];
  if (!d) throw new RangeError(`Unknown device "${spec}"; known: ${Object.keys(DEVICES).join(", ")}`);
  const o = (m[2] as "portrait" | "landscape" | undefined) ?? orientation ?? d.prefer;
  const land = o === "landscape";
  return {
    name: `${m[1]}-${o}`,
    width: land ? d.h : d.w,
    height: land ? d.w : d.h,
    pixelRatio: d.pixelRatio,
    insets: [...(land ? d.landscape : d.portrait)] as Insets,
    touch: d.touch,
  };
}

/** One piece of text as drawn, for `auditScreen`. */
export interface TextAudit {
  text: string;
  /** Font size on screen, in logical units (the bitmap font counts 10 units per scale). */
  size: number;
  /** In points on this screen. */
  points: number;
}

/** One control (button, slider, field) as laid out, for `auditScreen`. */
export interface TargetAudit {
  name: string;
  /** Size on screen in points. */
  width: number;
  height: number;
}

export interface ScreenAudit {
  screen: ScreenInfo;
  minTextPoints: number;
  minTouchPoints: number;
  /** Every distinct text drawn in the frame, smallest first. */
  text: TextAudit[];
  /** Text under `minTextPoints`. */
  smallText: TextAudit[];
  /** Every visible, enabled control, smallest first. */
  targets: TargetAudit[];
  /** Controls narrower or shorter than `minTouchPoints` (only checked on touch screens). */
  smallTargets: TargetAudit[];
  /** No small text, and no small targets on a touch screen. */
  ok: boolean;
}
