// Menus as thin scenes over the shell's stores: a generic vertical menu with keyboard,
// controller and pointer navigation, and on top of it a title, a pause overlay, settings,
// control remapping and save slots. A game composes what it needs; none of it is required.

import type { App } from "../app/app.ts";
import { measureText as measurePixel } from "../art/font.ts";
import type { DrawContext } from "../scene/draw.ts";
import { Anchor, Column, FocusGroup } from "../scene/layout.ts";
import { Node2D } from "../scene/node.ts";
import { Scene } from "../scene/scene.ts";
import { Label } from "../scene/text.ts";
import { Button, type Control } from "../scene/ui.ts";
import { RichText, Slider } from "../scene/widgets.ts";
import { keyName } from "./hints.ts";
import type { SaveSlots } from "./saves.ts";
import type { Settings } from "./settings.ts";

/** Bindings menus rely on; `bindShellActions` adds the ones a game has not mapped. */
export const SHELL_BINDINGS: Record<string, string[]> = {
  up: ["ArrowUp", "KeyW", "GamepadDpadUp", "GamepadLeftStickUp"],
  down: ["ArrowDown", "KeyS", "GamepadDpadDown", "GamepadLeftStickDown"],
  left: ["ArrowLeft", "KeyA", "GamepadDpadLeft", "GamepadLeftStickLeft"],
  right: ["ArrowRight", "KeyD", "GamepadDpadRight", "GamepadLeftStickRight"],
  confirm: ["Enter", "Space", "GamepadA"],
  back: ["Escape", "Backspace", "GamepadB"],
  pause: ["Escape", "GamepadStart"],
};

/** Bind the menu actions a game has not bound itself. Call after the game's own `input.map`. */
export function bindShellActions(app: App): void {
  for (const [action, codes] of Object.entries(SHELL_BINDINGS)) {
    if (app.input.bindingsOf(action).length === 0) app.input.bind(action, codes);
  }
}

export interface MenuEntry {
  label: string;
  onPick?: () => void;
  disabled?: boolean;
}

export interface MenuOptions {
  title?: string;
  subtitle?: string;
  entries?: MenuEntry[];
  footer?: string;
  /** Back or pause: pops the scene by default when one is under it. */
  onBack?: () => void;
  width?: number;
  rowHeight?: number;
  gap?: number;
  background?: number;
  /** Darken what is under this menu (for overlays), 0 to 1. */
  dim?: number;
  /** Put an opaque, content-sized panel behind overlay menu rows. */
  panel?: boolean;
  titleSize?: number;
}

class Dim extends Node2D {
  constructor(private readonly amount: number) {
    super();
  }

  override render(ctx: DrawContext): void {
    ctx.rect(0, 0, ctx.width, ctx.height, 0x000000, this.amount);
  }
}

class MenuBackdrop extends Node2D {
  constructor(private readonly content: () => Column) { super(); }

  override render(ctx: DrawContext): void {
    const column = this.content();
    column.layout();
    const w = Math.min(ctx.width - 24, column.w + 48);
    const h = Math.min(ctx.height - 24, column.h + 40);
    const x = -w / 2, y = -h / 2;
    const theme = this.scene?.app.theme;
    ctx.rect(x, y, w, h, theme?.panel.fill ?? 0x141225, 0.98);
    ctx.frame(x, y, w, h, theme?.panel.border ?? 0x6b6a8a, 0.7, 1);
    ctx.rect(x, y, w, 3, theme?.accent ?? 0xffc857, 0.8);
  }
}

/** A vertical menu. Subclasses add rows in `build`; entries come from the options. */
export class MenuScene extends Scene {
  readonly focus = new FocusGroup([]);
  protected column!: Column;
  protected panel!: Node2D;
  protected readonly rows: Control[] = [];
  /** Hide the rows while another menu is stacked on top; the dim stays. */
  hideWhenCovered = true;

