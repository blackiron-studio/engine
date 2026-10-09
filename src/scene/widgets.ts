// More UI: text input, scroll containers, rich text, grids and tooltips. They follow the
// same rules as the rest of the UI layer: Controls receive pointer routing from the Scene,
// sizes are local, and looks fall back to the App's theme.

import { measureText as measurePixel } from "../art/font.ts";
import type { FontSpec, Mat } from "../render/types.ts";
import { matCompose, matMul } from "../render/types.ts";
import type { DrawContext } from "./draw.ts";
import { type LayoutBox, layoutBox, textBox } from "./layout.ts";
import { Node, Node2D } from "./node.ts";
import type { Theme } from "./theme.ts";
import { defaultTheme } from "./theme.ts";
import { Control } from "./ui.ts";

function themeOf(node: Node): Theme {
  return node.scene?.attachedApp?.theme ?? defaultTheme;
}

function measure(node: Node, text: string, font: FontSpec | "pixel"): number {
  if (font === "pixel") return measurePixel(text, 1);
  const r = node.scene?.attachedApp?.renderer;
  return r ? r.measureText(text, font).width : text.length * font.size * 0.56;
}

function lineHeightOf(node: Node, font: FontSpec | "pixel"): number {
  if (font === "pixel") return 9;
  const r = node.scene?.attachedApp?.renderer;
  return r ? r.measureText("Hg", font).height : font.size * 1.3;
}

// --- TextInput ---------------------------------------------------------------------------

export interface TextInputOptions {
  value?: string;
  placeholder?: string;
  maxLength?: number;
  font?: FontSpec | "pixel";
  /** Hide the characters. */
  password?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

const EDIT_KEYS = ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", "NumpadEnter", "Escape"];

/** A single-line text field. Press it to focus; the scene routes typed text and keys to it. */
export class TextInput extends Control {
  value: string;
  caret: number;
  placeholder: string;
  maxLength: number;
  font: FontSpec | "pixel";
  password: boolean;
  onChange: ((value: string) => void) | null;
  onSubmit: ((value: string) => void) | null;
  private blink = 0;

  constructor(x: number, y: number, w: number, h: number, opts: TextInputOptions = {}) {
    super(x, y);
    this.w = w;
    this.h = h;
    this.value = opts.value ?? "";
    this.caret = this.value.length;
    this.placeholder = opts.placeholder ?? "";
    this.maxLength = opts.maxLength ?? 64;
    this.font = opts.font ?? "pixel";
    this.password = opts.password ?? false;
    this.onChange = opts.onChange ?? null;
    this.onSubmit = opts.onSubmit ?? null;
  }

  override ready(): void {
    if (this.font === "pixel" && themeOf(this).font !== "pixel") this.font = themeOf(this).font;
  }

  override onPress(): void {
    this.focus();
  }

  focus(): void {
    const s = this.scene;
    if (!s) return;
    if (s.activeInput && s.activeInput !== this) s.activeInput.blur();
    s.activeInput = this;
    this.focused = true;
    this.blink = 0;
    s.attachedApp?.showKeyboard(true);
  }

  blur(): void {
    const s = this.scene;
    if (s && s.activeInput === this) s.activeInput = null;
    if (this.focused) s?.attachedApp?.showKeyboard(false);
    this.focused = false;
  }

