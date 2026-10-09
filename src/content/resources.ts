/** Deduplicated asynchronous resources with explicit, reference-counted ownership. */
export interface ResourceLoader<T> {
  load(key: string): Promise<T>;
  dispose(value: T): void;
  bytes?(value: T): number;
}
interface Entry<T> {
  key: string;
  refs: number;
  value?: T;
  ready: boolean;
  promise: Promise<T>;
}
export interface ResourceLease<T> {
  readonly value: Promise<T>;
  release(): void;
}
export class ResourceCache<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(private loader: ResourceLoader<T>) {}
  acquire(key: string): ResourceLease<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, refs: 0, ready: false, promise: null! };
      const current = entry;
      this.entries.set(key, current);
      current.promise = Promise.resolve()
        .then(() => this.loader.load(key))
        .then(
          (value) => {
            current.value = value;
            current.ready = true;
            if (current.refs === 0) this.releaseEntry(current);
            return value;
          },
          (error) => {
            if (this.entries.get(key) === current) this.entries.delete(key);
            throw error;
          },
        );
    }
    entry.refs++;
    const current = entry;
    let released = false;
    return {
      value: current.promise.then((value) => {
        if (released)
          throw new Error(
            `Resource lease released before loading completed: ${key}`,
          );
        return value;
      }),
      release: () => {
        if (released) return;
        released = true;
        if (--current.refs === 0 && current.ready) this.releaseEntry(current);
      },
    };
  }
  private releaseEntry(entry: Entry<T>): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.ready) {
      entry.ready = false;
      this.loader.dispose(entry.value!);
      entry.value = undefined;
    }
  }
  /** In-use resources cannot be invalidated underneath another scene. */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.refs)
      throw new Error(`Cannot invalidate leased resource: ${key}`);
    if (entry) this.releaseEntry(entry);
  }
  get stats(): {
    entries: number;
    references: number;
    pending: number;
    bytes: number;
  } {
    let references = 0,
      pending = 0,
      bytes = 0;
    for (const e of this.entries.values()) {
      references += e.refs;
      if (!e.ready) pending++;
      else bytes += this.loader.bytes?.(e.value!) ?? 0;
    }
    return { entries: this.entries.size, references, pending, bytes };
  }
}

/** Own a scene's leases and disposables; disposal is idempotent and drains every item. */
export class ResourceScope {
  private cleanup: (() => void)[] = [];
  private closed = false;
  own<T extends { dispose(): void }>(resource: T): T {
    this.defer(() => resource.dispose());
    return resource;
  }
  defer(cleanup: () => void): void {
    if (this.closed) {
      cleanup();
      throw new Error("ResourceScope is disposed");
    }
    this.cleanup.push(cleanup);
  }
  acquire<T>(cache: ResourceCache<T>, key: string): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("ResourceScope is disposed"));
    const lease = cache.acquire(key);
    this.defer(lease.release);
    return lease.value;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const cleanup of this.cleanup.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Resource cleanup failed");
  }
  get count(): number {
    return this.cleanup.length;
  }
}
