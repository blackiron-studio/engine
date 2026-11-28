// Sentry Yard's play scene: draws the yard simulation and feeds it input. Mouse and right
// stick aim (twin-stick, with aim assist on the stick), the cursor picks the ground on the
// height map so shots rise onto raised pads, grenades show their arc before they leave the
// hand, fog of war and each turret's sight cone tint the cells, and every hit has a spark,
// a sound and, for the big ones, a hit-stop and a shake. Shots are travelling tracer beams,
// bolts leave trails and carry a light, sparks streak along their flight, flashes light the
// yard, and hits leave marks on the walls and floor.
//
// On a touch screen (a phone, a tablet) the left thumb moves and the right thumb aims and
// fires on two virtual sticks, with aim assist as on a controller; the HUD moves to the top
// edge, clear of the thumbs, and carries buttons for the grenade, reload, weapon and pause.

import { AimAssist, TwinStickAim, pickGround, screenDirToWorld } from "@blackiron-studio/engine/combat";
import { Heading } from "@blackiron-studio/engine/core";
import type { DrawContext } from "@blackiron-studio/engine/scene";
import { AnimatedSprite, Anchor, Beams, Button, Decals, IsoTileMap, Label, LightLayer, LightPool, Node2D, Scene, Sprite, SpritePool, Trails, VirtualSticks } from "@blackiron-studio/engine/scene";
import { PauseScene } from "@blackiron-studio/engine/shell";
import { CELL, TILE } from "../art.ts";
import { UI_FONT, title } from "../main.ts";
import { shell } from "../shell.ts";
import { BARREL, CHEST, CRATE, CRATE_SPLIT, type Controls, type Fx, GRENADE_BLAST, PAD, type Sentry, WALL, Yard, type YardSave, levelsOf } from "../yard.ts";
import { ISO_TILES } from "./look.ts";

const FOG_HIDDEN = 0x262d35;
const FOG_SEEN = 0x77818d;
const CONE = 0xff9a7a;
const CONE_ALERT = 0xff5a46;
const INK = 0x0c1116;
/** Ambient light: a little cool and dim, so flashes can brighten; post brightness gives the level back. */
const AMBIENT = 0xb0b6c4;
const BRIGHTNESS = 1.34;

const mulTint = (a: number, b: number): number => {
  const r = (((a >> 16) & 255) * ((b >> 16) & 255)) / 255;
  const g = (((a >> 8) & 255) * ((b >> 8) & 255)) / 255;
  const bl = ((a & 255) * (b & 255)) / 255;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};
