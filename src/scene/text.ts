import { FONT_ADVANCE, FONT_LINE, measureText } from "../art/font.ts";
import type { FontSpec } from "../render/types.ts";
import type { DrawContext } from "./draw.ts";
import { type LayoutBox, textBox } from "./layout.ts";
import { Node2D } from "./node.ts";

export interface LabelOptions {
  color?: number;
  /** Bitmap font scale. */
  scale?: number;
  align?: "left" | "center" | "right";
  shadow?: number | null;
  additive?: boolean;
  /** Wrap words to this pixel width. */
  wrap?: number;
  /** A web font, or "pixel" (default) for the built-in bitmap font. */
  font?: FontSpec | "pixel";
}

/** A line or paragraph of text, bitmap or web font. */
export class Label extends Node2D {
  private colorOverride: number | undefined;
  private fontOverride: FontSpec | "pixel" | undefined;
  private measuredFont: FontSpec | "pixel" | null = null;
  get color(): number { return this.colorOverride ?? this.scene?.attachedApp?.theme.text ?? 0xffffff; }
  set color(value: number) { this.colorOverride = value; }
  get font(): FontSpec | "pixel" { return this.fontOverride ?? this.scene?.attachedApp?.theme.font ?? "pixel"; }
  set font(value: FontSpec | "pixel") { this.fontOverride = value; this.reflow(); }
  scale2 = 1;
  align: "left" | "center" | "right";
  shadow: number | null;
  additive: boolean;
  wrap: number;
  private _text = "";
  private lines: string[] = [];
  private measured = 0;

  constructor(text: string, x = 0, y = 0, opts: LabelOptions = {}) {
    super(x, y);
    if (opts.color !== undefined) this.color = opts.color;
    this.scale2 = opts.scale ?? 1;
    this.align = opts.align ?? "left";
    this.shadow = opts.shadow ?? null;
    this.additive = opts.additive ?? false;
    this.wrap = opts.wrap ?? 0;
    if (opts.font !== undefined) this.font = opts.font;
    this.text = text;
  }

  get text(): string {
    return this._text;
  }

  set text(v: string) {
    if (v === this._text && this.lines.length) return;
    this._text = v;
    this.reflow();
  }

  private measureLine(line: string): number {
    if (this.font !== "pixel") {
      const r = this.scene?.app.renderer;
      return r ? r.measureText(line, this.font).width : line.length * this.font.size * 0.56;
    }
    return measureText(line, this.scale2);
  }

  private reflow(): void {
    this.measuredFont = this.font;
    this.lines = this.wrap > 0 ? wrapText(this._text, this.wrap, (l) => this.measureLine(l)) : this._text.split("\n");
    this.measured = 0;
    for (const l of this.lines) this.measured = Math.max(this.measured, this.measureLine(l));
  }

  /** Text scale, separate from the node's transform scale so hit boxes stay simple. */
  get textScale(): number {
    return this.scale2;
  }

  set textScale(v: number) {
    this.scale2 = v;
    this.reflow();
  }

  /** Width of the widest line. */
  get width(): number {
    this.ensureReflow();
    return this.measured;
  }

  /** Height of all lines. */
  get textHeight(): number {
    this.ensureReflow();
    if (this.font !== "pixel") {
      const r = this.scene?.app.renderer;
      return (r ? r.measureText("Hg", this.font).height : this.font.size * 1.2) * this.lines.length;
    }
    return this.lines.length * FONT_LINE * this.scale2 - 2 * this.scale2;
  }

  /** The box containers place: centred and right-aligned text draws around its origin. */
  layoutBox(): LayoutBox {
    return textBox(this.width, this.textHeight, this.align);
  }

  private ensureReflow(): void { if (this.measuredFont !== this.font) this.reflow(); }

  override ready(): void { this.reflow(); }

  override render(ctx: DrawContext): void {
    this.ensureReflow();
    ctx.text(this.lines.join("\n"), 0, 0, {
      color: this.color,
      scale: this.scale2,
      align: this.align,
      shadow: this.shadow,
      additive: this.additive,
      font: this.font,
    });
  }
}

export function wrapText(text: string, maxWidth: number, measure: (line: string) => number = (l) => measureText(l)): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(" ");
    let line = "";
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (measure(candidate) <= maxWidth || !line) line = candidate;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export { FONT_ADVANCE, measureText };
