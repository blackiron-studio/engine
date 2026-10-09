// UI layout helpers: anchoring to screen edges (so UI holds at any aspect ratio),
// simple row and column containers, and keyboard focus for menus.

import type { DrawContext } from "./draw.ts";
import { Node, Node2D } from "./node.ts";
import { Control } from "./ui.ts";

export type AnchorX = "left" | "center" | "right";
export type AnchorY = "top" | "center" | "bottom";

export interface AnchorOptions {
  x?: AnchorX;
  y?: AnchorY;
  /** Offset from the anchor point in logical units. */
  dx?: number;
  dy?: number;
  /** Size of the anchored box, so "right" and "bottom" align its far edge. */
  w?: number;
  h?: number;
  /** Keep this far from the edges, for notches and rounded corners. */
  safe?: number;
}

/**
 * A group positioned relative to the screen. Children are laid out in the group's own
 * space, so a HUD corner or a centred menu moves as one when the viewport changes.
 */
export class Anchor extends Node2D {
  ax: AnchorX;
  ay: AnchorY;
  dx: number;
  dy: number;
  w: number;
  h: number;
  safe: number;

  constructor(opts: AnchorOptions = {}) {
    super();
    this.ax = opts.x ?? "left";
    this.ay = opts.y ?? "top";
    this.dx = opts.dx ?? 0;
    this.dy = opts.dy ?? 0;
    this.w = opts.w ?? 0;
    this.h = opts.h ?? 0;
    this.safe = opts.safe ?? 0;
  }

  /** Recompute the position from the scene's size. Called each frame; cheap. */
  place(width: number, height: number): void {
    const scene = this.scene;
    if (scene) {
      for (let p: Node | null = this; p; p = p.parent) {
        if (p === scene.ui) { width = scene.uiWidth; height = scene.uiHeight; break; }
      }
    }
    this.x = this.ax === "left" ? this.safe + this.dx : this.ax === "right" ? width - this.safe - this.w + this.dx : Math.round((width - this.w) / 2) + this.dx;
    this.y = this.ay === "top" ? this.safe + this.dy : this.ay === "bottom" ? height - this.safe - this.h + this.dy : Math.round((height - this.h) / 2) + this.dy;
  }

  override ready(): void {
    const s = this.scene;
    if (s) this.place(s.width, s.height);
  }

  override update(): void {
    const s = this.scene;
    if (s) this.place(s.width, s.height);
  }

  override drawTree(ctx: DrawContext): void {
    this.place(ctx.width, ctx.height);
    super.drawTree(ctx);
  }
}

/** The box a node occupies in a container, and where the node's own origin sits inside it. */
export interface LayoutBox {
  w: number;
  h: number;
  /** Offset of the node's origin from the box's left and top edges. */
  ox: number;
  oy: number;
}

/**
 * The box a child reports for layout. Nodes that know better implement `layoutBox()`:
 * text aligned "center" or "right" draws around its origin, and containers with an
 * `origin` sit around theirs. Otherwise controls and panels have w/h, labels have width.
 */
export function layoutBox(n: Node): LayoutBox {
  if (n instanceof Row || n instanceof Column) n.layout();
  const o = n as unknown as { layoutBox?: () => LayoutBox; w?: number; h?: number; width?: number; height?: number; textHeight?: number };
  if (typeof o.layoutBox === "function") return o.layoutBox();
  const w = o.w ?? o.width ?? 0;
  const h = o.h ?? o.textHeight ?? o.height ?? 0;
  return { w, h, ox: 0, oy: 0 };
}

/** Where text sits relative to its origin for each alignment. */
export function textBox(w: number, h: number, align: "left" | "center" | "right"): LayoutBox {
  return { w, h, ox: align === "center" ? w / 2 : align === "right" ? w : 0, oy: 0 };
}

export type Origin = "start" | "center" | "end";

export interface StackOptions {
  gap?: number;
  /** Cross-axis alignment of the children. */
  align?: Origin;
  /**
   * Where the container's own origin sits in its box. "center" makes a stack self-centring,
   * so under a centred Anchor it needs no offsets.
   */
  origin?: Origin;
  /** Re-run layout every frame (default), so text that reflows or children added later stay placed. */
  auto?: boolean;
  /** Lay children out from the end: a Row runs right to left, for right-to-left locales. */
  reverse?: boolean;
}

function fraction(o: Origin): number {
  return o === "start" ? 0 : o === "end" ? 1 : 0.5;
}

