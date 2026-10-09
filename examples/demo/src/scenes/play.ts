import { TAU } from "@kiln/engine/core";
import { Anchor, Graphics2D, AnimatedSprite, Button, Label, Light2D, Node2D, Panel, ParticleEmitter, Rig2D, Scene, Sprite, TouchControls } from "@kiln/engine/scene";
import { LanternKeeper, EmberCompass } from "../scenery.ts";
import { BUTTON, DISPLAY_SMALL, UI, UI_SMALL } from "../fonts.ts";
import { type GameEvent, type GameState, RULES, WORLD_H, WORLD_W, createGame, tick } from "../game.ts";
import { saves } from "../store.ts";
import { type Hollow, buildHollow } from "./hollow.ts";
import { OverScene } from "./over.ts";

/** A glowing thing in the world: a soft additive halo under an emissive animated sprite. */
class Glowing extends Node2D {
  readonly halo: Sprite;
  readonly body: AnimatedSprite;
  constructor(anim: string, tint: number, haloScale: number, haloAlpha: number) {
    super();
    this.halo = this.add(new Sprite("__blob"));
    this.halo.tint = tint;
    this.halo.additive = true;
    this.halo.scale = haloScale;
    this.halo.alpha = haloAlpha;
    this.body = this.add(new AnimatedSprite(anim));
    this.body.emissive = true;
  }
}

export class PlayScene extends Scene {
  state!: GameState;
  private hollow!: Hollow;
  private hero!: AnimatedSprite;
  private rig!: Rig2D;
  private keeper!: LanternKeeper;
  /** Lantern glow and sparks, following whichever hero is showing. */
  private heroFx!: Node2D;
  /** The knight as a cutout rig (default), the knight's sheet, or the painted hero. K cycles. */
  private heroMode: "vector" | "rig" | "sheet" | "painted" = "vector";
  private heroLight!: Sprite;
  private lantern!: Light2D;
  private sparks!: ParticleEmitter;
  private bursts!: ParticleEmitter;
  private wispBursts!: ParticleEmitter;
  private embers = new Map<number, Glowing>();
  private wisps = new Map<number, Glowing>();
  private wispLights = new Map<number, Light2D>();
  private wispTrails = new Map<number, ParticleEmitter>();
  private hearts: Sprite[] = [];
  private score!: Label;
  private best!: Label;
  private pausePanel!: Node2D;
  private pausedFlag = false;
  private t = 0;
  private ending = false;
  private bestScore = 0;
  private pointerWalking = false;

  constructor(private readonly seed: string | number = Date.now()) {
    super();
    this.name = "play";
  }

