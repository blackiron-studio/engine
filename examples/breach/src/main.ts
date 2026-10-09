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
  Vec3,
  Mesh3D,
  Node3D,
  spatialAudio3D,
  type DamageEvent3D,
  type NavigationGrid3D,
} from "@blackiron-studio/engine/three";
import { BreachArt, P } from "./presentation.ts";
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
  heavy: boolean;
  node: Node3D;
  core: Mesh3D;
  rotor: Node3D;
  body: ReturnType<PhysicsBackend3D["createBody"]>;
  removeTarget: () => void;
  position: Vec3;
  cooldown: number;
  flash: number;
  path: Vec3[];
  repath: number;
}
interface Bolt {
  shot: Projectile3D;
  mesh: Mesh3D;
}
interface Trail {
  mesh: Mesh3D;
  time: number;
}
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
  private trails: Trail[] = [];
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
    this.name = "signal-breach";
    this.settings = settings;
    this.physics3D = physicsWorld;
    this.camera3D.fov = settings.fov;
    this.camera3D.near = 0.045;
    this.camera3D.far = 160;
    this.look.sensitivity = settings.sensitivity;
    this.look.invertY = settings.invertY;
    this.background = 0xb6c9c8;
    Object.assign(this.environment, {
      ambient: 0xcde9df,
      ambientIntensity: 0.65,
      groundColor: 0x586d70,
      sunColor: 0xffe7c2,
      sunIntensity: 2.2,
      fogColor: 0xb6c9c8,
      fogDensity: 0.008,
      shadows: true,
      shadowMapSize: 2048,
      shadowExtent: 34,
      shadowBias: 0.0007,
    });
    this.environment.sunDirection.set(-0.5, 1, 0.35);
    this.environment.shadowTarget.set(0, 1, -3);
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
      const enemy: Enemy = {
        id: this.nextEnemy++,
        health: heavy ? 100 : 58,
        heavy,
        node: visual.root,
        core: visual.core,
        rotor: visual.rotor,
        body,
        removeTarget: () => {},
        position: p,
        cooldown: 1.5 + i * 0.5,
        flash: 0,
        path: [],
        repath: 0,
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
    this.particles.burst({
      ...e.point,
      color: P.cyan,
      count: 4,
      speed: 2,
      lifetime: 0.25,
      size: 0.045,
    });
    if (enemy.health === 0) {
      this.state.kills++;
      enemy.node.visible = false;
      enemy.removeTarget();
      this.physicsWorld.removeBody(enemy.body);
      this.particles.burst({
        x: enemy.position.x,
        y: 1.6,
        z: enemy.position.z,
        color: P.orange,
        count: 26,
        speed: 5,
        lifetime: 0.7,
        size: 0.13,
      });
      this.app.audio.play(
        "breach-break",
        spatialAudio3D(this.eye, this.look.right(), enemy.node.position),
      );
      if (this.enemies.every((e) => e.health <= 0))
        this.notice("AREA CLEAR / FIND AN AMBER RELAY", 4);
    } else this.app.audio.play("breach-hit", { volume: 0.6 });
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
    const lamp = this.art.relayLamps[i];
    lamp.color = lamp.emissive = P.cyan;
    for (const c of this.art.relays[i].children)
      if (c instanceof Mesh3D && c.geometry === this.art.ring)
        c.material = this.art.mat(P.cyan, true);
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
    this.placeCamera();
    for (const w of this.weapons) w.update(dt);
    const weapon = this.weapons[this.weaponIndex],
      directions = weapon.trigger(
        input.isDown("fire") || this.firePressed,
        this.look.forward(),
      );
    this.firePressed = false;
    if (directions.length) {
      this.flash = 0.055;
      this.recoil = this.weaponIndex ? 0.22 : 0.075;
      this.look.turn(0, this.weaponIndex ? 0.014 : 0.0028);
      this.app.audio.play(this.weaponIndex ? "breach-scatter" : "breach-rifle");
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
        this.tracer(
          this.eye
            .clone()
            .add(this.look.right().multiplyScalar(0.24))
            .add(new Vec3(0, -0.17, 0)),
          end,
          P.cyan,
          0.06,
        );
        if (hit && !hit.target)
          this.particles.burst({
            ...hit.point,
            color: P.chalk,
            count: 3,
            speed: 1.8,
            lifetime: 0.22,
            size: 0.04,
          });
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
      b.mesh.position.copy(b.shot.position);
      if (hit)
        this.particles.burst({
          ...hit.point,
          color: P.red,
          count: 5,
          speed: 1.5,
          lifetime: 0.25,
          size: 0.07,
        });
      if (!b.shot.alive) {
        b.mesh.destroy();
        this.bolts.splice(i, 1);
      }
    }
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const t = this.trails[i];
      t.time -= dt;
      if (t.time <= 0) {
        t.mesh.destroy();
        this.trails.splice(i, 1);
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
    for (const r of this.art.relays) {
      const ring = r.children.find(
        (c) => c instanceof Mesh3D && c.geometry === this.art.ring,
      );
      if (ring instanceof Mesh3D) ring.rotation.z = Math.sin(s.time) * 0.08;
    }
    this.syncWeapon();
  }
  private updateEnemies(dt: number): void {
    for (const e of this.enemies) {
      if (e.health <= 0) continue;
      e.flash = Math.max(0, e.flash - dt);
      e.core.tint = e.flash > 0 ? 0xffffff : P.red;
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
      const hover = 1.6 + Math.sin(this.state.time * 2.4 + e.id) * 0.13;
      e.node.position.set(e.position.x, hover, e.position.z);
      e.node.rotation.y = Math.atan2(-delta.x, -delta.z);
      e.rotor.rotation.y = this.state.time * 5;
      e.body.setNextKinematicTranslation(e.node.position);
      e.cooldown -= dt;
      if (e.cooldown <= 0 && distance < 34) {
        const origin = e.node.position.clone(),
          aim = this.eye.clone().sub(origin).normalize();
        const hit = this.combat.cast(
          origin,
          aim,
          distance + 2,
          e.body.collider(0).handle,
        );
        if (
          hit?.collider === this.player.collider.handle &&
          this.bolts.length < 32
        ) {
          const speed = e.heavy ? 11 : 13;
          const shot = new Projectile3D(
            origin,
            aim.multiplyScalar(speed),
            4,
            e.heavy ? 12 : 8,
            e.body.collider(0).handle,
            "drone",
          );
          const mesh = this.art.mesh(
            this.world3D,
            this.art.sphere,
            origin.x,
            origin.y,
            origin.z,
            0.12,
            0.12,
            0.12,
            P.red,
            true,
          );
          mesh.castShadow = false;
          this.bolts.push({ shot, mesh });
          this.app.audio.play(
            "breach-drone",
            spatialAudio3D(this.eye, this.look.right(), origin, 35),
          );
          e.cooldown = e.heavy ? 1.5 : 2.3;
        } else e.cooldown = 0.25;
      }
    }
  }
  private tracer(start: Vec3, end: Vec3, color: number, time: number): void {
    if (this.trails.length >= 40) {
      this.trails.shift()!.mesh.destroy();
    }
    const direction = end.clone().sub(start),
      length = direction.length;
    const mesh = this.art.box(
      this.world3D,
      (start.x + end.x) / 2,
      (start.y + end.y) / 2,
      (start.z + end.z) / 2,
      0.018,
      0.018,
      length,
      color,
      true,
    );
    // Transform an identity +Z beam with yaw then pitch via a parent yaw node would allocate;
    // XYZ rotation can align Z directly with these angles.
    mesh.rotation.y = Math.asin(direction.x / Math.max(0.0001, length));
    mesh.rotation.x = Math.atan2(-direction.y, direction.z);
    mesh.castShadow = false;
    this.trails.push({ mesh, time });
  }
  private placeCamera(): void {
    if (this.state.phase === "title") {
      this.camera3D.position.set(12, 6.5, 21);
      this.camera3D.lookAt(-1, 3, -7);
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
    this.look.apply(this.camera3D, this.eye);
    this.syncWeapon();
  }
  private syncWeapon(): void {
    const root = this.art.weaponRoot;
    root.visible = this.state.phase !== "title";
    // yaw parent, pitch child composition matches the look convention.
    root.position.copy(this.eye);
    root.rotation.set(0, -this.look.yaw, 0);
    for (let i = 0; i < this.art.weaponModels.length; i++) {
      const gun = this.art.weaponModels[i];
      gun.visible = i === this.weaponIndex;
      const reload = this.weapons[i].reloadRemaining > 0;
      gun.rotation.set(
        this.look.pitch + (reload ? -0.7 : this.recoil * 0.5),
        0,
        reload ? -0.35 : 0,
      );
      gun.setScale(0.8);
      const offset = new Vec3(
        0.3 + Math.sin(this.stride) * 0.008,
        -0.29 - this.recoil * 0.14 + (reload ? -0.22 : 0),
        -0.65 + this.recoil * 0.22,
      );
      const c = Math.cos(this.look.pitch),
        s = Math.sin(this.look.pitch);
      gun.position.set(
        offset.x,
        offset.y * c - offset.z * s,
        offset.y * s + offset.z * c,
      );
    }
    this.art.muzzle.visible = this.flash > 0;
    this.art.muzzle.position.set(
      0.26,
      -0.25 * Math.cos(this.look.pitch) + 1.14 * Math.sin(this.look.pitch),
      -0.25 * Math.sin(this.look.pitch) - 1.14 * Math.cos(this.look.pitch),
    );
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
      text = (
        value: string,
        x: number,
        y: number,
        size = 14,
        color = 0xe5ebdf,
        align: "left" | "center" | "right" = "left",
        weight = 600,
      ) =>
        ctx.text(value, x, y, {
          font: { family: "Arial", size, weight },
          color,
          align,
          shadow: null,
        });
    const button = (
      label: string,
      x: number,
      y: number,
      width: number,
      accent = true,
    ) => {
      ctx.rect(x, y, width, 52, accent ? P.cyan : P.dark, 0.96);
      text(
        label,
        x + width / 2,
        y + 16,
        16,
        accent ? P.black : P.chalk,
        "center",
        700,
      );
    };
    // Small persistent framing details, designed at 1280×720.
    if (s.phase === "title") {
      ctx.rect(36, 38, 450, 625, P.black, 0.94);
      ctx.rect(36, 38, 4, 625, P.cyan);
      ctx.rect(66, 70, 28, 4, P.cyan);
      text("RELAY 07   /   OFFSHORE ARRAY", 108, 63, 12, P.cyan);
      text("SIGNAL", 60, 110, 88, 0xf0ecda, "left", 800);
      text("BREACH", 60, 190, 88, 0xf0ecda, "left", 800);
      text("THE STATION IS NO LONGER OURS.", 68, 304, 13, P.orange);
      text(
        "Cut through security. Reboot three relays.",
        68,
        343,
        17,
        0xb9cbc3,
        "left",
        400,
      );
      text(
        "Two weapons. Three response waves.",
        68,
        370,
        17,
        0xb9cbc3,
        "left",
        400,
      );
      text(
        "One way to bring the signal back.",
        68,
        397,
        17,
        0xb9cbc3,
        "left",
        400,
      );
      text("01  /  SINGLE PLAYER CAMPAIGN", 68, 456, 12, P.chalk);
      button("ENTER THE STATION   →", 66, 493, 322);
      text("CONTROL SETTINGS", 68, 573, 12, P.cyan);
      text("ENTER TO BEGIN", 390, 573, 11, P.chalk, "right");
      text("A BLACKIRON ORIGINAL", 68, 625, 11, P.steel);
      text("FPS  /  01", 453, 625, 11, P.steel, "right");
      text("SECURITY OVERRIDE REQUIRED", 1227, 53, 11, P.black, "right");
      text("07", 1232, 569, 92, P.black, "right", 800);
      text("THE RELAY STATION", 1226, 667, 13, P.black, "right");
    } else {
      ctx.rect(28, 25, 287, 61, P.black, 0.9);
      ctx.rect(28, 25, 3, 61, P.cyan);
      text("SIGNAL BREACH", 45, 38, 15, P.chalk);
      text(`${s.completed} / 3 RELAYS ONLINE`, 45, 62, 11, P.cyan);
      for (let i = 0; i < 3; i++) {
        ctx.rect(
          230 + i * 22,
          48,
          13,
          18,
          s.relays[i] ? P.cyan : P.steel,
          s.relays[i] ? 1 : 0.45,
        );
      }
      const heading = ((((g.look.yaw * 180) / Math.PI) % 360) + 360) % 360;
      text(
        `RELAY 07     ${Math.round(heading).toString().padStart(3, "0")}°     OFFSHORE`,
        640,
        34,
        11,
        P.black,
        "center",
      );
      ctx.rect(990, 25, 262, 61, P.black, 0.9);
      text(`RESPONSE ${Math.min(3, s.wave + 1)} / 3`, 1008, 39, 12, P.chalk);
      text(
        `${String(Math.floor(s.time / 60)).padStart(2, "0")}:${String(Math.floor(s.time % 60)).padStart(2, "0")}`,
        1233,
        37,
        20,
        P.cyan,
        "right",
      );
      text(
        `${g.enemies.filter((e) => e.health > 0).length} HOSTILES   /   ${s.kills} NEUTRALIZED`,
        1008,
        63,
        10,
        P.steel,
      );
      // Map is deliberately schematic: route choice, relays and moving contacts.
      ctx.rect(1110, 102, 142, 158, P.black, 0.78);
      for (let i = 0; i < 3; i++) {
        const p = RELAYS[i];
        ctx.rect(
          1181 + p.x * 2.2 - 3,
          180 + p.z * 2.1 - 3,
          6,
          6,
          s.relays[i] ? P.cyan : P.orange,
        );
      }
      for (const e of g.enemies)
        if (e.health > 0)
          ctx.rect(
            1181 + e.position.x * 2.2 - 2,
            180 + e.position.z * 2.1 - 2,
            4,
            4,
            P.red,
          );
      ctx.rect(
        1181 + g.player.position.x * 2.2 - 3,
        180 + g.player.position.z * 2.1 - 3,
        6,
        6,
        0xffffff,
      );
      text("RELAY SCAN", 1181, 244, 9, P.steel, "center");
      // Minimal crosshair expands with recoil. White hit confirmation is brief.
      const gap = 5 + g.recoil * 40,
        color = s.hitMarker > 0 ? P.orange : P.cyan;
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
      ctx.rect(28, 617, 266, 77, P.black, 0.9);
      ctx.rect(28, 617, 3, 77, s.health < 30 ? P.red : P.cyan);
      text("INTEGRITY", 46, 631, 10, P.steel);
      text(
        String(Math.ceil(s.health)).padStart(3, "0"),
        45,
        650,
        31,
        s.health < 30 ? P.red : P.chalk,
        "left",
        700,
      );
      for (let i = 0; i < 10; i++)
        ctx.rect(
          118 + i * 15,
          663,
          11,
          14,
          s.health > i * 10 ? P.cyan : P.steel,
          s.health > i * 10 ? 1 : 0.2,
        );
      ctx.rect(968, 601, 284, 93, P.black, 0.92);
      ctx.rect(1249, 601, 3, 93, P.orange);
      text(
        g.weaponIndex === 0 ? "AR-04 / PULSE RIFLE" : "SG-08 / SCATTERGUN",
        989,
        615,
        11,
        P.chalk,
      );
      text(String(w.ammo).padStart(2, "0"), 990, 638, 39, P.chalk);
      text(`/ ${w.reserve}`, 1050, 658, 15, P.steel);
      text("1  RIFLE    2  SCATTER", 1230, 639, 10, P.steel, "right");
      text(
        w.reloadRemaining > 0 ? "RELOADING…" : "R  RELOAD",
        1230,
        672,
        10,
        w.reloadRemaining > 0 ? P.orange : P.cyan,
        "right",
      );
      if (w.reloadRemaining > 0)
        ctx.rect(
          990,
          689,
          236 * (1 - w.reloadRemaining / w.definition.reloadSeconds),
          2,
          P.orange,
        );
      text(
        "WASD MOVE   SHIFT SPRINT   SPACE JUMP   E RELAY",
        640,
        675,
        10,
        P.chalk,
        "center",
      );
      text(
        "ESC PAUSE   •   F1 SETTINGS   •   M SOUND",
        640,
        694,
        9,
        P.steel,
        "center",
      );
      if (g.nearestRelay >= 0 && s.phase === "playing") {
        ctx.rect(420, 478, 440, 54, P.black, 0.92);
        text(
          g.enemies.some((e) => e.health > 0)
            ? "RELAY LOCKED / CLEAR SECURITY FIRST"
            : "[ E ]   REBOOT RELAY / RESTORE +30 INTEGRITY",
          640,
          498,
          12,
          P.cyan,
          "center",
        );
      }
      if (s.noticeTime > 0) {
        ctx.rect(387, 111, 506, 37, P.black, 0.82);
        text(s.notice, 640, 123, 12, P.cyan, "center");
      }
      if (s.damageFlash > 0) {
        ctx.rect(0, 0, 1280, 7, P.red, s.damageFlash * 2);
        ctx.rect(0, 713, 1280, 7, P.red, s.damageFlash * 2);
        ctx.rect(0, 0, 7, 720, P.red, s.damageFlash * 2);
        ctx.rect(1273, 0, 7, 720, P.red, s.damageFlash * 2);
      }
      if (s.phase === "playing" && !g.lock?.locked) {
        ctx.rect(402, 554, 476, 40, P.black, 0.9);
        text(
          g.lock?.dragFallback
            ? "HOLD RIGHT MOUSE TO AIM · LEFT CLICK FIRES"
            : "CLICK TO CAPTURE MOUSE  /  ARROWS AIM · J FIRES",
          640,
          568,
          11,
          P.cyan,
          "center",
        );
      }
    }
    if (s.phase === "paused" || s.phase === "won" || s.phase === "lost") {
      ctx.rect(0, 0, 1280, 720, P.black, 0.62);
      ctx.rect(415, 172, 450, 428, P.black, 0.97);
      ctx.rect(415, 172, 450, 3, P.cyan);
      text("RELAY 07 / OPERATOR STATUS", 640, 203, 11, P.steel, "center");
      const title =
        s.phase === "paused"
          ? "SIGNAL HELD"
          : s.phase === "won"
            ? "SIGNAL RESTORED"
            : "SIGNAL LOST";
      text(
        title,
        640,
        256,
        36,
        s.phase === "lost" ? P.orange : P.chalk,
        "center",
        800,
      );
      text(
        s.phase === "paused"
          ? "The station will wait."
          : s.phase === "won"
            ? "All three relays are back on the network."
            : "Security overwhelmed the uplink. Try another route.",
        640,
        315,
        14,
        P.steel,
        "center",
        400,
      );
      if (s.phase === "paused") {
        button("RESUME OPERATION", 470, 397, 340);
        text("CONTROL SETTINGS", 640, 482, 13, P.cyan, "center");
        text("RESTART STATION", 640, 550, 12, P.steel, "center");
      } else {
        text(
          `${s.kills} CONTACTS   /   ${Math.floor(s.time)} SECONDS   /   ${s.completed} RELAYS`,
          640,
          369,
          12,
          P.cyan,
          "center",
        );
        button("DEPLOY AGAIN   →", 470, 438, 340);
        text("ENTER TO RESTART", 640, 538, 11, P.steel, "center");
      }
    }
    if (g.settingsOpen) {
      ctx.rect(0, 0, 1280, 720, P.black, 0.88);
      ctx.rect(400, 135, 480, 443, P.dark);
      ctx.rect(400, 135, 480, 3, P.cyan);
      text("OPERATOR CONTROLS", 640, 164, 25, P.chalk, "center", 700);
      text(
        `−     MOUSE SENSITIVITY  ${(g.look.sensitivity * 1000).toFixed(1)}     +`,
        640,
        237,
        15,
        P.cyan,
        "center",
      );
      text(
        `INVERT VERTICAL LOOK    ${g.look.invertY ? "ON" : "OFF"}`,
        640,
        291,
        14,
        P.chalk,
        "center",
      );
      text(
        `FIELD OF VIEW    ${g.settings.fov}°   /   CLICK TO SWITCH`,
        640,
        347,
        14,
        P.chalk,
        "center",
      );
      text(`REBIND FORWARD`, 527, 407, 12, P.cyan, "center");
      text("REBIND JUMP", 752, 407, 12, P.cyan, "center");
      button("BACK", 470, 463, 340);
      text(
        g.rebindAction
          ? `PRESS A LETTER KEY OR SPACE FOR ${g.rebindAction.toUpperCase()} · ESC CANCELS`
          : "SETTINGS SAVE ON THIS DEVICE",
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
      text(
        `${(d?.estimatedGpuBytes / 1048576).toFixed(1)} MiB EST. GPU  |  ${g.combat.targetCount} TARGETS`,
        43,
        143,
        11,
        P.chalk,
      );
      text(
        `GPU p95 ${d?.gpu?.p95Ms?.toFixed(2) ?? "—"} ms`,
        43,
        165,
        11,
        P.chalk,
      );
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
