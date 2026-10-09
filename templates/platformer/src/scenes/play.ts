import { TileMapData } from "@blackiron-studio/engine/core";
import { Anchor, AnimatedSprite, Label, Node2D, ParticleEmitter, Scene, Sprite, TileMap, TouchControls } from "@blackiron-studio/engine/scene";
import { UI } from "../fonts.ts";
import { type GameEvent, type GameState, LEVEL, T, TILE, coinKey, createGame, tick } from "../game.ts";
import { saves } from "../store.ts";
import { buildBackdrop } from "./backdrop.ts";
import { OverScene } from "./over.ts";

export class PlayScene extends Scene {
  state!: GameState;
  private hero!: AnimatedSprite;
  private coins = new Map<number, AnimatedSprite>();
  private dust!: ParticleEmitter;
  private sparks!: ParticleEmitter;
  private coinLabel!: Label;
  private timeLabel!: Label;
  private ending = false;

  constructor() {
    super();
    this.name = "play";
  }

  override ready(): void {
    const s = (this.state = createGame(LEVEL));
    const map = s.map;
    // Hills sit on the spike floor line, so the parallax slides them under the ground tiles.
    buildBackdrop(this.world, (map.rows - 7) * TILE + 10);
    this.world.add(
      new TileMap({
        data: map as TileMapData,
        tileSize: TILE,
        tiles: { [T.SOLID]: { autotile: "ground" }, [T.PLATFORM]: "platform", [T.SPIKE]: "spike" },
        solid: [T.SOLID],
        oneWay: [T.PLATFORM],
      }),
    );
    const things = this.world.add(new Node2D());
    for (const f of map.find(T.FLAG)) things.add(new Sprite("flag", f.x * TILE, f.y * TILE + TILE));
    for (const k of s.coins) {
      const c = k % map.cols;
      const r = Math.floor(k / map.cols);
      const n = things.add(new AnimatedSprite("coin", c * TILE + TILE / 2, r * TILE + TILE / 2));
      n.emissive = true;
      this.coins.set(k, n);
    }
    this.hero = this.world.add(new AnimatedSprite("hero.idle"));
    this.dust = this.world.add(new ParticleEmitter({ life: [0.2, 0.4], speed: [20, 80], angle: [-Math.PI * 0.9, -Math.PI * 0.1], gravity: 240, size: [2, 4], colors: [0xc8b090, 0x8a7a60], alpha: [0.8, 0] }));
    this.dust.emitting = false;
    this.sparks = this.world.add(new ParticleEmitter({ life: [0.3, 0.6], speed: [60, 140], gravity: 160, drag: 2, size: [2, 4], colors: [0xf2c14e, 0xfff3b0, 0xffffff], alpha: [1, 0], additive: true }));
    this.sparks.emitting = false;

    this.camera.bounds = { x: 0, y: 0, w: map.cols * TILE, h: map.rows * TILE };
    this.camera.follow(this.heroCenter(), 9);

    const topLeft = this.ui.add(new Anchor({ x: "left", y: "top", safe: 16 }));
    this.coinLabel = topLeft.add(new Label(`COINS 0/${s.coinsTotal}`, 0, 0, { font: UI, color: 0xf2c14e, shadow: 0x000000 }));
    const topRight = this.ui.add(new Anchor({ x: "right", y: "top", safe: 16 }));
    this.timeLabel = topRight.add(new Label("0.0", 0, 0, { font: UI, align: "right", color: 0xe6e3f2, shadow: 0x000000 }));
    this.ui.add(new TouchControls({ stick: { left: "left", right: "right", up: "jump", down: "down" }, buttons: [{ action: "jump", label: "A" }], size: 64 }));
  }

  private heroCenter(): { x: number; y: number } {
    const p = this.state.player;
    return { x: p.x + p.w / 2, y: p.y + p.h / 2 - 40 };
  }

  override update(dt: number): void {
    if (this.ending) return;
    const app = this.app;
    const s = this.state;
    let x = app.input.axis("left", "right");
    if (x === 0 && app.gamepad.connected) x = Math.abs(app.gamepad.leftStick.x) > 0.3 ? Math.sign(app.gamepad.leftStick.x) : 0;
    for (const ev of tick(s, { x, jump: app.input.justPressed("jump"), jumpHeld: app.input.isDown("jump") }, dt)) this.handle(ev);

    const p = s.player;
    this.hero.setPosition(Math.round(p.x + p.w / 2), Math.round(p.y + p.h));
    this.hero.flipX = p.facing === -1;
    this.hero.visible = p.dead <= 0;
    this.hero.play(!p.onGround ? "hero.jump" : Math.abs(p.vx) > 10 ? "hero.run" : "hero.idle");
    this.camera.target = this.heroCenter();
    this.coinLabel.text = `COINS ${s.coinsGot}/${s.coinsTotal}`;
    this.timeLabel.text = s.time.toFixed(1);
  }

  private handle(ev: GameEvent): void {
    switch (ev.type) {
      case "jump":
        this.dust.burst(6, ev.x, ev.y);
        break;
      case "land":
        this.dust.burst(8, ev.x, ev.y);
        break;
      case "coin": {
        this.sparks.burst(12, ev.x, ev.y);
        const map = this.state.map;
        const k = coinKey(Math.floor(ev.x / TILE), Math.floor(ev.y / TILE), map.cols);
        this.coins.get(k)?.destroy();
        this.coins.delete(k);
        break;
      }
      case "die":
        this.sparks.burst(20, ev.x, ev.y);
        this.camera.shake(6, 0.25);
        break;
      case "win": {
        this.ending = true;
        const data = saves.load();
        const isBest = data.bestTime === 0 || ev.time < data.bestTime;
        if (isBest) data.bestTime = ev.time;
        saves.save(data);
        this.tweens.to(this.post, { brightness: 1.6, bloom: 1.4 }, 0.8, { ease: "outQuad" });
        this.tweens.after(1, () => this.app.scenes.change(new OverScene(ev.time, ev.deaths, this.state.coinsGot, this.state.coinsTotal, isBest)));
        break;
      }
    }
  }
}