  override ready(): void {
    const app = this.app;
    this.state = createGame(this.seed);
    this.hollow = buildHollow(this.world, this.state, 0x879eac);
    this.camera.bounds = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
    this.camera.follow(this.state.player, 7);

    // The hero, a lantern halo and spark trail, and the light that actually lights the ground.
    this.hero = this.hollow.actors.add(new AnimatedSprite("knight.idle"));
    this.hero.facing = "right";
    this.rig = this.hollow.actors.add(new Rig2D("knight-rig"));
    this.rig.scaleX = this.rig.scaleY = 0.97;
    this.rig.play("idle");
    this.keeper = this.hollow.actors.add(new LanternKeeper());
    this.heroFx = this.hollow.actors.add(new Node2D());
    this.heroLight = this.heroFx.add(new Sprite("__blob", 12, -12));
    this.heroLight.tint = 0xffc070;
    this.heroLight.additive = true;
    this.heroLight.scale = 1.8;
    this.heroLight.alpha = 0.45;
    this.sparks = this.heroFx.add(
      new ParticleEmitter({ rate: 12, life: [0.3, 0.7], speed: [8, 30], angle: [-TAU * 0.4, -TAU * 0.1], gravity: -36, size: [2, 3], colors: [0xffd36b, 0xff9a3a, 0xfff2b0], alpha: [0.9, 0], additive: true, spread: 4, seed: 4 }, 12, -12),
    );
    this.lantern = this.hollow.lights.add(new Light2D({ radius: 340, color: 0xffb060, intensity: 1.1, flicker: 0.1, falloff: 1.4, shadows: true, shadowStrength: 0.45 }));

    this.bursts = this.world.add(new ParticleEmitter({ life: [0.35, 0.8], speed: [60, 180], gravity: 80, drag: 2, size: [2, 5], colors: [0xffd36b, 0xff9a3a, 0xfff2b0, 0xffffff], alpha: [1, 0], additive: true, seed: 8 }));
    this.bursts.emitting = false;
    this.wispBursts = this.world.add(new ParticleEmitter({ life: [0.4, 1], speed: [40, 140], drag: 3, size: [2, 5], colors: [0x8de9d8, 0xc8fff4, 0x4fd1c0], alpha: [1, 0], additive: true, seed: 12 }));
    this.wispBursts.emitting = false;

    for (const e of this.state.embers) this.addEmber(e.id);
    for (const w of this.state.wisps) this.addWisp(w.id);

    // HUD, anchored so it holds at any aspect ratio.
    const topLeft = this.ui.add(new Anchor({ x: "left", y: "top", safe: 16 }));
    topLeft.add(new Graphics2D(-8,-8).roundedRect(0,0,154,78,12,{color:0x142d3b,alpha:.88}));
    topLeft.add(new Label("LANTERN KEEPER",0,46,{font:UI_SMALL,color:0xb5ccc5}));
    for (let i = 0; i < RULES.lives; i++) {
      const h = topLeft.add(new Sprite("heart", i * 44, 0));
      h.scale = 2;
      this.hearts.push(h);
    }
    const topRight = this.ui.add(new Anchor({ x: "right", y: "top", safe: 16 }));
    topRight.add(new Graphics2D(-214,-8).roundedRect(0,0,222,80,12,{color:0x142d3b,alpha:.88}));
    this.score = topRight.add(new Label("EMBERS 0", 0, 0, { font: UI, align: "right", color: 0xffe9a3, shadow: 0x000000 }));
    this.bestScore = saves.load().best;
    this.best = topRight.add(new Label(this.bestScore > 0 ? `BEST ${this.bestScore}` : "", 0, 30, { font: UI_SMALL, align: "right", color: 0xaaa6c8, shadow: 0x000000 }));

    const compass = this.ui.add(new Anchor({x:"center",y:"bottom",dy:-62}));
    compass.add(new EmberCompass(this.state));
    compass.add(new Label("FOLLOW THE EMBERS",0,40,{font:UI_SMALL,align:"center",color:0xc7dbce}));
    const hint = this.ui.add(new Anchor({x:"left",y:"bottom",safe:20,dy:-24}));
    hint.add(new Label("WASD / ARROWS   Move     ESC   Pause",0,0,{font:UI_SMALL,color:0xc7dbce,shadow:0x142d3b}));

    this.pausePanel = this.ui.add(new Anchor({ x: "center", y: "center", w: 360, h: 220 }));
    this.pausePanel.add(new Panel(0, 0, 360, 220));
    this.pausePanel.add(new Label("PAUSED", 180, 22, { font: DISPLAY_SMALL, align: "center", color: 0xffd67a, shadow: 0x000000 }));
    this.pausePanel.add(new Button("RESUME", 30, 96, 300, 44, { action: "pause", style: { font: BUTTON } }));
    this.pausePanel.add(new Button("QUIT TO TITLE", 30, 152, 300, 44, { action: "quit", style: { font: BUTTON } }));
    this.pausePanel.visible = false;

    this.ui.add(new TouchControls({ stick: { left: "left", right: "right", up: "up", down: "down" }, buttons: [{ action: "pause", label: "II" }], size: 64 }));
    this.syncPresentation();
    app.audio.setMood("night");
  }

  private addEmber(id: number): void {
    const g = new Glowing("ember", 0xff9a3a, 1.1, 0.6);
    this.hollow.actors.add(g);
    this.embers.set(id, g);
  }

  private addWisp(id: number): void {
    const g = new Glowing("wisp", 0x66ffe0, 1.4, 0.5);
    g.body.play("wisp");
    this.hollow.actors.add(g);
    this.wisps.set(id, g);
    const trail = this.world.add(new ParticleEmitter({ rate: 16, life: [0.3, 0.7], speed: [4, 16], size: [2, 3], colors: [0x8de9d8, 0x4fd1c0], alpha: [0.7, 0], additive: true, spread: 6, seed: id }));
    this.wispTrails.set(id, trail);
    this.wispLights.set(id, this.hollow.lights.add(new Light2D({ radius: 120, color: 0x66ffe0, intensity: 0.7, flicker: 0.2 })));
  }

