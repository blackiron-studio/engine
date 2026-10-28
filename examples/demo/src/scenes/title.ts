import { Anchor, Button, FocusGroup, Label, Light2D, NineSlice, Scene, Sprite } from "@blackiron-studio/engine/scene";
import { BUTTON_SKINS } from "../look.ts";
import { BUTTON, CAPTION, DISPLAY, UI, UI_SMALL } from "../fonts.ts";
import { WORLD_H, WORLD_W, createGame } from "../game.ts";
import { saves } from "../store.ts";
import { buildHollow } from "./hollow.ts";
import { PlayScene } from "./play.ts";

export class TitleScene extends Scene {
  private soundButton!: Button;
  private focus = new FocusGroup();
  private drift = 0;
  private glow!: Light2D;

  constructor() {
    super();
    this.name = "title";
  }

  override ready(): void {
    const app = this.app;
    const state = createGame("title");
    const hollow = buildHollow(this.world, state, 0x7890a8);
    this.camera.bounds = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
    this.camera.x = WORLD_W * 0.35;
    this.camera.y = WORLD_H * 0.5;
    this.camera.followRate = 0;
    this.post.vignette = 0.3;
    this.glow = hollow.lights.add(new Light2D({ radius: 520, color: 0xffc27a, intensity: 0.9, flicker: 0.05 }));

    const center = this.ui.add(new Anchor({ x: "center", y: "top", dy: 150 }));
    const scrim = center.add(new Sprite("wh.ui.scrim", 0, 40));
    scrim.scaleX = 4.6;
    scrim.scaleY = 3;
    const halo = center.add(new Sprite("__blob", 0, 30));
    halo.scaleX = 12;
    halo.scaleY = 3;
    halo.tint = 0xffa24a;
    halo.alpha = 0.22;
    halo.additive = true;
    center.add(new Label("BLACKIRON  \u00b7  THE 2D COLLECTION", 0, -34, { font: CAPTION, align: "center", color: 0x9fc6b7 }));
    center.add(new Label("WISP HOLLOW", 0, -12, { font: DISPLAY, align: "center", color: 0xffd98a, shadow: 0x2a1406 }));
    center.add(new Sprite("wh.ui.rule", 0, 84)).scale = 1.4;
    center.add(new Label("A lantern. A sleeping forest. A little courage.", 0, 100, { font: UI, align: "center", color: 0xe6eef0, shadow: 0x02060c }));

    const menu = this.ui.add(new Anchor({ x: "center", y: "center", dy: 80, w: 280, h: 120 }));
    const play = menu.add(new Button("ENTER THE HOLLOW", 0, 0, 280, 54, { action: "play", style: { font: BUTTON, skin: BUTTON_SKINS.primary, text: 0x2a1406, textShadow: null } }));
    const data = saves.load();
    app.audio.setMuted(data.muted);
    this.soundButton = menu.add(new Button(data.muted ? "SOUND: OFF" : "SOUND: ON", 30, 68, 220, 44, { action: "toggleSound", style: { font: BUTTON, skin: BUTTON_SKINS.quiet, text: 0xd8e8e4 } }));
    this.focus.items = [play, this.soundButton];
    if (data.best > 0) menu.add(new Label(`BEST  ${data.best} EMBERS`, 140, 128, { font: CAPTION, align: "center", color: 0xffd98a, shadow: 0x02060c }));

    const foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -56, safe: 12 }));
    foot.add(new NineSlice("wh.ui.pill", -330, -8, 660, 60, 12));
    foot.add(new Label("WASD or arrows to move  \u00b7  hold the pointer to walk  \u00b7  gamepad and touch work too", 0, 2, { font: UI_SMALL, align: "center", color: 0xc4d8d2 }));
    foot.add(new Label("Gather embers. Keep your lantern burning. Follow the golden compass.", 0, 24, { font: UI_SMALL, align: "center", color: 0x8fb0aa }));
    app.audio.setMood("title");
  }

  override update(dt: number): void {
    this.drift += dt;
    this.camera.x = WORLD_W * 0.35 + Math.sin(this.drift * 0.11) * 320;
    this.camera.y = WORLD_H * 0.5 + Math.cos(this.drift * 0.07) * 120;
    this.glow.x = this.camera.x;
    this.glow.y = this.camera.y + 60;
  }

  override onAction(name: string, pressed: boolean): void {
    if (this.focus.onAction(name, pressed)) return;
    if (!pressed) return;
    if (name === "play" || name === "confirm") {
      this.app.audio.play("start");
      this.app.scenes.change(new PlayScene(this.app.rng.int(0, 2 ** 31)));
    } else if (name === "toggleSound" || name === "mute") {
      const muted = this.app.audio.toggleMuted();
      const data = saves.load();
      data.muted = muted;
      saves.save(data);
      this.soundButton.text = muted ? "SOUND: OFF" : "SOUND: ON";
      this.app.audio.play("click");
    }
  }
}
