import { Rng } from "@blackiron-studio/engine/core";
import {
  Anchor, AnimatedSprite, AnimationPlayer, Area2D, Button, CharacterBody2D, Label, LightLayer, Light2D, Node2D,
  RichText, RigidBody2D, Scene, ScrollContainer, Sprite, StateMachine, StaticBody2D, Tooltip,
} from "@blackiron-studio/engine/scene";
import { TitleScene, saves } from "./title.ts";

const TILE = 32;
const WORLD_W = 1280;
const WORLD_H = 720;

class Hero extends CharacterBody2D {
  readonly sprite = new AnimatedSprite("hero.idle", 0, 0);
  readonly anim = new AnimationPlayer();
  readonly machine: StateMachine;
  facing = 1;

  constructor(x: number, y: number) {
    super({ shape: { capsule: [26, 9] }, collider: { y: -19, friction: 0 }, snap: 6, maxSlope: 50 }, x, y);
    this.add(this.sprite);
    this.add(this.anim);
    this.anim.define("squash", { properties: [{ target: this.sprite, property: "scaleY", keys: [[0, 0.7], [0.12, 1.1, "outQuad"], [0.3, 1, "outQuad"]] }, { target: this.sprite, property: "scaleX", keys: [[0, 1.3], [0.12, 0.95], [0.3, 1]] }] });
    this.anim.define("stretch", { sounds: { keys: [[0, "jump"]] }, properties: [{ target: this.sprite, property: "scaleY", keys: [[0, 1.25], [0.25, 1, "outQuad"]] }, { target: this.sprite, property: "scaleX", keys: [[0, 0.8], [0.25, 1, "outQuad"]] }] });
    this.machine = new StateMachine(this.anim)
      .add("idle", { enter: () => this.sprite.play("hero.idle") })
      .add("run", { enter: () => this.sprite.play("hero.run") })
      .add("air", { enter: () => this.sprite.play("hero.jump") })
      .transition("any", "air", () => !this.grounded)
      .transition("air", "idle", () => this.grounded, 0)
      .transition("idle", "run", () => this.grounded && Math.abs(this.velocity.x) > 10)
      .transition("run", "idle", () => this.grounded && Math.abs(this.velocity.x) <= 10);
    this.machine.set("idle");
  }

  override update(dt: number): void {
    const input = this.scene?.attachedApp?.input;
    if (!input) return;
    const dir = input.axis("left", "right");
    const target = dir * 260;
    this.velocity.x += (target - this.velocity.x) * Math.min(1, dt * (this.grounded ? 14 : 6));
    if (dir !== 0) this.facing = Math.sign(dir);
    this.sprite.flipX = this.facing < 0;
    const wasGrounded = this.grounded;
    if (this.grounded && input.justPressed("jump")) {
      this.velocity.y = -640;
      this.anim.play("stretch");
    }
    this.velocity.y += 1400 * dt;
    this.moveAndSlide(dt);
    if (!wasGrounded && this.grounded) {
      this.anim.play("squash");
      this.scene?.attachedApp?.audio.play("thud", { x: this.x, y: this.y, volume: 0.6 });
    }
    this.machine.update(dt);
  }
}

class Crate extends RigidBody2D {
  constructor(x: number, y: number, rng: Rng) {
    super({ shape: { rect: [32, 32] }, collider: { friction: 0.6, restitution: 0.05, density: 1 }, angularDamping: 0.6 }, x, y);
    this.rotation = rng.range(-0.1, 0.1);
    this.add(new Sprite("crate", 0, 0));
  }
}

class Ball extends RigidBody2D {
  constructor(x: number, y: number) {
    super({ shape: { circle: 12 }, collider: { friction: 0.3, restitution: 0.75, density: 0.6 } }, x, y);
    this.add(new Sprite("ball", 0, 0));
  }
}

export class PlayScene extends Scene {
  private readonly dice = new Rng(11);
  private hero!: Hero;
  private stars = 0;
  private crates = 0;
  private starZone!: Area2D;
  private log!: ScrollContainer;
  private logY = 0;
  private scoreLabel!: Label;

  constructor(readonly playerName: string) {
    super();
  }

  override ready(): void {
    this.name = "play";
    this.background = 0x1a1c2c;
    this.buildYard();
    this.hero = this.world.add(new Hero(160, WORLD_H - TILE * 2));
    const lights = this.world.add(new LightLayer(0x6a6f90));
    lights.add(new Light2D({ radius: 420, color: 0xfff0c0 }, 320, 200));
    lights.add(new Light2D({ radius: 360, color: 0xffd080, flicker: 0.08 }, WORLD_W - 200, 240));
    this.buildUi();
    this.app.audio.setMood("yard", { crossfade: 1.2 });
    this.camera.x = WORLD_W / 2;
    this.camera.y = WORLD_H / 2;
    this.app.audio.listener = { x: WORLD_W / 2, y: WORLD_H / 2, range: 1400 };
  }