  constructor(readonly menu: MenuOptions = {}) {
    super();
  }

  override ready(): void {
    if (!this.name) this.name = "menu";
    if (this.menu.background !== undefined) this.background = this.menu.background;
    if (this.menu.dim) this.ui.add(new Dim(this.menu.dim));
    const anchor = this.ui.add(new Anchor({ x: "center", y: "center" }));
    this.panel = anchor;
    if (this.menu.panel) anchor.add(new MenuBackdrop(() => this.column));
    this.column = anchor.add(new Column({ gap: this.menu.gap ?? 12, align: "center", origin: "center" }));
    const theme = this.app.theme;
    if (this.menu.title) this.column.add(this.makeTitle(this.menu.title, this.menu.titleSize ?? 44));
    if (this.menu.subtitle) this.column.add(new Label(this.menu.subtitle, 0, 0, { align: "center", color: theme.muted, wrap: Math.max(this.rowWidth(), Math.min(this.width - 40, 640)) }));
    this.build();
    for (const e of this.menu.entries ?? []) this.addEntry(e);
    if (this.menu.footer) this.column.add(new Label(this.menu.footer, 0, 0, { align: "center", color: theme.muted }));
    if (this.rows.length) this.focus.set(0);
    // Hit tests before the first draw see identity transforms; count hover from real movement only.
    const p = this.app.pointer;
    this.pointerAt = `${p.x},${p.y}`;
  }

  /** Subclasses add their rows here, before the option entries. */
  protected build(): void {}

  override drawTree(ctx: DrawContext): void {
    if (this.hideWhenCovered && this.panel) {
      const all = this.app.scenes.all();
      let covered = false;
      for (let i = all.indexOf(this) + 1; i < all.length; i++) if (all[i] instanceof MenuScene) covered = true;
      this.panel.visible = !covered;
    }
    super.drawTree(ctx);
  }

  private makeTitle(text: string, size: number): Node2D {
    const f = this.app.theme.font;
    if (f === "pixel") return new Label(text, 0, 0, { align: "center", scale: 3, shadow: 0x000000 });
    return new RichText(`[b]${text}[/b]`, 0, 0, { font: { ...f, size: Math.round(size * this.app.accessibility.textScale), weight: 700 }, align: "center", shadow: 0x000000 });
  }

  protected rowWidth(): number {
    return this.menu.width ?? Math.min(380, this.width - 40);
  }

  protected rowHeight(): number {
    return this.menu.rowHeight ?? Math.round(44 * Math.max(1, this.app.accessibility.textScale));
  }

  addEntry(e: MenuEntry): Button {
    const b = new Button(e.label, 0, 0, this.rowWidth(), this.rowHeight(), { onPress: () => e.onPick?.() });
    b.disabled = e.disabled ?? false;
    this.addRow(b);
    return b;
  }

  /** Add any control as a focusable row. */
  addRow<T extends Control>(control: T): T {
    this.column.add(control);
    this.rows.push(control);
    this.focus.items = this.rows;
    return control;
  }

  /** Back: the option's handler, else pop when a scene is under this one. */
  protected back(): void {
    // One key can drive both "back" and "pause"; the second call finds this menu already gone.
    if (this.app.scenes.current !== this) return;
    if (this.menu.onBack) this.menu.onBack();
    else if (this.app.scenes.depth > 1) this.app.scenes.pop();
  }

  private pointerAt = "";

  override update(): void {
    // The pointer and the keyboard share one focus: moving the pointer over a row focuses it.
    const p = this.app.pointer;
    const at = `${p.x},${p.y}`;
    if (at === this.pointerAt) return;
    this.pointerAt = at;
    const h = this.hoveredControl;
    if (h) {
      const i = this.rows.indexOf(h);
      if (i >= 0 && this.focus.index !== i) this.focus.set(i);
    }
  }