  /** Insert typed text at the caret. */
  type(text: string): void {
    let clean = "";
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code !== 127) clean += ch;
    }
    if (!clean) return;
    const room = Math.max(0, this.maxLength - this.value.length);
    clean = [...clean].slice(0, room).join("");
    if (!clean) return;
    this.value = this.value.slice(0, this.caret) + clean + this.value.slice(this.caret);
    this.caret += clean.length;
    this.blink = 0;
    this.onChange?.(this.value);
  }

  /** Handle a key while focused; returns true when consumed. */
  key(code: string, down: boolean): boolean {
    if (!down) return EDIT_KEYS.includes(code) || isTypingKey(code);
    switch (code) {
      case "Backspace":
        if (this.caret > 0) {
          this.value = this.value.slice(0, this.caret - 1) + this.value.slice(this.caret);
          this.caret--;
          this.onChange?.(this.value);
        }
        break;
      case "Delete":
        if (this.caret < this.value.length) {
          this.value = this.value.slice(0, this.caret) + this.value.slice(this.caret + 1);
          this.onChange?.(this.value);
        }
        break;
      case "ArrowLeft":
        this.caret = Math.max(0, this.caret - 1);
        break;
      case "ArrowRight":
        this.caret = Math.min(this.value.length, this.caret + 1);
        break;
      case "Home":
        this.caret = 0;
        break;
      case "End":
        this.caret = this.value.length;
        break;
      case "Enter":
      case "NumpadEnter":
        this.onSubmit?.(this.value);
        break;
      case "Escape":
        this.blur();
        break;
      default:
        // Letters and digits arrive as text; swallow their key codes so they fire no actions.
        return isTypingKey(code);
    }
    this.blink = 0;
    return true;
  }

  override update(dt: number): void {
    this.blink += dt;
  }

  override render(ctx: DrawContext): void {
    const t = themeOf(this).input;
    ctx.rect(0, 0, this.w, this.h, t.fill, t.fillAlpha);
    const border = this.focused ? t.focusBorder : t.border;
    if (border !== null) ctx.frame(0, 0, this.w, this.h, border);
    const pad = Math.round(this.h * 0.25);
    const shown = this.password ? "*".repeat(this.value.length) : this.value;
    const lineH = lineHeightOf(this, this.font);
    const ty = Math.round((this.h - lineH) / 2);
    ctx.clip(1, 1, this.w - 2, this.h - 2);
    if (shown.length === 0 && this.placeholder && !this.focused) {
      ctx.text(this.placeholder, pad, ty, { font: this.font, color: t.placeholder });
    } else {
      // Keep the caret visible by scrolling long text left.
      const caretX = measure(this, shown.slice(0, this.caret), this.font);
      const shift = Math.max(0, caretX - (this.w - pad * 2));
      ctx.text(shown, pad - shift, ty, { font: this.font, color: t.text });
      if (this.focused && this.blink % 1 < 0.6) ctx.rect(pad - shift + caretX, ty, 1, lineH, t.caret);
    }
    ctx.unclip();
  }
}

function isTypingKey(code: string): boolean {
  return /^(Key|Digit|Numpad|Space|Minus|Equal|Bracket|Semicolon|Quote|Comma|Period|Slash|Backslash|Backquote|IntlBackslash)/.test(code);
}

// --- ScrollContainer ---------------------------------------------------------------------

export interface ScrollOptions {
  direction?: "vertical" | "horizontal" | "both";
  /** Content extent; measured from the children when omitted. */
  contentWidth?: number;
  contentHeight?: number;
  scrollbar?: boolean;
  /** Pixels per wheel unit. */
  wheelSpeed?: number;
}

/**
 * Clips and scrolls its `content`. Add children to `content`; scroll with the wheel, by
 * dragging, or by setting `scrollX` / `scrollY`. Controls inside stay clickable only while
 * visible.
 */
export class ScrollContainer extends Control {
  readonly content = new Node2D();
  scrollX = 0;
  scrollY = 0;
  direction: "vertical" | "horizontal" | "both";
  contentWidth: number | null;
  contentHeight: number | null;
  scrollbar: boolean;
  wheelSpeed: number;
  /** Marker for Control.hitTest: children outside the box are not hit. */
  readonly clipsChildren = true;
  private dragX = 0;
  private dragY = 0;
  private dragging = false;
  private velocityY = 0;
  private velocityX = 0;

  constructor(x: number, y: number, w: number, h: number, opts: ScrollOptions = {}) {
    super(x, y);
    this.w = w;
    this.h = h;
    this.direction = opts.direction ?? "vertical";
    this.contentWidth = opts.contentWidth ?? null;
    this.contentHeight = opts.contentHeight ?? null;
    this.scrollbar = opts.scrollbar ?? true;
    this.wheelSpeed = opts.wheelSpeed ?? 1;
    this.add(this.content);
  }

