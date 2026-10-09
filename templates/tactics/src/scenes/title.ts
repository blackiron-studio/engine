import { Anchor, Button, FocusGroup, Label, Scene, Sprite } from "@kiln/engine/scene";
import { BUTTON, DISPLAY, UI, UI_SMALL } from "../fonts.ts";
import { PlayScene } from "./play.ts";

export class TitleScene extends Scene {
  private focus = new FocusGroup();

  constructor() {
    super();
    this.name = "title";
  }

  override ready(): void {
    this.background = 0x15121f;
    const head = this.ui.add(new Anchor({ x: "center", y: "top", dy: 120 }));
    head.add(new Label("SKIRMISH", 0, 0, { font: DISPLAY, align: "center", color: 0xffe08a, shadow: 0x3a1c0a }));
    head.add(new Label("TACTICS STARTER", 0, 80, { font: UI, align: "center", color: 0xe6e3f2, shadow: 0x000000 }));
    const mid = this.ui.add(new Anchor({ x: "center", y: "center", dy: 40, w: 240, h: 48 }));
    const blue = mid.add(new Sprite("soldier.0", 60, -30));
    blue.scale = 2;
    const red = mid.add(new Sprite("brute.1", 180, -30));
    red.scale = 2;
    red.flipX = true;
    const play = mid.add(new Button("PLAY", 0, 20, 240, 48, { action: "play", style: { font: BUTTON } }));
    this.focus.items = [play];
    const foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -40, safe: 12 }));
    foot.add(new Label("Four units a side. Defeat the red team.", 0, 0, { font: UI_SMALL, align: "center", color: 0xaaa6c8, shadow: 0x000000 }));
  }

  override onAction(name: string, pressed: boolean): void {
    if (this.focus.onAction(name, pressed)) return;
    if (pressed && (name === "play" || name === "confirm")) this.app.scenes.change(new PlayScene());
  }
}
