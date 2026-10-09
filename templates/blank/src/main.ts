import "./art.ts";
import type { App } from "@kiln/engine/app";
import { Anchor, Label, Scene, Sprite, TouchControls } from "@kiln/engine/scene";

const UI = { family: "Instrument Sans", size: 22, weight: 600 };

class Main extends Scene {
  hero!: Sprite;
  star!: Sprite;
  t = 0;

  override ready(): void {
    this.background = 0x1b2434;
    this.hero = this.world.add(new Sprite("hero", this.width / 2, this.height / 2));
    this.star = this.world.add(new Sprite("star", this.width / 2, this.height / 2 - 80));
    this.star.additive = true;
    this.star.emissive = true;
    const top = this.ui.add(new Anchor({ x: "center", y: "top", safe: 16 }));
    top.add(new Label("Arrows or WASD to move", 0, 0, { font: UI, align: "center", shadow: 0x000000 }));
    this.ui.add(new TouchControls({ stick: { left: "left", right: "right", up: "up", down: "down" } }));
  }

  override update(dt: number): void {
    this.t += dt;
    const v = this.app.input.vector("left", "right", "up", "down");
    this.hero.x += v.x * 160 * dt;
    this.hero.y += v.y * 160 * dt;
    if (v.x !== 0) this.hero.flipX = v.x < 0;
    this.star.y = this.height / 2 - 80 + Math.sin(this.t * 3) * 8;
  }
}

/** Called by the entry wrapper once the App exists, on the web and natively. */
export default async function main(app: App): Promise<void> {
  app.input.map({
    left: ["KeyA", "ArrowLeft", "GamepadDpadLeft", "GamepadLeftStickLeft"],
    right: ["KeyD", "ArrowRight", "GamepadDpadRight", "GamepadLeftStickRight"],
    up: ["KeyW", "ArrowUp", "GamepadDpadUp", "GamepadLeftStickUp"],
    down: ["KeyS", "ArrowDown", "GamepadDpadDown", "GamepadLeftStickDown"],
  });
  app.scenes.change(new Main());
}
