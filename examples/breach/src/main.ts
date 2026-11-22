import type { App } from "@blackiron-studio/engine/app";
import { Node, type DrawContext } from "@blackiron-studio/engine/scene";
import { NativePointerLockInput, PointerLockInput } from "@blackiron-studio/engine/input";
import {
  Scene3D,
  createPhysics3D,
  type PhysicsBackend3D,
  CharacterController3D,
  FirstPersonLook,
  CombatWorld3D,
  Weapon3D,
  Projectile3D,
  Particles3D,
  CameraShake3D,
  Material3D,
  Vec3,
  Mesh3D,
  Node3D,
  spatialAudio3D,
  type DamageEvent3D,
  type NavigationGrid3D,
} from "@blackiron-studio/engine/three";
import { BreachArt, P, type DroneVisual } from "./presentation.ts";
import { Spring } from "@blackiron-studio/engine/core";
import { type BoltFx, Fx, type MuzzleFlash, TRACER_SPEED, mixColor, rand, randDir, seedRandom } from "./fx.ts";
import {
  BreachRun,
  SPAWN,
  WEAPONS,
  WAVES,
  RELAYS,
  ENEMY_SPAWNS,
} from "./level.ts";
interface Enemy {
  id: number;
  health: number;
  maxHealth: number;
  heavy: boolean;
  /** Placed and turned by the game. */
  node: Node3D;
  /** Under `node`: banking, recoil and hit jolts. */
  rig: Node3D;
  core: Mesh3D;
  eye: Material3D;
  visual: DroneVisual;
  body: ReturnType<PhysicsBackend3D["createBody"]>;
  removeTarget: () => void;
  position: Vec3;
  cooldown: number;
  flash: number;
  path: Vec3[];
  repath: number;
  yaw: number;
  vel: Vec3;
  last: Vec3;
  jolt: [Spring, Spring, Spring];
  tilt: [Spring, Spring];
  kick: Spring;
  /** Seconds of charge left before it fires, or -1. */
  charge: number;
  smoke: number;
  barrel: number;
  rotor: number;
}
interface Bolt {
  shot: Projectile3D;
  fx: BoltFx;
}
/** How long a drone's eye charges before it fires. */
const CHARGE = { light: 0.45, heavy: 0.6 };
interface Settings {
  sensitivity: number;
  invertY: boolean;
  fov: number;
  muted: boolean;
  bindings: Record<string, string>;
  best: number;
}
const DEFAULT_SETTINGS: Settings = {
  sensitivity: 0.0022,
  invertY: false,
  fov: 68,
  muted: false,
  bindings: {},
  best: 0,
};
export class BreachScene extends Scene3D {
  readonly state = new BreachRun();
  readonly look = new FirstPersonLook();
  readonly eye = new Vec3();
  readonly weapons = WEAPONS.map((d, i) => new Weapon3D(d, 202 + i));
  readonly combat: CombatWorld3D;
  readonly player: CharacterController3D;
  readonly art: BreachArt;
  readonly navigation: NavigationGrid3D;
  readonly enemies: Enemy[] = [];
  readonly bolts: Bolt[] = [];
  readonly particles: Particles3D;
  readonly fx: Fx;
  private readonly flashes: MuzzleFlash[];
  // First-person gun motion: springs kicked by each shot, sway from the mouse, and blends for
  // sprinting and drawing the gun.
  private readonly gunKick = { back: new Spring(260, 22), lift: new Spring(200, 18), pitch: new Spring(240, 20), roll: new Spring(160, 12), yaw: new Spring(180, 16) };
  private readonly sway = { x: new Spring(90, 14), y: new Spring(90, 14) };
  private readonly shake = new CameraShake3D("breach");
  private heat = 0;
  private sprintBlend = 0;
  private raise = 1;
  private pumpTime = -1;
  private pumpEjected = true;
  private lastLook = { yaw: 0, pitch: 0 };
  private wasGrounded = true;
  private fallSpeed = 0;
  private ventSmoke = 0;
  weaponIndex = 0;
  recoil = 0;
  stride = 0;
  settingsOpen = false;
  rebindAction: string | null = null;
  lock: PointerLockInput | NativePointerLockInput | null = null;
  message = "";
  nearestRelay = -1;
  private jump = false;
  private firePressed = false;
  private footsteps = 0;
  private nextEnemy = 0;
  private destroyed = false;
  private flash = 0;
  private debugHud = false;
  settings: Settings;
  constructor(
    readonly physicsWorld: PhysicsBackend3D,
    settings: Settings,
  ) {
    super(1280, 720);
    // Every run plays its effects from the same seed.
    seedRandom("signal-breach");
    this.name = "signal-breach";
    this.settings = settings;
    this.physics3D = physicsWorld;
    this.camera3D.fov = settings.fov;
    this.camera3D.near = 0.045;
    this.camera3D.far = 160;
    this.look.sensitivity = settings.sensitivity;
    this.look.invertY = settings.invertY;
    // Dusk storm over the sea: a low copper sun under a slate sky, cool fill, salt haze.
    this.background = 0x2a2c36;
    Object.assign(this.environment, {
      ambient: 0x7f93b4,
      ambientIntensity: 0.8,
      groundColor: 0x3a3438,
      sunColor: 0xffb47c,
      sunIntensity: 3.1,
      fogColor: 0x5a5665,
      fogDensity: 0.0115,
      exposure: 1.2,
      shadows: true,
      shadowMapSize: 2048,
      shadowExtent: 34,
      shadowBias: 0.0007,
    });
    this.environment.sunDirection.set(-0.78, 0.46, -0.42);
    this.environment.shadowTarget.set(0, 1, -3);
    Object.assign(this.post, {
      bloom: 0.62,
      bloomThreshold: 0.7,
      bloomPasses: 3,
      vignette: 0.36,
      saturation: 1.08,
      contrast: 1.12,
      brightness: 1.0,
      tint: 0xd8e4ff,
      tintAmount: 0.06,
      grain: 0.035,
    });
    this.art = new BreachArt(this, physicsWorld);
    this.navigation = this.art.navigation();
    this.player = this.resources.own(
      new CharacterController3D(physicsWorld, {
        position: SPAWN,
        speed: 6.6,
        sprintMultiplier: 1.45,
      }),
    );
    this.combat = this.resources.own(new CombatWorld3D(physicsWorld));
    this.combat.register(this.player.collider.handle, {
      takeDamage: (e) => this.damage(e),
    });
    this.particles = this.resources.own(
      this.world3D.add(new Particles3D(220, "breach")),
    );
    this.particles.floor = null;
    this.fx = new Fx(this.world3D);
    this.fx.cast = (o, d, len) => this.combat.cast(o, d, len, this.player.collider.handle);
    this.flashes = this.art.weaponModels.map((g, i) => this.fx.muzzle(g, this.art.muzzles[i], i ? "scatter" : "pulse"));
    this.lastLook = { yaw: this.look.yaw, pitch: this.look.pitch };
    this.ui.add(new BreachHud(this));
    this.timeScale = 0;
    physicsWorld.step(1 / 60);
    this.placeCamera();
  }
  override ready(): void {
    this.app.audio.setMuted(this.settings.muted);
    if (this.app.platform.kind === "native") {
      const host = (
        this.app.platform as import("@blackiron-studio/engine/platform").NativePlatform
      ).host;
      const lock = this.resources.own(
        new NativePointerLockInput(host, this.app.input),
      );
      this.lock = lock;
      lock.onChange = (locked) => {
        if (!locked && this.state.phase === "playing") this.pause();
      };
      lock.onError = (message) => {
        this.message = message;
      };
    }
    if (this.app.canvas) {
      const canvas = this.app.canvas,
        lock = this.resources.own(new PointerLockInput(canvas, this.app.input));
      this.lock = lock;
      lock.onChange = (locked) => {
        if (this.destroyed) return;
        if (!locked && this.state.phase === "playing") this.pause();
        else if (locked && this.state.phase === "paused" && !this.settingsOpen)
          this.resume();
      };
      lock.onError = () => {
        if (this.state.phase === "playing" && !this.settingsOpen)
          lock.setDragFallback(true);
        this.message =
          "Mouse capture unavailable · hold right mouse to aim, left click fires";
      };
      const down = (event: PointerEvent) => {
        if (
          event.button !== 0 ||
          lock.locked ||
          lock.dragFallback ||
          this.settingsOpen
        )
          return;
        const rect = canvas.getBoundingClientRect(),
          x = ((event.clientX - rect.left) / rect.width) * 1280,
          y = ((event.clientY - rect.top) / rect.height) * 720;
        if (
          this.state.phase === "title" &&
          x >= 66 &&
          x <= 388 &&
          y >= 493 &&
          y <= 555
        ) {
          this.start();
          void lock.request();
        } else if (
          this.state.phase === "paused" &&
          !this.settingsOpen &&
          x >= 470 &&
          x <= 810 &&
          y >= 397 &&
          y <= 451
        ) {
          this.resume();
          void lock.request();
        } else if (this.state.phase === "playing") void lock.request();
      };
      canvas.addEventListener("pointerdown", down);
      this.resources.defer(() =>
        canvas.removeEventListener("pointerdown", down),
      );
      this.resources.defer(
        this.app.platform.onVisibility((v) => {
          if (!v) this.pause();
        }),
      );
    }
  }
  private saveSettings(): void {
    try {
      this.app.platform
        .storage()
        .set("blackiron.signal-breach.settings", JSON.stringify(this.settings));
    } catch {
      this.message = "Settings could not be saved on this device.";
    }
  }
  start(): void {
    if (this.state.phase !== "title") return;
    this.state.phase = "playing";
    this.timeScale = 1;
    this.player.teleport(SPAWN);
    this.look.yaw = 0;
    this.look.pitch = -0.025;
    this.spawnWave();
    this.placeCamera();
    if (this.lock instanceof NativePointerLockInput) void this.lock.request();
  }
  pause(): void {
    if (this.state.phase !== "playing") return;
    this.state.phase = "paused";
    this.timeScale = 0;
    this.jump = false;
    this.firePressed = false;
    this.lock?.release();
    this.app.input.reset();
    for (const w of this.weapons) w.release();
  }
  resume(): void {
    if (this.state.phase !== "paused") return;
    this.settingsOpen = false;
    this.state.phase = "playing";
    this.timeScale = 1;
    this.app.input.reset();
    this.lock?.clear();
    if (this.lock instanceof NativePointerLockInput) void this.lock.request();
  }
  async restart(): Promise<void> {
    if (this.destroyed) return;
    const app = this.app;
    this.lock?.release();
    this.timeScale = 0;
    this.message = "Rebuilding relay station…";
    const world = await createPhysics3D();
    if (this.destroyed) {
      world.dispose();
      return;
    }
    app.scenes.change(new BreachScene(world, this.settings));
  }
  private spawnWave(): void {
    const wave = this.state.wave,
      count = WAVES[wave];
    if (count === undefined) return;
    this.notice(`SECURITY RESPONSE ${wave + 1} / 3`, 2.5);
    for (let i = 0; i < count; i++) {
      const p = ENEMY_SPAWNS[(i + wave * 2) % ENEMY_SPAWNS.length].clone(),
        heavy = wave > 0 && i % 3 === 0;
      const visual = this.art.drone(heavy);
      visual.root.position.set(p.x, 1.6, p.z);
      const body = this.physicsWorld.createBody({
        type: "kinematic",
        position: { x: p.x, y: 1.6, z: p.z },
        sensor: true,
        shape: { kind: "sphere", radius: heavy ? 0.78 : 0.66 },
      });
      // Each drone's eye has its own material so it can flare as it charges.
      const eye = new Material3D({ color: P.red, shading: "unlit", toneMapped: false, emissive: P.red, emissiveIntensity: 0.55 });
      visual.core.material = eye;
      const toPlayer = this.player.position.clone().sub(p);
      const enemy: Enemy = {
        id: this.nextEnemy++,
        health: heavy ? 100 : 58,
        maxHealth: heavy ? 100 : 58,
        heavy,
        node: visual.root,
        rig: visual.rig,
        core: visual.core,
        eye,
        visual,
        body,
        removeTarget: () => {},
        position: p,
        cooldown: 1.5 + i * 0.5,
        flash: 0,
        path: [],
        repath: 0,
        yaw: Math.atan2(-toPlayer.x, -toPlayer.z),
        vel: new Vec3(),
        last: visual.root.position.clone(),
        jolt: [new Spring(70, 8), new Spring(70, 8), new Spring(70, 8)],
        tilt: [new Spring(40, 7), new Spring(40, 7)],
        kick: new Spring(120, 11),
        charge: -1,
        smoke: 0,
        barrel: 0,
        rotor: rand(0, 1) * 6,
      };
      enemy.removeTarget = this.combat.register(body.collider(0).handle, {
        takeDamage: (e) => this.damageEnemy(enemy, e),
      });
      this.enemies.push(enemy);
    }
  }
  private damage(e: DamageEvent3D): void {
    if (e.source === "player") return;
    const before = this.state.health;
    this.state.damage(e.amount);
    if (this.state.health !== before) {
      this.app.audio.play("breach-hurt");
      this.app.haptic("medium");
    }
    if (this.state.phase === "lost") {
      this.timeScale = 0;
      this.lock?.release();
      this.app.input.reset();
    }
  }
  private damageEnemy(enemy: Enemy, e: DamageEvent3D): void {
    if (enemy.health <= 0 || e.source !== "player") return;
    enemy.health = Math.max(0, enemy.health - e.amount);
    enemy.flash = 0.12;
    this.state.hitMarker = 0.16;
    // Knocked along the shot and set wobbling (in the drone's own frame).
    const k = (enemy.heavy ? 0.55 : 1) * Math.min(1.4, e.amount / 22),
      c = Math.cos(enemy.yaw),
      sn = Math.sin(enemy.yaw),
      d = e.direction;
    enemy.jolt[0].velocity += (d.x * c - d.z * sn) * 2.4 * k;
    enemy.jolt[1].velocity += d.y * 2.4 * k + 0.3 * k;
    enemy.jolt[2].velocity += (d.x * sn + d.z * c) * 2.4 * k;
    enemy.tilt[0].velocity += rand(-6, 6) * k;
    enemy.tilt[1].velocity += rand(-8, 8) * k;
    this.particles.burst({ ...e.point, color: 0x39424a, count: 3, speed: 3, lifetime: 0.5, size: 0.035 });
    if (enemy.health === 0) {
      this.state.kills++;
      enemy.removeTarget();
      this.physicsWorld.removeBody(enemy.body);
      // It blows when the killing shot's tracer reaches it.
      const delay = this.eye.distanceTo(e.point) / TRACER_SPEED[this.weaponIndex ? "pellet" : "pulse"],
        dir = new Vec3().copy(e.direction);
      this.fx.after(delay, () => this.wreck(enemy, dir));
      if (this.enemies.every((e) => e.health <= 0))
        this.notice("AREA CLEAR / FIND AN AMBER RELAY", 4);
    } else this.app.audio.play("breach-hit", { volume: 0.6 });
  }
  /** Blow a drone apart: fireball, its pieces flung out burning, a scorch below, a shake. */
  private wreck(enemy: Enemy, dir: Vec3): void {
    const v = enemy.visual,
      p = enemy.node.getWorldPosition(),
      s = enemy.heavy ? 1.3 : 1;
    this.fx.explode(p, s);
    const dead = this.art.mat(0x1c1412, false, 0.6, 0.3);
    const darken = (n: Node3D) => {
      if (n instanceof Mesh3D && n.material.shading === "unlit") n.material = dead;
      for (const c of n.children) if (c instanceof Node3D) darken(c);
    };
    for (const [i, c] of v.chunks.entries()) {
      darken(c.node);
      const w = c.node.getWorldPosition(),
        out = w.clone().sub(p);
      out.y += 0.15;
      if (out.length < 0.05) randDir(out);
      out.normalize();
      const vel =
        i === 0
          ? randDir().multiplyScalar(1.5).add(new Vec3(0, rand(1.5, 3), 0)).add(dir.clone().multiplyScalar(rand(1, 2.5)))
          : out
              .multiplyScalar(rand(2.5, 5.5))
              .add(new Vec3(0, rand(2, 4), 0))
              .add(dir.clone().multiplyScalar(rand(1, 3)));
      this.fx.throwPiece(c.node, {
        vel,
        spin: randDir().multiplyScalar(rand(5, 12) / (0.5 + c.radius)),
        radius: c.radius * 0.8,
        bounce: 0.3,
        life: rand(7, 10),
        smoke: i === 0 ? 0.08 : rand(0, 1) < 0.4 ? 0.18 : 0,
        fire: i === 0 ? 1.6 : rand(0, 1) < 0.35 ? rand(0.4, 0.9) : 0,
        spinners: v.rotors.filter((r) => r.chunk === c.node).map((r) => r.node),
        spinRate: 22,
      });
    }
    enemy.node.destroy();
    const floor = this.combat.cast(p, new Vec3(0, -1, 0), 8, this.player.collider.handle);
    if (floor) this.fx.scorch(floor.point, floor.normal, 2.5 * s, 0xff7a30, 30);
    this.particles.burst({ x: p.x, y: p.y, z: p.z, color: 0x2a3036, count: 18, speed: 6, lifetime: 1.1, size: 0.07 });
    const near = Math.max(0, 1 - this.eye.distanceTo(p) / 28);
    this.shake.kick(0.06 * near * s, 0.5);
    this.look.punchPitch.velocity += rand(0.8, 1.6) * near * s;
    this.look.punchYaw.velocity += rand(-1.4, 1.4) * near * s;
    this.app.audio.play("breach-break", spatialAudio3D(this.eye, this.look.right(), p));
  }
  private notice(text: string, seconds = 2): void {
    this.state.notice = text;
    this.state.noticeTime = seconds;
  }
  private interact(): void {
    if (this.state.phase !== "playing" || this.nearestRelay < 0) return;
    if (this.enemies.some((e) => e.health > 0)) {
      this.notice("CLEAR SECURITY DRONES FIRST");
      return;
    }
    const i = this.nearestRelay;
    this.state.relays[i] = true;
    this.art.activateRelay(i);
    this.state.health = Math.min(100, this.state.health + 30);
    for (const w of this.weapons) w.reserve += w.definition.magazine * 2;
    this.app.audio.play("breach-relay");
    this.notice("RELAY ONLINE / INTEGRITY +30 / AMMO RESTORED", 3);
    this.state.wave++;
    if (this.state.completed === 3) {
      this.state.phase = "won";
      this.timeScale = 0;
      this.lock?.release();
      this.app.input.reset();
      const score = Math.max(
        0,
        Math.round(30000 - this.state.time * 40 + this.state.health * 20),
      );
      this.settings.best = Math.max(this.settings.best, score);
      this.saveSettings();
    } else this.spawnWave();
  }
  override onAction(action: string, pressed: boolean): void {
    if (!pressed) return;
    if (this.settingsOpen && (action === "confirm" || action === "pause")) {
      this.settingsOpen = false;
      this.rebindAction = null;
      return;
    }
    if (action === "confirm") {
      if (this.state.phase === "title") this.start();
      else if (this.state.phase === "paused") this.resume();
      else if (this.state.phase === "won" || this.state.phase === "lost")
        void this.restart();
    }
    if (action === "pause") {
      if (this.rebindAction) {
        this.rebindAction = null;
        return;
      }
      if (this.state.phase === "playing") this.pause();
      else if (this.state.phase === "paused") this.resume();
    }
    if (action === "settings") {
      if (this.state.phase === "playing") this.pause();
      if (this.state.phase === "paused" || this.state.phase === "title")
        this.settingsOpen = !this.settingsOpen;
    }
    if (action === "mute") {
      this.settings.muted = !this.settings.muted;
      this.app.audio.setMuted(this.settings.muted);
      this.saveSettings();
    }
    if (action === "debug") this.debugHud = !this.debugHud;
    if (this.state.phase !== "playing") return;
    if (action === "fire") this.firePressed = true;
    if (action === "jump") this.jump = true;
    if (action === "reload" && this.weapons[this.weaponIndex].reload())
      this.app.audio.play("breach-reload");
    if (action === "weapon1" || action === "weapon2") {
      this.weaponIndex = action === "weapon1" ? 0 : 1;
      for (const w of this.weapons) w.release();
      this.recoil = 0.1;
      this.raise = 0;
      this.pumpTime = -1;
    }
    if (action === "interact") this.interact();
  }
  override onKey(code: string, down: boolean): boolean {
    if (this.rebindAction && down) {
      if (code !== "Escape") {
        if (!code.startsWith("Key") && code !== "Space") return true;
        this.settings.bindings[this.rebindAction] = code;
        this.app.input.bind(this.rebindAction, code);
        this.saveSettings();
      }
      this.rebindAction = null;
      return true;
    }
    return false;
  }
  override onPointerDown(x: number, y: number): void {
    if (this.lock?.locked) return;
    if (this.settingsOpen) {
      if (x < 400 || x > 880) return;
      if (y > 215 && y < 270) {
        this.look.sensitivity = Math.max(
          0.0006,
          Math.min(0.006, this.look.sensitivity + (x < 640 ? -0.0003 : 0.0003)),
        );
        this.settings.sensitivity = this.look.sensitivity;
      }
      if (y > 275 && y < 320) {
        this.look.invertY = !this.look.invertY;
        this.settings.invertY = this.look.invertY;
      }
      if (y > 330 && y < 380) {
        this.settings.fov = this.settings.fov === 68 ? 82 : 68;
        this.camera3D.fov = this.settings.fov;
      }
      if (y > 390 && y < 435) this.rebindAction = x < 640 ? "up" : "jump";
      if (y > 462 && y < 517) this.settingsOpen = false;
      this.saveSettings();
      return;
    }
    if (this.state.phase === "title" && x < 400 && y > 560 && y < 610)
      this.settingsOpen = true;
    if (this.state.phase === "paused") {
      if (y > 470 && y < 512) this.settingsOpen = true;
      if (y > 538 && y < 580) void this.restart();
    }
    if (
      (this.state.phase === "won" || this.state.phase === "lost") &&
      x > 450 &&
      x < 830 &&
      y > 435 &&
      y < 495
    )
      void this.restart();
  }
  override update(dt: number): void {
    if (dt <= 0 || this.state.phase !== "playing") return;
    const s = this.state,
      input = this.app.input;
    s.time += dt;
    s.damageFlash = Math.max(0, s.damageFlash - dt);
    s.hitMarker = Math.max(0, s.hitMarker - dt);
    s.noticeTime = Math.max(0, s.noticeTime - dt);
    this.flash = Math.max(0, this.flash - dt);
    this.recoil *= Math.exp(-dt * 14);
    const mouse = this.lock?.consume();
    if (mouse) this.look.mouse(mouse.x, mouse.y);
    this.look.turn(
      input.axis("lookLeft", "lookRight") * dt * 1.8,
      input.axis("lookDown", "lookUp") * dt * 1.35,
    );
    const movement = this.look.movement(
      input.axis("left", "right"),
      input.axis("down", "up"),
    );
    this.player.move(movement, dt, {
      jump: this.jump,
      sprint: input.isDown("sprint"),
    });
    this.jump = false;
    if (this.player.position.y < -8) {
      this.player.teleport(SPAWN);
      s.damage(15);
    }
    this.stride +=
      Math.hypot(this.player.velocity.x, this.player.velocity.z) * dt;
    if (movement.length > 0.1 && this.player.grounded) {
      this.footsteps -= dt;
      if (this.footsteps <= 0) {
        this.footsteps = input.isDown("sprint") ? 0.26 : 0.36;
        this.app.audio.play("breach-step", { volume: 0.4 });
      }
    }
    // Landing dips the view and the gun; a hard fall dips them more.
    if (!this.player.grounded) this.fallSpeed = Math.max(this.fallSpeed, -this.player.velocity.y);
    else if (!this.wasGrounded) {
      const hard = Math.min(9, this.fallSpeed);
      this.look.dip.velocity -= 0.35 + hard * 0.12;
      this.gunKick.lift.velocity -= 0.4 + hard * 0.1;
      this.fallSpeed = 0;
    }
    this.wasGrounded = this.player.grounded;
    for (const sp of [this.gunKick.back, this.gunKick.lift, this.gunKick.pitch, this.gunKick.roll, this.gunKick.yaw]) sp.step(dt);
    this.look.update(dt);
    this.shake.update(dt);
    this.placeCamera();
    for (const w of this.weapons) w.update(dt);
    const weapon = this.weapons[this.weaponIndex],
      directions = weapon.trigger(
        input.isDown("fire") || this.firePressed,
        this.look.forward(),
      );
    this.firePressed = false;
    if (directions.length) {
      const scatter = this.weaponIndex === 1;
      this.flash = scatter ? 0.07 : 0.05;
      this.recoil = scatter ? 0.22 : 0.075;
      this.look.turn(0, scatter ? 0.014 : 0.0028);
      this.app.audio.play(scatter ? "breach-scatter" : "breach-rifle");
      this.kickGun(scatter);
      const muzzle = this.muzzleWorld();
      this.fx.muzzleSmoke(muzzle, this.look.forward(), scatter, this.player.velocity);
      for (const dir of directions) {
        const hit = this.combat.hitscan(
          this.eye,
          dir,
          weapon.definition.range,
          weapon.definition.damage,
          this.player.collider.handle,
          "player",
        );
        const end =
          hit?.point ??
          this.eye
            .clone()
            .add(dir.clone().multiplyScalar(weapon.definition.range));
        const delay = this.fx.tracer(muzzle, end, scatter ? "pellet" : "pulse");
        if (hit) {
          const at = hit.point.clone(),
            n = hit.normal.clone(),
            d = dir.clone();
          if (hit.target) this.fx.after(delay, () => this.fx.hitDrone(at, n, d, scatter));
          else this.fx.after(delay, () => this.fx.impact(at, n, d, scatter ? "pellet" : "pulse"));
        }
      }
    }
    if (
      input.isDown("fire") &&
      weapon.ammo === 0 &&
      weapon.reserve > 0 &&
      weapon.reloadRemaining === 0
    )
      weapon.reload();
    this.updateEnemies(dt);
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const hit = b.shot.step(this.combat, dt);
      b.fx.move(b.shot.position, b.shot.velocity, dt, s.time);
      if (hit) {
        if (hit.collider === this.player.collider.handle) {
          this.shake.kick(0.06, 0.3);
          this.look.punchPitch.velocity += rand(-1.2, 1.2);
          this.look.punchYaw.velocity += rand(-1.5, 1.5);
        } else this.fx.impact(hit.point, hit.normal, b.shot.velocity.clone().normalize(), "bolt");
      }
      if (!b.shot.alive) {
        b.fx.end();
        this.bolts.splice(i, 1);
      }
    }
    this.nearestRelay = -1;
    for (let i = 0; i < RELAYS.length; i++) {
      const p = RELAYS[i];
      if (
        !s.relays[i] &&
        Math.hypot(this.player.position.x - p.x, this.player.position.z - p.z) <
          2.7 &&
        Math.abs(this.player.position.y - p.y) < 0.8
      )
        this.nearestRelay = i;
    }
    this.art.rotor.rotation.y = s.time * 0.2;
    this.art.animate(s.time);
    for (const r of this.art.relays) {
      const ring = r.children.find(
        (c) => c instanceof Mesh3D && c.geometry === this.art.ring,
      );
      if (ring instanceof Mesh3D) ring.rotation.z = Math.sin(s.time) * 0.08;
    }
    this.animateGun(dt);
    this.syncWeapon();
    this.fx.update(dt);
  }
  private updateEnemies(dt: number): void {
    const t = this.state.time;
    for (const e of this.enemies) {
      if (e.health <= 0) continue;
      e.flash = Math.max(0, e.flash - dt);
      e.repath -= dt;
      const delta = this.player.position.clone().sub(e.position),
        distance = Math.hypot(delta.x, delta.z);
      if (e.repath <= 0) {
        e.path = this.navigation.findPath(e.position, this.player.position);
        e.repath = 0.65 + (e.id % 3) * 0.12;
      }
      const target = e.path.length > 1 ? e.path[1] : null;
      if (target && distance > 5) {
        const d = target.clone().sub(e.position);
        d.y = 0;
        const step = Math.min(d.length, (e.heavy ? 1.3 : 2.1) * dt);
        e.position.add(d.normalize().multiplyScalar(step));
        if (e.position.distanceTo(target) < 0.15) e.path.shift();
      }
      // Hover with a slow bob and a sideways weave (the hit body follows, so aim stays true).
      const side = distance > 0.01 ? 1 / distance : 0,
        weave = Math.sin(t * 0.9 + e.id * 2.1) * 0.35,
        hover = 1.6 + Math.sin(t * 2.4 + e.id) * 0.13 + Math.sin(t * 0.83 + e.id * 1.7) * 0.05;
      e.node.position.set(e.position.x - delta.z * side * weave, hover, e.position.z + delta.x * side * weave);
      e.body.setNextKinematicTranslation(e.node.position);
      // Velocity from how it actually moved, smoothed.
      const k = 1 - Math.exp(-dt * 6);
      e.vel.x += ((e.node.position.x - e.last.x) / dt - e.vel.x) * k;
      e.vel.y += ((e.node.position.y - e.last.y) / dt - e.vel.y) * k;
      e.vel.z += ((e.node.position.z - e.last.z) / dt - e.vel.z) * k;
      e.last.copy(e.node.position);
      // Turn smoothly to face the player.
      let turn = Math.atan2(-delta.x, -delta.z) - e.yaw;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn)) * (1 - Math.exp(-dt * 5));
      e.yaw += turn;
      e.node.rotation.y = e.yaw;
      const hurt = e.health / e.maxHealth;
      // Bank into the motion: nose down when going forward, roll into strafes and turns.
      const c = Math.cos(e.yaw),
        sn = Math.sin(e.yaw),
        forward = -e.vel.x * sn - e.vel.z * c,
        right = e.vel.x * c - e.vel.z * sn,
        charging = e.charge >= 0 ? 1 - e.charge / (e.heavy ? CHARGE.heavy : CHARGE.light) : 0;
      const pitch = Math.max(-0.4, Math.min(0.4, -forward * 0.12 + charging * 0.12)),
        roll = Math.max(-0.45, Math.min(0.45, -right * 0.14 - (turn / Math.max(dt, 1e-4)) * 0.12));
      // Badly hurt drones fly unsteadily.
      if (hurt < 0.3) {
        e.tilt[0].velocity += rand(-1, 1) * dt * 40;
        e.tilt[1].velocity += rand(-1, 1) * dt * 60;
      }
      e.tilt[0].step(dt, pitch);
      e.tilt[1].step(dt, roll);
      for (const j of e.jolt) j.step(dt);
      e.kick.step(dt);
      e.rig.position.set(e.jolt[0].value, e.jolt[1].value, e.jolt[2].value + e.kick.value);
      e.rig.rotation.set(e.tilt[0].value - e.kick.value * 1.6, 0, e.tilt[1].value);
      // Rotors run faster as it works harder.
      e.rotor += dt * (16 + Math.hypot(e.vel.x, e.vel.z) * 4 + charging * 6);
      for (const [i, r] of e.visual.rotors.entries()) r.node.rotation.y = e.rotor * (i % 2 ? -1 : 1);
      // The eye: flares on hits and while charging, flickers when badly hurt.
      e.eye.emissiveIntensity = e.flash > 0 ? 2.2 : 0.55 + charging * charging * 3.5 + (hurt < 0.3 ? rand(-0.4, 0.3) : 0);
      e.eye.color = e.eye.emissive = mixColor(P.red, 0xffe0d8, e.flash > 0 ? 0.8 : charging * 0.6);
      const eyeScale = 1 + charging * 0.45;
      e.core.setScale(e.visual.coreScale[0] * eyeScale, e.visual.coreScale[1] * eyeScale, e.visual.coreScale[2]);
      // Damaged drones smoke, then burn and spit sparks.
      if (hurt < 0.6) {
        e.smoke -= dt;
        if (e.smoke <= 0) {
          e.smoke = hurt < 0.3 ? 0.045 : 0.1;
          this.fx.damage(e.visual.frame.localToWorld(new Vec3(rand(-0.25, 0.25), 0.3, rand(-0.1, 0.3))), hurt < 0.3);
        }
      }
      // Fire: lock on, charge the eye (a tell the player can react to), then shoot.
      const chargeTime = e.heavy ? CHARGE.heavy : CHARGE.light;
      e.cooldown -= dt;
      if (e.charge < 0) {
        if (e.cooldown <= chargeTime && distance < 34) {
          const origin = e.node.position.clone(),
            aim = this.eye.clone().sub(origin).normalize();
          const hit = this.combat.cast(origin, aim, distance + 2, e.body.collider(0).handle);
          if (hit?.collider === this.player.collider.handle && this.bolts.length < 32) {
            e.charge = chargeTime;
            this.fx.charge(e.visual.frame, new Vec3(e.visual.eye[0], e.visual.eye[1], e.visual.eye[2] - 0.3), chargeTime);
          } else e.cooldown = chargeTime + 0.25;
        }
      } else {
        e.charge -= dt;
        if (rand(0, 1) < dt * 16) this.fx.converge(e.visual.frame.localToWorld(new Vec3(...e.visual.eye)), 0.22);
        if (e.charge <= 0) {
          e.charge = -1;
          this.droneFire(e);
          e.cooldown = e.heavy ? 1.5 : 2.3;
        }
      }
    }
  }
  /** A drone's shot from one of its twin barrels, alternating. */
  private droneFire(e: Enemy): void {
    e.barrel ^= 1;
    const origin = e.visual.frame.localToWorld(new Vec3(...e.visual.muzzles[e.barrel])),
      aim = this.eye.clone().sub(origin).normalize();
    const speed = e.heavy ? 11 : 13;
    const shot = new Projectile3D(origin, aim.clone().multiplyScalar(speed), 4, e.heavy ? 12 : 8, e.body.collider(0).handle, "drone");
    this.bolts.push({ shot, fx: this.fx.bolt(origin, shot.velocity, e.heavy) });
    this.fx.droneFlash(origin.clone().add(aim.clone().multiplyScalar(0.18)), aim);
    // Recoil: shoved back, nose up, a twitch toward the firing barrel.
    e.kick.velocity += e.heavy ? 1.6 : 2.2;
    e.tilt[1].velocity += (e.barrel ? -1 : 1) * 2.5;
    this.app.audio.play("breach-drone", spatialAudio3D(this.eye, this.look.right(), origin, 35));
  }
  /** The kick of one shot on the first-person gun and the view. */
  private kickGun(scatter: boolean): void {
    const k = this.gunKick;
    if (scatter) {
      k.back.velocity += 2.9;
      k.pitch.velocity += rand(4.6, 5.6);
      k.roll.velocity += rand(1.6, 2.8);
      k.yaw.velocity += rand(-1, 1);
      k.lift.velocity += 0.8;
      this.look.punchPitch.velocity += 1.3;
      this.look.punchYaw.velocity += rand(-0.6, 0.6);
      this.shake.kick(0.022, 0.18);
      this.heat = Math.min(1, this.heat + 0.22);
      this.pumpTime = 0;
      this.pumpEjected = false;
    } else {
      k.back.velocity += 1.15;
      k.pitch.velocity += rand(1.4, 2.1);
      k.roll.velocity += rand(-1.3, 1.3);
      k.yaw.velocity += rand(-0.7, 0.7);
      k.lift.velocity += 0.22;
      this.look.punchPitch.velocity += 0.32;
      this.look.punchYaw.velocity += rand(-0.15, 0.15);
      this.heat = Math.min(1, this.heat + 0.055);
      this.eject(0);
    }
    this.sprintBlend *= 0.3;
    this.flashes[this.weaponIndex].fire();
  }
  /** The current gun's muzzle in the world. */
  private muzzleWorld(): Vec3 {
    const i = this.weaponIndex;
    this.syncWeapon();
    return this.art.weaponModels[i].localToWorld(new Vec3(...this.art.muzzles[i]));
  }
  /** Throw a spent casing (rifle) or shell (scattergun) out of the ejection port. */
  private eject(i: number): void {
    const gun = this.art.weaponModels[i],
      port = this.art.ports[i];
    const at = gun.localToWorld(new Vec3(...port)),
      out = gun.localToWorld(new Vec3(port[0] + 1, port[1] + rand(0.5, 0.9), port[2] + rand(0.1, 0.4))).sub(at).normalize();
    const node = this.fx.root.add(this.art.casing(i === 1));
    node.position.copy(at);
    node.rotation.set(Math.PI / 2, rand(0, Math.PI), 0);
    this.fx.throwPiece(node, {
      vel: out.multiplyScalar(rand(2.2, 3.2)).add(this.player.velocity),
      spin: randDir().multiplyScalar(rand(14, 26)),
      radius: i ? 0.014 : 0.008,
      bounce: 0.45,
      life: rand(2.5, 3.5),
    });
  }
  /** Per-frame gun motion that is not a spring: heat, sprint, draw, pump and vent smoke. */
  private animateGun(dt: number): void {
    const input = this.app.input,
      speed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    const sprinting = input.isDown("sprint") && speed > 5 && this.player.grounded && !input.isDown("fire") && this.flash <= 0;
    this.sprintBlend += ((sprinting ? 1 : 0) - this.sprintBlend) * (1 - Math.exp(-dt * 8));
    this.raise = Math.min(1, this.raise + dt / 0.4);
    this.heat = Math.max(0, this.heat - dt * 0.45);
    for (const [i, m] of this.art.weaponGlows.entries()) {
      const h = i === this.weaponIndex ? this.heat : 0;
      m.emissiveIntensity = 0.55 + h * 2.4;
      m.color = m.emissive = mixColor(i ? P.amber : P.cyan, 0xffffff, h * 0.45);
    }
    for (const f of this.flashes) f.update(dt);
    // Mouse sway: the gun lags behind the view.
    const dy = this.look.yaw - this.lastLook.yaw,
      dp = this.look.pitch - this.lastLook.pitch;
    this.lastLook = { yaw: this.look.yaw, pitch: this.look.pitch };
    this.sway.x.velocity -= Math.max(-0.25, Math.min(0.25, dy)) * 9;
    this.sway.y.velocity -= Math.max(-0.25, Math.min(0.25, dp)) * 9;
    this.sway.x.step(dt);
    this.sway.y.step(dt);
    this.sway.x.value = Math.max(-0.09, Math.min(0.09, this.sway.x.value));
    this.sway.y.value = Math.max(-0.07, Math.min(0.07, this.sway.y.value));
    // Scattergun: rack the pump after each shot and throw the shell at the back of the stroke.
    if (this.pumpTime >= 0) {
      this.pumpTime += dt;
      if (!this.pumpEjected && this.pumpTime > 0.3) {
        this.pumpEjected = true;
        this.eject(1);
      }
      if (this.pumpTime > 0.5) this.pumpTime = -1;
    }
    // Hot barrels breathe a little smoke from the vents.
    if (this.heat > 0.45) {
      this.ventSmoke -= dt;
      if (this.ventSmoke <= 0) {
        this.ventSmoke = 0.09 / this.heat;
        const gun = this.art.weaponModels[this.weaponIndex],
          vx = rand(-1, 1) < 0 ? -0.08 : 0.08;
        this.fx.sprites.spawn({
          texture: "smoke",
          variant: 0,
          position: gun.localToWorld(new Vec3(vx, 0.05, rand(-0.6, -0.45))),
          velocity: new Vec3(rand(-0.1, 0.1), rand(0.25, 0.45), rand(-0.1, 0.1)).add(this.player.velocity),
          lifetime: rand(0.6, 0.9),
          size: 0.03,
          endSize: 0.16,
          opacity: 0.18 * this.heat,
          fadeIn: 0.2,
          colors: [0xb8c4c8],
          drag: 1.5,
          spin: rand(-1, 1),
        });
      }
    }
  }
  private placeCamera(): void {
    if (this.state.phase === "title") {
      this.camera3D.position.set(8.5, 5.6, 22);
      this.camera3D.lookAt(-3.5, 2.6, -8);
      this.art.weaponRoot.visible = false;
      return;
    }
    const moving = Math.min(
      1,
      Math.hypot(this.player.velocity.x, this.player.velocity.z) / 6.6,
    );
    this.eye
      .copy(this.player.position)
      .add(
        new Vec3(
          0,
          1.62 +
            (this.player.grounded
              ? Math.sin(this.stride * 2.3) * 0.024 * moving
              : 0),
          0,
        ),
      );
    // The view kicks with each shot and springs back (the look's punch), and dips on landing; the
    // aim itself only climbs a little.
    this.look.apply(this.camera3D, this.eye);
    const o = this.shake.offset;
    this.camera3D.position.add(o);
    this.camera3D.target.add(o);
    this.syncWeapon();
  }
  private syncWeapon(): void {
    const root = this.art.weaponRoot;
    root.visible = this.state.phase !== "title";
    // yaw parent, pitch child composition matches the look convention.
    root.position.copy(this.eye).add(this.shake.offset);
    root.position.y += this.look.dip.value;
    root.rotation.set(0, -this.look.yaw, 0);
    const k = this.gunKick,
      t = this.state.time,
      moving = Math.min(1, Math.hypot(this.player.velocity.x, this.player.velocity.z) / 6.6) * (this.player.grounded ? 1 : 0.25),
      ph = this.stride * 1.15,
      sp = this.sprintBlend,
      draw = 1 - (1 - this.raise) ** 3,
      ss = (a: number, b: number, x: number) => {
        const u = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return u * u * (3 - 2 * u);
      };
    for (let i = 0; i < this.art.weaponModels.length; i++) {
      const gun = this.art.weaponModels[i];
      gun.visible = i === this.weaponIndex;
      // Reload: tilt the gun over, swap the cell (rifle) or feed shells (scattergun), settle.
      const w = this.weapons[i],
        rt = w.reloadRemaining > 0 ? 1 - w.reloadRemaining / w.definition.reloadSeconds : -1,
        rl = rt < 0 ? 0 : ss(0, 0.18, rt) * (1 - ss(0.82, 1, rt));
      let seat = 0,
        partY = 0,
        partZ = 0;
      if (rt >= 0 && i === 0) {
        seat = Math.exp(-(((rt - 0.64) / 0.035) ** 2));
        if (rt < 0.4) partY = -0.36 * ss(0.14, 0.36, rt);
        else partY = -0.3 * (1 - ss(0.42, 0.62, rt));
        partZ = partY * -0.1;
      } else if (rt >= 0)
        for (const at of [0.3, 0.42, 0.54, 0.66]) seat += Math.exp(-(((rt - at) / 0.025) ** 2)) * 0.6;
      // Scattergun pump stroke: after a shot, and once at the end of a reload.
      let stroke = 0;
      if (i === 1) {
        if (this.pumpTime >= 0) stroke = Math.sin(Math.PI * ss(0.1, 0.46, this.pumpTime));
        if (rt >= 0) stroke = Math.max(stroke, Math.sin(Math.PI * ss(0.74, 0.92, rt)));
        partZ = stroke * 0.09;
      }
      const part = this.art.weaponParts[i];
      part.position.set(0, partY, partZ);
      part.visible = partY > -0.33;
      gun.rotation.set(
        this.look.pitch + k.pitch.value - sp * 0.32 + rl * 0.18 + seat * 0.05 + this.sway.y.value * 1.5 - (1 - draw) * 0.9 + Math.sin(t * 1.1) * 0.004,
        k.yaw.value - this.sway.x.value * 1.6 + sp * 0.62 + rl * 0.28,
        k.roll.value + Math.sin(ph) * 0.02 * moving - this.sway.x.value * 1.2 + sp * 0.32 - rl * 0.6 - stroke * 0.09 + (1 - draw) * 0.3,
      );
      gun.setScale(0.8);
      const offset = new Vec3(
        0.3 + Math.sin(ph) * 0.011 * moving + this.sway.x.value * 0.6 - sp * 0.05 - rl * 0.05,
        -0.29 + k.lift.value - Math.abs(Math.cos(ph)) * 0.014 * moving + Math.sin(t * 1.7) * 0.0025 + this.sway.y.value * 0.5 - sp * 0.07 - rl * 0.07 + seat * 0.02 - stroke * 0.012 - (1 - draw) * 0.32,
        -0.65 + k.back.value + sp * 0.05 + rl * 0.03,
      );
      const c = Math.cos(this.look.pitch),
        s = Math.sin(this.look.pitch);
      gun.position.set(
        offset.x,
        offset.y * c - offset.z * s,
        offset.y * s + offset.z * c,
      );
    }
    // The flash light rides at the live gun's muzzle.
    const gun = this.art.weaponModels[this.weaponIndex],
      light = this.art.muzzleLight,
      lit = this.flashes?.[this.weaponIndex]?.lit ?? 0;
    if (light.parent !== gun) gun.add(light);
    const m = this.art.muzzles[this.weaponIndex];
    light.position.set(m[0], m[1], m[2] - 0.05);
    light.color = this.weaponIndex ? 0xffa050 : 0x7ff5e4;
    light.intensity = lit * (this.weaponIndex ? 16 : 8);
    light.range = this.weaponIndex ? 9 : 6;
    this.art.muzzle.visible = false;
  }
  get diagnostics() {
    return {
      phase: this.state.phase,
      health: this.state.health,
      wave: this.state.wave,
      kills: this.state.kills,
      relays: this.state.completed,
      player: { ...this.player.position },
      grounded: this.player.grounded,
      ammo: this.weapons.map((w) => w.ammo),
      enemies: this.enemies.filter((e) => e.health > 0).length,
      projectiles: this.bolts.length,
      physics: this.physicsWorld.stats,
      targets: this.combat.targetCount,
      locked: this.lock?.locked ?? false,
    };
  }
  override exit(): void {
    this.destroyed = true;
    this.lock?.dispose();
    for (const e of this.enemies) e.removeTarget();
  }
  get showDiagnostics(): boolean {
    return this.debugHud;
  }
}
class BreachHud extends Node {
  constructor(private game: BreachScene) {
    super();
  }
  override render(ctx: DrawContext): void {
    const g = this.game,
      s = g.state,
      w = g.weapons[g.weaponIndex],
      clock = g.app.time,
      text = (
        value: string,
        x: number,
        y: number,
        size = 14,
        color = 0xe5ebdf,
        align: "left" | "center" | "right" = "left",
        weight = 600,
        alpha = 1,
      ) =>
        ctx.text(value, x, y, {
          font: { family: "Arial", size, weight },
          color,
          align,
          shadow: null,
          alpha,
        });
    // Glass panel: deep slate fill, a hairline frame and cyan corner brackets.
    const panel = (x: number, y: number, pw: number, ph: number, accent: number = P.cyan, alpha = 0.78) => {
      ctx.rect(x, y, pw, ph, P.black, alpha);
      ctx.rect(x, y, pw, Math.min(18, ph / 3), 0x1d2a35, 0.35);
      ctx.frame(x, y, pw, ph, 0x8fa6b3, 0.16);
      const c = 9;
      ctx.rect(x - 1, y - 1, c, 2, accent);
      ctx.rect(x - 1, y - 1, 2, c, accent);
      ctx.rect(x + pw - c + 1, y + ph - 1, c, 2, accent);
      ctx.rect(x + pw - 1, y + ph - c + 1, 2, c, accent);
    };
    const button = (label: string, x: number, y: number, width: number, accent = true) => {
      if (accent) {
        ctx.rect(x - 3, y - 3, width + 6, 58, P.cyan, 0.12, true);
        ctx.rect(x, y, width, 52, P.cyan, 0.97);
        ctx.rect(x, y + 48, width, 4, 0x2fb9a4, 1);
        ctx.rect(x + width - 52, y, 1, 52, P.black, 0.25);
      } else {
        ctx.rect(x, y, width, 52, P.dark, 0.96);
        ctx.frame(x, y, width, 52, P.steel, 0.4);
      }
      text(label, x + width / 2, y + 16, 16, accent ? P.black : P.chalk, "center", 700);
    };
    const blink = Math.sin(clock * 5) > 0;
    if (s.phase === "title") {
      // Left column: the title card. Hit areas match BreachScene's pointer handlers.
      for (let k = 0; k < 8; k++) ctx.rect(0, 0, 520 + k * 40, 720, P.black, 0.07);
      ctx.rect(36, 38, 450, 625, P.black, 0.86);
      ctx.rect(36, 38, 450, 120, 0x15212b, 0.5);
      ctx.frame(36, 38, 450, 625, 0x8fa6b3, 0.18);
      ctx.rect(36, 38, 4, 625, P.cyan);
      ctx.rect(40, 38, 10, 625, P.cyan, 0.08, true);
      ctx.rect(66, 70, 28, 4, P.cyan);
      text("RELAY 07   /   OFFSHORE ARRAY", 108, 63, 12, P.cyan);
      text("SIGNAL", 63, 113, 88, 0x000000, "left", 800, 0.5);
      text("SIGNAL", 60, 110, 88, 0xf3efe2, "left", 800);
      text("BREACH", 63, 193, 88, 0x000000, "left", 800, 0.5);
      text("BREACH", 60, 190, 88, 0xf3efe2, "left", 800);
      ctx.rect(66, 283, 64, 3, P.orange);
      ctx.rect(134, 283, 18, 3, P.orange, 0.5);
      ctx.rect(156, 283, 6, 3, P.orange, 0.3);
      text("THE STATION IS NO LONGER OURS.", 68, 304, 13, P.orange);
      text("Cut through security. Reboot three relays.", 68, 343, 17, 0xb9c8cc, "left", 400);
      text("Two weapons. Three response waves.", 68, 370, 17, 0xb9c8cc, "left", 400);
      text("One way to bring the signal back.", 68, 397, 17, 0xb9c8cc, "left", 400);
      ctx.rect(68, 440, 386, 1, P.steel, 0.3);
      text("01  /  SINGLE PLAYER CAMPAIGN", 68, 456, 12, P.chalk);
      button("ENTER THE STATION   →", 66, 493, 322);
      text("CONTROL SETTINGS", 68, 573, 12, P.cyan);
      text("ENTER TO BEGIN", 390, 573, 11, P.chalk, "right", 600, blink ? 1 : 0.45);
      ctx.rect(68, 605, 386, 1, P.steel, 0.3);
      text("A BLACKIRON ORIGINAL", 68, 625, 11, P.steel);
      text("FPS  /  01", 453, 625, 11, P.steel, "right");
      // Right column: status chips over the scene.
      panel(1000, 38, 240, 32, P.red, 0.7);
      ctx.rect(1016, 50, 8, 8, P.red, blink ? 1 : 0.3);
      text("SECURITY OVERRIDE REQUIRED", 1227, 48, 11, P.chalk, "right");
      text("STORM ADVISORY  ·  WIND 41 KN  ·  SEA STATE 6", 1227, 82, 10, P.steel, "right");
      text("07", 1235, 572, 92, 0x000000, "right", 800, 0.45);
      text("07", 1232, 569, 92, P.chalk, "right", 800, 0.92);
      ctx.rect(1110, 660, 122, 2, P.cyan);
      text("THE RELAY STATION", 1226, 670, 13, P.chalk, "right");
    } else {
      panel(28, 25, 287, 61);
      ctx.rect(28, 25, 3, 61, P.cyan);
      text("SIGNAL BREACH", 45, 38, 15, P.chalk, "left", 700);
      text(`${s.completed} / 3 RELAYS ONLINE`, 45, 62, 11, P.cyan);
      for (let i = 0; i < 3; i++) {
        if (s.relays[i]) ctx.rect(228 + i * 22, 46, 17, 22, P.cyan, 0.25, true);
        ctx.rect(230 + i * 22, 48, 13, 18, s.relays[i] ? P.cyan : P.steel, s.relays[i] ? 1 : 0.3);
      }
      // Compass strip: ticks every 15 degrees, cardinal letters, centred heading readout.
      const heading = ((((g.look.yaw * 180) / Math.PI) % 360) + 360) % 360;
      ctx.rect(470, 26, 340, 26, P.black, 0.55);
      ctx.rect(470, 52, 340, 1, P.steel, 0.35);
      for (let d = -165; d <= 180; d += 15) {
        const deg = Math.round(heading / 15) * 15 + d,
          x = 640 + (deg - heading) * 1.6;
        if (x < 476 || x > 804) continue;
        const n = ((deg % 360) + 360) % 360,
          card = n % 90 === 0,
          fade = 1 - Math.abs(x - 640) / 170;
        ctx.rect(x, card ? 40 : 45, 1, card ? 12 : 7, P.chalk, 0.6 * fade);
        if (card) text(["N", "E", "S", "W"][n / 90], x, 27, 11, n === 0 ? P.orange : P.chalk, "center", 700, fade);
      }
      ctx.rect(639, 52, 2, 6, P.cyan);
      text(`${Math.round(heading).toString().padStart(3, "0")}°`, 640, 60, 10, P.cyan, "center");
      text("RELAY 07  ·  OFFSHORE", 640, 76, 9, P.steel, "center");
      panel(990, 25, 262, 61);
      text(`RESPONSE ${Math.min(3, s.wave + 1)} / 3`, 1008, 39, 12, P.chalk, "left", 700);
      text(
        `${String(Math.floor(s.time / 60)).padStart(2, "0")}:${String(Math.floor(s.time % 60)).padStart(2, "0")}`,
        1233,
        37,
        20,
        P.cyan,
        "right",
        700,
      );
      text(`${g.enemies.filter((e) => e.health > 0).length} HOSTILES   /   ${s.kills} NEUTRALIZED`, 1008, 63, 10, P.steel);
      // Map is deliberately schematic: route choice, relays and moving contacts.
      panel(1110, 102, 142, 158, P.cyan, 0.7);
      ctx.frame(1128, 117, 106, 118, P.steel, 0.25);
      ctx.rect(1181 - 13 * 2.2, 117, 1, 118, P.steel, 0.15);
      ctx.rect(1181 + 13 * 2.2, 117, 1, 118, P.steel, 0.15);
      for (let i = 0; i < 3; i++) {
        const p = RELAYS[i];
        ctx.rect(1181 + p.x * 2.2 - 3, 180 + p.z * 2.1 - 3, 6, 6, s.relays[i] ? P.cyan : P.amber);
        ctx.rect(1181 + p.x * 2.2 - 5, 180 + p.z * 2.1 - 5, 10, 10, s.relays[i] ? P.cyan : P.amber, 0.25, true);
      }
      for (const e of g.enemies)
        if (e.health > 0) {
          ctx.rect(1181 + e.position.x * 2.2 - 2, 180 + e.position.z * 2.1 - 2, 4, 4, P.red);
          ctx.rect(1181 + e.position.x * 2.2 - 4, 180 + e.position.z * 2.1 - 4, 8, 8, P.red, blink ? 0.3 : 0.1, true);
        }
      ctx.rect(1181 + g.player.position.x * 2.2 - 3, 180 + g.player.position.z * 2.1 - 3, 6, 6, 0xffffff);
      text("RELAY SCAN", 1181, 244, 9, P.steel, "center");
      // Minimal crosshair expands with recoil. Hit confirmation is brief.
      const gap = 5 + g.recoil * 40,
        color = s.hitMarker > 0 ? P.orange : P.cyan;
      ctx.rect(640 - gap - 9, 358, 9, 4, P.black, 0.35);
      ctx.rect(640 + gap, 358, 9, 4, P.black, 0.35);
      ctx.rect(640 - gap - 8, 359, 7, 2, color);
      ctx.rect(640 + gap + 1, 359, 7, 2, color);
      ctx.rect(639, 360 - gap - 8, 2, 7, color);
      ctx.rect(639, 360 + gap + 1, 2, 7, color);
      ctx.rect(639, 359, 2, 2, 0xffffff);
      if (s.hitMarker > 0) {
        for (const [x, y] of [
          [-12, -12],
          [9, 9],
          [-12, 9],
          [9, -12],
        ])
          ctx.rect(640 + x, 360 + y, 4, 4, P.orange);
      }
      const low = s.health < 30;
      panel(28, 617, 266, 77, low ? P.red : P.cyan);
      ctx.rect(28, 617, 3, 77, low ? P.red : P.cyan);
      text("INTEGRITY", 46, 631, 10, P.steel, "left", 700);
      text(String(Math.ceil(s.health)).padStart(3, "0"), 45, 650, 31, low ? P.red : P.chalk, "left", 700);
      for (let i = 0; i < 10; i++) {
        const on = s.health > i * 10;
        ctx.rect(118 + i * 15, 663, 11, 14, on ? (low ? P.red : P.cyan) : P.steel, on ? 1 : 0.18);
        if (on) ctx.rect(118 + i * 15, 663, 11, 3, 0xffffff, 0.25);
      }
      if (low && blink) ctx.rect(118, 683, 146, 2, P.red, 0.8);
      panel(968, 601, 284, 93, P.orange);
      ctx.rect(1249, 601, 3, 93, P.orange);
      text(g.weaponIndex === 0 ? "AR-04 / PULSE RIFLE" : "SG-08 / SCATTERGUN", 989, 615, 11, P.chalk, "left", 700);
      text(String(w.ammo).padStart(2, "0"), 990, 638, 39, w.ammo <= w.definition.magazine * 0.25 ? P.orange : P.chalk, "left", 700);
      text(`/ ${w.reserve}`, 1050, 658, 15, P.steel);
      for (let i = 0; i < 2; i++) ctx.rect(1132 + i * 50, 652, 44, 2, i === g.weaponIndex ? P.cyan : P.steel, i === g.weaponIndex ? 1 : 0.3);
      text("1  RIFLE    2  SCATTER", 1230, 635, 10, P.steel, "right");
      text(w.reloadRemaining > 0 ? "RELOADING…" : "R  RELOAD", 1230, 672, 10, w.reloadRemaining > 0 ? P.orange : P.cyan, "right", 700);
      if (w.reloadRemaining > 0) ctx.rect(990, 689, 236 * (1 - w.reloadRemaining / w.definition.reloadSeconds), 2, P.orange);
      text("WASD MOVE   SHIFT SPRINT   SPACE JUMP   E RELAY", 640, 675, 10, P.chalk, "center", 600, 0.75);
      text("ESC PAUSE   •   F1 SETTINGS   •   M SOUND", 640, 694, 9, P.steel, "center");
      if (g.nearestRelay >= 0 && s.phase === "playing") {
        const locked = g.enemies.some((e) => e.health > 0);
        panel(420, 478, 440, 54, locked ? P.red : P.amber, 0.88);
        text(locked ? "RELAY LOCKED / CLEAR SECURITY FIRST" : "[ E ]   REBOOT RELAY / RESTORE +30 INTEGRITY", 640, 498, 12, locked ? P.red : P.amber, "center", 700);
      }
      if (s.noticeTime > 0) {
        const a = Math.min(1, s.noticeTime * 3);
        ctx.rect(387, 111, 506, 37, P.black, 0.78 * a);
        ctx.rect(387, 111, 506, 1, P.cyan, 0.6 * a);
        ctx.rect(387, 147, 506, 1, P.cyan, 0.6 * a);
        ctx.rect(387, 111, 3, 37, P.cyan, a);
        ctx.rect(890, 111, 3, 37, P.cyan, a);
        text(s.notice, 640, 123, 12, P.cyan, "center", 700, a);
      }
      if (s.damageFlash > 0) {
        const a = s.damageFlash * 2;
        for (let k = 0; k < 4; k++) {
          const t = 8 + k * 14,
            al = a * (0.5 - k * 0.11);
          ctx.rect(0, 0, 1280, t, P.red, al);
          ctx.rect(0, 720 - t, 1280, t, P.red, al);
          ctx.rect(0, 0, t, 720, P.red, al);
          ctx.rect(1280 - t, 0, t, 720, P.red, al);
        }
      }
      if (s.phase === "playing" && !g.lock?.locked) {
        panel(402, 554, 476, 40, P.cyan, 0.85);
        text(
          g.lock?.dragFallback ? "HOLD RIGHT MOUSE TO AIM · LEFT CLICK FIRES" : "CLICK TO CAPTURE MOUSE  /  ARROWS AIM · J FIRES",
          640,
          568,
          11,
          P.cyan,
          "center",
          700,
        );
      }
    }
    if (s.phase === "paused" || s.phase === "won" || s.phase === "lost") {
      ctx.rect(0, 0, 1280, 720, P.black, 0.62);
      const accent = s.phase === "lost" ? P.orange : P.cyan;
      ctx.rect(415, 172, 450, 428, P.black, 0.95);
      ctx.rect(415, 172, 450, 90, 0x15212b, 0.6);
      ctx.frame(415, 172, 450, 428, 0x8fa6b3, 0.2);
      ctx.rect(415, 172, 450, 3, accent);
      ctx.rect(415, 175, 450, 8, accent, 0.08, true);
      text("RELAY 07 / OPERATOR STATUS", 640, 203, 11, P.steel, "center");
      const title = s.phase === "paused" ? "SIGNAL HELD" : s.phase === "won" ? "SIGNAL RESTORED" : "SIGNAL LOST";
      text(title, 640, 256, 36, s.phase === "lost" ? P.orange : P.chalk, "center", 800);
      ctx.rect(610, 300, 60, 2, accent);
      text(
        s.phase === "paused"
          ? "The station will wait."
          : s.phase === "won"
            ? "All three relays are back on the network."
            : "Security overwhelmed the uplink. Try another route.",
        640,
        315,
        14,
        0xa9b8bf,
        "center",
        400,
      );
      if (s.phase === "paused") {
        button("RESUME OPERATION", 470, 397, 340);
        text("CONTROL SETTINGS", 640, 482, 13, P.cyan, "center", 700);
        ctx.rect(560, 520, 160, 1, P.steel, 0.3);
        text("RESTART STATION", 640, 550, 12, P.steel, "center", 700);
      } else {
        text(`${s.kills} CONTACTS   /   ${Math.floor(s.time)} SECONDS   /   ${s.completed} RELAYS`, 640, 369, 12, P.cyan, "center", 700);
        button("DEPLOY AGAIN   →", 470, 438, 340);
        text("ENTER TO RESTART", 640, 538, 11, P.steel, "center");
      }
    }
    if (g.settingsOpen) {
      ctx.rect(0, 0, 1280, 720, P.black, 0.88);
      ctx.rect(400, 135, 480, 443, P.dark, 0.98);
      ctx.frame(400, 135, 480, 443, 0x8fa6b3, 0.2);
      ctx.rect(400, 135, 480, 3, P.cyan);
      text("OPERATOR CONTROLS", 640, 164, 25, P.chalk, "center", 700);
      for (const y of [215, 275, 330, 390]) ctx.rect(430, y, 420, 1, P.steel, 0.2);
      text(`−     MOUSE SENSITIVITY  ${(g.look.sensitivity * 1000).toFixed(1)}     +`, 640, 237, 15, P.cyan, "center");
      text(`INVERT VERTICAL LOOK    ${g.look.invertY ? "ON" : "OFF"}`, 640, 291, 14, P.chalk, "center");
      text(`FIELD OF VIEW    ${g.settings.fov}°   /   CLICK TO SWITCH`, 640, 347, 14, P.chalk, "center");
      text(`REBIND FORWARD`, 527, 407, 12, P.cyan, "center");
      text("REBIND JUMP", 752, 407, 12, P.cyan, "center");
      button("BACK", 470, 463, 340);
      text(
        g.rebindAction ? `PRESS A LETTER KEY OR SPACE FOR ${g.rebindAction.toUpperCase()} · ESC CANCELS` : "SETTINGS SAVE ON THIS DEVICE",
        640,
        543,
        10,
        P.steel,
        "center",
      );
    }
    if (g.message) text(g.message, 640, 92, 11, P.orange, "center");
    if (g.showDiagnostics) {
      ctx.rect(28, 104, 350, 94, P.black, 0.93);
      const d = g.app.renderer.diagnostics as any;
      text(
        `${g.app.platform.kind === "native" ? "NATIVE GPU" : "WEBGL2"}  |  ${g.physicsWorld.stats.bodies} BODIES`,
        43,
        120,
        12,
        P.cyan,
      );
      text(`${(d?.estimatedGpuBytes / 1048576).toFixed(1)} MiB EST. GPU  |  ${g.combat.targetCount} TARGETS`, 43, 143, 11, P.chalk);
      text(`GPU p95 ${d?.gpu?.p95Ms?.toFixed(2) ?? "—"} ms`, 43, 165, 11, P.chalk);
    }
  }
}
export default async function main(app: App): Promise<void> {
  const settings: Settings = { ...DEFAULT_SETTINGS, bindings: {} };
  try {
    const raw = app.platform.storage().get("blackiron.signal-breach.settings");
    if (raw) {
      const stored = JSON.parse(raw);
      if (Number.isFinite(stored.sensitivity))
        settings.sensitivity = Math.max(
          0.0006,
          Math.min(0.006, stored.sensitivity),
        );
      settings.invertY = stored.invertY === true;
      settings.muted = stored.muted === true;
      if (stored.fov === 82) settings.fov = 82;
      if (Number.isFinite(stored.best))
        settings.best = Math.max(0, stored.best);
      for (const [a, k] of Object.entries(stored.bindings ?? {}))
        if (
          ["up", "jump"].includes(a) &&
          typeof k === "string" &&
          /^(Key[A-Z]|Space)$/.test(k)
        )
          settings.bindings[a] = k;
    }
  } catch {
    /* Invalid settings start from defaults. */
  }
  app.input.map({
    left: ["KeyA", "GamepadLeftStickLeft"],
    right: ["KeyD", "GamepadLeftStickRight"],
    up: ["KeyW", "GamepadLeftStickUp"],
    down: ["KeyS", "GamepadLeftStickDown"],
    jump: ["Space", "GamepadA"],
    sprint: ["ShiftLeft", "ShiftRight", "GamepadL3"],
    fire: ["Mouse0", "KeyJ", "GamepadR2"],
    reload: ["KeyR", "GamepadX"],
    weapon1: "Digit1",
    weapon2: "Digit2",
    interact: ["KeyE", "GamepadY"],
    lookLeft: ["ArrowLeft", "GamepadRightStickLeft"],
    lookRight: ["ArrowRight", "GamepadRightStickRight"],
    lookUp: ["ArrowUp", "GamepadRightStickUp"],
    lookDown: ["ArrowDown", "GamepadRightStickDown"],
    confirm: "Enter",
    pause: ["Escape", "GamepadStart"],
    settings: "F1",
    mute: "KeyM",
    debug: "Backquote",
  });
  for (const [action, key] of Object.entries(settings.bindings))
    app.input.bind(action, key);
  const sounds: Record<
    string,
    {
      wave: "noise" | "square" | "sine" | "triangle";
      freq: number;
      freqEnd: number;
      duration: number;
      volume: number;
    }
  > = {
    rifle: {
      wave: "square",
      freq: 220,
      freqEnd: 58,
      duration: 0.085,
      volume: 0.15,
    },
    scatter: {
      wave: "noise",
      freq: 170,
      freqEnd: 38,
      duration: 0.2,
      volume: 0.24,
    },
    hit: {
      wave: "sine",
      freq: 800,
      freqEnd: 520,
      duration: 0.04,
      volume: 0.14,
    },
    break: {
      wave: "noise",
      freq: 110,
      freqEnd: 30,
      duration: 0.24,
      volume: 0.18,
    },
    hurt: {
      wave: "triangle",
      freq: 120,
      freqEnd: 45,
      duration: 0.18,
      volume: 0.21,
    },
    reload: {
      wave: "square",
      freq: 440,
      freqEnd: 140,
      duration: 0.12,
      volume: 0.09,
    },
    relay: {
      wave: "sine",
      freq: 390,
      freqEnd: 1200,
      duration: 0.5,
      volume: 0.22,
    },
    drone: {
      wave: "triangle",
      freq: 650,
      freqEnd: 130,
      duration: 0.12,
      volume: 0.13,
    },
    step: {
      wave: "noise",
      freq: 65,
      freqEnd: 32,
      duration: 0.035,
      volume: 0.12,
    },
  };
  for (const [name, sound] of Object.entries(sounds))
    app.audio.defineSfx(`breach-${name}`, sound);
  app.renderer.profiling = true;
  const physics = await createPhysics3D();
  try {
    app.scenes.change(new BreachScene(physics, settings));
  } catch (error) {
    physics.dispose();
    throw error;
  }
}
