// Save slots over the versioned Store: a fixed number of slots, each a document of the
// game's own type, plus an index with a summary line and a timestamp per slot, so a menu
// can list them without loading everything. `autosave` writes the slot in use.

import { type Store, type StoreBackend, createStore } from "../save/store.ts";

export interface SlotInfo {
  index: number;
  empty: boolean;
  savedAt: Date | null;
  summary: string;
}

export interface SaveSlotsOptions<T> {
  key: string;
  version: number;
  /** How many slots; three by default. */
  slots?: number;
  initial: () => T;
  migrate?: (data: unknown, fromVersion: number) => T | null;
  validate?: (data: unknown) => boolean;
  /** The line a menu shows for a slot. */
  summarize?: (data: T) => string;
  backend?: StoreBackend;
}

interface IndexData {
  current: number;
  /** Counts saves, so the newest slot is unambiguous inside one millisecond. */
  seq?: number;
  slots: Record<string, { summary: string; savedAt: number; seq?: number }>;
}

export class SaveSlots<T> {
  readonly count: number;
  private readonly stores: Store<T>[] = [];
  private readonly index: Store<IndexData>;
  private meta: IndexData;
  private readonly summarize: (data: T) => string;
  private readonly initial: () => T;

  constructor(opts: SaveSlotsOptions<T>) {
    this.count = Math.max(1, opts.slots ?? 3);
    this.initial = opts.initial;
    this.summarize = opts.summarize ?? (() => "");
    for (let i = 0; i < this.count; i++) {
      this.stores.push(createStore<T>({ key: `${opts.key}.slot${i}`, version: opts.version, initial: opts.initial, migrate: opts.migrate, validate: opts.validate, backend: opts.backend }));
    }
    this.index = createStore<IndexData>({ key: `${opts.key}.slots`, version: 1, initial: () => ({ current: 0, slots: {} }), backend: opts.backend });
    this.meta = this.index.load();
  }

  /** The slot `autosave` writes; `load` sets it. */
  get current(): number {
    return this.meta.current;
  }

  set current(i: number) {
    this.meta.current = Math.max(0, Math.min(this.count - 1, i));
    this.index.save(this.meta);
  }

  has(i: number): boolean {
    return this.meta.slots[String(i)] !== undefined;
  }

  list(): SlotInfo[] {
    const out: SlotInfo[] = [];
    for (let i = 0; i < this.count; i++) {
      const m = this.meta.slots[String(i)];
      out.push({ index: i, empty: !m, savedAt: m ? new Date(m.savedAt) : null, summary: m?.summary ?? "" });
    }
    return out;
  }

  /** The most recently saved slot, or -1 when every slot is empty. */
  newest(): number {
    let best = -1;
    let at = -1;
    for (const [k, m] of Object.entries(this.meta.slots)) {
      const order = m.seq ?? m.savedAt;
      if (order > at) {
        at = order;
        best = Number(k);
      }
    }
    return best;
  }

  /** Load a slot (a fresh document when empty) and make it current. */
  load(i: number): T {
    this.current = i;
    return this.has(i) ? this.stores[i].load() : this.initial();
  }

  save(i: number, data: T, summary?: string): boolean {
    const ok = this.stores[i].save(data);
    if (ok) {
      this.meta.seq = (this.meta.seq ?? 0) + 1;
      this.meta.slots[String(i)] = { summary: summary ?? this.summarize(data), savedAt: Date.now(), seq: this.meta.seq };
      this.meta.current = i;
      this.index.save(this.meta);
    }
    return ok;
  }

  /** Save to the current slot. */
  autosave(data: T, summary?: string): boolean {
    return this.save(this.meta.current, data, summary);
  }

  delete(i: number): void {
    this.stores[i].clear();
    delete this.meta.slots[String(i)];
    this.index.save(this.meta);
  }

  clearAll(): void {
    for (let i = 0; i < this.count; i++) this.delete(i);
  }
}

export function createSaveSlots<T>(opts: SaveSlotsOptions<T>): SaveSlots<T> {
  return new SaveSlots(opts);
}
