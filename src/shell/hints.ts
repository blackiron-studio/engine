// Tutorial hints as data: each hint names when it applies, which action ends it, and how
// it reads. The layer shows one at a time with the glyph for the device the player last
// used, and hints seen once stay seen through the settings store.

import type { App } from "../app/app.ts";
import type { DrawContext } from "../scene/draw.ts";
import { Node2D } from "../scene/node.ts";
import { wrapText } from "../scene/text.ts";
import type { Settings } from "./settings.ts";

export interface HintSpec {
  id: string;
  /** Text; `{action}` becomes the glyph for that action's binding. */
  text: string;
  /** Pressing this action dismisses the hint (and its glyph fills `{action}` by default). */
  action?: string;
  /** Show only while this holds; always by default. */
  when?: (app: App) => boolean;
  /** Dismiss once this holds. */
  until?: (app: App) => boolean;
  /** Seconds to wait after `when` first holds. */
  delay?: number;
  /** Dismiss after this many seconds on screen. */
  duration?: number;
  /** Never show again once dismissed; true by default. */
  once?: boolean;
}

const KEY_NAMES: Record<string, string> = {
  Space: "Space", Enter: "Enter", NumpadEnter: "Enter", Escape: "Esc", Backspace: "Backspace", Tab: "Tab",
  ShiftLeft: "Shift", ShiftRight: "Shift", ControlLeft: "Ctrl", ControlRight: "Ctrl", AltLeft: "Alt", AltRight: "Alt",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

const PAD_NAMES: Record<string, string> = {
  GamepadA: "A", GamepadB: "B", GamepadX: "X", GamepadY: "Y", GamepadStart: "Start", GamepadSelect: "Select",
  GamepadL1: "LB", GamepadR1: "RB", GamepadL2: "LT", GamepadR2: "RT", GamepadL3: "L3", GamepadR3: "R3", GamepadHome: "Home",
  GamepadDpadUp: "D-pad ↑", GamepadDpadDown: "D-pad ↓", GamepadDpadLeft: "D-pad ←", GamepadDpadRight: "D-pad →",
  GamepadLeftStickUp: "Left stick ↑", GamepadLeftStickDown: "Left stick ↓", GamepadLeftStickLeft: "Left stick ←", GamepadLeftStickRight: "Left stick →",
  GamepadRightStickUp: "Right stick ↑", GamepadRightStickDown: "Right stick ↓", GamepadRightStickLeft: "Right stick ←", GamepadRightStickRight: "Right stick →",
};

/** A readable name for a key or button code. */
export function keyName(code: string): string {
  if (PAD_NAMES[code]) return PAD_NAMES[code];
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

/** The glyph for an action on the device the player last used. */
export function glyphFor(app: App, action: string): string {
  const codes = app.input.bindingsOf(action);
  const device = app.input.lastDevice;
  if (device === "touch") return codes.length ? action : "tap";
  const pad = codes.filter((c) => c.startsWith("Gamepad"));
  const keys = codes.filter((c) => !c.startsWith("Gamepad"));
  const pick = device === "gamepad" ? (pad[0] ?? keys[0]) : (keys[0] ?? pad[0]);
  return pick ? keyName(pick) : action;
}

export class Hints {
  readonly specs: HintSpec[];
  current: HintSpec | null = null;
  /** Seconds the current hint has been on screen. */
  shownFor = 0;
  private waiting = new Map<string, number>();
  private readonly done = new Set<string>();

  constructor(
    readonly app: App,
    specs: HintSpec[],
    readonly settings: Settings | null = null,
  ) {
    this.specs = specs;
  }

  private seen(id: string): boolean {
    return this.done.has(id) || (this.settings?.hintSeen(id) ?? false);
  }

  /** The current hint's text with glyphs filled in. */
  text(): string {
    const h = this.current;
    if (!h) return "";
    return h.text.replace(/\{(\w+)\}/g, (_, action: string) => glyphFor(this.app, action));
  }

  update(dt: number): void {
    const app = this.app;
    if (this.current) {
      const h = this.current;
      this.shownFor += dt;
      const ended = (h.action && app.input.justPressed(h.action)) || (h.until?.(app) ?? false) || (h.duration !== undefined && this.shownFor >= h.duration) || (h.when && !h.when(app));
      if (ended) this.dismiss();
      return;
    }
    for (const h of this.specs) {
      if (this.seen(h.id) || !(h.when?.(app) ?? true)) continue;
      if (h.delay) {
        const waited = (this.waiting.get(h.id) ?? 0) + dt;
        this.waiting.set(h.id, waited);
        if (waited < h.delay) continue;
      }
      this.current = h;
      this.shownFor = 0;
      return;
    }
  }

  dismiss(): void {
    const h = this.current;
    if (!h) return;
    this.current = null;
    if (h.once ?? true) {
      this.done.add(h.id);
      this.settings?.markHintSeen(h.id);
    }
  }

  /** Forget every hint shown, so they play again. */
  reset(): void {
    this.done.clear();
    this.waiting.clear();
    this.current = null;
    this.settings?.resetHints();
  }
}

export interface HintLayerOptions {
  /** Distance from the bottom edge. */
  bottom?: number;
  /** Widest the panel may be; the text wraps inside it. The screen's width less a margin by default. */
  maxWidth?: number;
}

/** Draws the current hint in a panel above the bottom edge; add it to a scene's UI layer. */
export class HintLayer extends Node2D {
  private alpha2 = 0;

  constructor(
    readonly hints: Hints,
    readonly opts: HintLayerOptions = {},
  ) {
    super();
  }

  override update(dt: number): void {
    this.hints.update(dt);
    const target = this.hints.current ? 1 : 0;
    const rate = this.hints.app.accessibility.reducedMotion ? 30 : 8;
    this.alpha2 += (target - this.alpha2) * Math.min(1, rate * dt);
  }

  override render(ctx: DrawContext): void {
    if (this.alpha2 < 0.02) return;
    const app = this.hints.app;
    const font = app.theme.font;
    const text = this.hints.text() || this.lastText;
    if (!text) return;
    this.lastText = text;
    // Wrap to the width allowed, so a long hint never runs off a narrow screen.
    const maxWidth = Math.min(this.opts.maxWidth ?? ctx.width - 40, ctx.width - 40) - 28;
    const lines = wrapText(text, maxWidth, (t) => ctx.measure(t, 1, 0, font));
    const lineH = font === "pixel" ? 9 : ctx.lineHeight(1, font);
    const w = Math.max(...lines.map((l) => ctx.measure(l, 1, 0, font))) + 28;
    const h = lineH * lines.length + 18;
    const x = Math.round((ctx.width - w) / 2);
    const y = Math.round(ctx.height - (this.opts.bottom ?? 48) - h - app.safeInsets[2]);
    const p = app.theme.panel;
    ctx.rect(x, y, w, h, p.fill, p.fillAlpha * this.alpha2);
    if (p.border !== null) ctx.frame(x, y, w, h, p.border, this.alpha2);
    ctx.rect(x, y, 3, h, app.theme.accent, this.alpha2);
    lines.forEach((line, i) => ctx.text(line, x + 14, y + 9 + i * lineH, { font, color: app.theme.text, alpha: this.alpha2 }));
  }

  private lastText = "";
}