  /** Content extent from explicit sizes or the children's positions and sizes. */
  measureContent(): [number, number] {
    let w = this.contentWidth ?? 0;
    let h = this.contentHeight ?? 0;
    if (this.contentWidth === null || this.contentHeight === null) {
      for (const c of this.content.children) {
        if (!(c instanceof Node2D)) continue;
        const box = layoutBox(c);
        if (this.contentWidth === null) w = Math.max(w, c.x + box.w - box.ox);
        if (this.contentHeight === null) h = Math.max(h, c.y + box.h - box.oy);
      }
    }
    return [w, h];
  }

  get maxScrollX(): number {
    return Math.max(0, this.measureContent()[0] - this.w);
  }

  get maxScrollY(): number {
    return Math.max(0, this.measureContent()[1] - this.h);
  }

  /** Whether a screen point is inside the box, for children hit-testing. */
  containsScreenPoint(sx: number, sy: number): boolean {
    const [lx, ly] = this.localPointNow(sx, sy);
    return lx >= 0 && ly >= 0 && lx < this.w && ly < this.h;
  }

  scrollTo(x: number, y: number): void {
    this.scrollX = Math.max(0, Math.min(this.maxScrollX, Number.isFinite(x) ? x : 0));
    this.scrollY = Math.max(0, Math.min(this.maxScrollY, Number.isFinite(y) ? y : 0));
    // Pointer routing can run before the next draw; keep the content transform current.
    this.content.x = -Math.round(this.scrollX);
    this.content.y = -Math.round(this.scrollY);
  }

  override onDown(): void {
    const p = this.scene?.attachedApp?.pointer;
    if (!p) return;
    this.dragging = true;
    this.dragX = p.x;
    this.dragY = p.y;
    this.velocityX = 0;
    this.velocityY = 0;
  }

  override onUp(): void {
    this.dragging = false;
  }

  override update(dt: number): void {
    const app = this.scene?.attachedApp;
    if (!app) return;
    const p = app.pointer;
    const vertical = this.direction !== "horizontal";
    const horizontal = this.direction !== "vertical";
    // The pointer counts as over the box even when a child control has the hover.
    const inside = this.containsScreenPoint(p.x, p.y);
    if (inside && p.wheel !== 0) {
      if (vertical) this.scrollY += p.wheel * this.wheelSpeed;
      else this.scrollX += p.wheel * this.wheelSpeed;
    }
    if (p.justPressed && inside && !this.dragging) {
      this.dragging = true;
      this.dragX = p.x;
      this.dragY = p.y;
      this.velocityX = 0;
      this.velocityY = 0;
    }
    if (this.dragging && p.down) {
      const dx = p.x - this.dragX;
      const dy = p.y - this.dragY;
      this.dragX = p.x;
      this.dragY = p.y;
      if (horizontal) this.scrollX -= dx;
      if (vertical) this.scrollY -= dy;
      if (dt > 0) {
        this.velocityX = -dx / dt;
        this.velocityY = -dy / dt;
      }
    } else if (!p.down) {
      this.dragging = false;
      if (Math.abs(this.velocityY) > 1 || Math.abs(this.velocityX) > 1) {
        if (horizontal) this.scrollX += this.velocityX * dt;
        if (vertical) this.scrollY += this.velocityY * dt;
        const decay = Math.max(0, 1 - 6 * dt);
        this.velocityX *= decay;
        this.velocityY *= decay;
      }
    }
    this.scrollTo(this.scrollX, this.scrollY);
  }

