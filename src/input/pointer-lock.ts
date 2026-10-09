import type { ActionMap } from "./actions.ts";

/** Browser-relative mouse input. Request from a user gesture; disposal releases held buttons. */
export class PointerLockInput {
  private dx = 0;
  private dy = 0;
  private pending = false;
  private disposed = false;
  private pointerId: number | null = null;
  private fallback = false;
  private fallbackPointer: number | null = null;
  private drag: { id: number; x: number; y: number } | null = null;
  private held = new Set<string>();
  private cleanup: (() => void)[] = [];
  onChange: ((locked: boolean) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  constructor(
    readonly element: HTMLElement,
    private actions?: ActionMap,
  ) {
    const doc = element.ownerDocument;
    const listen = (
      target: EventTarget,
      type: string,
      fn: (event: any) => void,
    ) => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    listen(element, "pointerdown", (e: PointerEvent) => {
      this.pointerId = e.pointerId;
      if (!this.fallback || this.locked || e.pointerType === "touch") return;
      this.fallbackPointer = e.pointerId;
      this.updateFallback(e);
      element.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    listen(doc, "pointermove", (e: PointerEvent) => {
      if (this.fallback && !this.locked && this.fallbackPointer === e.pointerId)
        this.updateFallback(e);
    });
    listen(doc, "pointerup", (e: PointerEvent) => {
      if (this.fallback && this.fallbackPointer === e.pointerId) {
        this.updateFallback(e);
        if (e.buttons === 0) this.fallbackPointer = null;
      }
    });
    listen(doc, "pointercancel", () => this.clear());
    listen(element, "lostpointercapture", () => {
      if (this.fallback) this.clear();
    });
    listen(doc, "mousemove", (e: MouseEvent) => {
      if (this.locked) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    });
    listen(doc, "mousedown", (e: MouseEvent) => {
      if (!this.locked) return;
      const code = `Mouse${e.button}`;
      this.held.add(code);
      this.actions?.keyDown(code);
      e.preventDefault();
    });
    listen(doc, "mouseup", (e: MouseEvent) => {
      const code = `Mouse${e.button}`;
      if (this.held.delete(code)) this.actions?.keyUp(code);
    });
    listen(element, "contextmenu", (e: Event) => {
      if (this.locked || this.fallback) e.preventDefault();
    });
    listen(doc, "pointerlockchange", () => {
      this.pending = false;
      if (this.locked) this.fallback = false;
      this.clear();
      this.onChange?.(this.locked);
    });
    listen(doc, "pointerlockerror", () => {
      this.pending = false;
      this.onError?.(
        "Mouse capture was denied. Click the game to retry, or use keyboard aiming.",
      );
    });
    if (doc.defaultView) listen(doc.defaultView, "blur", () => this.release());
  }
  private updateFallback(e: PointerEvent): void {
    // Chorded buttons produce pointermove, not another pointerdown/up.
    if (e.buttons & 2) {
      if (this.drag) {
        this.dx += e.clientX - this.drag.x;
        this.dy += e.clientY - this.drag.y;
      }
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    } else this.drag = null;
    for (const [button, bit] of [
      [0, 1],
      [1, 4],
      [3, 8],
      [4, 16],
    ]) {
      const code = `Mouse${button}`;
      if (e.buttons & bit && !this.held.has(code)) {
        this.held.add(code);
        this.actions?.keyDown(code);
      } else if (!(e.buttons & bit) && this.held.delete(code))
        this.actions?.keyUp(code);
    }
  }
  get locked(): boolean {
    return this.element.ownerDocument.pointerLockElement === this.element;
  }
  get dragFallback(): boolean {
    return this.fallback;
  }
  /** Opt-in for browsers without pointer lock: right-drag looks, other mouse buttons bind actions. */
  setDragFallback(enabled: boolean): void {
    if (this.disposed || this.fallback === enabled) return;
    this.clear();
    this.fallback = enabled && !this.locked;
  }
  async request(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.locked) return true;
    if (this.pending) return false;
    if (!this.element.requestPointerLock) {
      this.onError?.("This browser does not support mouse capture.");
      return false;
    }
    this.pending = true;
    try {
      // Stop the regular canvas UI's drag capture before switching input modes.
      if (
        this.pointerId !== null &&
        this.element.hasPointerCapture?.(this.pointerId)
      )
        this.element.releasePointerCapture(this.pointerId);
      await this.element.requestPointerLock();
      return this.locked;
    } catch (error) {
      this.pending = false;
      this.onError?.(String(error));
      return false;
    }
  }
  /** Consume once per simulation update: catch-up steps never repeat one mouse delta. */
  consume(): { x: number; y: number } {
    const out = { x: this.dx, y: this.dy };
    this.dx = this.dy = 0;
    return out;
  }
  clear(): void {
    this.dx = this.dy = 0;
    this.drag = null;
    this.fallbackPointer = null;
    for (const code of this.held) this.actions?.keyUp(code);
    this.held.clear();
  }
  release(): void {
    this.fallback = false;
    this.clear();
    if (this.locked) this.element.ownerDocument.exitPointerLock();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onChange = this.onError = null;
    this.release();
    for (const cleanup of this.cleanup.splice(0)) cleanup();
  }
}