  private buildYard(): void {
    const ground = this.world.add(new StaticBody2D({ shape: { rect: [WORLD_W, TILE] }, collider: { friction: 0.8 } }, WORLD_W / 2, WORLD_H - TILE / 2));
    for (let c = 0; c < WORLD_W / TILE; c++) ground.add(new Sprite("ground", c * TILE - WORLD_W / 2, -TILE / 2));
    for (const side of [-1, 1]) {
      const wall = this.world.add(new StaticBody2D({ shape: { rect: [TILE, WORLD_H] } }, side < 0 ? TILE / 2 : WORLD_W - TILE / 2, WORLD_H / 2));
      for (let r = 0; r < WORLD_H / TILE; r++) wall.add(new Sprite("wall", -TILE / 2, r * TILE - WORLD_H / 2));
    }
    // A ledge to jump onto and a stack of crates to knock over.
    const ledge = this.world.add(new StaticBody2D({ shape: { rect: [TILE * 6, TILE] } }, WORLD_W - TILE * 5, WORLD_H - TILE * 6));
    for (let c = 0; c < 6; c++) ledge.add(new Sprite("ground", c * TILE - TILE * 3, -TILE / 2));
    for (let i = 0; i < 4; i++) for (let j = 0; j <= i; j++) this.spawnCrate(560 + j * 34 - i * 17, WORLD_H - TILE - 18 - (3 - i) * 34);
    for (let i = 0; i < 3; i++) this.world.add(new Ball(880 + i * 60, WORLD_H - TILE * 4 - i * 40));
    this.starZone = this.world.add(new Area2D({ shape: { circle: 22 } }, WORLD_W - TILE * 5, WORLD_H - TILE * 8));
    this.starZone.add(new Sprite("star", 0, 0)).emissive = true;
    this.starZone.onEnter = (other) => {
      if (other instanceof Hero) this.collectStar();
    };
  }

  private buildUi(): void {
    const top = this.ui.add(new Anchor({ x: "left", y: "top", safe: 16 }));
    this.scoreLabel = top.add(new Label(`${this.playerName}   stars 0   crates 0`, 0, 0, { shadow: 0x000000 }));
    const right = this.ui.add(new Anchor({ x: "right", y: "top", safe: 16 }));
    const menu = right.add(new Button("MENU", -120, 0, 120, 40, { onPress: () => this.app.scenes.change(new TitleScene(), { transition: "fade", duration: 0.6 }) }));
    this.ui.add(new Tooltip(menu, "Back to the title", { side: "below" }));
    const bottom = this.ui.add(new Anchor({ x: "right", y: "bottom", safe: 16 }));
    this.log = bottom.add(new ScrollContainer(-300, -170, 300, 150, { contentWidth: 280 }));
    this.addLog(`[b]${this.playerName}[/b] enters the yard.`);
    this.addLog("Click or tap to drop a [icon=crate] crate. R resets.");
  }

  private addLog(markup: string): void {
    const line = this.log.content.add(new RichText(markup, 6, this.logY, { font: { family: "Instrument Sans", size: 16, weight: 500 }, wrap: 270, color: 0xdad6f0 }));
    this.logY += line.height + 4;
    this.log.contentHeight = this.logY;
    this.log.scrollTo(0, this.log.maxScrollY);
  }

  private spawnCrate(x: number, y: number): Crate {
    this.crates++;
    return this.world.add(new Crate(x, y, this.dice));
  }

  private collectStar(): void {
    this.stars++;
    this.app.audio.play("star", { x: this.starZone.x, y: this.starZone.y });
    this.app.haptic("success");
    this.addLog(`[color=#ffc857]Star ${this.stars}![/color]`);
    const data = saves.load();
    if (this.stars > data.best) {
      data.best = this.stars;
      saves.save(data);
    }
    // Move the star somewhere reachable.
    this.starZone.x = this.dice.range(TILE * 3, WORLD_W - TILE * 3);
    this.starZone.y = this.dice.range(TILE * 4, WORLD_H - TILE * 5);
  }

  override onPointerDown(x: number, y: number): void {
    if (this.hoveredControl) return;
    const [wx, wy] = this.camera.screenToWorld(x, y);
    if (wx < TILE || wx > WORLD_W - TILE || wy > WORLD_H - TILE * 2) return;
    const crate = this.spawnCrate(wx, wy);
    crate.impulse(0, 120, this.dice.range(-2, 2));
    this.app.haptic("light");
    this.app.audio.play("thud", { x: wx, y: wy, volume: 0.4, pitch: 1.4 });
    this.addLog(`Crate ${this.crates} dropped at ${Math.round(wx)}, ${Math.round(wy)}.`);
  }

  override onAction(name: string, pressed: boolean): void {
    if (pressed && name === "reset") this.app.scenes.change(new PlayScene(this.playerName), { transition: "slide", duration: 0.5 });
  }

  override update(dt: number): void {
    this.scoreLabel.text = `${this.playerName}   stars ${this.stars}   crates ${this.crates}`;
    // A ray from the hero's feet shows how the query API is used: it lands the hero's shadow.
    const hit = this.app.physics?.raycast(this.hero.x, this.hero.y + 2, 0, 1, 400);
    this.shadowY = hit ? hit.y : null;
    void dt;
  }

  private shadowY: number | null = null;

  override render(ctx: import("@blackiron-studio/engine/scene").DrawContext): void {
    if (this.shadowY !== null && !this.hero.grounded) {
      const d = Math.max(0, Math.min(1, 1 - (this.shadowY - this.hero.y) / 400));
      ctx.rect(this.hero.x - 10 * d, this.shadowY - 2, 20 * d, 3, 0x000000, 0.35 * d);
    }
  }
}
