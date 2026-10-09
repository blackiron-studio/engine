import type { ActionMap } from "./actions.ts";
import type { KilnHostApi } from "../render/native.ts";
const receivers = new WeakMap<ActionMap, NativePointerLockInput>();
/** Desktop relative mouse capture. The host acknowledges actual OS capture before locked becomes true. */
export class NativePointerLockInput {
  locked = false;
  readonly dragFallback = false;
  onChange: ((locked: boolean) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  private dx = 0;
  private dy = 0;
  private disposed = false;
  private wanted = false;
  private pending: ((locked: boolean) => void) | null = null;
  constructor(
    private host: Pick<KilnHostApi, "setPointerCapture">,
    private actions: ActionMap,
  ) {
    if (receivers.has(actions))
      throw Error("Pointer capture already owned by this input map");
    receivers.set(actions, this);
  }
  request(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.locked) return Promise.resolve(true);
    if (this.pending) return Promise.resolve(false);
    if (!this.host.setPointerCapture) {
      this.onError?.("Native host does not support mouse capture");
      return Promise.resolve(false);
    }
    this.wanted = true;
    return new Promise((resolve) => {
      this.pending = resolve;
      this.host.setPointerCapture!(true);
    });
  }
  /** @internal Host acknowledgment, including loss of window focus. */
  capture(locked: boolean): void {
    if (this.disposed) return;
    if (locked && !this.wanted) {
      this.host.setPointerCapture?.(false);
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending?.(locked);
    if (!locked) {
      this.wanted = false;
      this.clear();
      if (pending)
        this.onError?.(
          "Native mouse capture unavailable; keyboard aiming remains available",
        );
    }
    if (this.locked !== locked) {
      this.locked = locked;
      this.onChange?.(locked);
    }
  }
  /** @internal Raw device deltas, unscaled by display resolution. */
  motion(x: number, y: number): void {
    if (this.locked && Number.isFinite(x) && Number.isFinite(y)) {
      this.dx += x;
      this.dy += y;
    }
  }
  consume(): { x: number; y: number } {
    const value = { x: this.dx, y: this.dy };
    this.dx = this.dy = 0;
    return value;
  }
  clear(): void {
    this.dx = this.dy = 0;
    for (const key of ["Mouse0", "Mouse1", "Mouse2"]) this.actions.keyUp(key);
  }
  release(): void {
    this.wanted = false;
    this.pending?.(false);
    this.pending = null;
    this.host.setPointerCapture?.(false);
    this.capture(false);
  }
  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
    receivers.delete(this.actions);
  }
}
/** @internal App host bridge dispatch. */
export function nativePointerCapture(
  actions: ActionMap,
  locked: boolean,
): void {
  receivers.get(actions)?.capture(locked);
}
/** @internal App host bridge dispatch. */
export function nativePointerMotion(
  actions: ActionMap,
  x: number,
  y: number,
): void {
  receivers.get(actions)?.motion(x, y);
}
