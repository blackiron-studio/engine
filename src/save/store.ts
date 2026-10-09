// Versioned persistence. A store wraps one JSON document under one key with a schema
// version, migrations for old saves, and a backend that is localStorage in the browser
// and memory everywhere else.

export interface StoreBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function memoryBackend(): StoreBackend {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

/** localStorage when it exists and works (private mode can throw), else null. */
export function localStorageBackend(): StoreBackend | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    const probe = "__blackiron_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return {
      get: (k) => {
        try {
          return ls.getItem(k);
        } catch {
          return null;
        }
      },
      // Store.save owns error handling and must report rejected writes to the game.
      set: (k, v) => ls.setItem(k, v),
      remove: (k) => {
        try {
          ls.removeItem(k);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}

let shared: StoreBackend | null = null;

/** The default backend: what the platform provides once an App exists, else localStorage or memory. */
export function defaultBackend(): StoreBackend {
  if (!shared) shared = localStorageBackend() ?? memoryBackend();
  return shared;
}

/** Route every store created from now on through `backend` (the App sets the platform's). */
export function setDefaultBackend(backend: StoreBackend | null): void {
  shared = backend;
}

export interface StoreOptions<T> {
  key: string;
  version: number;
  initial: () => T;
  /**
   * Upgrade a document saved by an older version. Return null to discard it.
   * Called repeatedly if several versions apart; `fromVersion` is the current step.
   */
  migrate?: (data: unknown, fromVersion: number) => T | null;
  /** Reject corrupt documents before they reach the game. */
  validate?: (data: unknown) => boolean;
  backend?: StoreBackend;
}

interface Envelope {
  v: number;
  savedAt: string;
  data: unknown;
}

export class Store<T> {
  readonly key: string;
  readonly version: number;
  private readonly backend: StoreBackend;
  private readonly opts: StoreOptions<T>;

  constructor(opts: StoreOptions<T>) {
    this.opts = opts;
    this.key = opts.key;
    this.version = opts.version;
    this.backend = opts.backend ?? defaultBackend();
  }

  has(): boolean {
    return this.backend.get(this.key) !== null;
  }

  /** The saved document, migrated if needed, or a fresh initial one. */
  load(): T {
    const raw = this.backend.get(this.key);
    if (raw === null) return this.opts.initial();
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return this.opts.initial();
    }
    if (!env || typeof env !== "object" || typeof env.v !== "number") return this.opts.initial();
    let data: unknown = env.data;
    let v = env.v;
    while (v < this.version) {
      if (!this.opts.migrate) return this.opts.initial();
      const next = this.opts.migrate(data, v);
      if (next === null) return this.opts.initial();
      data = next;
      v++;
    }
    if (v > this.version) return this.opts.initial();
    if (this.opts.validate && !this.opts.validate(data)) return this.opts.initial();
    return data as T;
  }

  save(data: T): boolean {
    try {
      const env: Envelope = { v: this.version, savedAt: new Date().toISOString(), data };
      this.backend.set(this.key, JSON.stringify(env));
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.backend.remove(this.key);
  }

  /** When the current document was written, or null. */
  savedAt(): Date | null {
    const raw = this.backend.get(this.key);
    if (raw === null) return null;
    try {
      const env = JSON.parse(raw) as Envelope;
      return env.savedAt ? new Date(env.savedAt) : null;
    } catch {
      return null;
    }
  }
}

export function createStore<T>(opts: StoreOptions<T>): Store<T> {
  return new Store(opts);
}