  override drawTree(ctx: DrawContext): void {
    if (!this.visible) return;
    const parentT = ctx.transform;
    const parentA = ctx.alpha;
    const saved: Mat = [parentT[0], parentT[1], parentT[2], parentT[3], parentT[4], parentT[5]];
    const local: Mat = [1, 0, 0, 1, 0, 0];
    matCompose(local, this.x, this.y, this.scaleX, this.scaleY, this.rotation);
    matMul(this.world, parentT, local);
    this.worldAlpha = parentA * this.alpha;
    ctx.setTransform(this.world, this.worldAlpha);
    this.render(ctx);
    this.content.x = -Math.round(this.scrollX);
    this.content.y = -Math.round(this.scrollY);
    ctx.clip(0, 0, this.w, this.h);
    this.content.drawTree(ctx);
    ctx.setTransform(this.world, this.worldAlpha);
    ctx.unclip();
    if (this.scrollbar) this.drawScrollbar(ctx);
    ctx.setTransform(saved, parentA);
  }

  private drawScrollbar(ctx: DrawContext): void {
    const t = themeOf(this).scrollbar;
    const [cw, ch] = this.measureContent();
    if (this.direction !== "horizontal" && ch > this.h) {
      const thumbH = Math.max(12, (this.h * this.h) / ch);
      const y = (this.scrollY / Math.max(1, ch - this.h)) * (this.h - thumbH);
      ctx.rect(this.w - t.width, 0, t.width, this.h, t.track, 0.6);
      ctx.rect(this.w - t.width, y, t.width, thumbH, t.thumb);
    }
    if (this.direction !== "vertical" && cw > this.w) {
      const thumbW = Math.max(12, (this.w * this.w) / cw);
      const x = (this.scrollX / Math.max(1, cw - this.w)) * (this.w - thumbW);
      ctx.rect(0, this.h - t.width, this.w, t.width, t.track, 0.6);
      ctx.rect(x, this.h - t.width, thumbW, t.width, t.thumb);
    }
  }
}

// --- RichText ----------------------------------------------------------------------------

export interface RichTextOptions {
  font?: FontSpec | "pixel";
  color?: number;
  /** Wrap width in units; 0 for none. */
  wrap?: number;
  align?: "left" | "center" | "right";
  lineSpacing?: number;
  shadow?: number | null;
}

interface Run {
  text: string;
  color: number;
  bold: boolean;
  italic: boolean;
  icon: string | null;
  width: number;
}

interface Line {
  runs: Run[];
  width: number;
}

/**
 * Text with inline markup: `[color=#ff8800]...[/color]`, `[b]...[/b]`, `[i]...[/i]`,
 * `[icon=sprite]`, and line breaks. Wraps at `wrap` units.
 */
export class RichText extends Node2D {
  font: FontSpec | "pixel";
  color: number;
  wrap: number;
  align: "left" | "center" | "right";
  lineSpacing: number;
  shadow: number | null;
  private _markup = "";
  private lines: Line[] = [];
  private lineH = 9;
  private dirty = true;

  constructor(markup: string, x = 0, y = 0, opts: RichTextOptions = {}) {
    super(x, y);
    this.font = opts.font ?? "pixel";
    this.color = opts.color ?? 0xffffff;
    this.wrap = opts.wrap ?? 0;
    this.align = opts.align ?? "left";
    this.lineSpacing = opts.lineSpacing ?? 1.2;
    this.shadow = opts.shadow ?? null;
    this._markup = markup;
  }

  get markup(): string {
    return this._markup;
  }

  set markup(v: string) {
    if (v === this._markup) return;
    this._markup = v;
    this.dirty = true;
  }

  get width(): number {
    this.layout();
    return Math.max(0, ...this.lines.map((l) => l.width));
  }

  get height(): number {
    this.layout();
    return this.lines.length * this.lineH * this.lineSpacing;
  }

  /** Lines after wrapping, for tests and layout. */
  get lineCount(): number {
    this.layout();
    return this.lines.length;
  }

  /** The box containers place: centred and right-aligned text draws around its origin. */
  layoutBox(): LayoutBox {
    return textBox(this.width, this.height, this.align);
  }

  override ready(): void {
    if (this.font === "pixel" && themeOf(this).font !== "pixel") this.font = themeOf(this).font;
    this.dirty = true;
  }

