// In-app purchases behind the Platform seam. Native hosts answer asynchronously through the
// bridge; MockPurchases stands in on the web (`?store=mock`) and in tests so a game's shop
// can be exercised without a device or a store account.

import type { BlackironHostApi } from "../render/native.ts";
import type { StoreBackend } from "../save/store.ts";
import type { PurchaseResult, Purchases, StoreProduct } from "./types.ts";

const RESULTS: readonly PurchaseResult[] = ["purchased", "restored", "cancelled", "pending", "failed", "unavailable"];

const parseIds = (json: unknown): string[] => (Array.isArray(json) ? json.filter((x): x is string => typeof x === "string") : []);

/** Purchases relayed to StoreKit or Play Billing by the native host. */
export class HostPurchases implements Purchases {
  private next = 1;
  private readonly waiting = new Map<number, (json: unknown) => void>();
  private readonly listeners = new Set<(owned: string[]) => void>();
  /** Read from the host on first use, so games that never sell anything never start the store. */
  private cache: string[] | null = null;

  constructor(private readonly host: BlackironHostApi) {}

  /** Whether this host build has a store at all. */
  static supported(host: BlackironHostApi): boolean {
    return typeof host.purchaseRequest === "function";
  }

  private readOwned(): string[] {
    try {
      return parseIds(JSON.parse(this.host.purchaseOwned?.() ?? "[]"));
    } catch {
      return [];
    }
  }

  private request(op: string, arg: string): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      try {
        this.host.purchaseRequest!(id, op, arg);
      } catch {
        this.waiting.delete(id);
        resolve({ error: "unavailable" });
      }
    });
  }

  /** Called by the host bridge. Request id 0 carries an unsolicited entitlement update. */
  deliver(requestId: number, json: string): void {
    let data: unknown = null;
    try {
      data = JSON.parse(json);
    } catch {
      data = { error: "failed" };
    }
    const owned = (data as { owned?: unknown } | null)?.owned;
    if (owned !== undefined) this.setOwned(parseIds(owned));
    const done = this.waiting.get(requestId);
    this.waiting.delete(requestId);
    done?.(data);
  }

  private setOwned(ids: string[]): void {
    const old = this.cache ?? [];
    const changed = ids.length !== old.length || ids.some((id) => !old.includes(id));
    this.cache = ids;
    if (changed) for (const cb of this.listeners) cb([...ids]);
  }

  async products(ids: string[]): Promise<StoreProduct[]> {
    const data = (await this.request("products", JSON.stringify(ids))) as { products?: unknown };
    if (!Array.isArray(data?.products)) return [];
    return data.products
      .filter((p): p is StoreProduct => !!p && typeof p.id === "string" && typeof p.price === "string")
      .map((p) => ({ id: p.id, title: typeof p.title === "string" ? p.title : p.id, price: p.price }));
  }

  async buy(id: string): Promise<PurchaseResult> {
    const data = (await this.request("buy", id)) as { result?: unknown; error?: unknown };
    const r = data?.result ?? data?.error;
    return RESULTS.includes(r as PurchaseResult) ? (r as PurchaseResult) : "failed";
  }

  async restore(): Promise<string[]> {
    const data = (await this.request("restore", "")) as { owned?: unknown; error?: unknown };
    if (data?.error) throw new Error(`Store restore failed: ${String(data.error)}`);
    return parseIds(data?.owned);
  }

  owned(): string[] {
    this.cache ??= this.readOwned();
    return [...this.cache];
  }

  onChange(cb: (owned: string[]) => void): () => void {
    this.cache ??= this.readOwned();
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

/**
 * A pretend store for development: every product exists at a fixed price and every purchase
 * succeeds (or does what `next` says). Entitlements persist in the given storage, so a
 * reload behaves like a reinstall that restores.
 */
export class MockPurchases implements Purchases {
  /** Outcome of the next `buy`; resets to "purchased" afterwards. */
  next: PurchaseResult = "purchased";
  readonly bought: string[] = [];
  private readonly listeners = new Set<(owned: string[]) => void>();
  private ownedIds: string[];

  constructor(
    private readonly storage?: StoreBackend,
    readonly price = "$4.99",
  ) {
    let saved: string[] = [];
    try {
      saved = parseIds(JSON.parse(storage?.get("blackiron.mockstore") ?? "[]"));
    } catch {
      saved = [];
    }
    this.ownedIds = saved;
  }

  async products(ids: string[]): Promise<StoreProduct[]> {
    return ids.map((id) => ({ id, title: id, price: this.price }));
  }

  async buy(id: string): Promise<PurchaseResult> {
    const result = this.next;
    this.next = "purchased";
    if (result === "purchased" && !this.ownedIds.includes(id)) {
      this.bought.push(id);
      this.ownedIds.push(id);
      try {
        this.storage?.set("blackiron.mockstore", JSON.stringify(this.ownedIds));
      } catch {
        // A full or blocked storage only costs the mock its memory across reloads.
      }
      for (const cb of this.listeners) cb(this.owned());
    }
    return result;
  }

  async restore(): Promise<string[]> {
    return this.owned();
  }

  owned(): string[] {
    return [...this.ownedIds];
  }

  onChange(cb: (owned: string[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