/** Shared placement for rows and columns; `main` is the axis children stack along. */
abstract class Stack extends Node2D {
  gap: number;
  align: Origin;
  origin: Origin;
  auto: boolean;
  reverse: boolean;
  w = 0;
  h = 0;

  constructor(opts: StackOptions, x: number, y: number) {
    super(x, y);
    this.gap = opts.gap ?? 8;
    this.align = opts.align ?? "start";
    this.origin = opts.origin ?? "start";
    this.auto = opts.auto ?? true;
    this.reverse = opts.reverse ?? false;
  }

  protected abstract main: "x" | "y";

  /** Place every child. Called for you each frame unless `auto` is false. */
  layout(): this {
    const boxes = this.children.map((c) => layoutBox(c));
    const cross = this.main === "x" ? "h" : "w";
    const along = this.main === "x" ? "w" : "h";
    let extent = 0;
    for (const b of boxes) extent = Math.max(extent, b[cross]);
    let pos = 0;
    const f = fraction(this.align);
    const order = this.children.map((_, i) => i);
    if (this.reverse) order.reverse();
    for (const i of order) {
      const c = this.children[i];
      const b = boxes[i];
      if (c instanceof Node2D) {
        // Round the origin's final position, so odd-width text still lands on a whole pixel.
        const side = (extent - b[cross]) * f;
        if (this.main === "x") {
          c.x = Math.round(pos + b.ox);
          c.y = Math.round(side + b.oy);
        } else {
          c.y = Math.round(pos + b.oy);
          c.x = Math.round(side + b.ox);
        }
      }
      pos += b[along] + this.gap;
    }
    const total = Math.max(0, pos - this.gap);
    if (this.main === "x") {
      this.w = total;
      this.h = extent;
    } else {
      this.w = extent;
      this.h = total;
    }
    // Shift everything so the container's origin lands where `origin` says.
    const sx = Math.round(this.w * fraction(this.origin));
    const sy = Math.round(this.h * fraction(this.origin));
    if (sx || sy) {
      for (const c of this.children) {
        if (c instanceof Node2D) {
          c.x -= sx;
          c.y -= sy;
        }
      }
    }
    return this;
  }

  layoutBox(): LayoutBox {
    return { w: this.w, h: this.h, ox: Math.round(this.w * fraction(this.origin)), oy: Math.round(this.h * fraction(this.origin)) };
  }

  override ready(): void {
    this.layout();
  }

  override drawTree(ctx: DrawContext): void {
    if (this.auto) this.layout();
    super.drawTree(ctx);
  }
}

/** Lays children out left to right. */
export class Row extends Stack {
  protected main = "x" as const;

  constructor(opts: StackOptions = {}, x = 0, y = 0) {
    super(opts, x, y);
  }
}

/** Lays children out top to bottom. */
export class Column extends Stack {
  protected main = "y" as const;

  constructor(opts: StackOptions = {}, x = 0, y = 0) {
    super(opts, x, y);
  }
}

/**
 * Keyboard and gamepad focus for a list of controls. Feed it the scene's actions:
 * `focus.onAction(name, pressed)` with "up", "down" and "confirm".
 */
export class FocusGroup {
  index = -1;

  constructor(
    public items: Control[] = [],
    public wrap = true,
  ) {}

  get current(): Control | null {
    const control = this.items[this.index];
    return control && this.usable(control) ? control : null;
  }

  private usable(control: Control): boolean {
    if (control.disabled) return false;
    for (let node: Node | null = control; node; node = node.parent) {
      if (!node.visible || (node instanceof Control && node.disabled)) return false;
    }
    return true;
  }

  /** Read the focused control's text through the screen reader when one is on. */
  announce = true;

  set(i: number): void {
    for (const c of this.items) c.focused = false;
    this.index = -1;
    if (i < 0 || i >= this.items.length) return;
    for (let step = 0; step < this.items.length; step++) {
      const candidate = (i + step) % this.items.length;
      if (this.usable(this.items[candidate])) { this.index = candidate; break; }
    }
    const c = this.current;
    if (c) {
      c.focused = true;
      const label = (c as { text?: string; label?: string }).text ?? (c as { label?: string }).label;
      if (this.announce && label && c.scene) c.scene.app.accessibility.announce(label);
    }
  }

  move(dir: 1 | -1): void {
    if (this.items.length === 0) return;
    let i = this.index < 0 ? (dir > 0 ? -1 : this.items.length) : this.index;
    for (let step = 0; step < this.items.length; step++) {
      i += dir;
      if (i < 0 || i >= this.items.length) {
        if (!this.wrap) return;
        i = (i + this.items.length) % this.items.length;
      }
      if (this.usable(this.items[i])) { this.set(i); return; }
    }
  }

