import { Anchor, Button, FocusGroup, Label, Scene, Sprite } from "@blackiron-studio/engine/scene";
import { BUTTON, DISPLAY, UI, UI_SMALL } from "../fonts.ts";
import { saves } from "../store.ts";
import { buildBackdrop } from "./backdrop.ts";
import { PlayScene } from "./play.ts";

export class TitleScene extends Scene {
  private t = 0;
  private focus = new FocusGroup();

  constructor() {
    super();
    this.name = "title";
  }

  override ready(): void {
    buildBackdrop(this.world, 640);
    this.camera.followRate = 0;
    const head = this.ui.add(new Anchor({ x: "center", y: "top", dy: 110 }));
    head.add(new Label("CLIFFSIDE", 0, 0, { font: DISPLAY, align: "center", color: 0xffe08a, shadow: 0x3a1c0a }));
    head.add(new Label("PLATFORMER STARTER", 0, 80, { font: UI, align: "center", color: 0xe6e3f2, shadow: 0x000000 }));
    const mid = this.ui.add(new Anchor({ x: "center", y: "center", dy: 20, w: 240, h: 48 }));
    const hero = mid.add(new Sprite("hero.idle", 120, -20));
    hero.scale = 2;
    const play = mid.add(new Button("PLAY", 0, 20, 240, 48, { action: "play", style: { font: BUTTON } }));
    this.focus.items = [play];
    const best = saves.load().bestTime;
    if (best > 0) mid.add(new Label(`BEST ${best.toFixed(1)}S`, 120, 84, { font: UI_SMALL, align: "center", color: 0xffe08a, shadow: 0x000000 }));
    const foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -40, safe: 12 }));
    foot.add(new Label("Arrows or A/D to run, Space or W to jump. Gamepad and touch work too.", 0, 0, { font: UI_SMALL, align: "center", color: 0xe6e3f2, shadow: 0x000000 }));
  }

  override update(dt: number): void {
    this.t += dt;
    this.camera.x = 640 + this.t * 24;
    this.camera.y = 360;
  }

  override onAction(name: string, pressed: boolean): void {
    if (this.focus.onAction(name, pressed)) return;
    if (pressed && (name === "play" || name === "confirm" || name === "jump")) this.app.scenes.change(new PlayScene());
  }
}
