import { Anchor, Button, FocusGroup, Label, Panel, Scene } from "@kiln/engine/scene";
import { BUTTON, DISPLAY_SMALL, UI } from "../fonts.ts";
import { PlayScene } from "./play.ts";
import { TitleScene } from "./title.ts";

export class OverScene extends Scene {
  private focus = new FocusGroup();

  constructor(
    private readonly won: boolean,
    private readonly rounds: number,
  ) {
    super();
    this.name = "over";
  }

  override ready(): void {
    this.background = 0x15121f;
    const pw = 420;
    const ph = 220;
    const box = this.ui.add(new Anchor({ x: "center", y: "center", w: pw, h: ph }));
    box.add(new Panel(0, 0, pw, ph));
    box.add(new Label(this.won ? "VICTORY" : "DEFEAT", pw / 2, 24, { font: DISPLAY_SMALL, align: "center", color: this.won ? 0x8ff5e6 : 0xff8a7a, shadow: 0x000000 }));
    box.add(new Label(`${this.rounds} round${this.rounds === 1 ? "" : "s"}`, pw / 2, 84, { font: UI, align: "center", color: 0xd9d6ec, shadow: 0x000000 }));
    const again = box.add(new Button("AGAIN", 30, 144, 170, 46, { action: "again", style: { font: BUTTON } }));
    const title = box.add(new Button("TITLE", pw - 30 - 170, 144, 170, 46, { action: "title", style: { font: BUTTON } }));
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