  private setPaused(v: boolean): void {
    this.pausedFlag = v;
    this.pointerWalking = false;
    this.pausePanel.visible = v;
    this.world.paused = v;
    this.timeScale = v ? 0 : 1;
    this.uiChanged();
    this.app.audio.play("click");
  }

  override onPointerDown(): void { this.pointerWalking = !this.pausedFlag; }
  override onPointerUp(): void { this.pointerWalking = false; }

  override onAction(name: string, pressed: boolean): void {
    if (name === "swap" && pressed) {
      // Rigged knight, the knight's sheet, or the painted lantern-bearer, on the same ground.
      this.heroMode = this.heroMode === "vector" ? "rig" : this.heroMode === "rig" ? "sheet" : this.heroMode === "sheet" ? "painted" : "vector";
      this.hero.play(this.heroMode === "sheet" ? "knight.idle" : "hero.idle", true);
      return;
    }
    if (!pressed || this.ending) return;
    if (name === "pause") this.setPaused(!this.pausedFlag);
    else if (name === "quit" && this.pausedFlag) {
      const { TitleScene } = titleModule;
      this.app.scenes.change(new TitleScene());
    } else if (name === "mute") {
      const muted = this.app.audio.toggleMuted();
      const data = saves.load();
      data.muted = muted;
      saves.save(data);
    }
  }

  override update(dt: number): void {
    if (this.pausedFlag) return;
    this.t += dt;
    const app = this.app;
    const s = this.state;

    // Input: keys or pad, or hold the pointer to walk toward it.
    let dir = app.input.vector("left", "right", "up", "down");
    if (dir.x === 0 && dir.y === 0 && app.gamepad.connected) dir = { x: app.gamepad.leftStick.x, y: app.gamepad.leftStick.y };
    if (dir.x === 0 && dir.y === 0 && this.pointerWalking && app.pointer.down && !this.hoveredControl && app.pointer.type !== "touch") {
      const [wx, wy] = this.screenToWorld(app.pointer.x, app.pointer.y);
      const dx = wx - s.player.x;
      const dy = wy - (s.player.y - 16);
      const d = Math.hypot(dx, dy);
      if (d > 12) dir = { x: dx / d, y: dy / d };
    }

    for (const ev of tick(s, dir, dt)) this.handle(ev);

    this.syncPresentation();
  }

