// Canvas-drawn UI: panels, nine-slice frames, buttons and bars that live on the scene's
// `ui` layer and receive pointer routing from the Scene.

import type { Atlas, Region } from "../art/atlas.ts";
import { measureText } from "../art/font.ts";
import type { FontSpec } from "../render/types.ts";
import type { DrawContext } from "./draw.ts";
import { Node, Node2D } from "./node.ts";
import type { ButtonSkin } from "./theme.ts";

export interface PointerSnapshot {
  x: number;
  y: number;
  down: boolean;
  justPressed: boolean;
  justReleased: boolean;
}

/** Base for anything that reacts to the pointer. Bounds are local, from the node origin. */
export abstract class Control extends Node2D {
  w = 0;
  h = 0;
  hovered = false;
  pressed = false;
  disabled = false;
  /** Keyboard or gamepad focus, driven by a FocusGroup. */
  focused = false;

  /** Current screen-to-local UI transform, valid even before the first draw. */
  localPointNow(sx: number, sy: number): [number, number] {
    const scene = this.scene;
    if (!scene) return this.toLocal(sx, sy);
    const chain: Node2D[] = [];
    let insideUI = false;
    for (let node: Node | null = this; node; node = node.parent) {
      if (node instanceof Node2D) chain.push(node);
      if (node === scene.ui) { insideUI = true; break; }
    }
    if (!insideUI) return this.toLocal(sx, sy);
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i];
      if (node.scaleX === 0 || node.scaleY === 0) return [NaN, NaN];
      const dx = sx - node.x, dy = sy - node.y;
      const c = Math.cos(node.rotation), s = Math.sin(node.rotation);
      sx = (dx * c + dy * s) / node.scaleX;
      sy = (-dx * s + dy * c) / node.scaleY;
    }
    return [sx, sy];
  }

  hitTest(sx: number, sy: number): boolean {
    if (!this.visible || this.disabled) return false;
    const [lx, ly] = this.localPointNow(sx, sy);
    if (!(lx >= 0 && ly >= 0 && lx < this.w && ly < this.h)) return false;
    // Inside a scroll container, only the visible part is clickable.
    for (let p = this.parent; p; p = p.parent) {
      if (!p.visible || (p instanceof Control && p.disabled)) return false;
      const clip = p as { clipsChildren?: boolean; containsScreenPoint?(x: number, y: number): boolean };
      if (clip.clipsChildren && clip.containsScreenPoint && !clip.containsScreenPoint(sx, sy)) return false;
    }
    return true;
  }

  onEnter(): void {}
  onLeave(): void {}
  onDown(): void {}
  onUp(_inside: boolean): void {}
  /** A complete press and release inside the control. */
  onPress(): void {}
}

export interface PanelStyle {
  fill?: number;
  fillAlpha?: number;
  border?: number | null;
  /** Darker inner line below the border for depth. */
  bevel?: number | null;
}

export class Panel extends Node2D {
  private fillOverride: number | undefined;
  private alphaOverride: number | undefined;
  private borderOverride: number | null | undefined;
  private bevelOverride: number | null | undefined;

  get fill(): number { return this.fillOverride ?? this.scene?.attachedApp?.theme.panel.fill ?? 0x141225; }
  set fill(value: number) { this.fillOverride = value; }
  get fillAlpha(): number { return this.alphaOverride ?? this.scene?.attachedApp?.theme.panel.fillAlpha ?? 0.85; }
  set fillAlpha(value: number) { this.alphaOverride = value; }
  get border(): number | null { const theme = this.scene?.attachedApp?.theme; return this.borderOverride === undefined ? theme ? theme.panel.border : 0x6b6a8a : this.borderOverride; }
  set border(value: number | null) { this.borderOverride = value; }
  get bevel(): number | null { const theme = this.scene?.attachedApp?.theme; return this.bevelOverride === undefined ? theme ? theme.panel.bevel : 0x08070f : this.bevelOverride; }
  set bevel(value: number | null) { this.bevelOverride = value; }

  constructor(
    x: number,
    y: number,
    public w: number,
    public h: number,
    style: PanelStyle = {},
  ) {
    super(x, y);
    if (style.fill !== undefined) this.fill = style.fill;
    if (style.fillAlpha !== undefined) this.fillAlpha = style.fillAlpha;
    if (style.border !== undefined) this.border = style.border;
    if (style.bevel !== undefined) this.bevel = style.bevel;
  }

  override render(ctx: DrawContext): void {
    ctx.rect(0, 0, this.w, this.h, this.fill, this.fillAlpha);
    if (this.bevel !== null) {
      ctx.rect(1, this.h - 2, this.w - 2, 1, this.bevel, 0.9);
      ctx.rect(this.w - 2, 1, 1, this.h - 2, this.bevel, 0.9);
    }
    if (this.border !== null) ctx.frame(0, 0, this.w, this.h, this.border);
  }
}

/** A sprite stretched as nine slices: corners fixed, edges and centre scaled. */
export class NineSlice extends Node2D {
  private parts: Region[] | null = null;
  private forSprite = "";
  private forInset = -1;
  private forAtlas: Atlas | null = null;

