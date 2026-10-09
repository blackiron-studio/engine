// Unified mouse / touch / pen pointer in logical canvas coordinates, plus the full set of
// live touches for on-screen controls.

import type { PointerSnapshot } from "../scene/ui.ts";

export interface Touch {
  x: number;
  y: number;
}

export class Pointer {
  x = 0;
  y = 0;
  down = false;
  justPressed = false;
  justReleased = false;
  /** Whether the pointer is over the canvas. */
  inside = false;
  button = 0;
  type: "mouse" | "touch" | "pen" = "mouse";
  /** Position where the current press started. */
  pressX = 0;
  pressY = 0;
  /** Wheel delta accumulated this frame. */
  wheel = 0;
  /** Every contact currently down, by pointer id. Touch controls read this. */
  readonly touches = new Map<number, Touch>();
  private activeId: number | null = null;
  private routingPressed = false;
  private routingReleased = false;

  handleMove(x: number, y: number, type: Pointer["type"] = "mouse", id = 0): void {
    if (this.activeId === null || this.activeId === id) {
      this.x = x;
      this.y = y;
    }
    this.type = type;
    this.inside = true;
    const t = this.touches.get(id);
    if (t) {
      t.x = x;
      t.y = y;
    }
  }

  handleDown(x: number, y: number, button = 0, id = 0, type: Pointer["type"] = "mouse"): void {
    this.touches.set(id, { x, y });
    this.type = type;
    this.inside = true;
    if (this.down && this.activeId !== null && this.activeId !== id) return;
    this.activeId = id;
    this.x = x;
    this.y = y;
    this.button = button;
    this.down = true;
    this.justPressed = true;
    this.routingPressed = true;
    this.pressX = x;
    this.pressY = y;
  }

  handleUp(x: number, y: number, id = 0): void {
    this.touches.delete(id);
    if (this.activeId !== null && this.activeId !== id) return;
    this.x = x;
    this.y = y;
    if (this.down) this.justReleased = this.routingReleased = true;
    this.down = false;
    this.activeId = null;
  }

  handleLeave(): void {
    this.inside = false;
  }

  handleWheel(delta: number): void {
    this.wheel += delta;
  }

  /** Force-release, for focus loss. */
  cancel(): void {
    if (this.down) this.justReleased = this.routingReleased = true;
    this.down = false;
    this.activeId = null;
    this.touches.clear();
  }

  endFrame(): void {
    this.justPressed = false;
    this.justReleased = false;
    this.wheel = 0;
  }

  snapshot(): PointerSnapshot {
    return { x: this.x, y: this.y, down: this.down, justPressed: this.justPressed, justReleased: this.justReleased };
  }

  /** Consume UI edges once per render frame, retaining simulation edges until a fixed step. */
  consumeRoutingSnapshot(): PointerSnapshot {
    const snapshot = { x: this.x, y: this.y, down: this.down, justPressed: this.routingPressed, justReleased: this.routingReleased };
    this.routingPressed = this.routingReleased = false;
    return snapshot;
  }
}