const mixTint = (a: number, b: number, t: number): number => {
  const ch = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/** Seconds for a half turn: the operative's body follows the aim quickly; sentries swing slower. */
const HERO_TURN = 0.12;
const SENTRY_TURN = 0.3;
/** World units the muzzle flash sits in front of the figure, so it sorts over the body. */
const MUZZLE_FORWARD = 4;
/** How far out the aiming thumb is pushed, 0..1, before it fires. */
const TOUCH_FIRE = 0.6;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Pop {
  label: Label;
  age: number;
}

export class PlayScene extends Scene {
  readonly yard: Yard;
  private map!: IsoTileMap;
  private hero!: AnimatedSprite;
  private heroShadow!: Sprite;
  private readonly sentrySprites = new Map<number, { body: AnimatedSprite; shadow: Sprite }>();
  private readonly barrels = new Map<number, Sprite[]>();
  private fx!: SpritePool;
  private smoke!: SpritePool;
  private debris!: SpritePool;
  private bolts!: SpritePool;
  private nades!: SpritePool;
  private arc!: SpritePool;
  private beams!: Beams;
  private trails!: Trails;
  private decals!: Decals;
  private lights!: LightPool;
  private reticle!: Sprite;
  private lock!: Sprite;
  private blastRing!: Sprite;
  private readonly pops: Pop[] = [];
  private readonly aim = new TwinStickAim({ deadzone: 0.3 });
  private readonly assist = new AimAssist<Sentry>({ cone: 0.24, strength: 0.55, range: 380 });
  private readonly cameraGround = { x: 0, y: 0, z: 0 };
  private tints = new Uint32Array(0);
  private cone = new Uint8Array(0);
  private coneScratch = new Uint8Array(0);
  private moving = false;
  private aimingGrenade = false;
  private grenadeTarget = { x: 0, y: 0 };
  private wantWeapon: number | undefined;
  private wantReload = false;
  private hurtFlash = 0;
  private ended = false;
  private hud!: Hud;
  /** Touch screens: the two sticks, the fingers already seen, and the one holding the grenade button. */
  private sticks: VirtualSticks | null = null;
  private readonly fingers = new Set<number>();
  private grenadeFinger: number | null = null;

  constructor(save: YardSave | null = null) {
    super();
    this.yard = new Yard(save);
  }

  override ready(): void {
    this.name = "play";
    this.background = 0x1b2128;
    this.post.bloom = 0.24;
    this.post.bloomThreshold = 0.78;
    this.post.vignette = 0.24;
    this.post.brightness = BRIGHTNESS;
    const y = this.yard;
    this.map = this.world.add(new IsoTileMap({ data: y.map, elevation: (c, r) => levelsOf(y.map.get(c, r)), tile: TILE, tiles: ISO_TILES, faces: { left: "wall.left", right: "wall.right" } }));
    this.decals = this.world.add(new Decals({ capacity: 180, cell: CELL, seed: 17 }));
    this.tints = new Uint32Array(y.cols * y.rows).fill(0xffffffff);
    this.cone = new Uint8Array(y.cols * y.rows);
    this.coneScratch = new Uint8Array(y.cols * y.rows);
    for (let r = 0; r < y.rows; r++) for (let c = 0; c < y.cols; c++) if (y.map.get(c, r) === BARREL) this.addBarrel(c, r);

    for (const s of y.sentries) {
      const shadow = this.ground("contact", s.x, s.y, s.z, 0.75);
      const body = this.world.add(new AnimatedSprite(s.state === "dead" ? "sentry.dead" : "sentry.idle", s.x, s.y));
      body.z = s.z;
      body.turn = new Heading({ angle: s.facing, halfTurn: SENTRY_TURN });
      body.heading = s.facing;
      this.sentrySprites.set(s.id, { body, shadow });
    }
    this.heroShadow = this.ground("contact", y.player.x, y.player.y, 0, 0.62);
    this.hero = this.world.add(new AnimatedSprite("op.idle", y.player.x, y.player.y));
    // The body lags the aim a little but catches up fast past 70°, so it never fires backwards.
    this.hero.turn = new Heading({ angle: y.player.aim, halfTurn: HERO_TURN, catchUp: 1.2, catchUpHalfTurn: 0.07 });
    this.hero.heading = y.player.aim;

    this.debris = this.world.add(new SpritePool({ capacity: 160, sprite: "chip", gravityZ: -520, floor: "bounce", smooth: true }));
    this.smoke = this.world.add(new SpritePool({ capacity: 96, sprite: "smoke", gravityZ: 26, smooth: true }));
    this.fx = this.world.add(new SpritePool({ capacity: 640, sprite: "spark", additive: true, smooth: true, gravityZ: -160 }));
    this.bolts = this.world.add(new SpritePool({ capacity: 96, sprite: "bolt.streak", additive: true, smooth: true, align: "velocity", stretch: 0.0022 }));
    this.trails = this.world.add(new Trails({ capacity: 96, time: 0.16, width: 5, endWidth: 0.6, color: 0xffb4a4, endColor: 0xff3a2a, alpha: 0.9, endAlpha: 0, minStep: 3 }));
    this.beams = this.world.add(new Beams({ capacity: 96, segment: 20 }));
    this.nades = this.world.add(new SpritePool({ capacity: 8, sprite: "grenade", smooth: true, shadow: true }));
    this.arc = this.world.add(new SpritePool({ capacity: 80, sprite: "dot", additive: true, smooth: true }));

    this.reticle = this.world.add(new Sprite("reticle", 0, 0));
    this.reticle.depthBias = 40;
    this.lock = this.world.add(new Sprite("lock", 0, 0));
    this.lock.visible = false;
    this.lock.depthBias = -2;
    this.blastRing = this.world.add(new Sprite("blast.ring", 0, 0));
    this.blastRing.visible = false;
    this.blastRing.depthBias = -2;
    this.blastRing.scaleX = this.blastRing.scaleY = GRENADE_BLAST.radius / 48;

    this.camera.projection = { kind: "isometric", tile: { w: TILE.w, h: TILE.h } };
    this.camera.zoom = 1.3;
    Object.assign(this.cameraGround, { x: y.player.x, y: y.player.y, z: 0 });
    this.camera.follow(this.cameraGround, 6);

    // Last in the world, as light layers go: flashes and the bolts' glow.
    this.lights = this.world.add(new LightLayer(AMBIENT)).add(new LightPool({ capacity: 24 }));

    this.hud = this.ui.add(new Hud(this));
    this.syncTouch();
    this.retint(true);
    this.app.audio.setMood("yard", { crossfade: 1 });
  }

  /** A projected decal on the ground at height z. */
  private ground(sprite: string, x: number, y: number, z: number, scale = 1): Sprite {
    const s = this.world.add(new Sprite(sprite, x, y));
    s.z = z;
    s.depthBias = -1;
    s.scaleX = s.scaleY = scale;
    return s;
  }

  private addBarrel(c: number, r: number): void {
    const [x, y] = [(c + 0.5) * CELL, (r + 0.5) * CELL];
    const shadow = this.ground("contact", x, y, 0, 0.7);
    const body = this.world.add(new Sprite("barrel", x, y));
    this.barrels.set(r * this.yard.cols + c, [body, shadow]);
  }

  // ----------------------------------------------------------------------------- input

  override onAction(name: string, pressed: boolean): void {
    if (this.ended) return;
    if (name === "pause" && pressed) this.pauseGame();
    if (name === "restart" && pressed) this.app.scenes.change(new PlayScene(), { transition: "fade", duration: 0.4 });
    if (name === "reload" && pressed) this.wantReload = true;
    if (name === "rifle" && pressed) this.wantWeapon = 0;
    if (name === "shotgun" && pressed) this.wantWeapon = 1;
    if (name === "swap" && pressed) this.wantWeapon = (this.yard.weapon + 1) % this.yard.weapons.length;
    if (name === "grenade") this.setGrenade(pressed);
  }

  private setGrenade(down: boolean): void {
    if (down && this.yard.grenades > 0) this.aimingGrenade = true;
    else if (!down && this.aimingGrenade) {
      this.aimingGrenade = false;
      if (this.yard.throwGrenade(this.grenadeTarget.x, this.grenadeTarget.y)) this.app.haptic("light");
    }
  }

  override onResize(): void {
    if (this.hud) this.syncTouch();
  }

  /** The virtual sticks exist on touch screens only; their zones follow the HUD's layout. */
  private syncTouch(): void {
    const L = this.hud.layout();
    if (!L.touch) {
      this.sticks?.destroy();
      this.sticks = null;
      return;
    }
    if (!this.sticks) {
      this.sticks = this.ui.add(new VirtualSticks({ sticks: [{ zone: "left" }, { zone: "right" }], size: 52, always: true }));
      // A thumb aims like a controller's stick: along a direction, with assist.
      this.aim.device = "stick";
      this.aim.angle = this.yard.player.aim;
    }
    const H = Math.max(1, this.uiHeight);
    // Under the HUD's top row on the left; under the grenade and reload buttons on the right.
    const left = Math.min(0.6, (L.vitals.y + L.vitals.h + 12) / H);
    const right = Math.min(0.7, (L.reload.y + L.reload.h + 8) / H);
    this.sticks.specs[0] = { zone: { x: 0, y: left, w: 0.5, h: 1 - left }, rest: [0.14, 0.8] };
    this.sticks.specs[1] = { zone: { x: 0.5, y: right, w: 0.5, h: 1 - right }, rest: [0.86, 0.8] };
  }

  /** Taps on the HUD's touch buttons: each finger counts once, and the grenade is held. */
  private readTouch(): void {
    const L = this.hud.layout();
    if (!L.touch) return;
    const touches = this.app.pointer.touches;
    for (const id of this.fingers) if (!touches.has(id)) this.fingers.delete(id);
    if (this.grenadeFinger !== null && !touches.has(this.grenadeFinger)) {
      this.grenadeFinger = null;
      this.setGrenade(false);
    }
    const inside = (r: Box, p: { x: number; y: number }) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
    for (const [id, t] of touches) {
      if (this.fingers.has(id)) continue;
      this.fingers.add(id);
      const p = this.toUI(t.x, t.y);
      if (inside(L.pause, p)) this.pauseGame();
      else if (inside(L.weapon, p)) this.wantWeapon = (this.yard.weapon + 1) % this.yard.weapons.length;
      else if (inside(L.reload, p)) this.wantReload = true;
      else if (inside(L.grenade, p) && this.grenadeFinger === null) {
        this.grenadeFinger = id;
        this.setGrenade(true);
      }
    }
  }

  private pointerGround(): { x: number; y: number; z: number } {
    const p = this.app.pointer;
    return pickGround(this.camera, p.x, p.y, (x, y) => this.yard.heightAt(x, y), { maxZ: TILE.rise * 2 + 4, step: 4 });
  }

  private readControls(): Controls {
    const app = this.app;
    const y = this.yard;
    const p = y.player;
    // Movement is screen-relative: up on the keyboard or stick walks up the screen.
    let ix = app.input.axis("left", "right");
    let iy = app.input.axis("up", "down");
    const stick = app.gamepad.leftStick;
    if (app.gamepad.connected && Math.hypot(stick.x, stick.y) > 0.22) {
      ix = stick.x;
      iy = stick.y;
      app.input.lastDevice = "gamepad";
    }
    this.readTouch();
    const sticks = this.sticks;
    const thumb = sticks ? sticks.vector(0) : null;
    if (thumb && Math.hypot(thumb.x, thumb.y) > 0.18) {
      ix = thumb.x;
      iy = thumb.y;
    }
    let moveX = 0;
    let moveY = 0;
    const mag = Math.min(1, Math.hypot(ix, iy));
    if (mag > 0) {
      const [wx, wy] = screenDirToWorld(this.camera, p.x, p.y, ix, iy);
      moveX = wx * mag;
      moveY = wy * mag;
    }
    const pointer = app.pointer;
    const pick = this.pointerGround();
    let right = app.gamepad.connected ? app.gamepad.rightStick : null;
    // The right thumb aims past the stick's deadzone and fires when pushed further out.
    const aimThumb = sticks ? sticks.vector(1) : null;
    const push = aimThumb ? Math.hypot(aimThumb.x, aimThumb.y) : 0;
    if (aimThumb && push > this.aim.deadzone) right = aimThumb;
    // With sticks on screen the pointer is a finger on a control, never a cursor to aim at.
    let aim = this.aim.update(sticks ? { from: p, stick: right, camera: this.camera } : { from: p, stick: right, pointer: { x: pointer.x, y: pointer.y }, pointerGround: pick, camera: this.camera });
    let aimZ: number | undefined;
    let aimDist: number | undefined;
    if (this.aim.device === "stick") {
      const visible = y.sentries.filter((s) => s.state !== "dead" && y.fog.sees(s.x, s.y));
      aim = this.assist.apply(p.x, p.y, aim, visible, (s) => y.world.clear(p.x, p.y, s.x, s.y, p.z + CHEST, s.z + CHEST));
      const t = this.assist.target;
      if (t) {
        aimZ = t.z + CHEST;
        aimDist = Math.hypot(t.x - p.x, t.y - p.y);
      }
      this.grenadeTarget = { x: p.x + Math.cos(aim) * 170, y: p.y + Math.sin(aim) * 170 };
    } else {
      this.assist.reset();
      aimZ = pick.z + CHEST;
      aimDist = Math.hypot(pick.x - p.x, pick.y - p.y);
      this.grenadeTarget = { x: pick.x, y: pick.y };
    }
    const mouseFire = pointer.down && pointer.button === 0 && pointer.type === "mouse" && !this.hud.covers(pointer.x, pointer.y);
    const fire = !this.aimingGrenade && (app.input.isDown("fire") || mouseFire || push > TOUCH_FIRE);
    const c: Controls = { moveX, moveY, aim, aimZ, aimDist, fire, weapon: this.wantWeapon, reload: this.wantReload };
    this.wantWeapon = undefined;
    this.wantReload = false;
    return c;
  }

  override onPointerDown(): void {
    if (this.app.pointer.button === 2) this.setGrenade(true);
  }

  override onPointerUp(): void {
    if (this.aimingGrenade && this.app.pointer.button === 2) this.setGrenade(false);
  }

  // ----------------------------------------------------------------------------- frame

  override update(dt: number): void {
    const y = this.yard;
    if (!this.ended) {
      const before = { x: y.player.x, y: y.player.y };
      y.step(dt, this.readControls());
      const moved = Math.hypot(y.player.x - before.x, y.player.y - before.y);
      this.moving = moved > 0.01;
      // Stride with the ground covered.
      this.hero.speed = this.moving && dt > 0 ? Math.min(1.6, Math.max(0.5, moved / dt / 130)) : 1;
    } else {
      y.step(dt, { moveX: 0, moveY: 0, aim: y.player.aim, fire: false });
    }
    this.drain();
    this.syncActors();
    this.syncAim();
    this.retint(false);
    this.updatePops(dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    Object.assign(this.cameraGround, { x: y.player.x, y: y.player.y, z: y.player.z });
    if (!this.ended && (y.cleared || !y.alive)) this.finish(y.cleared);
  }

  /** Turn the simulation's events into sparks, sounds, decals and shakes. */
  private drain(): void {
    const y = this.yard;
    const audio = this.app.audio;
    const muzzles = new Set<string>();
    for (const f of y.fx.splice(0)) {
      switch (f.kind) {
        case "shot":
          this.tracer(f);
          break;
        case "blast": {
          this.explosion(f.x, f.y, f.z, f.radius);
          audio.play("boom");
          this.camera.shake(f.radius > 80 ? 7 : 4, 0.35);
          this.hitStop(f.radius > 80 ? 0.045 : 0.02);
          this.app.haptic("heavy");
          break;
        }
        case "tile": {
          this.map.set(f.col, f.row, f.to);
          this.map.setElevation(f.col, f.row, levelsOf(f.to));
          const [x, yy] = [(f.col + 0.5) * CELL, (f.row + 0.5) * CELL];
          const top = levelsOf(f.from) * TILE.rise;
          if (f.from === BARREL) {
            for (const s of this.barrels.get(f.row * y.cols + f.col) ?? []) s.destroy();
            this.barrels.delete(f.row * y.cols + f.col);
          }
          if (f.destroyed) this.decals.freeCell(f.col, f.row);
          const wood = f.from === CRATE || f.from === CRATE_SPLIT;
          this.burst(x, yy, Math.max(4, top * 0.6), f.destroyed ? 18 : 6, wood ? "splinter" : "chip", 130);
          if (f.destroyed && f.from !== BARREL) this.puff(x, yy, top * 0.5, 4);
          audio.play(f.destroyed ? "smash" : "crack");
          break;
        }
        case "hurt": {
          this.pop(f.amount >= 1 ? String(Math.round(f.amount)) : "·", f.x, f.y, f.z, f.target === "operative" ? 0xff7a66 : 0xffe1a0);
          if (f.target === "operative") {
            this.hurtFlash = Math.min(1, this.hurtFlash + 0.45);
            this.camera.shake(2.5, 0.15);
            audio.play("hurt");
          } else if (f.killed) {
            this.hitStop(0.07);
            audio.play("kill");
            this.pop("DOWN", f.x, f.y, f.z + 16, 0xffb547);
            shell.saves?.autosave({ yard: y.save(), cleared: 0 });
          } else audio.play("ping");
          break;
        }
        case "spotted": {
          const s = y.sentries.find((q) => q.id === f.id);
          if (s && y.fog.sees(s.x, s.y)) {
            this.pop("!", s.x, s.y, s.z + 44, 0xff5a46);
            audio.play("alert");
          }
          break;
        }
        case "reload":
          audio.play("reload");
          break;
        case "throw":
          audio.play("throw");
          break;
        case "bounce":
          audio.play("clink");
          break;
        case "bolt":
          if (y.fog.sees(f.x, f.y)) {
            this.trails.push(f.id, f.x, f.y, f.z);
            this.lights.track(f.id, f.x, f.y, f.z, { color: 0xff5a3a, radius: 58, intensity: 0.9, fade: 0.08 });
          }
          break;
        case "empty":
          audio.play("click");
          break;
      }
      if (f.kind === "shot" && f.weapon !== "bolt") {
        const key = `${f.weapon}${Math.round(f.x0)},${Math.round(f.y0)}`;
        if (!muzzles.has(key)) {
          muzzles.add(key);
          const [mx, my, mz] = this.heroMuzzle() ?? [f.x0, f.y0, f.z + 2];
          this.fx.spawn({ sprite: "muzzle", x: mx, y: my, z: mz, life: 0.05, scale: f.weapon === "shotgun" ? 1.4 : 1 });
          this.lights.flash(f.x0, f.y0, f.z + 4, { color: 0xffc27a, radius: f.weapon === "shotgun" ? 150 : 105, intensity: 1, life: f.weapon === "shotgun" ? 0.09 : 0.05 });
          audio.play(f.weapon);
          this.camera.shake(f.weapon === "shotgun" ? 2.2 : 0.6, 0.08);
        }
      } else if (f.kind === "shot") audio.play("zap");
    }
  }

  /** Where the operative's painted barrel ends, for the flash and tracer; the shot itself comes from the sim. */
  private heroMuzzle(): [number, number, number] | null {
    return this.hero.pointInWorld("muzzle", MUZZLE_FORWARD);
  }

  private tracer(f: Extract<Fx, { kind: "shot" }>): void {
    const bolt = f.weapon === "bolt";
    if (!bolt) {
      // A travelling tracer: a short bright section that leaves the barrel and reaches the hit.
      const shotgun = f.weapon === "shotgun";
      // The sim fires from the body; the tracer leaves the painted barrel.
      const [x0, y0, z0] = this.heroMuzzle() ?? [f.x0, f.y0, f.z];
      this.beams.spawn(x0, y0, z0, f.x1, f.y1, f.z1, shotgun
        ? { speed: 2100, head: 34, width: 1.5, color: 0xffe9b8, glow: 0xff9a3a, glowWidth: 3, glowAlpha: 0.4 }
        : { speed: 2600, head: 88, width: 2.2, color: 0xfff3d0, glow: 0xffa040, glowWidth: 3.2, glowAlpha: 0.5 });
    }
    if (f.hit === "none") return;
    const back = Math.atan2(f.y0 - f.y1, f.x0 - f.x1);
    const sparks = f.hit === "sentry" ? 8 : f.hit === "operative" ? 3 : 5;
    for (let i = 0; i < sparks; i++) {
      const a = back + (Math.random() - 0.5) * 1.8;
      const v = 60 + Math.random() * 110;
      this.fx.spawn({ sprite: bolt ? "bolt.streak" : "spark.streak", x: f.x1, y: f.y1, z: f.z1, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 30 + Math.random() * 70, life: 0.15 + Math.random() * 0.15, scale: bolt ? 0.45 : 0.6 + Math.random() * 0.4, align: "velocity", stretch: 0.012 });
    }
    if (f.hit === "brick" || f.hit === "wall") this.burst(f.x1, f.y1, f.z1, 3, "chip", 70);
    if (f.hit === "crate") this.burst(f.x1, f.y1, f.z1, 3, "splinter", 70);
    if (f.hit === "wall" || f.hit === "brick" || f.hit === "crate") this.markHit(f.x1, f.y1, f.z1, f.nx, f.ny, bolt);
  }

  /** A bullet hole, or a bolt's scorch, on the face the shot went into. */
  private markHit(x: number, y: number, z: number, nx: number, ny: number, bolt: boolean): void {
    const at = this.map.surfaceAt(x, y, z, nx, ny);
    if (!at.visible) return;
    this.decals.mark(at.x, at.y, at.z, bolt
      ? { sprite: "scorch.flat", normal: at.normal, scale: [0.14, 0.2], randomRot: true, alpha: 0.8, stay: 10, fade: 3 }
      : { sprite: "hole", normal: at.normal, scale: [0.75, 1.1], randomRot: true, stay: 14, fade: 3 });
  }

  private burst(x: number, y: number, z: number, count: number, sprite: string, speed: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.debris.spawn({ sprite, x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 60 + Math.random() * 120, vrot: (Math.random() - 0.5) * 20, life: 0.6 + Math.random() * 0.5 });
    }
  }

  private puff(x: number, y: number, z: number, count: number): void {
    for (let i = 0; i < count; i++) {
      this.smoke.spawn({ x: x + (Math.random() - 0.5) * 20, y: y + (Math.random() - 0.5) * 20, z: z + Math.random() * 10, vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, vz: 10, life: 1 + Math.random() * 0.6, scale: 0.8 + Math.random() * 0.8, alpha: 0.7 });
    }
  }

  private explosion(x: number, y: number, z: number, radius: number): void {
    const k = radius / 96;
    for (let i = 0; i < Math.round(26 * k); i++) {
      const a = Math.random() * Math.PI * 2;
      const v = radius * (0.4 + Math.random() * 0.9);
      this.fx.spawn({ sprite: "flame", x, y, z: z + 6, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 40 + Math.random() * 140, life: 0.25 + Math.random() * 0.25, scale: (0.8 + Math.random() * 1.2) * k });
    }
    this.fx.spawn({ sprite: "flame", x, y, z: z + 14, life: 0.18, scale: 4 * k });
    this.puff(x, y, z + 8, Math.round(10 * k));
    this.burst(x, y, z + 4, Math.round(10 * k), "chip", radius * 1.6);
    const sx = x + (Math.random() - 0.5) * 6;
    const sy = y + (Math.random() - 0.5) * 6;
    this.decals.mark(sx, sy, this.yard.heightAt(sx, sy), { sprite: "scorch.flat", scale: (radius / 52) * (0.8 + Math.random() * 0.3), randomRot: true, alpha: 0.85, stay: 40, fade: 8 });
    this.lights.flash(x, y, z + 12, { color: 0xff9a4a, radius: radius * 3.2, intensity: 1, life: 0.45, curve: "quad" });
  }

  private pop(text: string, x: number, y: number, z: number, color: number): void {
    let p = this.pops.find((q) => q.age >= 0.8);
    if (!p) {
      if (this.pops.length >= 24) p = this.pops.reduce((a, b) => (a.age > b.age ? a : b));
      else {
        p = { label: this.world.add(new Label("", 0, 0, { align: "center", shadow: INK, font: { ...UI_FONT, size: 15, weight: 700 } })), age: 0 };
        this.pops.push(p);
      }
    }
    p.label.text = text;
    p.label.color = color;
    p.label.setPosition(x + (Math.random() - 0.5) * 8, y);
    p.label.z = z;
    p.label.depthBias = 60;
    p.label.visible = true;
    p.label.alpha = 1;
    p.age = 0;
  }

  private updatePops(dt: number): void {
    for (const p of this.pops) {
      if (p.age >= 0.8) continue;
      p.age += dt;
      p.label.z += dt * 30;
      p.label.alpha = Math.min(1, (0.8 - p.age) * 4);
      if (p.age >= 0.8) p.label.visible = false;
    }
  }

  private syncActors(): void {
    const y = this.yard;
    const p = y.player;
    this.hero.play(!y.alive ? "op.dead" : this.moving ? "op.walk" : "op.idle");
    this.hero.turn!.target = p.aim;
    this.hero.setPosition(p.x, p.y);
    this.hero.z = p.z;
    this.hero.material = p.flash > 0 ? { kind: "flash", p0: 0.8 } : null;
    this.heroShadow.setPosition(p.x, p.y);
    this.heroShadow.z = p.z;
    for (const s of y.sentries) {
      const sp = this.sentrySprites.get(s.id)!;
      sp.body.play(s.state === "dead" ? "sentry.dead" : "sentry.idle");
      sp.body.turn!.target = s.facing;
      sp.body.material = s.flash > 0 ? { kind: "flash", p0: 0.9 } : null;
      const explored = y.fog.isExplored(s.col, s.row);
      sp.body.visible = sp.shadow.visible = explored;
      sp.body.tint = y.fog.isVisible(s.col, s.row) ? 0xffffff : FOG_SEEN;
    }
    this.bolts.freeAll();
    for (const b of y.bolts) if (y.fog.sees(b.x, b.y)) this.bolts.spawn({ x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.slope * Math.hypot(b.vx, b.vy) });
    this.nades.freeAll();
    for (const g of y.grenadesInFlight) {
      const blink = g.fuse < 0.5 && Math.floor(g.fuse * 16) % 2 === 0;
      this.nades.spawn({ x: g.t.x, y: g.t.y, z: g.t.z + 3, tint: blink ? 0xff8a6a : 0xffffff });
    }
    for (const [key, sprites] of this.barrels) {
      const c = key % y.cols, r = Math.floor(key / y.cols);
      const tint = y.fog.isVisible(c, r) ? 0xffffff : y.fog.isExplored(c, r) ? FOG_SEEN : FOG_HIDDEN;
      sprites[0].tint = tint;
    }
  }

  private syncAim(): void {
    const y = this.yard;
    const p = y.player;
    const pick = this.aim.device === "pointer" ? this.pointerGround() : null;
    this.reticle.visible = y.alive && !this.ended && !this.aimingGrenade;
    if (pick) {
      this.reticle.setPosition(pick.x, pick.y);
      this.reticle.z = pick.z;
    } else {
      const d = 120;
      const rx = p.x + Math.cos(p.aim) * d, ry = p.y + Math.sin(p.aim) * d;
      this.reticle.setPosition(rx, ry);
      this.reticle.z = y.heightAt(rx, ry);
    }
    const t = this.assist.target;
    this.lock.visible = !!t && this.aim.device === "stick";
    if (t) {
      this.lock.setPosition(t.x, t.y);
      this.lock.z = t.z;
    }
    this.arc.freeAll();
    this.blastRing.visible = this.aimingGrenade && y.grenades > 0;
    if (this.blastRing.visible) {
      const prev = y.previewThrow(this.grenadeTarget.x, this.grenadeTarget.y);
      for (const pt of prev.path) this.arc.spawn({ x: pt.x, y: pt.y, z: pt.z, alpha: 0.85, scale: 0.9 });
      this.blastRing.setPosition(prev.end.x, prev.end.y);
      this.blastRing.z = prev.end.z;
    }
  }

  /**
   * Cell tints: fog first (hidden, seen, visible), then every visible turret's sight cone,
   * cut by walls the way its line of sight is. Only cells whose tint changed are written.
   */
  private retint(all: boolean): void {
    const y = this.yard;
    this.cone.fill(0);
    for (const s of y.sentries) {
      if (s.state === "dead" || !y.fog.isVisible(s.col, s.row)) continue;
      y.sentryView(s, this.coneScratch);
      const mark = s.state === "alert" ? 2 : 1;
      for (let i = 0; i < this.cone.length; i++) if (this.coneScratch[i] && this.cone[i] < mark) this.cone[i] = mark;
    }
    for (let r = 0; r < y.rows; r++) {
      for (let c = 0; c < y.cols; c++) {
        const i = r * y.cols + c;
        let tint = y.fog.visible[i] ? 0xffffff : y.fog.explored[i] ? FOG_SEEN : FOG_HIDDEN;
        if (y.fog.visible[i] && this.cone[i] && levelsOf(y.map.get(c, r)) === 0) tint = mixTint(tint, this.cone[i] === 2 ? CONE_ALERT : CONE, this.cone[i] === 2 ? 0.28 : 0.16);
        // A little per-cell variation keeps the slabs from looking stamped.
        const h = ((c * 73856093) ^ (r * 19349663)) >>> 0;
        tint = mulTint(tint, 0xf2f2f2 + ((h % 13) << 16) + ((h % 13) << 8) + (h % 13));
        if (all || this.tints[i] !== tint) {
          this.tints[i] = tint;
          this.map.setTint(c, r, tint);
        }
      }
    }
    y.fogChanged.length = 0;
  }

  // ----------------------------------------------------------------------------- flow

  private pauseGame(): void {
    this.aimingGrenade = false;
    this.grenadeFinger = null;
    this.app.scenes.push(new PauseScene({ settings: shell.settings ?? undefined, onQuit: () => this.quit() }), { overlay: true });
  }

  private quit(): void {
    if (!this.ended) shell.saves?.autosave({ yard: this.yard.save(), cleared: 0 });
    this.app.scenes.change(title(this.app), { transition: "fade", duration: 0.4 });
  }

  private finish(won: boolean): void {
    this.ended = true;
    this.aimingGrenade = false;
    this.grenadeFinger = null;
    if (this.sticks) this.sticks.visible = false;
    shell.saves?.delete(0);
    const L = this.hud.layout();
    // A phone's HUD row reaches further down the screen: the card sits a little lower.
    const card = this.ui.add(new Anchor({ x: "center", y: "center", dy: this.compact && L.touch ? 14 : 0 }));
    card.add(new Plate(-250, -110, 500, 220));
    card.add(new Label(won ? "YARD CLEAR" : "OPERATIVE DOWN", 0, -76, { align: "center", color: won ? 0xffb547 : 0xff6a56, shadow: INK, font: { ...UI_FONT, size: 34, weight: 700 } }));
    const y = this.yard;
    const line = won ? `All six sentries down in ${Math.round(y.time)} s, ${y.grenades} grenades to spare.` : `${y.remaining} of 6 sentries still hold the yard.`;
    card.add(new Label(line, 0, -22, { align: "center", color: 0xe9edf0, font: { ...UI_FONT, size: 16, weight: 600 } }));
    card.add(new Button(won ? "Run it again" : "Try again", -120, 26, 240, L.tap(50), { onPress: () => this.app.scenes.change(new PlayScene(), { transition: "fade", duration: 0.4 }) }));
  }

  /** For the HUD. */
  get hurt(): number {
    return this.hurtFlash;
  }

  get grenadeAiming(): boolean {
    return this.aimingGrenade;
  }

  get aimDevice(): "pointer" | "stick" {
    return this.aim.device;
  }

  get over(): boolean {
    return this.ended;
  }

  /** Whether a thumb holds stick `i` (0 moves, 1 aims). */
  stickHeld(i: number): boolean {
    return !!this.sticks?.held(i);
  }
}

class Plate extends Node2D {
  constructor(x: number, y: number, private readonly w: number, private readonly h: number) {
    super(x, y);
  }
  override render(ctx: DrawContext): void {
    ctx.rect(0, 0, this.w, this.h, 0x10161c, 0.94);
    ctx.frame(0, 0, this.w, this.h, 0x4a5866, 1, 1);
    ctx.rect(0, 0, this.w, 3, 0xffb547, 0.9);
  }
}

/**
 * The HUD: vitals and the sentry count top left, a tactical map of explored cells top right,
 * the weapon, ammo and grenades bottom right, the controls bottom left. Drawn straight from
 * the yard every frame.
 */
class Hud extends Node2D {
  constructor(private readonly play: PlayScene) {
    super();
  }

  /**
   * Where everything sits, in UI units. On a laptop the HUD keeps its four corners. On a touch
   * screen `ui.minPoints` / `ui.tabletPoints` (blackiron.json) grow the UI layer, so it is about
   * 830-980 units by 470-550: the bottom corners belong to the thumbs, so the weapon joins the
   * vitals in a row along the top with a pause button, the grenade and reload buttons sit under
   * the map, text is raised to 11 points and buttons to 44.
   */
  layout() {
    const scene = this.scene;
    const info = scene?.screenInfo;
    const touch = !!info?.touch;
    const W = scene?.uiWidth ?? 1280;
    const H = scene?.uiHeight ?? 720;
    const [it, ir, ib, il] = scene?.uiInsets ?? [0, 0, 0, 0];
    // Points one UI unit shows at, after the engine grew the layer.
    const per = (info?.pointsPerUnit ?? 1) * Math.abs(scene?.ui.scaleX || 1);
    const text = (size: number) => (touch ? Math.max(size, Math.ceil(11 / per - 1e-6)) : size);
    const tap = (size: number) => (touch ? Math.max(size, Math.ceil(44 / per - 1e-6)) : size);
    const y = this.play.yard;
    const head = text(12), small = text(10);
    const bar1 = 30 + head + 12, bar2 = bar1 + 18 + small;
    const vitals: Box = { x: 20 + il, y: 20 + it, w: 270, h: bar2 + 12 + small + 8 - 20 };
    const cs = 6;
    const map: Box = { x: W - 20 - ir - y.cols * cs, y: 20 + it, w: y.cols * cs, h: y.rows * cs };
    const weapon: Box = touch ? { x: vitals.x + vitals.w + 12, y: vitals.y, w: 250, h: vitals.h } : { x: W - 270, y: H - 112, w: 250, h: 92 };
    const side = tap(56);
    const pause: Box = { x: weapon.x + weapon.w + 12, y: vitals.y, w: side, h: side };
    const bw = Math.max(88, side), bh = side, by = map.y + map.h + 6 + 10;
    const reload: Box = { x: W - 20 - ir - bw, y: by, w: bw, h: bh };
    const grenade: Box = { x: reload.x - 12 - bw, y: by, w: bw, h: bh };
    return { touch, W, H, text, tap, head, small, bar1, bar2, vitals, map, cs, weapon, pause, reload, grenade, bottom: ib };
  }

  /** Screen rectangles the HUD owns, so a click there does not fire. */
  covers(x: number, y: number): boolean {
    const w = this.scene?.app.width ?? 1280;
    return (x < 300 && y < 120) || (x > w - 190 && y < 190);
  }

  override render(ctx: DrawContext): void {
    const play = this.play;
    const y = play.yard;
    const scene = this.scene!;
    const app = scene.app;
    const L = this.layout();
    const { W, H, touch } = L;
    const f = (size: number, weight = 700) => ({ ...UI_FONT, size: L.text(size), weight });
    if (play.hurt > 0) {
      ctx.rect(0, 0, W, H, 0xb3261e, play.hurt * 0.22);
    }
    // Vitals.
    const v = L.vitals, vx = v.x - 20, vy = v.y - 20;
    ctx.rect(v.x, v.y, v.w, v.h, 0x10161c, 0.88);
    ctx.rect(v.x, v.y, 3, v.h, 0xffb547);
    ctx.text("SENTRY YARD", vx + 36, vy + 30, { color: 0xffb547, font: f(12) });
    if (touch) ctx.text(`${y.remaining} / 6 SENTRIES`, vx + 274, vy + 30, { color: y.remaining ? 0xff8a76 : 0x9be38a, font: f(12), align: "right" });
    else ctx.text(`${y.remaining} / 6 SENTRIES`, vx + 150, vy + 30, { color: y.remaining ? 0xff8a76 : 0x9be38a, font: f(12) });
    const hp = y.player.health;
    const bar = (yy: number, value: number, max: number, color: number, label: string) => {
      ctx.rect(vx + 36, yy, 238, 10, 0x262f38);
      ctx.rect(vx + 36, yy, Math.max(0, (238 * value) / max), 10, color);
      ctx.text(label, vx + 36, yy + 12, { color: 0x8d9aa6, font: f(10, 600) });
    };
    bar(vy + L.bar1, hp.hp, hp.max, 0xe0503a, `HEALTH ${Math.ceil(hp.hp)}`);
    bar(vy + L.bar2, hp.armour, Math.max(1, hp.maxArmour), 0x5aa7e0, `ARMOUR ${Math.ceil(hp.armour)}`);
    // Tactical map: what has been explored, the sentries seen, the operative.
    const cs = L.cs, mx = L.map.x, my = L.map.y;
    ctx.rect(mx - 6, my - 6, y.cols * cs + 12, y.rows * cs + 12, 0x10161c, 0.88);
    for (let r = 0; r < y.rows; r++) {
      for (let c = 0; c < y.cols; c++) {
        if (!y.fog.isExplored(c, r)) continue;
        const t = y.map.get(c, r), lv = levelsOf(t);
        const col = t === BARREL ? 0xd4483a : lv === 2 ? (t === WALL ? 0x8b949c : 0x9a5a44) : lv === 1 ? (t === PAD ? 0x6c757d : 0xb88552) : 0x39434d;
        ctx.rect(mx + c * cs, my + r * cs, cs - 1, cs - 1, col, y.fog.isVisible(c, r) ? 1 : 0.6);
      }
    }
    for (const s of y.sentries) {
      if (!y.fog.isExplored(s.col, s.row)) continue;
      ctx.rect(mx + s.col * cs - 1, my + s.row * cs - 1, cs + 1, cs + 1, s.state === "dead" ? 0x5a6168 : s.state === "alert" ? 0xff4a32 : 0xffa070);
    }
    const pc = y.player.x / CELL, pr = y.player.y / CELL;
    ctx.rect(mx + pc * cs - 2.5, my + pr * cs - 2.5, 5, 5, 0xffffff);
    // Weapon and ammo.
    const gun = y.gun;
    const bx = L.weapon.x, by = L.weapon.y, wh = L.weapon.h;
    ctx.rect(bx, by, 250, wh, 0x10161c, 0.88);
    ctx.rect(bx + 247, by, 3, wh, 0xffb547);
    ctx.text(gun.def.id === "rifle" ? "RIFLE" : "SHOTGUN", bx + 16, by + 12, { color: 0xe9edf0, font: f(14) });
    if (touch) ctx.text("TAP TO SWAP", bx + 234, by + 12, { color: 0x8d9aa6, font: f(11, 600), align: "right" });
    else ctx.text(gun.def.id === "rifle" ? "1 · Q" : "2 · Q", bx + 200, by + 14, { color: 0x6c7a86, font: f(11, 600), align: "right" });
    if (gun.reloading) {
      ctx.text("RELOADING", bx + 16, by + 38, { color: 0xffb547, font: f(22) });
      ctx.rect(bx + 16, by + 70, 200, 6, 0x262f38);
      ctx.rect(bx + 16, by + 70, 200 * gun.reloadProgress, 6, 0xffb547);
    } else {
      ctx.text(String(gun.ammo), bx + 16, by + 32, { color: gun.ammo <= gun.def.magazine * 0.25 ? 0xff8a76 : 0xffffff, font: f(36) });
      ctx.text(`/ ${gun.def.magazine}`, bx + 84, by + 48, { color: 0x8d9aa6, font: f(14, 600) });
    }
    // On a touch screen the taller type would run into the reload bar, which takes this room.
    if (!(touch && gun.reloading)) {
      ctx.text("GRENADES", bx + 150, by + 44, { color: 0x8d9aa6, font: f(10, 600) });
      for (let i = 0; i < 5; i++) ctx.rect(bx + 150 + i * 16, by + 50 + L.small, 11, 11, i < y.grenades ? 0x9db07c : 0x262f38);
    }
    if (touch) {
      this.renderTouch(ctx, L);
    } else {
      // Controls.
      const pad = app.input.lastDevice === "gamepad";
      const lines = pad
        ? ["Left stick  move", "Right stick  aim · RT fire", "LT  hold to aim a grenade, release to throw", "X reload · Y swap · Start pause"]
        : ["WASD  move · mouse aim · click fire", "Right-click or G  hold to aim a grenade", "R reload · 1 2 Q weapons · Esc pause"];
      ctx.rect(20, H - 22 - lines.length * 18 - 12, 330, lines.length * 18 + 16, 0x10161c, 0.8);
      lines.forEach((l, i) => ctx.text(l, 32, H - 22 - lines.length * 18 + i * 18 - 4, { color: 0xb9c3cc, font: f(12, 600) }));
    }
    if (play.grenadeAiming) ctx.text("RELEASE TO THROW", W / 2, H - 60 - L.bottom, { align: "center", color: 0xffb547, shadow: INK, font: f(16) });
    if (y.grenades === 0 && play.grenadeAiming) ctx.text("NO GRENADES", W / 2, H - 84 - L.bottom, { align: "center", color: 0xff8a76, font: f(14) });
  }

  /** The touch buttons, and what each thumb does, said where it rests. */
  private renderTouch(ctx: DrawContext, L: ReturnType<Hud["layout"]>): void {
    const play = this.play;
    const scene = this.scene!;
    if (play.over) return;
    const y = play.yard;
    const f = (size: number, weight = 700) => ({ ...UI_FONT, size: L.text(size), weight });
    const plate = (b: Box, lit: boolean) => {
      ctx.rect(b.x, b.y, b.w, b.h, lit ? 0x2a3540 : 0x10161c, 0.88);
      ctx.frame(b.x, b.y, b.w, b.h, lit ? 0xffb547 : 0x4a5866, 1, 1);
    };
    const label = (b: Box, s: string, color: number) => ctx.text(s, b.x + b.w / 2, b.y + b.h / 2 - L.text(12) * 0.62, { align: "center", color, font: f(12) });
    plate(L.pause, false);
    const p = L.pause;
    ctx.rect(p.x + p.w / 2 - 9, p.y + p.h / 2 - 10, 6, 20, 0xe9edf0);
    ctx.rect(p.x + p.w / 2 + 3, p.y + p.h / 2 - 10, 6, 20, 0xe9edf0);
    plate(L.grenade, play.grenadeAiming);
    label(L.grenade, "GRENADE", y.grenades > 0 ? 0xe9edf0 : 0x6c7a86);
    plate(L.reload, y.gun.reloading);
    label(L.reload, "RELOAD", y.gun.reloading ? 0xffb547 : 0xe9edf0);
    scene.reportTarget("Pause", p.x, p.y, p.w, p.h);
    scene.reportTarget("Swap weapon", L.weapon.x, L.weapon.y, L.weapon.w, L.weapon.h);
    scene.reportTarget("Grenade", L.grenade.x, L.grenade.y, L.grenade.w, L.grenade.h);
    scene.reportTarget("Reload", L.reload.x, L.reload.y, L.reload.w, L.reload.h);
    // Under each resting stick, until a thumb takes it.
    const rest = (i: number, fx: number, s: string) => {
      if (!play.stickHeld(i)) ctx.text(s, L.W * fx, L.H * 0.8 + 62, { align: "center", color: 0xb9c3cc, shadow: INK, font: f(12, 600) });
    };
    rest(0, 0.14, "MOVE");
    rest(1, 0.86, play.grenadeAiming ? "AIM THE THROW" : "AIM · PUSH TO FIRE");
  }
}