  private fontFor(bold: boolean, italic: boolean): FontSpec | "pixel" {
    if (this.font === "pixel") return "pixel";
    const base = typeof this.font.weight === "number" ? this.font.weight : this.font.weight === "bold" ? 700 : 400;
    return { ...this.font, weight: bold ? Math.max(700, base) : base, style: italic ? "italic" : this.font.style };
  }

  /** Parse markup into styled words, then wrap them into lines. */
  private layout(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lineH = lineHeightOf(this, this.font);
    const tokens = this._markup.split(/(\[\/?[a-z]+(?:=[^\]]+)?\]|\n)/g);
    const colors: number[] = [];
    let bold = 0;
    let italic = 0;
    const words: (Run | "\n")[] = [];
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok === "\n") {
        words.push("\n");
        continue;
      }
      const tag = /^\[(\/?)([a-z]+)(?:=([^\]]+))?\]$/.exec(tok);
      if (tag) {
        const [, close, name, arg] = tag;
        if (name === "color") {
          if (close) colors.pop();
          else colors.push(parseColor(arg ?? "", this.color));
        } else if (name === "b") bold += close ? -1 : 1;
        else if (name === "i") italic += close ? -1 : 1;
        else if (name === "icon" && arg) words.push({ text: "", color: 0xffffff, bold: false, italic: false, icon: arg, width: this.lineH });
        continue;
      }
      const color = colors[colors.length - 1] ?? this.color;
      const style = { color, bold: bold > 0, italic: italic > 0, icon: null };
      for (const piece of tok.split(/(\s+)/)) {
        if (!piece) continue;
        words.push({ text: piece, ...style, width: measure(this, piece, this.fontFor(style.bold, style.italic)) });
      }
    }
    const lines: Line[] = [];
    let line: Line = { runs: [], width: 0 };
    const flush = () => {
      // Drop trailing whitespace from the line width.
      while (line.runs.length && /^\s+$/.test(line.runs[line.runs.length - 1].text)) line.width -= line.runs.pop()?.width ?? 0;
      lines.push(line);
      line = { runs: [], width: 0 };
    };
    for (const w of words) {
      if (w === "\n") {
        flush();
        continue;
      }
      const isSpace = /^\s+$/.test(w.text);
      if (this.wrap > 0 && line.width + w.width > this.wrap && line.runs.length && !isSpace) flush();
      if (isSpace && line.runs.length === 0) continue;
      line.runs.push(w);
      line.width += w.width;
    }
    flush();
    this.lines = lines;
  }

  override render(ctx: DrawContext): void {
    this.layout();
    const step = this.lineH * this.lineSpacing;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      let x = this.align === "center" ? -line.width / 2 : this.align === "right" ? -line.width : 0;
      const y = i * step;
      for (const run of line.runs) {
        if (run.icon) {
          const r = ctx.region(run.icon);
          const s = this.lineH / Math.max(1, r.h);
          ctx.sprite(run.icon, x, y, { sx: s, sy: s, ox: 0, oy: 0 });
        } else if (run.text.trim()) {
          ctx.text(run.text, x, y, { font: this.fontFor(run.bold, run.italic), color: run.color, shadow: this.shadow });
        }
        x += run.width;
      }
    }
  }
}

function parseColor(v: string, fallback: number): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (m) return parseInt(m[1], 16);
  const named: Record<string, number> = { white: 0xffffff, black: 0x000000, red: 0xe0574a, green: 0x5ac46a, blue: 0x4ab0e0, yellow: 0xffc857, orange: 0xff9040, purple: 0xb060e0, gray: 0x9a96b8, grey: 0x9a96b8 };
  return named[v.trim().toLowerCase()] ?? fallback;
}

// --- Grid --------------------------------------------------------------------------------

export interface GridOptions {
  cols: number;
  gap?: number;
  /** Cell size; measured from the largest child when omitted. */
  cellWidth?: number;
  cellHeight?: number;
}

/** Lays children out in rows of `cols`. Call `layout()` after adding them. */
export class Grid extends Node2D {
  cols: number;
  gap: number;
  cellWidth: number | null;
  cellHeight: number | null;
  w = 0;
  h = 0;

