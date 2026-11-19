// Cloud saves. The game keeps reading and writing its stores synchronously against the
// device, exactly as without a backend; this layer copies changes up in the background and
// brings newer saves down. The device copy is always usable offline.

import { realTimers, type Timers } from "../net/types.ts";
import type { StoreBackend } from "../save/store.ts";
import type { Identity } from "./identity.ts";
import { ServiceError, type SaveDoc } from "./types.ts";

const META = "blackiron.cloud";

/** What to do when the device and the backend both changed a save since they last agreed. */
export type ConflictPolicy = "newest" | "local" | "remote" | ((local: { data: string; changedAt: number }, remote: SaveDoc) => "local" | "remote");

export type CloudStatus = "idle" | "syncing" | "offline" | "error";

export interface CloudOptions {
  identity: Identity;
  /** The device's storage. */
  local: StoreBackend;
  /** Which keys sync. By default every key except the engine's own (`blackiron.*`). */
  keys?: (key: string) => boolean;
  /** "newest" by default: the save changed most recently wins. */
  conflict?: ConflictPolicy;
  /** Quiet time after a write before uploading, in milliseconds; 2 seconds by default. */
  debounceMs?: number;
  timers?: Timers;
  now?: () => number;
}

interface KeyMeta {
  /** Revision the device copy is based on; 0 when never synced. */
  rev: number;
  /** Changed on the device since `rev`. */
  dirty: boolean;
  /** Removed on the device; the removal still has to reach the backend. */
  deleted?: boolean;
  /** When the device copy last changed. */
  at: number;
}

interface Meta {
  player: string | null;
  keys: Record<string, KeyMeta>;
}

export interface SyncReport {
  /** Keys uploaded. */
  pushed: string[];
  /** Keys replaced on the device by the backend's copy (or removed). The game should reload them. */
  pulled: string[];
  /** Keys both sides had changed, and which side won. */
  conflicts: { key: string; kept: "local" | "remote" }[];
  /** Keys the backend refused (too large, over quota), with the reason. */
  failed: { key: string; reason: string }[];
}

export class CloudSaves {
  /** Give this to `setDefaultBackend` (the App does when `cloud` is on) or to a single store. */
  readonly backend: StoreBackend;
  status: CloudStatus = "idle";
  /** The last sync error, for a settings screen. */
  lastError: string | null = null;
  private readonly opts: CloudOptions;
  private readonly timers: Timers;
  private readonly now: () => number;
  private meta: Meta = { player: null, keys: {} };
  private timer: unknown = null;
  private running: Promise<SyncReport> | null = null;
  private again = false;
  private readonly statusListeners = new Set<(s: CloudStatus) => void>();
  private readonly remoteListeners = new Set<(keys: string[]) => void>();

  constructor(opts: CloudOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? Date.now;
    try {
      const saved = JSON.parse(opts.local.get(META) ?? "null") as Meta | null;
      if (saved && typeof saved === "object" && saved.keys) this.meta = saved;
    } catch {
      this.meta = { player: null, keys: {} };
    }
    const local = opts.local;
    this.backend = {
      get: (key) => local.get(key),
      set: (key, value) => {
        const same = local.get(key) === value;
        local.set(key, value);
        if (!same) this.touch(key, false);
      },
      remove: (key) => {
        const had = local.get(key) !== null;
        local.remove(key);
        if (had) this.touch(key, true);
      },
    };
  }

  private syncs(key: string): boolean {
    return key !== META && (this.opts.keys ? this.opts.keys(key) : !key.startsWith("blackiron."));
  }

  private saveMeta(): void {
    try {
      this.opts.local.set(META, JSON.stringify(this.meta));
    } catch {
      // Losing the bookkeeping only costs a redundant upload later.
    }
  }

  private touch(key: string, deleted: boolean): void {
    if (!this.syncs(key)) return;
    const m = this.meta.keys[key] ?? { rev: 0, dirty: false, at: 0 };
    this.meta.keys[key] = { rev: m.rev, dirty: true, at: this.now(), ...(deleted ? { deleted: true } : {}) };
    this.saveMeta();
    this.timers.clear(this.timer);
    this.timer = this.timers.set(() => void this.sync().catch(() => {}), this.opts.debounceMs ?? 2000);
  }

  /** Saves changed on the device and not uploaded yet. */
  get pending(): number {
    let n = 0;
    for (const k of Object.keys(this.meta.keys)) if (this.meta.keys[k]!.dirty || this.meta.keys[k]!.rev === 0) n++;
    return n;
  }

