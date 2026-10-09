// Minimal typed event emitter. `E` maps event names to their argument tuples.

type Listener<A extends unknown[]> = (...args: A) => void;

export class Emitter<E extends Record<string, unknown[]>> {
  private map = new Map<keyof E, Set<Listener<never>>>();

  on<K extends keyof E>(name: K, fn: Listener<E[K]>): () => void {
    let set = this.map.get(name);
    if (!set) this.map.set(name, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => this.off(name, fn);
  }

  once<K extends keyof E>(name: K, fn: Listener<E[K]>): () => void {
    const off = this.on(name, ((...args: E[K]) => {
      off();
      fn(...args);
    }) as Listener<E[K]>);
    return off;
  }

  off<K extends keyof E>(name: K, fn: Listener<E[K]>): void {
    this.map.get(name)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof E>(name: K, ...args: E[K]): void {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of [...set]) (fn as Listener<E[K]>)(...args);
  }

  clear(): void {
    this.map.clear();
  }

  count(name: keyof E): number {
    return this.map.get(name)?.size ?? 0;
  }
}
