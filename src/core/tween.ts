import { type EaseFn, type EaseName, resolveEase } from "./math.ts";

export interface TweenOptions {
  ease?: EaseName | EaseFn;
  delay?: number;
  onUpdate?: (t: number) => void;
  onDone?: () => void;
}

type Numeric<T> = { [K in keyof T]?: T[K] extends number ? number : never };

/** Interpolates numeric properties on any plain object. Drive it through a `Tweens` manager. */
export class Tween<T extends object = Record<string, number>> {
  private elapsed = 0;
  private started = false;
  private from: Record<string, number> = {};
  private readonly keys: string[];
  private readonly ease: EaseFn;
  done = false;

  constructor(
    readonly target: T,
    readonly to: Numeric<T>,
    readonly duration: number,
    private readonly opts: TweenOptions = {},
  ) {
    this.keys = Object.keys(to);
    this.ease = resolveEase(opts.ease);
    this.elapsed = -(opts.delay ?? 0);
  }

  /** Advance by `dt` seconds. Returns true once finished. */
  update(dt: number): boolean {
    if (this.done) return true;
    this.elapsed += dt;
    if (this.elapsed < 0) return false;
    if (!this.started) {
      this.started = true;
      const t = this.target as unknown as Record<string, number>;
      for (const k of this.keys) this.from[k] = t[k];
    }
    const raw = this.duration <= 0 ? 1 : Math.min(1, this.elapsed / this.duration);
    const e = this.ease(raw);
    const t = this.target as unknown as Record<string, number>;
    const to = this.to as unknown as Record<string, number>;
    for (const k of this.keys) t[k] = this.from[k] + (to[k] - this.from[k]) * e;
    this.opts.onUpdate?.(e);
    if (raw >= 1) {
      this.done = true;
      this.opts.onDone?.();
    }
    return this.done;
  }

  cancel(): void {
    this.done = true;
  }
}

/** Owns a list of tweens and steps them each frame. Scenes and the App each have one. */
export class Tweens {
  private list: Tween<object>[] = [];

  to<T extends object>(target: T, to: Numeric<T>, duration: number, opts?: TweenOptions): Tween<T> {
    const tw = new Tween(target, to, duration, opts);
    this.list.push(tw as Tween<object>);
    return tw;
  }

  /** Run a callback after a delay, as a tween with no properties. */
  after(delay: number, fn: () => void): Tween<object> {
    return this.to({}, {}, 0, { delay, onDone: fn });
  }

  update(dt: number): void {
    if (this.list.length === 0) return;
    let write = 0;
    for (let i = 0; i < this.list.length; i++) {
      const tw = this.list[i];
      if (!tw.update(dt)) this.list[write++] = tw;
    }
    this.list.length = write;
  }

  clear(): void {
    for (const t of this.list) t.cancel();
    this.list.length = 0;
  }

  get size(): number {
    return this.list.length;
  }
}