  constructor(opts: GridOptions, x = 0, y = 0) {
    super(x, y);
    this.cols = Math.max(1, opts.cols);
    this.gap = opts.gap ?? 8;
    this.cellWidth = opts.cellWidth ?? null;
    this.cellHeight = opts.cellHeight ?? null;
  }

  layout(): this {
    const kids = this.children.filter((c): c is Node2D => c instanceof Node2D);
    const boxes = kids.map((c) => layoutBox(c));
    let cw = this.cellWidth ?? 0;
    let ch = this.cellHeight ?? 0;
    for (const box of boxes) {
      if (this.cellWidth === null) cw = Math.max(cw, box.w);
      if (this.cellHeight === null) ch = Math.max(ch, box.h);
    }
    kids.forEach((c, i) => {
      c.x = (i % this.cols) * (cw + this.gap) + boxes[i].ox;
      c.y = Math.floor(i / this.cols) * (ch + this.gap) + boxes[i].oy;
    });
    const rows = Math.ceil(kids.length / this.cols);
    this.w = kids.length ? Math.min(this.cols, kids.length) * (cw + this.gap) - this.gap : 0;
    this.h = rows ? rows * (ch + this.gap) - this.gap : 0;
    return this;
  }
}

// --- Tooltip -----------------------------------------------------------------------------

export interface TooltipOptions {
  delay?: number;
  font?: FontSpec | "pixel";
  /** Above (default) or below the target. */
  side?: "above" | "below";
}

/** A label that appears near a control after hovering it (or holding it, on touch). */
export class Tooltip extends Node2D {
  text: string;
  delay: number;
  font: FontSpec | "pixel";
  side: "above" | "below";
  private timer = 0;
  private shown = false;

  constructor(
    readonly target: Control,
    text: string,
    opts: TooltipOptions = {},
  ) {
    super();
    this.text = text;
    this.delay = opts.delay ?? 0.45;
    this.font = opts.font ?? "pixel";
    this.side = opts.side ?? "above";
    this.zIndex = 1000;
  }

  override ready(): void {
    if (this.font === "pixel" && themeOf(this).font !== "pixel") this.font = themeOf(this).font;
  }

  get visibleNow(): boolean {
    return this.shown;
  }

  override update(dt: number): void {
    const t = this.target;
    if ((t.hovered && !t.pressed) || (t.pressed && this.scene?.attachedApp?.pointer.type === "touch")) this.timer += dt;
    else this.timer = 0;
    this.shown = this.timer >= this.delay && t.visible;
  }

  override render(ctx: DrawContext): void {
    if (!this.shown || !this.parent) return;
    const t = themeOf(this).tooltip;
    const lineH = lineHeightOf(this, this.font);
    const pad = 6;
    const w = measure(this, this.text, this.font) + pad * 2;
    const h = lineH + pad * 2;
    const parent = this.parent as Node2D;
    const [tx, ty] = this.target.positionIn(parent);
    let x = Math.round(tx + this.target.w / 2 - w / 2);
    let y = this.side === "above" ? Math.round(ty - h - 6) : Math.round(ty + this.target.h + 6);
    x = Math.max(4, Math.min(ctx.width - w - 4, x));
    y = Math.max(4, Math.min(ctx.height - h - 4, y));
    ctx.rect(x - this.x, y - this.y, w, h, t.fill, 0.95);
    if (t.border !== null) ctx.frame(x - this.x, y - this.y, w, h, t.border);
    ctx.text(this.text, x - this.x + pad, y - this.y + pad, { font: this.font, color: t.text });
  }
}

// --- Slider ------------------------------------------------------------------------------

export interface SliderOptions {
  value?: number;
  min?: number;
  max?: number;
  /** Rounding for values; 0 for continuous. */
  step?: number;
  label?: string;
  /** Shared label-column width for a group of sliders; keeps their tracks aligned. */
  labelWidth?: number;
  /** Text for the value on the right; a percentage by default. */
  format?: (value: number) => string;
  onChange?: (value: number) => void;
  font?: FontSpec | "pixel";
}

