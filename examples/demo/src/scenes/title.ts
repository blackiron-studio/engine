import { Anchor, Button, FocusGroup, Label, Light2D, NineSlice, Scene, Sprite } from "@blackiron-studio/engine/scene";
import { BUTTON_SKINS, PHONE_TAP, touchFirst } from "../look.ts";
import { BUTTON, DISPLAY, UI, UI_SMALL, captionFor } from "../fonts.ts";
import { WORLD_H, WORLD_W, createGame } from "../game.ts";
import { saves } from "../store.ts";
import { buildHollow } from "./hollow.ts";
import { PlayScene } from "./play.ts";

export class TitleScene extends Scene {
  private soundButton!: Button;
  private focus = new FocusGroup();
  private drift = 0;
  private glow!: Light2D;
  private builtCompact = false;
  private how: Label | null = null;

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

    const data = saves.load();
    app.audio.setMuted(data.muted);
    this.buildUI();
    app.audio.setMood("title");
  }

  /**
   * The title, menu and hints. A phone gets a tighter stack (the UI layer is about 850 x 480 units
   * there, see `ui.minPoints`), 14-unit captions and 56-unit buttons; a touch screen gets touch wording.
   */
  private buildUI(): void {
    for (const child of [...this.ui.children]) child.destroy();
    const compact = (this.builtCompact = this.compact);
    const caption = captionFor(compact);
    const tap = compact ? PHONE_TAP : 0;

    const center = this.ui.add(new Anchor({ x: "center", y: "top", dy: compact ? 64 : 150 }));
    const scrim = center.add(new Sprite("wh.ui.scrim", 0, 40));
    scrim.scaleX = 4.6;
    scrim.scaleY = 3;
    const halo = center.add(new Sprite("__blob", 0, 30));
    halo.scaleX = 12;
    halo.scaleY = 3;
    halo.tint = 0xffa24a;
    halo.alpha = 0.22;
    halo.additive = true;
    center.add(new Label("BLACKIRON  \u00b7  THE 2D COLLECTION", 0, compact ? -36 : -34, { font: caption, align: "center", color: 0x9fc6b7 }));
    center.add(new Label("WISP HOLLOW", 0, -12, { font: DISPLAY, align: "center", color: 0xffd98a, shadow: 0x2a1406 }));
    center.add(new Sprite("wh.ui.rule", 0, 84)).scale = 1.4;
    center.add(new Label("A lantern. A sleeping forest. A little courage.", 0, 100, { font: UI, align: "center", color: 0xe6eef0, shadow: 0x02060c }));

    const playH = tap || 54;
    const soundH = tap || 44;
    const menu = this.ui.add(new Anchor({ x: "center", y: "center", dy: compact ? 34 : 80, w: 280, h: compact ? playH + 12 + soundH : 120 }));
    const play = menu.add(new Button("ENTER THE HOLLOW", 0, 0, 280, playH, { action: "play", style: { font: BUTTON, skin: BUTTON_SKINS.primary, text: 0x2a1406, textShadow: null } }));
    const muted = this.app.audio.muted;
    const soundY = compact ? playH + 12 : 68;
    this.soundButton = menu.add(new Button(muted ? "SOUND: OFF" : "SOUND: ON", 30, soundY, 220, soundH, { action: "toggleSound", style: { font: BUTTON, skin: BUTTON_SKINS.quiet, text: 0xd8e8e4 } }));
    this.focus.items = [play, this.soundButton];
    const best = saves.load().best;
    if (best > 0) menu.add(new Label(`BEST  ${best} EMBERS`, 140, compact ? soundY + soundH + 8 : 128, { font: caption, align: "center", color: 0xffd98a, shadow: 0x02060c }));

    const foot = this.ui.add(new Anchor({ x: "center", y: "bottom", dy: -56, safe: 12, safeArea: true }));
    foot.add(new NineSlice("wh.ui.pill", -330, -8, 660, 60, 12));
    this.how = foot.add(new Label(this.howText(), 0, 2, { font: UI_SMALL, align: "center", color: 0xc4d8d2, maxWidth: 636 }));
    foot.add(new Label("Gather embers. Keep your lantern burning. Follow the golden compass.", 0, 24, { font: UI_SMALL, align: "center", color: 0x8fb0aa, maxWidth: 636 }));
  }

  /** How to play, in the words of the input in use: touch on a touch screen. */
  private howText(): string {
    return touchFirst(this)
      ? "Drag on the left to walk  \u00b7  tap II to pause  \u00b7  gamepad works too"
      : "WASD or arrows to move  \u00b7  hold the pointer to walk  \u00b7  gamepad and touch work too";
  }

  /** The window crossed the small-screen line: lay it out again. The hint follows the input in use. */
  private refreshUI(): void {
    if (!this.attachedApp || !this.how) return;
    if (this.compact !== this.builtCompact) this.buildUI();
    else this.how.text = this.howText();
  }

  override onResize(): void {
    this.refreshUI();
  }

  override update(dt: number): void {
    this.refreshUI();
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