  /** Returns true when the action was consumed. */
  onAction(name: string, pressed: boolean): boolean {
    if (!pressed) return false;
    if (name === "down" || name === "next") {
      this.move(1);
      return true;
    }
    if (name === "up" || name === "prev") {
      this.move(-1);
      return true;
    }
    if (name === "confirm" && this.current) {
      this.current.onPress();
      return true;
    }
    return false;
  }
}


/** Padding around one child; its box is the child's plus the margins. */
export class Margin extends Node2D {
  constructor(
    public pad: number | { top: number; right: number; bottom: number; left: number } = 8,
    x = 0,
    y = 0,
  ) {
    super(x, y);
  }

  private get pads(): { top: number; right: number; bottom: number; left: number } {
    return typeof this.pad === "number" ? { top: this.pad, right: this.pad, bottom: this.pad, left: this.pad } : this.pad;
  }

  layout(): this {
    const p = this.pads;
    for (const c of this.children) {
      if (c instanceof Node2D) {
        const b = layoutBox(c);
        c.x = p.left + b.ox;
        c.y = p.top + b.oy;
      }
    }
    return this;
  }

  layoutBox(): LayoutBox {
    const p = this.pads;
    let w = 0;
    let h = 0;
    for (const c of this.children) {
      const b = layoutBox(c);
      w = Math.max(w, b.w);
      h = Math.max(h, b.h);
    }
    return { w: w + p.left + p.right, h: h + p.top + p.bottom, ox: 0, oy: 0 };
  }

  override ready(): void {
    this.layout();
  }

  override drawTree(ctx: DrawContext): void {
    this.layout();
    super.drawTree(ctx);
  }
}

/** Shows one child at a time; `show(index)` or `show(name)` switches. Its box is the largest child's. */
export class Pages extends Node2D {
  private current = 0;

  get index(): number {
    return this.current;
  }

  show(which: number | string): void {
    const i = typeof which === "number" ? which : this.children.findIndex((c) => c.name === which);
    if (i < 0 || i >= this.children.length) return;
    this.current = i;
    this.children.forEach((c, k) => {
      c.visible = k === i;
    });
  }

  override ready(): void {
    this.show(this.current);
  }

  layoutBox(): LayoutBox {
    let w = 0;
    let h = 0;
    for (const c of this.children) {
      const b = layoutBox(c);
      w = Math.max(w, b.w);
      h = Math.max(h, b.h);
    }
    return { w, h, ox: 0, oy: 0 };
  }
}

/**
 * A row of buttons over a Pages: pressing a tab shows its page. `tabs.add(label, page)` builds
 * both; the focus group moves along the tabs with left and right.
 */
export class Tabs extends Column {
  readonly bar: Row;
  readonly pages: Pages;
  readonly focus = new FocusGroup([], true);
  private readonly buttons: Control[] = [];
  onChange: ((index: number, name: string) => void) | null = null;

  constructor(
    private readonly makeButton: (label: string, onPress: () => void) => Control,
    opts: StackOptions = {},
    x = 0,
    y = 0,
  ) {
    super(opts, x, y);
    this.bar = this.add(new Row({ gap: opts.gap ?? 8 }));
    this.pages = this.add(new Pages());
  }

  /** Add a tab; the page is named after the label. */
  tab(label: string, page: Node2D): this {
    const index = this.buttons.length;
    page.name = label;
    const button = this.bar.add(this.makeButton(label, () => this.select(index)));
    this.buttons.push(button);
    this.focus.items = this.buttons;
    this.pages.add(page);
    // Only the selected page shows; a page added later starts hidden.
    this.pages.show(this.pages.index);
    if (index === 0) this.focus.set(0);
    return this;
  }

  get selected(): number {
    return this.pages.index;
  }

  select(index: number): void {
    this.pages.show(index);
    this.focus.set(index);
    this.onChange?.(index, this.pages.children[index]?.name ?? "");
  }

  /** Left and right move between tabs; returns true when consumed. */
  onAction(name: string, pressed: boolean): boolean {
    if (!pressed) return false;
    if (name === "left" || name === "prev") {
      this.select((this.selected + this.buttons.length - 1) % this.buttons.length);
      return true;
    }
    if (name === "right" || name === "next") {
      this.select((this.selected + 1) % this.buttons.length);
      return true;
    }
    return false;
  }
}