  override onAction(name: string, pressed: boolean): void {
    if (!pressed) return;
    if (name === "back" || name === "pause") {
      this.back();
      return;
    }
    if (name === "left" || name === "right") {
      const c = this.focus.current;
      if (c instanceof Slider) c.nudge(name === "left" ? -1 : 1);
      return;
    }
    this.focus.onAction(name, pressed);
  }
}

/** A title screen: a big name, the entries a game gives it, a version line. */
export class TitleScene extends MenuScene {
  constructor(opts: MenuOptions & { version?: string } = {}) {
    super({ titleSize: 60, ...opts, footer: opts.footer ?? opts.version });
  }

  override ready(): void {
    this.name = "title";
    super.ready();
  }
}

export interface PauseOptions {
  title?: string;
  settings?: Settings;
  /** Passed to the settings screen opened from here: extra rows, labels, the action list. */
  settingsOptions?: SettingsSceneOptions;
  /** Leave the game; the entry appears only when given. */
  onQuit?: () => void;
  entries?: MenuEntry[];
  labels?: { resume?: string; settings?: string; quit?: string };
}

/** Pushed over the game as an overlay: the game stops updating, sound ducks, Resume pops. */
export class PauseScene extends MenuScene {
  constructor(readonly pause: PauseOptions = {}) {
    super({ title: pause.title ?? "Paused", dim: 0.6, panel: true });
  }

  protected override build(): void {
    const l = this.pause.labels ?? {};
    this.addEntry({ label: l.resume ?? "Resume", onPick: () => this.back() });
    const settings = this.pause.settings;
    if (settings) this.addEntry({ label: l.settings ?? "Settings", onPick: () => this.app.scenes.push(new SettingsScene(settings, this.pause.settingsOptions), { overlay: true }) });
    for (const e of this.pause.entries ?? []) this.addEntry(e);
    if (this.pause.onQuit) this.addEntry({ label: l.quit ?? "Quit", onPick: this.pause.onQuit });
  }

  override ready(): void {
    this.name = "pause";
    super.ready();
    this.app.audio.pause();
  }

  override exit(): void {
    this.app.audio.resume();
  }
}

export interface ConfirmOptions {
  title?: string;
  message?: string;
  /** Labels for the two rows; "Yes" and "No" by default. */
  confirm?: string;
  cancel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  dim?: number;
  width?: number;
}

/** A yes-or-no question over the game: the first row or `confirm` says yes, `back` says no. Pops itself. */
export class ConfirmScene extends MenuScene {
  private answered = false;

  constructor(readonly ask: ConfirmOptions) {
    super({ title: ask.title ?? "Are you sure?", subtitle: ask.message, dim: ask.dim ?? 0.6, width: ask.width, onBack: () => this.answer(false) });
  }

  protected override build(): void {
    this.addEntry({ label: this.ask.confirm ?? "Yes", onPick: () => this.answer(true) });
    this.addEntry({ label: this.ask.cancel ?? "No", onPick: () => this.answer(false) });
  }

  override ready(): void {
    this.name = "confirm";
    super.ready();
  }

  private answer(yes: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.app.scenes.pop();
    if (yes) this.ask.onConfirm();
    else this.ask.onCancel?.();
  }
}

export interface SettingsSceneOptions {
  title?: string;
  onBack?: () => void;
  /** Show the control remapping entry; on by default. */
  controls?: boolean;
  /** Which actions the controls screen lists; every bound action but the shell's by default. */
  actions?: string[];
  labels?: Record<string, string>;
  /** Extra rows a game adds, after the standard ones. */
  extra?: (scene: SettingsScene) => void;
}

const TEXT_SIZES: [number, string][] = [[0.85, "Small"], [1, "Normal"], [1.2, "Large"]];

/** Volumes, screen shake, reduced motion, text size, mute, controls. */
export class SettingsScene extends MenuScene {
  private columnFont: unknown = null;

