// Settings: what every game lets a player change, stored once and applied to the engine.
// Volumes reach the audio buses, screen shake and reduced motion reach cameras and scene
// transitions, text size scales the theme's font, bindings reach the action map, and the
// set of tutorial hints already seen lives here too. Games add their own fields through
// `extra` and read them back with `get`.

import type { App } from "../app/app.ts";
import type { FontSpec } from "../render/types.ts";
import { type Store, type StoreBackend, createStore } from "../save/store.ts";

export interface SettingsData {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
  /** 0 disables camera shake, 1 leaves it as the game asks. */
  screenShake: number;
  /** Shorter scene transitions and a hint to games to calm their effects. */
  reducedMotion: boolean;
  /** Multiplies the theme font size; 1 is the game's own size. */
  textScale: number;
  /** Per-action bindings that replace the game's defaults. */
  bindings: Record<string, string[]>;
  seenHints: string[];
  /** Game-defined settings. */
  extra: Record<string, number | string | boolean>;
}

export interface SettingsOptions {
  /** Store key; one per game by default. */
  key?: string;
  defaults?: Partial<SettingsData>;
  backend?: StoreBackend;
}

const VERSION = 1;

export function defaultSettings(): SettingsData {
  return { masterVolume: 1, musicVolume: 0.8, sfxVolume: 1, muted: false, screenShake: 1, reducedMotion: false, textScale: 1, bindings: {}, seenHints: [], extra: {} };
}

export class Settings {
  readonly store: Store<SettingsData>;
  data: SettingsData;
  private readonly baseFont: FontSpec | "pixel";
  private readonly defaultBindings = new Map<string, string[]>();
  private readonly listeners = new Set<(data: SettingsData) => void>();

  constructor(
    readonly app: App,
    opts: SettingsOptions = {},
  ) {
    const defaults = { ...defaultSettings(), ...opts.defaults };
    this.store = createStore<SettingsData>({
      key: opts.key ?? "settings",
      version: VERSION,
      initial: () => ({ ...defaults, bindings: { ...defaults.bindings }, seenHints: [...defaults.seenHints], extra: { ...defaults.extra } }),
      validate: (d) => typeof d === "object" && d !== null && typeof (d as SettingsData).masterVolume === "number",
      backend: opts.backend,
    });
    this.data = { ...defaults, ...this.store.load() };
    this.baseFont = app.theme.font;
    for (const action of app.input.actions()) this.defaultBindings.set(action, [...app.input.bindingsOf(action)]);
    this.apply();
  }

  /** Change fields, apply them to the engine and save. */
  set(patch: Partial<SettingsData>): void {
    Object.assign(this.data, patch);
    this.apply();
    this.store.save(this.data);
    for (const l of this.listeners) l(this.data);
  }

  /** A game-defined setting. */
  get<T extends number | string | boolean>(name: string, fallback: T): T {
    const v = this.data.extra[name];
    return (v === undefined ? fallback : v) as T;
  }

  setExtra(name: string, value: number | string | boolean): void {
    this.set({ extra: { ...this.data.extra, [name]: value } });
  }

  onChange(cb: (data: SettingsData) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Push every field into the engine: audio, accessibility, theme font, bindings. */
  apply(): void {
    const d = this.data;
    const audio = this.app.audio;
    audio.masterVolume = d.masterVolume;
    audio.musicVolume = d.musicVolume;
    audio.sfxVolume = d.sfxVolume;
    audio.setMuted(d.muted);
    const a = this.app.accessibility;
    a.shakeScale = d.screenShake;
    a.reducedMotion = d.reducedMotion;
    a.textScale = d.textScale;
    const base = this.baseFont;
    if (base !== "pixel") this.app.setTheme({ font: { ...base, size: Math.max(6, Math.round(base.size * d.textScale)) } });
    for (const [action, codes] of Object.entries(d.bindings)) this.app.input.bind(action, codes);
  }

  /** The codes an action answers to right now. */
  bindingsOf(action: string): string[] {
    return this.app.input.bindingsOf(action);
  }

  /** Replace an action's bindings. Pass the game's default to clear the override. */
  rebind(action: string, codes: string[]): void {
    const bindings = { ...this.data.bindings, [action]: codes };
    this.set({ bindings });
  }

  /** Every action back to the game's defaults. */
  resetBindings(): void {
    for (const [action, codes] of this.defaultBindings) this.app.input.bind(action, codes);
    this.set({ bindings: {} });
  }

  defaultBindingsOf(action: string): string[] {
    return this.defaultBindings.get(action) ?? [];
  }

  hintSeen(id: string): boolean {
    return this.data.seenHints.includes(id);
  }

  markHintSeen(id: string): void {
    if (this.hintSeen(id)) return;
    this.set({ seenHints: [...this.data.seenHints, id] });
  }

  resetHints(): void {
    this.set({ seenHints: [] });
  }

  /** Everything back to defaults (bindings included). */
  reset(): void {
    for (const [action, codes] of this.defaultBindings) this.app.input.bind(action, codes);
    this.data = defaultSettings();
    this.set({});
  }
}

export function createSettings(app: App, opts: SettingsOptions = {}): Settings {
  return new Settings(app, opts);
}