  constructor(
    public sprite: string,
    x: number,
    y: number,
    public w: number,
    public h: number,
    /** Border size in sprite pixels. */
    public inset = 4,
  ) {
    super(x, y);
  }

  private slices(ctx: DrawContext): Region[] {
    if (this.parts && this.forSprite === this.sprite && this.forInset === this.inset && this.forAtlas === ctx.atlas) return this.parts;
    const r = ctx.region(this.sprite);
    const i = Math.max(0, Math.min(this.inset, Math.floor(r.w / 2), Math.floor(r.h / 2)));
    const aw = ctx.atlas.width;
    const ah = ctx.atlas.height;
    const xs = [r.x, r.x + i, r.x + r.w - i, r.x + r.w];
    const ys = [r.y, r.y + i, r.y + r.h - i, r.y + r.h];
    const parts: Region[] = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const x0 = xs[col];
        const x1 = xs[col + 1];
        const y0 = ys[row];
        const y1 = ys[row + 1];
        parts.push({ name: `${r.name}#${row}${col}`, x: x0, y: y0, w: x1 - x0, h: y1 - y0, u0: x0 / aw, v0: y0 / ah, u1: x1 / aw, v1: y1 / ah, ox: 0, oy: 0 });
      }
    }
    this.parts = parts;
    this.forSprite = this.sprite;
    this.forInset = this.inset;
    this.forAtlas = ctx.atlas;
    return parts;
  }

  override render(ctx: DrawContext): void {
    const p = this.slices(ctx);
    const i = p[0].w;
    const j = p[0].h;
    const edgeW = Math.min(i, Math.max(0, this.w) / 2);
    const edgeH = Math.min(j, Math.max(0, this.h) / 2);
    const mw = Math.max(0, this.w - edgeW * 2);
    const mh = Math.max(0, this.h - edgeH * 2);
    const cols = [0, edgeW, edgeW + mw];
    const rows = [0, edgeH, edgeH + mh];
    const ws = [edgeW, mw, edgeW];
    const hs = [edgeH, mh, edgeH];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const part = p[r * 3 + c];
        if (part.w === 0 || part.h === 0 || ws[c] === 0 || hs[r] === 0) continue;
        ctx.sprite(part, cols[c], rows[r], { sx: ws[c] / part.w, sy: hs[r] / part.h });
      }
    }
  }
}

const buttonSlices = new WeakMap<Atlas, Map<string, Region[]>>();

function drawButtonSkin(ctx: DrawContext, name: string, width: number, height: number, inset: number): void {
  let byName = buttonSlices.get(ctx.atlas);
  if (!byName) { byName = new Map(); buttonSlices.set(ctx.atlas, byName); }
  const key = `${name}:${inset}`;
  let parts = byName.get(key);
  if (!parts) {
    const r = ctx.region(name);
    const i = Math.max(0, Math.min(inset, Math.floor(r.w / 2), Math.floor(r.h / 2)));
    const xs = [r.x, r.x + i, r.x + r.w - i, r.x + r.w];
    const ys = [r.y, r.y + i, r.y + r.h - i, r.y + r.h];
    parts = [];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      const x0 = xs[col], x1 = xs[col + 1], y0 = ys[row], y1 = ys[row + 1];
      parts.push({ name: `${name}#${row}${col}`, x: x0, y: y0, w: x1 - x0, h: y1 - y0, u0: x0 / ctx.atlas.width, v0: y0 / ctx.atlas.height, u1: x1 / ctx.atlas.width, v1: y1 / ctx.atlas.height, ox: 0, oy: 0 });
    }
    byName.set(key, parts);
  }
  const i = Math.min(parts[0].w, Math.max(0, width) / 2);
  const j = Math.min(parts[0].h, Math.max(0, height) / 2);
  const ws = [i, Math.max(0, width - i * 2), i];
  const hs = [j, Math.max(0, height - j * 2), j];
  const xs = [0, i, i + ws[1]], ys = [0, j, j + hs[1]];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const part = parts[row * 3 + col];
    if (part.w && part.h && ws[col] && hs[row]) ctx.sprite(part, xs[col], ys[row], { sx: ws[col] / part.w, sy: hs[row] / part.h });
  }
}

export interface ButtonStyle extends PanelStyle {
  text?: number;
  /** Optional label drop shadow; null keeps dark text on light buttons crisp. */
  textShadow?: number | null;
  hover?: number;
  pressedFill?: number;
  textScale?: number;
  font?: FontSpec | "pixel";
  skin?: ButtonSkin;
}

type ResolvedButtonStyle = Required<Omit<ButtonStyle, "font" | "skin">> & { font: FontSpec | "pixel"; skin?: ButtonSkin };

export class Button extends Control {
  text: string;
  /** Action name forwarded to `scene.onAction` when pressed. */
  action: string | null;
  onPressed: (() => void) | null = null;
  style: ResolvedButtonStyle;

