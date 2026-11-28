// A knight from a generated sheet walks a meadow, twice: on the left the sheet's frames, picked
// by facing from the sprite set the importer wrote; on the right the same knight as a cutout rig,
// seven parts cut from one frame and posed by the engine's clips. The strip along the top shows
// each frame the importer found.

import "./art.ts";
import type { App } from "@blackiron-studio/engine/app";
import { Rng } from "@blackiron-studio/engine/core";
import { Anchor, AnimatedSprite, type DrawContext, Label, Node2D, Rig2D, Scene, TileMap } from "@blackiron-studio/engine/scene";

const UI = { family: "Instrument Sans", size: 18, weight: 500 } as const;
const FRAMES = 16;

/** Text on a phone: `ui.minPoints` shows a unit at 0.8 pt there, so 15 units is 12 pt. */
const UI_PHONE = { ...UI, size: 15 } as const;
const CELL = 76;

/**
 * Every imported frame with its index, so the import can be read at a glance. On a small screen
 * the UI layer is only about 850 units wide, so the strip shrinks to fit it; the numbers do not.
 */
class Strip extends Node2D {
  override render(ctx: DrawContext): void {
    const scene = this.scene;
    const compact = scene?.compact ?? false;
    // The strip is 16 cells from 6 units left of this node; the anchor keeps 10 units to the edge.
    const k = compact && scene ? Math.min(1, (scene.safeRect.w - 20) / (FRAMES * CELL)) : 1;
    for (let i = 0; i < FRAMES; i++) {
      const x = (i * CELL + 40) * k;
      ctx.rect(x - 34 * k, 0, 68 * k, 78 * k, 0x0e0c14, 0.5);
      ctx.sprite(`knight.${i}`, x, 72 * k, { sx: k, sy: k });
      ctx.text(String(i), x, 80 * k, { align: "center", color: 0xc8d0dc, font: compact ? UI_PHONE : UI });
    }
  }
}

class KnightScene extends Scene {
  private knight!: AnimatedSprite;
  private rig!: Rig2D;
  private busy = false;
  private hint!: Label;
  private about!: Label;
  private foot: Anchor | null = null;
  private builtStacked = false;
  private builtWidth = 0;

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
    this.ui.add(new Anchor({ x: "left", y: "top", dy: 12, safe: 10, safeArea: true })).add(new Strip());
    this.buildFoot();
  }

  /** On a touch screen the only input is a tap, so the hint says so. */
  private hintText(): string {
    const touch = this.screenInfo.touch || this.app.input.lastDevice === "touch" || this.app.pointer.type === "touch";
    return touch
      ? "Tap to attack. With a keyboard or a gamepad the knight walks, and is hurt, celebrates, picks up and guards."
      : "Move with WASD or the arrows. Space attacks, H hurts, V celebrates, E picks up, Shift guards. Click to attack.";
  }

  /** The two captions. One line each on a desktop; on a phone or tablet they wrap to the screen and stack up from the bottom. */
  private buildFoot(): void {
    this.foot?.destroy();
    // Wrapped on phones and tablets. A desktop keeps its one-line captions as designed.
    const stacked = (this.builtStacked = this.compact || this.screenInfo.touch);
    const font = this.compact ? UI_PHONE : UI;
    const about = "Left: the sheet's frames, picked by facing (blackiron art import). Right: the same knight as a cutout rig, seven parts from frame 3 posed by clips (blackiron art parts).";
    if (!stacked) {
      const foot = (this.foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -28, safe: 12, safeArea: true })));
      this.hint = foot.add(new Label(this.hintText(), 0, 0, { align: "center", color: 0xc8d0dc, font: UI, shadow: 0x000000 }));
      this.about = foot.add(new Label(about, 0, -26, { align: "center", color: 0x8a98a8, font: UI, shadow: 0x000000 }));
    } else {
      const wrap = Math.max(200, this.safeRect.w - 40);
      const foot = (this.foot = this.ui.add(new Anchor({ x: "center", y: "bottom", safe: 10, safeArea: true })));
      this.hint = foot.add(new Label(this.hintText(), 0, 0, { align: "center", color: 0xc8d0dc, font, shadow: 0x000000, wrap }));
      this.about = foot.add(new Label(about, 0, 0, { align: "center", color: 0x8a98a8, font, shadow: 0x000000, wrap }));
    }
    this.builtWidth = this.uiWidth;
    this.placeFoot();
  }

  private placeFoot(): void {
    this.hint.text = this.hintText();
    if (!this.builtStacked) return;
    this.hint.y = -this.hint.textHeight;
    this.about.y = this.hint.y - 6 - this.about.textHeight;
  }

  override onResize(): void {
    if (this.foot && ((this.compact || this.screenInfo.touch) !== this.builtStacked || (this.builtStacked && this.uiWidth !== this.builtWidth))) this.buildFoot();
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
    this.placeFoot();
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