  constructor(
    readonly settings: Settings,
    readonly opts: SettingsSceneOptions = {},
  ) {
    super({ title: opts.title ?? "Settings", dim: 0.82, panel: true, onBack: opts.onBack, gap: 10 });
  }

  private sliderLabelWidth(): number {
    const labels = ["Master volume", "Music", "Effects", "Screen shake"];
    const font = this.app.theme.font;
    const width = (text: string) => font === "pixel" ? measurePixel(text) : this.app.renderer.measureText(text, font).width;
    return Math.ceil(Math.max(...labels.map(width)) + 16);
  }

  private slider(label: string, key: "masterVolume" | "musicVolume" | "sfxVolume" | "screenShake"): void {
    const s = this.addRow(new Slider(0, 0, this.rowWidth(), this.rowHeight(), { label, labelWidth: this.sliderLabelWidth(), value: this.settings.data[key], step: 0.05, onChange: (v) => this.settings.set({ [key]: v }) }));
    s.name = key;
  }

  override update(): void {
    super.update();
    const font = this.app.theme.font;
    if (font === this.columnFont) return;
    this.columnFont = font;
    const labelWidth = this.sliderLabelWidth();
    for (const slider of this.rows) if (slider instanceof Slider && ["masterVolume", "musicVolume", "sfxVolume", "screenShake"].includes(slider.name)) slider.labelWidth = labelWidth;
  }

  /** A row for a boolean the game keeps in the settings' `extra` store, for `extra` builders. */
  toggleExtra(label: string, key: string, fallback = false): void {
    const on = () => this.settings.get(key, fallback) === true;
    const text = () => `${label}: ${on() ? "On" : "Off"}`;
    const b = this.addEntry({ label: text(), onPick: () => {
      this.settings.setExtra(key, !on());
      b.text = text();
    } });
    b.name = key;
  }

  private toggle(label: string, key: "reducedMotion" | "muted"): void {
    const text = () => `${label}: ${this.settings.data[key] ? "On" : "Off"}`;
    const b = this.addEntry({ label: text(), onPick: () => {
      this.settings.set({ [key]: !this.settings.data[key] });
      b.text = text();
    } });
    b.name = key;
  }

  protected override build(): void {
    this.slider("Master volume", "masterVolume");
    this.slider("Music", "musicVolume");
    this.slider("Effects", "sfxVolume");
    this.slider("Screen shake", "screenShake");
    this.toggle("Reduced motion", "reducedMotion");
    const sizeText = () => `Text size: ${TEXT_SIZES.find(([v]) => Math.abs(v - this.settings.data.textScale) < 0.01)?.[1] ?? `${Math.round(this.settings.data.textScale * 100)}%`}`;
    const size = this.addEntry({ label: sizeText(), onPick: () => {
      const i = TEXT_SIZES.findIndex(([v]) => Math.abs(v - this.settings.data.textScale) < 0.01);
      this.settings.set({ textScale: TEXT_SIZES[(i + 1) % TEXT_SIZES.length][0] });
      size.text = sizeText();
    } });
    size.name = "textScale";
    this.toggle("Mute", "muted");
    if (this.opts.controls !== false) this.addEntry({ label: "Controls", onPick: () => this.app.scenes.push(new ControlsScene(this.settings, { actions: this.opts.actions, labels: this.opts.labels }), { overlay: true }) });
    this.opts.extra?.(this);
    this.addEntry({ label: "Back", onPick: () => this.back() });
  }

  override ready(): void {
    this.name = "settings";
    super.ready();
  }
}

const SHELL_ONLY = new Set(["up", "down", "left", "right", "confirm", "back", "pause"]);

export interface ControlsSceneOptions {
  actions?: string[];
  labels?: Record<string, string>;
  onBack?: () => void;
}

/** Every action with its keys; pick one and press a key or button to rebind it. */
export class ControlsScene extends MenuScene {
  private capturing: { action: string; button: Button } | null = null;
  private readonly buttons = new Map<string, Button>();