  /** Establish poses before the first draw as well as after simulation; never advances game rules. */
  private syncPresentation(): void {
    const s = this.state;

    // Hero.
    const p = s.player;
    this.hero.x = this.rig.x = this.keeper.x = this.heroFx.x = p.x;
    this.hero.y = this.rig.y = this.keeper.y = this.heroFx.y = p.y;
    const rigMode = this.heroMode === "rig";
    if (rigMode) {
      this.rig.face(p.facing);
      if (p.hurt > 0) {
        if (this.rig.current !== "hurt") this.rig.play("hurt");
      } else this.rig.play(p.moving ? "walk" : "idle");
    } else if (this.heroMode === "sheet") {
      // The set picks the side's frames; a missing side would mirror.
      this.hero.facing = p.facing === -1 ? "left" : "right";
      this.hero.play(p.hurt > 0 ? "knight.hurt" : p.moving ? "knight.walk" : "knight.idle");
    } else {
      this.hero.flipX = p.facing === -1;
      this.hero.play(p.moving ? "hero.walk" : "hero.idle");
    }
    const shown = p.hurt <= 0 || Math.floor(this.t * 14) % 2 === 0;
    this.rig.visible = rigMode && shown;
    this.hero.visible = !rigMode && this.heroMode !== "vector" && shown;
    this.keeper.visible = this.heroMode === "vector" && shown;
    this.keeper.moving = p.moving;
    this.keeper.facing = p.facing;
    const flicker = 0.45 + Math.sin(this.t * 17) * 0.05 + Math.sin(this.t * 5.3) * 0.06;
    this.heroLight.alpha = flicker;
    this.heroLight.x = p.facing === -1 ? -12 : 12;
    this.sparks.x = this.heroLight.x;
    this.lantern.x = p.x + (p.facing === -1 ? -12 : 12);
    this.lantern.y = p.y - 14;

    // Embers bob; wisps float.
    for (const e of s.embers) {
      const n = this.embers.get(e.id);
      if (!n) continue;
      n.x = e.x;
      n.y = e.y + Math.sin(this.t * 3 + e.phase) * 3;
      n.halo.alpha = 0.5 + Math.sin(this.t * 5 + e.phase) * 0.2;
    }
    for (const w of s.wisps) {
      const n = this.wisps.get(w.id);
      if (!n) continue;
      n.x = w.x;
      n.y = w.y + Math.sin(this.t * 2.6 + w.phase) * 4;
      n.body.flipX = w.vx < 0;
      n.halo.alpha = 0.4 + Math.sin(this.t * 4 + w.phase) * 0.15;
      const trail = this.wispTrails.get(w.id);
      if (trail) {
        trail.x = w.x;
        trail.y = n.y + 8;
      }
      const light = this.wispLights.get(w.id);
      if (light) {
        light.x = w.x;
        light.y = n.y;
      }
    }

    // HUD.
    for (let i = 0; i < this.hearts.length; i++) this.hearts[i].sprite = i < p.lives ? "heart" : "heart.empty";
    this.score.text = `EMBERS ${s.score}`;
    if (s.score > this.bestScore) {
      this.best.text = "NEW BEST";
      this.best.color = 0xffd67a;
    }
  }

  private handle(ev: GameEvent): void {
    const app = this.app;
    switch (ev.type) {
      case "collect": {
        this.bursts.burst(16, ev.x, ev.y);
        app.audio.play("collect", { pitch: 1 + Math.min(0.5, ev.score * 0.01) });
        app.haptic("light");
        this.tweens.to(this.score, { y: -6 }, 0.08, { ease: "outQuad", onDone: () => this.tweens.to(this.score, { y: 0 }, 0.12) });
        break;
      }
      case "emberSpawn":
        this.addEmber(ev.id);
        break;
      case "wispSpawn":
        this.addWisp(ev.id);
        this.wispBursts.burst(12, ev.x, ev.y);
        app.audio.play("wisp");
        break;
      case "wispGone": {
        const n = this.wisps.get(ev.id);
        if (n) {
          this.wispBursts.burst(22, n.x, n.y);
          n.destroy();
          this.wisps.delete(ev.id);
        }
        this.wispLights.get(ev.id)?.destroy();
        this.wispLights.delete(ev.id);
        const trail = this.wispTrails.get(ev.id);
        if (trail) {
          trail.emitting = false;
          this.tweens.after(1, () => trail.destroy());
          this.wispTrails.delete(ev.id);
        }
        break;
      }
      case "hurt":
        this.camera.shake(8, 0.35);
        app.audio.play("hurt");
        app.haptic("heavy");
        app.audio.play("hit");
        this.post.tintAmount = 0.5;
        this.tweens.to(this.post, { tintAmount: this.app.basePost.tintAmount }, 0.6, { ease: "outQuad" });
        break;
      case "over": {
        this.ending = true;
        app.audio.play("over");
        app.haptic("error");
        app.audio.setMood(null);
        const data = saves.load();
        data.games++;
        const isBest = ev.score > data.best;
        if (isBest) data.best = ev.score;
        saves.save(data);
        this.tweens.to(this.post, { brightness: 0.35, bloom: 0.2 }, 1.4, { ease: "inOutQuad" });
        this.tweens.to(this.lantern, { intensity: 0 }, 1.2);
        this.tweens.after(1.6, () => app.scenes.change(new OverScene(ev.score, isBest, this.seed)));
        break;
      }
    }
    // Remove collected embers on the next frame so the burst spawns from the old spot.
    for (const [id, n] of this.embers) {
      if (!this.state.embers.some((e) => e.id === id)) {
        n.destroy();
        this.embers.delete(id);
      }
    }
  }
}

// Late import to avoid a circular import at module evaluation time.
import * as titleModule from "./title.ts";
