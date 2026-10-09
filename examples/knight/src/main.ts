// A knight from a generated sheet walks a meadow, twice: on the left the sheet's frames, picked
// by facing from the sprite set the importer wrote; on the right the same knight as a cutout rig,
// seven parts cut from one frame and posed by the engine's clips. The strip along the top shows
// each frame the importer found.

import "./art.ts";
import type { App } from "@kiln/engine/app";
import { Rng } from "@kiln/engine/core";
import { Anchor, AnimatedSprite, type DrawContext, Label, Node2D, Rig2D, Scene, TileMap } from "@kiln/engine/scene";

const UI = { family: "Instrument Sans", size: 18, weight: 500 } as const;
const FRAMES = 16;

/** Every imported frame with its index, so the import can be read at a glance. */
class Strip extends Node2D {
  override render(ctx: DrawContext): void {
    for (let i = 0; i < FRAMES; i++) {
      const x = i * 76 + 40;
      ctx.rect(x - 34, 0, 68, 78, 0x0e0c14, 0.5);
      ctx.sprite(`knight.${i}`, x, 72, { sx: 1, sy: 1 });
      ctx.text(String(i), x, 80, { align: "center", color: 0xc8d0dc, font: UI });
    }
  }
}

class KnightScene extends Scene {
  private knight!: AnimatedSprite;
  private rig!: Rig2D;
  private busy = false;
  private hint!: Label;

  override ready(): void {
    this.name = "knight";
    const rng = new Rng(3);
    const rows: number[][] = [];
    for (let r = 0; r < 23; r++) {
      const row: number[] = [];
      for (let c = 0; c < 40; c++) row.push(rng.chance(0.06) ? 3 : rng.chance(0.7) ? 0 : rng.chance(0.5) ? 1 : 2);
      rows.push(row);
    }
    this.world.add(new TileMap({ data: rows, tileSize: 32, tiles: { 0: "floor.0", 1: "floor.1", 2: "floor.2", 3: "stone" } }));

    // The sheet: one animation name, the facing picks the frames.
    this.knight = this.world.add(new AnimatedSprite("knight.idle", 540, 440));
    this.knight.scale = 2;
    this.knight.onFinished = () => {
      this.busy = false;
      this.knight.material = null;
      this.knight.play("knight.idle");
    };
    this.knight.onEvent = (name) => {
      if (name === "hit") this.hitStop(0.06);
    };

    // The rig: the same drawing as parts on bones, moving on its own.
    this.rig = this.world.add(new Rig2D("knight-rig"));
    this.rig.x = 740;
    this.rig.y = 440;
    this.rig.scale = 2;
    this.rig.play("idle");
    this.rig.onEvent = (name) => {
      if (name === "hit") this.hitStop(0.06);
    };

    this.camera.x = 640;
    this.camera.y = 360;
    this.ui.add(new Anchor({ x: "left", y: "top", dy: 12, safe: 10 })).add(new Strip());
    const foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -28, safe: 12 }));
    this.hint = foot.add(new Label("Move with WASD or the arrows. Space attacks, H hurts, V celebrates, E picks up, Shift guards. Click to attack.", 0, 0, { align: "center", color: 0xc8d0dc, font: UI, shadow: 0x000000 }));
    foot.add(new Label("Left: the sheet's frames, picked by facing (kiln art import). Right: the same knight as a cutout rig, seven parts from frame 3 posed by clips (kiln art parts).", 0, -26, { align: "center", color: 0x8a98a8, font: UI, shadow: 0x000000 }));
  }

  /** One-shots on both: the sheet's animation and the rig's clip, on a layer when the legs should keep going. */
  private once(anim: string, clip: string, layer = false): void {
    if (this.busy) return;
    this.busy = true;
    this.knight.play(anim, true);
    // A hurt flashes white through the flash material; the rig's parts flash too.
    if (anim === "knight.hurt") {
      this.knight.material = { kind: "flash", p0: 0.85 };
      for (const part of this.rig.parts.values()) part.material = { kind: "flash", p0: 0.85 };
      this.tweens.after(0.15, () => {
        for (const part of this.rig.parts.values()) part.material = null;
      });
    }
    // Poses the sheet cannot time (single frames without a hold) return to idle after a moment.
    if (!this.knight.willFinish) this.tweens.after(0.7, () => this.knight.onFinished?.(anim));
    if (layer) this.rig.layer("upper", clip, true);
    else this.rig.play(clip, true);
  }

  override onAction(name: string, pressed: boolean): void {
    if (!pressed) return;
    if (name === "attack") this.once("knight.attack", "swing", true);
    else if (name === "hurt") this.once("knight.hurt", "hurt");
    else if (name === "victory") this.once("knight.victory", "cast");
    else if (name === "pickup") this.once("knight.pickup", "thrust");
  }

  override onPointerDown(): void {
    this.once("knight.attack", "swing", true);
  }

  override update(dt: number): void {
    const app = this.app;
    if (app.input.isDown("guard") && !this.busy) {
      this.knight.play("knight.guard");
      this.rig.play("carry");
      return;
    }
    const v = app.input.vector("left", "right", "up", "down");
    if (v.x === 0 && v.y === 0 && app.gamepad.connected) {
      v.x = app.gamepad.leftStick.x;
      v.y = app.gamepad.leftStick.y;
    }
    const moving = Math.hypot(v.x, v.y) > 0.05;
    if (moving) {
      const dx = v.x * 160 * dt;
      const dy = v.y * 160 * dt;
      this.knight.x = Math.max(40, Math.min(600, this.knight.x + dx));
      this.knight.y = Math.max(180, Math.min(700, this.knight.y + dy));
      this.rig.x = Math.max(680, Math.min(1240, this.rig.x + dx));
      this.rig.y = Math.max(180, Math.min(700, this.rig.y + dy));
      this.knight.face(v.x, v.y);
      this.rig.face(v.x);
    }
    if (this.busy) return;
    this.knight.play(moving ? "knight.walk" : "knight.idle");
    if (!this.rig.busy) this.rig.play(moving ? "walk" : "idle");
  }
}

export default async function main(app: App): Promise<void> {
  app.input.map({
    left: ["KeyA", "ArrowLeft", "GamepadDpadLeft", "GamepadLeftStickLeft"],
    right: ["KeyD", "ArrowRight", "GamepadDpadRight", "GamepadLeftStickRight"],
    up: ["KeyW", "ArrowUp", "GamepadDpadUp", "GamepadLeftStickUp"],
    down: ["KeyS", "ArrowDown", "GamepadDpadDown", "GamepadLeftStickDown"],
    attack: ["Space", "GamepadA"],
    hurt: ["KeyH", "GamepadB"],
    victory: ["KeyV", "GamepadY"],
    pickup: ["KeyE", "GamepadX"],
    guard: ["ShiftLeft", "ShiftRight", "GamepadL1"],
  });
  app.scenes.change(new KnightScene());
}
