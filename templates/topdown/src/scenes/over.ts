import { Anchor, Button, FocusGroup, Label, Panel, Scene } from "@kiln/engine/scene";
import { BUTTON, DISPLAY, UI, UI_SMALL } from "../fonts.ts";
import { PlayScene } from "./play.ts";
import { TitleScene } from "./title.ts";

export class OverScene extends Scene {
  private focus = new FocusGroup();

  constructor(
    private readonly score: number,
    private readonly isBest: boolean,
  ) {
    super();
    this.name = "over";
  }

  override ready(): void {
    this.background = 0x0e1410;
    const pw = 420;
    const ph = 260;
    const box = this.ui.add(new Anchor({ x: "center", y: "center", w: pw, h: ph }));
    box.add(new Panel(0, 0, pw, ph));
    box.add(new Label("THE SLIMES WON", pw / 2, 22, { font: UI, align: "center", color: 0xd9d6ec, shadow: 0x000000 }));
    box.add(new Label(`${this.score}`, pw / 2, 52, { font: DISPLAY, align: "center", color: 0x8ff5e6, shadow: 0x0d2a2a }));
    box.add(new Label(this.isBest ? "NEW BEST!" : "GEMS", pw / 2, 132, { font: UI_SMALL, align: "center", color: this.isBest ? 0xffe08a : 0xaaa6c8, shadow: 0x000000 }));
    const again = box.add(new Button("AGAIN", 30, 180, 170, 46, { action: "again", style: { font: BUTTON } }));
    const title = box.add(new Button("TITLE", pw - 30 - 170, 180, 170, 46, { action: "title", style: { font: BUTTON } }));
    this.focus.items = [again, title];
    this.focus.set(0);
  }

  override onAction(name: string, pressed: boolean): void {
    if (pressed && (name === "left" || name === "right")) {
      this.focus.move(name === "left" ? -1 : 1);
      return;
    }
    if (!pressed) return;
    if (name === "confirm") {
      this.focus.current?.onPress();
      return;
    }
    if (name === "again") this.app.scenes.change(new PlayScene());
    else if (name === "title") this.app.scenes.change(new TitleScene());
  }
}
