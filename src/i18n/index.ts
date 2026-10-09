// Localization: message tables per locale, `t(key, values)` with placeholders, plurals and
// selects, formatted numbers and dates through Intl, and a change signal so labels re-render
// when the player switches language. Like Godot's translations and Unity's Localization
// package, without the editor: the tables are JSON a game ships or generates.

export type Messages = Record<string, string>;

export interface I18nOptions {
  /** Starting locale; the first table's when omitted. */
  locale?: string;
  /** Where a missing key is looked up before falling back to the key itself. */
  fallback?: string;
  /** Message tables by locale tag. */
  messages?: Record<string, Messages>;
}

export type Values = Record<string, string | number | Date>;

const RTL = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd"]);

/**
 * One instance per game. Messages use `{name}` placeholders and ICU-style
 * `{count, plural, one {# thing} other {# things}}` and `{kind, select, a {…} other {…}}`.
 */
export class I18n {
  private tables = new Map<string, Messages>();
  private locale_: string;
  readonly fallback: string;
  private readonly listeners = new Set<(locale: string) => void>();
  private numberFormat: Intl.NumberFormat | null = null;
  private plurals: Intl.PluralRules | null = null;

  constructor(opts: I18nOptions = {}) {
    for (const [tag, table] of Object.entries(opts.messages ?? {})) this.tables.set(tag, table);
    this.locale_ = opts.locale ?? this.tables.keys().next().value ?? "en";
    this.fallback = opts.fallback ?? "en";
  }

  /** Add or extend a locale's messages. */
  add(locale: string, messages: Messages): void {
    this.tables.set(locale, { ...(this.tables.get(locale) ?? {}), ...messages });
    if (locale === this.locale_) this.notify();
  }

  get locale(): string {
    return this.locale_;
  }

  set locale(tag: string) {
    if (tag === this.locale_) return;
    this.locale_ = tag;
    this.numberFormat = null;
    this.plurals = null;
    this.notify();
  }

  /** Locales with a message table. */
  get locales(): string[] {
    return [...this.tables.keys()];
  }

  /** Whether the current locale reads right to left. */
  get rtl(): boolean {
    return RTL.has(this.locale_.split("-")[0].toLowerCase());
  }

  has(key: string): boolean {
    return this.lookup(key) !== null;
  }

  private lookup(key: string): string | null {
    const own = this.tables.get(this.locale_)?.[key];
    if (own !== undefined) return own;
    const base = this.locale_.split("-")[0];
    const regional = this.tables.get(base)?.[key];
    if (regional !== undefined) return regional;
    const fb = this.tables.get(this.fallback)?.[key];
    return fb === undefined ? null : fb;
  }

  /** The message for a key with its values filled in; the key itself when no table has it. */
  t(key: string, values: Values = {}): string {
    const msg = this.lookup(key);
    if (msg === null) return key;
    return this.format(msg, values);
  }

  /** Fill a message's placeholders. */
  format(msg: string, values: Values = {}): string {
    let out = "";
    let i = 0;
    while (i < msg.length) {
      const open = msg.indexOf("{", i);
      if (open < 0) {
        out += msg.slice(i);
        break;
      }
      out += msg.slice(i, open);
      const close = matchBrace(msg, open);
      if (close < 0) {
        out += msg.slice(open);
        break;
      }
      out += this.placeholder(msg.slice(open + 1, close), values);
      i = close + 1;
    }
    return out;
  }

  private placeholder(inner: string, values: Values): string {
    const parts = splitTop(inner);
    const name = parts[0].trim();
    const value = values[name];
    if (parts.length === 1) return this.plain(value);
    const kind = parts[1].trim();
    if (kind === "number") return this.number(Number(value ?? 0));
    if (kind === "date") return this.date(value instanceof Date ? value : new Date(Number(value ?? 0)));
    if (kind === "plural" || kind === "select") {
      const options = parseOptions(parts.slice(2).join(","));
      let chosen: string | undefined;
      if (kind === "plural") {
        const n = Number(value ?? 0);
        chosen = options[`=${n}`] ?? options[this.pluralCategory(n)] ?? options.other;
        if (chosen !== undefined) return this.format(chosen.replace(/#/g, this.number(n)), values);
      } else {
        chosen = options[String(value)] ?? options.other;
        if (chosen !== undefined) return this.format(chosen, values);
      }
      return "";
    }
    return this.plain(value);
  }

  private plain(v: string | number | Date | undefined): string {
    if (v === undefined) return "";
    if (typeof v === "number") return this.number(v);
    if (v instanceof Date) return this.date(v);
    return v;
  }

  private pluralCategory(n: number): string {
    try {
      this.plurals ??= new Intl.PluralRules(this.locale_);
      return this.plurals.select(n);
    } catch {
      return n === 1 ? "one" : "other";
    }
  }

  /** A number in the locale's digits and separators. */
  number(n: number, opts?: Intl.NumberFormatOptions): string {
    try {
      if (opts) return new Intl.NumberFormat(this.locale_, opts).format(n);
      this.numberFormat ??= new Intl.NumberFormat(this.locale_);
      return this.numberFormat.format(n);
    } catch {
      return String(n);
    }
  }

  /** A date in the locale's order. */
  date(d: Date, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
    try {
      return new Intl.DateTimeFormat(this.locale_, opts).format(d);
    } catch {
      return d.toDateString();
    }
  }

  /** Run `fn` now and whenever the locale or its table changes; returns the unsubscribe. */
  watch(fn: (locale: string) => void): () => void {
    this.listeners.add(fn);
    fn(this.locale_);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.locale_);
  }

  /** The device's preferred locale among the ones with tables, else the fallback. */
  static preferred(available: string[], fallback = "en"): string {
    const wanted: string[] = [];
    try {
      const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
      if (nav?.languages) wanted.push(...nav.languages);
      else if (nav?.language) wanted.push(nav.language);
      wanted.push(Intl.DateTimeFormat().resolvedOptions().locale);
    } catch {
      /* no locale source */
    }
    for (const w of wanted) {
      if (available.includes(w)) return w;
      const base = w.split("-")[0];
      const match = available.find((a) => a.split("-")[0] === base);
      if (match) return match;
    }
    return available.includes(fallback) ? fallback : (available[0] ?? fallback);
  }
}

/** Index of the brace closing the one at `open`, or -1. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas at brace depth zero. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** `one {…} other {…} =0 {…}` into a map. */
function parseOptions(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const nameStart = i;
    while (i < s.length && s[i] !== "{" && !/\s/.test(s[i])) i++;
    const name = s.slice(nameStart, i);
    while (i < s.length && s[i] !== "{") i++;
    if (i >= s.length) break;
    const close = matchBrace(s, i);
    if (close < 0) break;
    out[name] = s.slice(i + 1, close);
    i = close + 1;
  }
  return out;
}

/** A shared instance for games that want one without wiring; `createI18n` replaces it. */
export let i18n = new I18n();

export function createI18n(opts: I18nOptions = {}): I18n {
  i18n = new I18n(opts);
  return i18n;
}

/** Shorthand for the shared instance. */
export const t = (key: string, values?: Values): string => i18n.t(key, values);