  constructor(text: string, x: number, y: number, w: number, h: number, opts: { action?: string; onPress?: () => void; style?: ButtonStyle } = {}) {
    super(x, y);
    this.w = w;
    this.h = h;
    this.text = text;
    this.action = opts.action ?? null;
    this.onPressed = opts.onPress ?? null;
    const defaults = {
      fill: 0x1d1a33,
      fillAlpha: 0.95,
      border: 0x8a86b8,
      bevel: 0x0a0912,
      text: 0xf1ecff,
      textShadow: 0x000000,
      hover: 0x2b2750,
      pressedFill: 0x120f22,
      textScale: 1,
      font: "pixel",
    };
    const explicit = new Set(Object.keys(opts.style ?? {}).filter((key) => (opts.style as Record<string, unknown>)[key] !== undefined));
    const themed = new Set(["fill", "fillAlpha", "border", "bevel", "text", "hover", "pressedFill", "font", "skin"]);
    const values = { ...defaults, ...opts.style } as ResolvedButtonStyle;
    this.style = new Proxy(values, {
      get: (target, property, receiver) => {
        if (typeof property === "string" && themed.has(property) && !explicit.has(property)) {
          const theme = this.scene?.attachedApp?.theme;
          if (theme) return property === "font" ? theme.font : (theme.button as unknown as Record<string, unknown>)[property];
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        if (typeof property === "string") explicit.add(property);
        return Reflect.set(target, property, value, receiver);
      },
    });
  }

  override onPress(): void {
    this.onPressed?.();
    if (this.action && this.scene) this.scene.onAction(this.action, true);
  }

  override render(ctx: DrawContext): void {
    const s = this.style;
    const lit = (this.hovered || this.focused) && !this.disabled;
    const fill = this.disabled ? s.fill : this.pressed ? s.pressedFill : lit ? s.hover : s.fill;
    const dy = this.pressed ? 1 : 0;
    const skin = s.skin;
    const sprite = skin && (this.disabled ? skin.disabled ?? skin.normal : this.pressed ? skin.pressed ?? skin.hover ?? skin.normal : lit ? skin.hover ?? skin.normal : skin.normal);
    if (sprite) drawButtonSkin(ctx, sprite, this.w, this.h, skin?.inset ?? 8);
    else {
      ctx.rect(0, dy, this.w, this.h, fill, s.fillAlpha);
      if (s.bevel !== null) {
        ctx.rect(1, this.h - 2 + dy, this.w - 2, 1, s.bevel, 0.9);
        ctx.rect(this.w - 2, 1 + dy, 1, this.h - 2, s.bevel, 0.9);
      }
      if (s.border !== null) ctx.frame(0, dy, this.w, this.h, lit ? 0xf1ecff : s.border, 1, this.focused ? 2 : 1);
    }
    const color = this.disabled ? 0x777390 : s.text;
    if (s.font !== "pixel") {
      const m = ctx.renderer.measureText(this.text, s.font);
      ctx.text(this.text, Math.round(this.w / 2), Math.round((this.h - m.height) / 2) + dy, { color, font: s.font, align: "center", shadow: s.textShadow ?? undefined });
    } else {
      const tw = measureText(this.text, s.textScale);
      ctx.text(this.text, Math.round((this.w - tw) / 2), Math.round((this.h - 7 * s.textScale) / 2) + dy, { color, scale: s.textScale, shadow: s.textShadow ?? undefined });
    }
  }
}

/** A horizontal meter, for health or progress. */
export class Bar extends Node2D {
  value = 1;
  fill = 0x7fd36b;
  back = 0x1a1626;
  border: number | null = 0x000000;

  constructor(
    x: number,
    y: number,
    public w: number,
    public h: number,
  ) {
    super(x, y);
  }

  override render(ctx: DrawContext): void {
    ctx.rect(0, 0, this.w, this.h, this.back, 0.9);
    const inner = Math.round((this.w - 2) * Math.max(0, Math.min(1, this.value)));
    if (inner > 0) ctx.rect(1, 1, inner, this.h - 2, this.fill);
    if (this.border !== null) ctx.frame(0, 0, this.w, this.h, this.border);
  }
}

/**
 * Route one frame of pointer state to the controls under `root`. The topmost hit control
 * (last in draw order) receives hover, press and release.
 */
export function routePointer(root: Node2D, p: PointerSnapshot, controls: Control[] = root.findAllInDrawOrder(Control)): Control | null {
  let hit: Control | null = null;
  for (let i = controls.length - 1; i >= 0; i--) {
    if (controls[i].hitTest(p.x, p.y)) {
      hit = controls[i];
      break;
    }
  }
  for (const c of controls) {
    const over = c === hit;
    if (over && !c.hovered) {
      c.hovered = true;
      c.onEnter();
    } else if (!over && c.hovered) {
      c.hovered = false;
      c.onLeave();
    }
    if (over && p.justPressed) {
      c.pressed = true;
      c.onDown();
    }
    if (c.pressed && p.justReleased) {
      c.pressed = false;
      c.onUp(over);
      if (over) c.onPress();
    }
    if (c.pressed && !p.down) c.pressed = false;
  }
  return hit;
}
