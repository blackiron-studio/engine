import { Anchor, Button, FocusGroup, Graphics2D, Label, Light2D, Scene, Sprite } from "@blackiron-studio/engine/scene";
import { BUTTON, DISPLAY, UI, UI_SMALL } from "../fonts.ts";
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
    const hollow = buildHollow(this.world, state, 0x8ca5ae);
    this.camera.bounds = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
    this.camera.x = WORLD_W * 0.35;
    this.camera.y = WORLD_H * 0.5;
    this.camera.followRate = 0;
    this.post.vignette = 0.3;
    this.glow = hollow.lights.add(new Light2D({ radius: 520, color: 0xffc27a, intensity: 0.9, flicker: 0.05 }));

    const center = this.ui.add(new Anchor({ x: "center", y: "top", dy: 110 }));
    center.add(new Graphics2D(-355,-34).roundedRect(0,0,710,192,22,{color:0x132c3d,alpha:.9}));
    center.add(new Label("BLACKIRON  /  THE 2D COLLECTION",0,-12,{font:UI_SMALL,align:"center",color:0x9fc6b7}));
    const halo = center.add(new Sprite("__blob", 0, 30));
    halo.scaleX = 11;
    halo.scaleY = 3;
    halo.tint = 0xffb45a;
    halo.alpha = 0.3;
    halo.additive = true;
    center.add(new Label("WISP HOLLOW", 0, 26, { font: DISPLAY, align: "center", color: 0xffd67a, shadow: 0x3a1c0a }));
    center.add(new Label("A lantern. A sleeping forest. A little courage.", 0, 116, { font: UI, align: "center", color: 0xd9d6ec, shadow: 0x000000 }));

    const menu = this.ui.add(new Anchor({ x: "center", y: "center", dy: 70, w: 260, h: 110 }));
    const play = menu.add(new Button("ENTER THE HOLLOW", 0, 0, 260, 48, { action: "play", style: { font: BUTTON, fill:0xc4d4a4, text:0x163743, hover:0xe3e9bc, border:null, bevel:null } }));
    const data = saves.load();
    app.audio.setMuted(data.muted);
    this.soundButton = menu.add(new Button(data.muted ? "SOUND: OFF" : "SOUND: ON", 0, 62, 260, 42, { action: "toggleSound", style: { font: BUTTON } }));
    this.focus.items = [play, this.soundButton];
    if (data.best > 0) menu.add(new Label(`BEST ${data.best} EMBERS`, 130, 120, { font: UI_SMALL, align: "center", color: 0xffe9a3, shadow: 0x000000 }));

    const foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -64, safe: 12 }));
    foot.add(new Label("WASD or arrows to move. Hold the pointer to walk. Gamepad and touch work too.", 0, 0, { font: UI_SMALL, align: "center", color: 0xaaa6c8, shadow: 0x000000 }));
    foot.add(new Label("Gather embers. Keep your lantern burning. Follow the golden compass.", 0, 26, { font: UI_SMALL, align: "center", color: 0xaaa6c8, shadow: 0x000000 }));
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