  constructor(
    readonly settings: Settings,
    readonly opts: ControlsSceneOptions = {},
  ) {
    super({ title: "Controls", dim: 0.6, onBack: opts.onBack, gap: 8, width: 420 });
  }

  private actions(): string[] {
    return this.opts.actions ?? this.settings.app.input.actions().filter((a) => !SHELL_ONLY.has(a));
  }

  private label(action: string): string {
    return this.opts.labels?.[action] ?? action.charAt(0).toUpperCase() + action.slice(1);
  }

  private text(action: string): string {
    const codes = this.settings.bindingsOf(action);
    return `${this.label(action)}: ${codes.length ? codes.map(keyName).join(" / ") : "unbound"}`;
  }

  protected override build(): void {
    for (const action of this.actions()) {
      const b = this.addEntry({ label: this.text(action), onPick: () => this.startCapture(action) });
      this.buttons.set(action, b);
    }
    this.addEntry({ label: "Reset to defaults", onPick: () => {
      this.settings.resetBindings();
      for (const [action, b] of this.buttons) b.text = this.text(action);
    } });
    this.addEntry({ label: "Back", onPick: () => this.back() });
  }

  override ready(): void {
    this.name = "controls";
    super.ready();
  }

  private startCapture(action: string): void {
    const button = this.buttons.get(action);
    if (!button) return;
    this.capturing = { action, button };
    button.text = `${this.label(action)}: press a key or button`;
  }

  /** While capturing, the next key or button replaces the binding of the same kind. */
  override onKey(code: string, down: boolean): boolean {
    const c = this.capturing;
    if (!c) return super.onKey(code, down);
    if (!down) return true;
    if (code !== "Escape") {
      const isPad = code.startsWith("Gamepad");
      const keep = this.settings.bindingsOf(c.action).filter((k) => k.startsWith("Gamepad") !== isPad);
      this.settings.rebind(c.action, [code, ...keep]);
    }
    c.button.text = this.text(c.action);
    this.capturing = null;
    return true;
  }

  override onAction(name: string, pressed: boolean): void {
    if (this.capturing) return;
    super.onAction(name, pressed);
  }
}

export interface SaveSlotsSceneOptions<T> {
  title?: string;
  /** Called with the slot and its document, or null for an empty slot. */
  onPick: (index: number, data: T | null) => void;
  allowDelete?: boolean;
  onBack?: () => void;
}

/** One row per slot with its summary and date; optional delete rows. */
export class SaveSlotsScene<T> extends MenuScene {
  constructor(
    readonly slots: SaveSlots<T>,
    readonly opts: SaveSlotsSceneOptions<T>,
  ) {
    super({ title: opts.title ?? "Saves", dim: 0.6, onBack: opts.onBack, width: 420 });
  }

  private text(i: number): string {
    const info = this.slots.list()[i];
    if (info.empty) return `Slot ${i + 1} · empty`;
    const when = info.savedAt ? info.savedAt.toLocaleDateString() : "";
    return `Slot ${i + 1} · ${info.summary}${when ? ` · ${when}` : ""}`;
  }

  protected override build(): void {
    const buttons: Button[] = [];
    for (let i = 0; i < this.slots.count; i++) {
      buttons.push(this.addEntry({ label: this.text(i), onPick: () => this.opts.onPick(i, this.slots.has(i) ? this.slots.load(i) : null) }));
    }
    if (this.opts.allowDelete) {
      for (let i = 0; i < this.slots.count; i++) {
        const b = this.addEntry({ label: `Delete slot ${i + 1}`, disabled: !this.slots.has(i), onPick: () => {
          this.slots.delete(i);
          buttons[i].text = this.text(i);
          b.disabled = true;
        } });
      }
    }
    this.addEntry({ label: "Back", onPick: () => this.back() });
  }

  override ready(): void {
    this.name = "saves";
    super.ready();
  }
}