  onStatus(cb: (status: CloudStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /**
   * Called when a sync replaced saves on the device with the backend's copy, with the keys
   * that changed. Stores already loaded into memory still hold the old data: reload them.
   */
  onRemote(cb: (keys: string[]) => void): () => void {
    this.remoteListeners.add(cb);
    return () => this.remoteListeners.delete(cb);
  }

  private setStatus(s: CloudStatus, error: string | null = null): void {
    this.lastError = error;
    if (s === this.status) return;
    this.status = s;
    for (const cb of [...this.statusListeners]) cb(s);
  }

  /**
   * Reconcile the device with the backend now. Never rejects for being offline: the report
   * is empty, the status says "offline" and the changes wait for the next sync.
   */
  sync(): Promise<SyncReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.timers.clear(this.timer);
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sync().catch(() => {});
      }
    });
    return this.running;
  }

  private async run(): Promise<SyncReport> {
    const report: SyncReport = { pushed: [], pulled: [], conflicts: [], failed: [] };
    const { identity, local } = this.opts;
    this.setStatus("syncing");
    try {
      const player = await identity.signIn();
      if (this.meta.player !== player.id) {
        // A different player than the device last synced with: nothing here is based on
        // their revisions. Their saves come down; saves they lack go up.
        // Where they already have a save, theirs wins: switching accounts must not overwrite
        // the account's progress with this device's. A first sign-in keeps its timestamps.
        const switched = this.meta.player !== null;
        for (const k of Object.keys(this.meta.keys)) {
          const m = this.meta.keys[k]!;
          if (m.deleted) delete this.meta.keys[k];
          else this.meta.keys[k] = switched ? { rev: 0, dirty: false, at: 0 } : { rev: 0, dirty: m.dirty, at: m.at };
        }
        this.meta.player = player.id;
      }
      const remote = new Map<string, SaveDoc>();
      for (const doc of await identity.authorized((s) => identity.provider.listSaves(s))) if (this.syncs(doc.key)) remote.set(doc.key, doc);

      const adopt = (doc: SaveDoc): void => {
        local.set(doc.key, doc.data);
        this.meta.keys[doc.key] = { rev: doc.rev, dirty: false, at: doc.updatedAt };
        report.pulled.push(doc.key);
      };
      const push = async (key: string, baseRev: number): Promise<void> => {
        const data = local.get(key);
        if (data === null) return;
        const sentAt = this.meta.keys[key]?.at ?? this.now();
        try {
          const res = await identity.authorized((s) => identity.provider.pushSave(s, key, data, baseRev));
          if (res.ok) {
            // A write that landed during the upload stays dirty for the next pass.
            const m = this.meta.keys[key];
            const changedSince = local.get(key) !== data || m?.deleted === true;
            this.meta.keys[key] = { rev: res.rev, dirty: changedSince, at: m?.at ?? sentAt, ...(m?.deleted ? { deleted: true } : {}) };
            if (changedSince) this.again = true;
            report.pushed.push(key);
          } else if (res.current) await settle(key, res.current);
          else if (baseRev !== 0) await push(key, 0);
          else report.failed.push({ key, reason: "The backend refused the save" });
        } catch (e) {
          if (e instanceof ServiceError && (e.kind === "limit" || e.kind === "rejected")) report.failed.push({ key, reason: e.message });
          else throw e;
        }
      };
      const settle = async (key: string, doc: SaveDoc): Promise<void> => {
        const m = this.meta.keys[key]!;
        const policy = this.opts.conflict ?? "newest";
        const data = local.get(key);
        let keep: "local" | "remote";
        if (m.deleted || data === null) keep = policy === "remote" ? "remote" : policy === "local" ? "local" : m.at >= doc.updatedAt ? "local" : "remote";
        else if (data === doc.data) keep = "remote";
        else if (typeof policy === "function") keep = policy({ data, changedAt: m.at }, doc);
        else keep = policy === "newest" ? (m.at >= doc.updatedAt ? "local" : "remote") : policy;
        if (data !== doc.data) report.conflicts.push({ key, kept: keep });
        if (keep === "remote") return adopt(doc);
        if (m.deleted) return remove(key);
        await push(key, doc.rev);
      };
      const remove = async (key: string): Promise<void> => {
        await identity.authorized((s) => identity.provider.deleteSave(s, key));
        delete this.meta.keys[key];
        report.pushed.push(key);
      };

      for (const [key, doc] of remote) {
        const m = this.meta.keys[key];
        const has = local.get(key) !== null;
        if (!m || (m.rev === 0 && !m.dirty)) {
          // Never synced here. A device copy that differs is a conflict; otherwise take theirs.
          if (has && local.get(key) !== doc.data) {
            this.meta.keys[key] = { rev: 0, dirty: true, at: m?.at ?? 0 };
            await settle(key, doc);
          } else adopt(doc);
        } else if (!m.dirty) {
          if (doc.rev !== m.rev) adopt(doc);
        } else if (doc.rev === m.rev) {
          if (m.deleted) await remove(key);
          else await push(key, m.rev);
        } else await settle(key, doc);
      }
      for (const key of Object.keys(this.meta.keys)) {
        if (remote.has(key)) continue;
        const m = this.meta.keys[key]!;
        if (m.deleted) delete this.meta.keys[key];
        else if (m.dirty || m.rev === 0) await push(key, 0);
        else {
          // Synced before and gone from the backend: it was deleted elsewhere.
          local.remove(key);
          delete this.meta.keys[key];
          report.pulled.push(key);
        }
      }
      this.saveMeta();
      this.setStatus(report.failed.length ? "error" : "idle", report.failed[0]?.reason ?? null);
    } catch (e) {
      this.saveMeta();
      const offline = e instanceof ServiceError && e.kind === "offline";
      this.setStatus(offline ? "offline" : "error", e instanceof Error ? e.message : String(e));
      if (!offline && !(e instanceof ServiceError)) throw e;
    }
    if (report.pulled.length) for (const cb of [...this.remoteListeners]) cb([...report.pulled]);
    return report;
  }

  /**
   * Start syncing saves that exist on the device but were written before cloud saves were
   * on (or outside `backend`). Call once with the keys the game uses.
   */
  track(...keys: string[]): void {
    let changed = false;
    for (const key of keys) {
      if (!this.syncs(key) || this.meta.keys[key] || this.opts.local.get(key) === null) continue;
      this.meta.keys[key] = { rev: 0, dirty: true, at: 0 };
      changed = true;
    }
    if (changed) this.saveMeta();
  }
}
