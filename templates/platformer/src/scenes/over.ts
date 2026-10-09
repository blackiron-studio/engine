import { Anchor, Button, FocusGroup, Label, Panel, Scene } from "@blackiron-studio/engine/scene";
import { BUTTON, DISPLAY_SMALL, UI, UI_SMALL } from "../fonts.ts";
import { buildBackdrop } from "./backdrop.ts";
import { PlayScene } from "./play.ts";
import { TitleScene } from "./title.ts";

export class OverScene extends Scene {
  private focus = new FocusGroup();

  constructor(
    private readonly time: number,
    private readonly deaths: number,
    private readonly coins: number,
    private readonly coinsTotal: number,
    private readonly isBest: boolean,
  ) {
    super();
    this.name = "over";
  }

  override ready(): void {
    buildBackdrop(this.world, 640);
    this.camera.x = 640;
    this.camera.y = 360;
    const pw = 460;
    const ph = 240;
    const box = this.ui.add(new Anchor({ x: "center", y: "center", w: pw, h: ph }));
    box.add(new Panel(0, 0, pw, ph));
    box.add(new Label("FLAG REACHED", pw / 2, 22, { font: DISPLAY_SMALL, align: "center", color: 0xffe08a, shadow: 0x3a1c0a }));
    box.add(new Label(`${this.time.toFixed(1)}s  ·  ${this.coins}/${this.coinsTotal} coins  ·  ${this.deaths} falls`, pw / 2, 84, { font: UI, align: "center", color: 0xe6e3f2, shadow: 0x000000 }));
    box.add(new Label(this.isBest ? "NEW BEST TIME!" : "", pw / 2, 116, { font: UI_SMALL, align: "center", color: 0x8ff5e6, shadow: 0x000000 }));
    const again = box.add(new Button("AGAIN", 30, 164, 190, 46, { action: "again", style: { font: BUTTON } }));
    const title = box.add(new Button("TITLE", pw - 30 - 190, 164, 190, 46, { action: "title", style: { font: BUTTON } }));
    this.focus.items = [again, title];
    this.focus.set(0);
  }

  override onAction(name: string, pressed: boolean): void {
    if (pressed && (name === "left" || name === "right")) {
      this.focus.move(name === "left" ? -1 : 1);
      return;
    }
    if (!pressed) return;
    if (name === "confirm" || name === "jump") {
      this.focus.current?.onPress();
      return;
    }
    if (name === "again") this.app.scenes.change(new PlayScene());
    else if (name === "title") this.app.scenes.change(new TitleScene());
  }
}
