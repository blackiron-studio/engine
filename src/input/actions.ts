// Named actions bound to key codes. Games ask "is jump down?" and never see raw keys,
// so touch buttons and gamepads can drive the same actions later.

export type Binding = string | string[];

export interface ActionEvent {
  name: string;
  pressed: boolean;
}

export class ActionMap {
  private readonly bindings = new Map<string, string[]>();
  /** What the player last pressed with; menus and hints show matching glyphs. */
  lastDevice: "keyboard" | "gamepad" | "touch" = "keyboard";
  private readonly byCode = new Map<string, string[]>();
  private readonly codesDown = new Set<string>();
  private readonly down = new Map<string, number>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly events: ActionEvent[] = [];
  private readonly eventSources = new WeakMap<ActionEvent, object>();
  private source: object | null = null;

  /** @internal Aliases from one physical key edge share an opaque dispatch source. */
  sourceOf(event: ActionEvent): object | undefined { return this.eventSources.get(event); }
  private enqueue(name: string, pressed: boolean): void {
    const event = { name, pressed };
    if (this.source) this.eventSources.set(event, this.source);
    this.events.push(event);
  }

  /** Bind several actions at once: `{ jump: "Space", left: ["KeyA", "ArrowLeft"] }`. */
  map(b: Record<string, Binding>): this {
    for (const [action, codes] of Object.entries(b)) this.bind(action, codes);
    return this;
  }

  bind(action: string, codes: Binding): this {
    const list = [...new Set(Array.isArray(codes) ? codes : [codes])];
    const previous = this.bindings.get(action) ?? [];
    // Reconcile only keyboard/gamepad sources; directly pressed touch sources stay held.
    const heldBefore = previous.filter((code) => this.codesDown.has(code)).length;
    const heldAfter = list.filter((code) => this.codesDown.has(code)).length;
    // Codes the action no longer answers to stop routing to it (rebinding in a settings menu).
    for (const old of this.bindings.get(action) ?? []) {
      if (list.includes(old)) continue;
      const arr = this.byCode.get(old);
      if (!arr) continue;
      const i = arr.indexOf(action);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.byCode.delete(old);
    }
    this.bindings.set(action, list);
    for (const c of list) {
      const arr = this.byCode.get(c) ?? [];
      if (!arr.includes(action)) arr.push(action);
      this.byCode.set(c, arr);
    }
    for (let i = heldBefore; i < heldAfter; i++) this.press(action);
    for (let i = heldAfter; i < heldBefore; i++) this.release(action);
    return this;
  }

  bindingsOf(action: string): string[] {
    return [...(this.bindings.get(action) ?? [])];
  }

  isBound(code: string): boolean {
    return this.byCode.has(code);
  }

  actions(): string[] {
    return [...this.bindings.keys()];
  }

  isDown(action: string): boolean {
    return (this.down.get(action) ?? 0) > 0;
  }

  justPressed(action: string): boolean {
    return this.pressed.has(action);
  }

  justReleased(action: string): boolean {
    return this.released.has(action);
  }

  /** -1, 0 or 1 from a pair of opposing actions. */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  /** Normalised movement vector from four actions. */
  vector(left: string, right: string, up: string, down: string): { x: number; y: number } {
    const x = this.axis(left, right);
    const y = this.axis(up, down);
    if (x !== 0 && y !== 0) {
      const k = Math.SQRT1_2;
      return { x: x * k, y: y * k };
    }
    return { x, y };
  }

  /** Feed a raw key code going down; returns true if it maps to an action. */
  keyDown(code: string): boolean {
    if (this.codesDown.has(code)) return this.byCode.has(code);
    this.codesDown.add(code);
    this.lastDevice = code.startsWith("Gamepad") ? "gamepad" : "keyboard";
    const acts = this.byCode.get(code);
    if (!acts) return false;
    this.source = {};
    try { for (const a of acts) this.press(a); }
    finally { this.source = null; }
    return true;
  }

  keyUp(code: string): boolean {
    if (!this.codesDown.delete(code)) return this.byCode.has(code);
    const acts = this.byCode.get(code);
    if (!acts) return false;
    this.source = {};
    try { for (const a of acts) this.release(a); }
    finally { this.source = null; }
    return true;
  }

  /** Press an action directly (touch controls, tests). Reference counted per source. */
  press(action: string): void {
    const n = this.down.get(action) ?? 0;
    this.down.set(action, n + 1);
    if (n === 0) {
      this.pressed.add(action);
      this.enqueue(action, true);
    }
  }

  release(action: string): void {
    const n = this.down.get(action) ?? 0;
    if (n <= 0) return;
    this.down.set(action, n - 1);
    if (n === 1) {
      this.released.add(action);
      this.enqueue(action, false);
    }
  }

  /** Take the queued press/release events since the last drain. */
  drain(): ActionEvent[] {
    const out = this.events.splice(0, this.events.length);
    return out;
  }

  /** Clear per-frame edges. The App calls this after the first fixed step of a frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }

  /** Release everything, for focus loss. */
  reset(): void {
    for (const [a, n] of this.down) if (n > 0) this.events.push({ name: a, pressed: false });
    this.down.clear();
    this.codesDown.clear();
    this.pressed.clear();
    this.released.clear();
  }
}