/** A horizontal slider: drag or click the track, or nudge with left and right while focused. */
export class Slider extends Control {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  labelWidth: number | null;
  format: (value: number) => string;
  onChange: ((value: number) => void) | null;
  private fontOverride: FontSpec | "pixel" | null;

  get font(): FontSpec | "pixel" { return this.fontOverride ?? themeOf(this).font; }
  set font(value: FontSpec | "pixel") { this.fontOverride = value; }

  constructor(x: number, y: number, w: number, h: number, opts: SliderOptions = {}) {
    super(x, y);
    this.w = w;
    this.h = h;
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 1;
    this.step = opts.step ?? 0;
    this.value = opts.value ?? this.min;
    this.label = opts.label ?? "";
    this.labelWidth = opts.labelWidth ?? null;
    this.format = opts.format ?? ((v) => `${Math.round(((v - this.min) / Math.max(1e-9, this.max - this.min)) * 100)}%`);
    this.onChange = opts.onChange ?? null;
    this.fontOverride = opts.font ?? null;
  }

  /** The track's horizontal extent inside the control, after the label. */
  private track(): { x: number; w: number } {
    // Render and pointer handling must use identical geometry. Previously clicks used a
    // 40%-width guess while rendering measured each label, shifting the clicked value.
    const labelW = this.label ? Math.min(this.w - 76, this.labelWidth ?? measure(this, this.label, this.font) + 12) : 0;
    const valueW = 56;
    return { x: labelW, w: Math.max(20, this.w - labelW - valueW) };
  }

  private setValue(v: number): void {
    v = Math.max(this.min, Math.min(this.max, v));
    if (this.step > 0) v = this.min + Math.round((v - this.min) / this.step) * this.step;
    v = Math.round(v * 1e6) / 1e6;
    if (v === this.value) return;
    this.value = v;
    this.onChange?.(v);
  }

  private setFromPointer(): void {
    const s = this.scene;
    if (!s) return;
    const p = s.app.pointer;
    const [lx] = this.localPointNow(p.x, p.y);
    const t = this.track();
    this.setValue(this.min + ((lx - t.x) / t.w) * (this.max - this.min));
  }

  override onPress(): void {
    this.setFromPointer();
  }

  override update(): void {
    if (this.pressed) this.setFromPointer();
  }

  /** Move by one step (a tenth of the range without one), for keyboards and controllers. */
  nudge(direction: -1 | 1): void {
    const step = this.step > 0 ? this.step : (this.max - this.min) / 10;
    this.setValue(this.value + direction * step);
  }

  override render(ctx: DrawContext): void {
    const theme = themeOf(this);
    const t = this.track();
    const lineH = lineHeightOf(this, this.font);
    const ty = Math.round((this.h - lineH) / 2);
    if (this.label) ctx.text(this.label, 0, ty, { font: this.font, color: this.disabled ? theme.muted : theme.text });
    const barH = Math.max(4, Math.round(this.h * 0.28));
    const by = Math.round((this.h - barH) / 2);
    const frac = (this.value - this.min) / Math.max(1e-9, this.max - this.min);
    ctx.rect(t.x, by, t.w, barH, theme.input.fill, theme.input.fillAlpha);
    ctx.rect(t.x, by, Math.round(t.w * frac), barH, theme.accent, this.disabled ? 0.4 : 0.9);
    ctx.frame(t.x, by, t.w, barH, this.focused || this.hovered ? theme.input.focusBorder : theme.input.border ?? theme.muted);
    const knob = Math.round(barH * 1.6);
    ctx.rect(Math.round(t.x + t.w * frac - knob / 2), Math.round((this.h - knob) / 2), knob, knob, this.focused ? theme.accent : theme.button.text);
    const text = this.format(this.value);
    const tw = measure(this, text, this.font);
    ctx.text(text, this.w - tw, ty, { font: this.font, color: theme.muted });
  }
}
