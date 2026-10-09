// Gamepads through the standard mapping. Buttons and stick directions become key codes
// like "GamepadA" or "GamepadLeftStickLeft", so they bind in the ActionMap next to keys.

import type { ActionMap } from "./actions.ts";

export const GAMEPAD_BUTTONS = ["A", "B", "X", "Y", "L1", "R1", "L2", "R2", "Select", "Start", "L3", "R3", "DpadUp", "DpadDown", "DpadLeft", "DpadRight", "Home"] as const;

export class GamepadInput {
  /** Stick travel needed to count as a direction. */
  deadzone = 0.5;
  private readonly down = new Set<string>();
  /** True when at least one pad was seen on the last poll. */
  connected = false;
  /** Left stick as a vector after the deadzone, for analog movement. */
  readonly leftStick = { x: 0, y: 0 };
  readonly rightStick = { x: 0, y: 0 };

  /** Read every connected pad and feed edges into the action map. Call once per frame. */
  poll(actions: ActionMap): void {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    if (!nav || typeof nav.getGamepads !== "function") { this.reset(actions); return; }
    let pads: (Gamepad | null)[];
    try {
      pads = nav.getGamepads();
    } catch {
      this.reset(actions);
      return;
    }
    const now = new Set<string>();
    this.connected = false;
    this.leftStick.x = this.leftStick.y = this.rightStick.x = this.rightStick.y = 0;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      this.connected = true;
      pad.buttons.forEach((b, i) => {
        if (b.pressed || b.value > 0.5) now.add(`Gamepad${GAMEPAD_BUTTONS[i] ?? i}`);
      });
      const [lx = 0, ly = 0, rx = 0, ry = 0] = pad.axes;
      const dz = this.deadzone;
      if (Math.hypot(lx, ly) > dz * 0.5) {
        this.leftStick.x = lx;
        this.leftStick.y = ly;
      }
      if (Math.hypot(rx, ry) > dz * 0.5) {
        this.rightStick.x = rx;
        this.rightStick.y = ry;
      }
      if (lx < -dz) now.add("GamepadLeftStickLeft");
      if (lx > dz) now.add("GamepadLeftStickRight");
      if (ly < -dz) now.add("GamepadLeftStickUp");
      if (ly > dz) now.add("GamepadLeftStickDown");
      if (rx < -dz) now.add("GamepadRightStickLeft");
      if (rx > dz) now.add("GamepadRightStickRight");
      if (ry < -dz) now.add("GamepadRightStickUp");
      if (ry > dz) now.add("GamepadRightStickDown");
    }
    for (const code of now) if (!this.down.has(code)) actions.keyDown(code);
    for (const code of this.down) if (!now.has(code)) actions.keyUp(code);
    this.down.clear();
    for (const code of now) this.down.add(code);
  }

  /** Release everything, for focus loss. */
  reset(actions: ActionMap): void {
    for (const code of this.down) actions.keyUp(code);
    this.down.clear();
    this.connected = false;
    this.leftStick.x = this.leftStick.y = this.rightStick.x = this.rightStick.y = 0;
  }
}
