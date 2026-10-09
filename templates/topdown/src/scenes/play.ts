import { Anchor, AnimatedSprite, Label, Node2D, ParticleEmitter, Scene, Sprite, TouchControls } from "@blackiron-studio/engine/scene";
import { UI } from "../fonts.ts";
import { type GameEvent, type GameState, RULES, WORLD_H, WORLD_W, createGame, tick } from "../game.ts";
import { saves } from "../store.ts";
import { buildMeadow } from "./meadow.ts";
import { OverScene } from "./over.ts";

export class PlayScene extends Scene {
  state!: GameState;
  private actors!: Node2D;
  private hero!: AnimatedSprite;
  private gems = new Map<number, AnimatedSprite>();
  private slimes = new Map<number, AnimatedSprite>();
  private bursts!: ParticleEmitter;
  private hearts: Sprite[] = [];
  private score!: Label;
  private t = 0;
  private ending = false;

  constructor(private readonly seed: string | number = Date.now()) {
    super();
    this.name = "play";
  }

  override ready(): void {
    const s = (this.state = createGame(this.seed));
    this.actors = buildMeadow(this.world, s).actors;
    this.hero = this.actors.add(new AnimatedSprite("hero.idle"));
    for (const g of s.gems) this.addGem(g.id);
    for (const w of s.slimes) this.addSlime(w.id);
    this.bursts = this.world.add(new ParticleEmitter({ life: [0.3, 0.6], speed: [60, 160], gravity: 120, size: [2, 4], colors: [0x8ff5e6, 0xffffff, 0x5ee0d0], alpha: [1, 0], additive: true }));
    this.bursts.emitting = false;

    this.camera.bounds = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
    this.camera.follow(s.player, 8);

    const topLeft = this.ui.add(new Anchor({ x: "left", y: "top", safe: 16 }));
    for (let i = 0; i < RULES.lives; i++) {
      const h = topLeft.add(new Sprite("heart", i * 44, 0));
      h.scale = 2;
      this.hearts.push(h);
    }
    const topRight = this.ui.add(new Anchor({ x: "right", y: "top", safe: 16 }));
    this.score = topRight.add(new Label("GEMS 0", 0, 0, { font: UI, align: "right", color: 0x8ff5e6, shadow: 0x000000 }));
    this.ui.add(new TouchControls({ stick: { left: "left", right: "right", up: "up", down: "down" }, size: 64 }));
  }

  private addGem(id: number): void {
    const n = this.actors.add(new AnimatedSprite("gem"));
    n.emissive = true;
    this.gems.set(id, n);
  }

  private addSlime(id: number): void {
    this.slimes.set(id, this.actors.add(new AnimatedSprite("slime")));
  }

  override update(dt: number): void {
    if (this.ending) return;
    this.t += dt;
    const s = this.state;
    let dir = this.app.input.vector("left", "right", "up", "down");
    if (dir.x === 0 && dir.y === 0 && this.app.gamepad.connected) dir = { x: this.app.gamepad.leftStick.x, y: this.app.gamepad.leftStick.y };
    for (const ev of tick(s, dir, dt)) this.handle(ev);

    const p = s.player;
    this.hero.setPosition(p.x, p.y);
    this.hero.flipX = p.facing === -1;
    this.hero.play(p.moving ? "hero.walk" : "hero.idle");
    this.hero.visible = p.hurt <= 0 || Math.floor(this.t * 14) % 2 === 0;
    for (const g of s.gems) this.gems.get(g.id)?.setPosition(g.x, g.y + Math.sin(this.t * 3 + g.id) * 3);
    for (const w of s.slimes) {
      const n = this.slimes.get(w.id);
      if (n) {
        n.setPosition(w.x, w.y);
        n.flipX = w.vx < 0;
      }
    }
    for (let i = 0; i < this.hearts.length; i++) this.hearts[i].sprite = i < p.lives ? "heart" : "heart.empty";
    this.score.text = `GEMS ${s.score}`;
  }

  private handle(ev: GameEvent): void {
    switch (ev.type) {
      case "pick":
        this.bursts.burst(14, ev.x, ev.y);
        for (const [id, n] of this.gems) if (!this.state.gems.some((g) => g.id === id)) {
          n.destroy();
          this.gems.delete(id);
        }
        break;
      case "gemSpawn":
        this.addGem(ev.id);
        break;
      case "slimeSpawn":
        this.addSlime(ev.id);
        break;
      case "hurt":
        this.camera.shake(8, 0.3);
        break;
      case "over": {
        this.ending = true;
        const data = saves.load();
        const isBest = ev.score > data.best;
        if (isBest) data.best = ev.score;
        saves.save(data);
        this.tweens.to(this.post, { brightness: 0.4 }, 1, { ease: "inOutQuad" });
        this.tweens.after(1.2, () => this.app.scenes.change(new OverScene(ev.score, isBest)));
        break;
      }
    }
  }
}
