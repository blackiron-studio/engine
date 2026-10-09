import { Anchor, Button, FocusGroup, Label, Scene } from "@kiln/engine/scene";
import { BUTTON, DISPLAY, UI, UI_SMALL } from "../fonts.ts";
import { WORLD_H, WORLD_W, createGame } from "../game.ts";
import { saves } from "../store.ts";
import { buildMeadow } from "./meadow.ts";
import { PlayScene } from "./play.ts";

export class TitleScene extends Scene {
  private t = 0;
  private focus = new FocusGroup();

  constructor() {
    super();
    this.name = "title";
  }

  override ready(): void {
    buildMeadow(this.world, createGame("title"));
    this.camera.bounds = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
    this.camera.x = WORLD_W / 2;
    this.camera.y = WORLD_H / 2;

    const head = this.ui.add(new Anchor({ x: "center", y: "top", dy: 120 }));
    head.add(new Label("GEM MEADOW", 0, 0, { font: DISPLAY, align: "center", color: 0x8ff5e6, shadow: 0x0d2a2a }));
    head.add(new Label("TOPDOWN STARTER", 0, 80, { font: UI, align: "center", color: 0xe6e3f2, shadow: 0x000000 }));
    const menu = this.ui.add(new Anchor({ x: "center", y: "center", dy: 60, w: 240, h: 48 }));
    const play = menu.add(new Button("PLAY", 0, 0, 240, 48, { action: "play", style: { font: BUTTON } }));
    this.focus.items = [play];
    const best = saves.load().best;
    if (best > 0) menu.add(new Label(`BEST ${best}`, 120, 64, { font: UI_SMALL, align: "center", color: 0xffe08a, shadow: 0x000000 }));
    const foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -40, safe: 12 }));
    foot.add(new Label("WASD, arrows, a gamepad or touch to move", 0, 0, { font: UI_SMALL, align: "center", color: 0xd0cde0, shadow: 0x000000 }));
  }

  override update(dt: number): void {
    this.t += dt;
    this.camera.x = WORLD_W / 2 + Math.sin(this.t * 0.2) * 260;
    this.camera.y = WORLD_H / 2 + Math.cos(this.t * 0.13) * 100;
  }

  override onAction(name: string, pressed: boolean): void {
    if (this.focus.onAction(name, pressed)) return;
    if (pressed && (name === "play" || name === "confirm")) this.app.scenes.change(new PlayScene());
  }
}
