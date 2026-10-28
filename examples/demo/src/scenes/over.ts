import { Anchor, Button, FocusGroup, Label, NineSlice, Scene, Sprite } from "@blackiron-studio/engine/scene";
import { BUTTON_SKINS } from "../look.ts";
import { BUTTON, CAPTION, DISPLAY, UI, UI_SMALL } from "../fonts.ts";
import { WORLD_H, WORLD_W, createGame } from "../game.ts";
import { saves } from "../store.ts";
import { buildHollow } from "./hollow.ts";
import { PlayScene } from "./play.ts";
import { TitleScene } from "./title.ts";

export class OverScene extends Scene {
  private focus = new FocusGroup();

  constructor(
    private readonly score: number,
    private readonly isBest: boolean,
    private readonly seed: string | number,
  ) {
    super();
    this.name = "over";
  }

  override ready(): void {
    const state = createGame(this.seed);
    buildHollow(this.world, state, 0x283650);
    this.camera.bounds = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
    this.camera.x = WORLD_W / 2;
    this.camera.y = WORLD_H / 2;
    this.post.brightness = 0.6;
    this.post.saturation = 0.7;
    this.post.vignette = 0.7;

    const pw = 480;
    const ph = 300;
    const box = this.ui.add(new Anchor({ x: "center", y: "center", w: pw, h: ph }));
    box.add(new NineSlice("wh.ui.plate", -6, -6, pw + 12, ph + 12, 16));
    box.add(new Label("THE LANTERN WENT OUT", pw / 2, 26, { font: UI, align: "center", color: 0xd8e8e4, shadow: 0x02060c }));
        box.add(new Label(`${this.score}`, pw / 2, 58, { font: DISPLAY, align: "center", color: 0xffd98a, shadow: 0x2a1406 }));
    box.add(new Sprite("wh.ui.rule", pw / 2, 138));
    box.add(new Label(this.score === 1 ? "EMBER GATHERED" : "EMBERS GATHERED", pw / 2, 148, { font: CAPTION, align: "center", color: 0xffe3ae }));
    const best = saves.load().best;
    box.add(new Label(this.isBest ? "NEW BEST!" : `BEST ${best}`, pw / 2, 172, { font: UI_SMALL, align: "center", color: this.isBest ? 0x8de9d8 : 0x8fb0aa, shadow: 0x02060c }));
    if (this.isBest) {
      const glow = box.add(new Sprite("__blob", pw / 2, 182));
      glow.scaleX = 6;
      glow.scaleY = 2;
      glow.tint = 0x66ffe0;
      glow.additive = true;
      glow.alpha = 0.25;
    }
    const again = box.add(new Button("PLAY AGAIN", 32, 216, 200, 46, { action: "again", style: { font: BUTTON, skin: BUTTON_SKINS.primary, text: 0x2a1406, textShadow: null } }));
    const title = box.add(new Button("TITLE", pw - 32 - 200, 216, 200, 46, { action: "title", style: { font: BUTTON, skin: BUTTON_SKINS.quiet, text: 0xd8e8e4 } }));
    this.focus.items = [again, title];
    this.focus.set(0);
    const foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -40, safe: 12 }));
    foot.add(new Label("Enter to play again", 0, 0, { font: UI_SMALL, align: "center", color: 0x8fb0aa, shadow: 0x02060c }));
  }

  override onAction(name: string, pressed: boolean): void {
    if ((name === "next" || name === "prev" || name === "left" || name === "right") && pressed) {
      this.focus.move(name === "prev" || name === "left" ? -1 : 1);
      return;
    }
    if (!pressed) return;
    if (name === "again" || name === "confirm") {
      if (name === "confirm" && (this.focus.current as Button | null)?.action === "title") {
        this.app.scenes.change(new TitleScene());
        return;
      }
      this.app.audio.play("start");
      this.app.scenes.change(new PlayScene(this.app.rng.int(0, 2 ** 31)));
    } else if (name === "title") {
      this.app.audio.play("click");
      this.app.scenes.change(new TitleScene());
    }
  }
}
