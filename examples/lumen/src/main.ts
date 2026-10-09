import { createSceneRegistry, parseSceneDocument } from "@blackiron-studio/engine/content";
import gateDocument from "../assets/scenes/main.blackiron.json";
import type { App } from "@blackiron-studio/engine/app";
import {
  Anchor,
  Button,
  Graphics2D,
  Label,
  TouchControls,
} from "@blackiron-studio/engine/scene";
import {
  Scene3D,
  Node3D,
  Mesh3D,
  Geometry3D,
  Material3D,
  PointLight3D,
  Particles3D,
  CameraShake3D,
  Vec3,
} from "@blackiron-studio/engine/three";
import {
  CORES,
  OBSTACLES,
  createSalvage,
  dronePosition,
  stepSalvage,
  SALVAGE_DASH,
} from "./game.ts";
const UI = { family: "Instrument Sans", size: 20, weight: 600 },
  SMALL = { ...UI, size: 16, weight: 500 },
  TITLE = { ...UI, size: 54, weight: 700 };
const palette = {
  stone: 0xe0d5bb,
  edge: 0x889e9b,
  dark: 0x3a565f,
  teal: 0x2eaca2,
  gold: 0xf4b961,
  leaf: 0x639679,
};
export class SalvageScene extends Scene3D {
  state = createSalvage();
  private hero = new Node3D();
  private cores: Node3D[] = [];
  private drones: Node3D[] = [];
  private rotor!: Mesh3D;
  private beacon!: Material3D;
  private status!: Label;
  private energy!: Label;
  private intro!: Anchor;
  private pauseMenu!: Anchor;
  private winMenu!: Anchor;
  private started = false;
  private pausedFlag = false;
  private jump = false;
  private angle = 0.62;
  private orthographic = false;
  private readonly direction = new Vec3();
  private readonly shake = new CameraShake3D("lumen");
  private readonly debris = new Particles3D(160, "lumen-debris");
  private readonly legs: Node3D[] = [];
  private readonly coreMarkers: Mesh3D[] = [];
  private readonly hullBars: Graphics2D[] = [];
  private contact!: Mesh3D;
  private objective!: Label;
  private viewLabel!: Label;
  private notification!: Label;
  private noticeTime = 0;
  private stride = 0;
  private moving = 0;
  private dash = false;
  private dashFill!: Graphics2D;
  private dashLabel!: Label;
  private readonly boxGeometry = Geometry3D.box();
  private primitiveCache = new Map<string, Geometry3D>();
  private sphere(radius: number): Geometry3D {
    const key = `sphere:${radius}`;
    let g = this.primitiveCache.get(key);
    if (!g) {
      g = Geometry3D.sphere(radius);
      this.primitiveCache.set(key, g);
    }
    return g;
  }
  private cylinder(radius: number, height: number): Geometry3D {
    const key = `cylinder:${radius}:${height}`;
    let g = this.primitiveCache.get(key);
    if (!g) {
      g = Geometry3D.cylinder(radius, height);
      this.primitiveCache.set(key, g);
    }
    return g;
  }
  private torus(radius: number, tube: number): Geometry3D {
    const key = `torus:${radius}:${tube}`;
    let g = this.primitiveCache.get(key);
    if (!g) {
      g = Geometry3D.torus(radius, tube);
      this.primitiveCache.set(key, g);
    }
    return g;
  }
  private ring(outer: number, inner: number): Geometry3D {
    const key = `ring:${outer}:${inner}`;
    let g = this.primitiveCache.get(key);
    if (!g) { g = Geometry3D.ring(outer, inner); this.primitiveCache.set(key, g); }
    return g;
  }
  private materialCache = new Map<number, Material3D>();
  private mat(color: number): Material3D {
    let m = this.materialCache.get(color);
    if (!m) {
      m = new Material3D({ color, roughness: 0.75 });
      this.materialCache.set(color, m);
    }
    return m;
  }
  private mesh(
    parent: Node3D,
    geometry: Geometry3D,
    color: number,
    x: number,
    y: number,
    z: number,
  ): Mesh3D {
    const m = parent.add(new Mesh3D(geometry, this.mat(0xffffff)));
    m.tint = color;
    m.position.set(x, y, z);
    return m;
  }
  private box(
    parent: Node3D,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number,
  ): Mesh3D {
    const m = this.mesh(parent, this.boxGeometry, color, x, y, z);
    m.scale.set(w, h, d);
    return m;
  }
  override ready(): void {
    const env = this.environment;
    this.background = 0xb9cdd0;
    env.ambient = 0xdde9e4;
    env.ambientIntensity = 0.55;
    env.sunColor = 0xffefd2;
    env.sunIntensity = 2;
    env.sunDirection.set(-0.7, 1, 0.4);
    env.groundColor = 0x637d85;
    env.fogColor = 0xb9cdd0;
    env.fogDensity = 0.008;
    env.shadows = true;
    env.shadowExtent = 20;
    this.camera3D.fov = 48;
    this.camera3D.near = 0.1;
    this.camera3D.far = 100;
    this.camera3D.orthoHeight = 28;
    this.camera3D.orthoWidth = 38;
    this.post.bloom = 0.12;
    this.post.bloomThreshold = 0.85;
    this.post.vignette = 0.13;
    const w = this.world3D;
    w.add(this.debris);
    this.box(w, 0, -1.1, 0, 25, 2, 25, palette.dark);
    this.box(w, 0, -0.2, 0, 24.7, 0.35, 24.7, palette.edge);
    for (let z = -11; z <= 11; z += 2)
      for (let x = -11; x <= 11; x += 2)
        this.box(
          w,
          x,
          -0.035,
          z,
          1.95,
          0.09,
          1.95,
          (x + z) % 6 === 0 ? 0xd4cbb8 : palette.stone,
        );
    // A low parapet, corner gardens and a monumental gate give the courtyard a silhouette.
    for (const x of [-12, 12]) this.box(w, x, 0.35, 0, 0.35, 0.7, 24, 0xb5b5a3);
    for (const z of [-12, 12]) this.box(w, 0, 0.35, z, 24, 0.7, 0.35, 0xb5b5a3);
    for (const o of OBSTACLES) {
      this.box(w, o.x, 0.5, o.z, o.w, 1, o.d, palette.edge);
      this.box(w, o.x, 1.04, o.z, 2.18, 0.14, 2.18, palette.stone);
      this.tree(o.x, o.z);
    }
    const gate = createSceneRegistry().instantiate(parseSceneDocument(gateDocument));
    this.resources.own(gate);
    w.add(gate.root);
    this.mesh(w, this.cylinder(1.8, 0.18), palette.edge, 0, 0.07, 0);
    this.mesh(w, this.cylinder(1.4, 0.24), palette.stone, 0, 0.23, 0);
    this.beacon = new Material3D({
      color: palette.teal,
      emissive: palette.teal,
      emissiveIntensity: 0.6,
      metallic: 0.3,
      roughness: 0.35,
    });
    const crystal = w.add(new Mesh3D(Geometry3D.cone(0.55, 1.8), this.beacon));
    crystal.position.set(0, 1.35, 0);
    const ring = this.mesh(w, this.torus(1.1, 0.08), palette.gold, 0, 1.15, 0);
    ring.rotation.x = Math.PI / 2;
    const glow = w.add(new PointLight3D(palette.teal, 2, 7));
    glow.position.set(0, 2, 0);
    // Brass seams and garden strips break up the paving without texture assets.
    for (const sign of [-1, 1]) {
      this.box(w, sign * 10.9, 0.035, 0, 0.08, 0.035, 21, 0xa99b70);
      this.box(w, 0, 0.035, sign * 10.9, 21, 0.035, 0.08, 0xa99b70);
      for (let i = 0; i < 9; i++) {
        const z = -8 + i * 2;
        this.box(w, sign * 11.6, 0.12, z, 0.38, 0.2, 0.8, 0x617f75);
        for (let j = 0; j < 3; j++) {
          const plant = this.mesh(
            w,
            this.sphere(0.16),
            j % 2 ? 0x90ac81 : 0x508778,
            sign * (11.55 + j * 0.05),
            0.3 + j * 0.07,
            z + (j - 1) * 0.18,
          );
          plant.scale.y = 2;
        }
      }
    }
    // An articulated courier built entirely from primitives.
    w.add(this.hero);
    this.contact = this.mesh(w, Geometry3D.ring(0.65, 0.56), palette.teal, 0, 0.045, 0);
    this.contact.castShadow = false;
    this.contact.material = new Material3D({ unlit: true, toneMapped: false });
    this.box(this.hero, 0, 0.7, 0, 0.7, 0.75, 0.54, palette.teal);
    this.box(this.hero, 0, 0.8, -0.32, 0.44, 0.35, 0.2, palette.gold);
    this.mesh(this.hero, this.sphere(0.42), palette.stone, 0, 1.4, 0);
    this.box(this.hero, 0, 1.4, 0.35, 0.56, 0.2, 0.12, palette.dark);
    for (const x of [-0.17, 0.17])
      this.box(this.hero, x, 1.42, 0.42, 0.08, 0.07, 0.03, 0xb6fff0);
    for (const x of [-0.22, 0.22]) {
      const leg = this.hero.add(new Node3D());
      leg.x = x;
      this.box(leg, 0, 0.2, 0, 0.22, 0.4, 0.3, palette.dark);
      this.box(leg, 0, 0.08, 0.1, 0.27, 0.16, 0.43, palette.stone);
      this.legs.push(leg);
    }
    for (const x of [-0.49, 0.49])
      this.mesh(this.hero, this.sphere(0.17), palette.stone, x, 0.92, 0);
    this.rotor = this.box(this.hero, 0, 1.98, 0, 1, 0.045, 0.11, palette.gold);
    this.box(this.hero, 0, 1.8, 0, 0.06, 0.4, 0.06, palette.dark);
    for (const [i, p] of CORES.entries()) {
      const root = w.add(new Node3D());
      root.position.set(p[0], 1, p[1]);
      const material = new Material3D({
        color: palette.gold,
        emissive: palette.gold,
        emissiveIntensity: 0.35,
        metallic: 0.55,
        roughness: 0.28,
      });
      root.add(new Mesh3D(this.sphere(0.28), material));
      const halo = root.add(
        new Mesh3D(this.torus(0.48, 0.055), this.mat(palette.teal)),
      );
      halo.rotation.x = 0.6;
      this.cores.push(root);
      this.mesh(w, this.cylinder(0.75, 0.08), palette.edge, p[0], 0.04, p[1]);
      const marker = this.mesh(w, this.ring(0.92, 0.87), palette.gold, p[0], 0.1, p[1]);
      marker.castShadow = false;
      this.coreMarkers.push(marker);
    }
    for (let i = 0; i < 2; i++) {
      const d = w.add(new Node3D());
      this.mesh(d, this.sphere(0.4), 0xc46a58, 0, 0.7, 0);
      this.box(d, 0, 0.75, 0.34, 0.42, 0.1, 0.1, palette.dark);
      this.mesh(d, this.torus(0.65, 0.05), palette.dark, 0, 0.7, 0).rotation.x =
        Math.PI / 2;
      this.drones.push(d);
      const warning = this.mesh(d, this.ring(0.92, 0.86), 0xc46a58, 0, 0.055, 0);
      warning.castShadow = false;
    }
    const brand = this.ui.add(new Anchor({ x: "left", y: "top", safe: 34 }));
    brand.add(new Graphics2D().roundedRect(0, 0, 44, 44, 8, 0x193e4b).polygon([[22, 6], [34, 22], [22, 38], [10, 22]], 0xe5c47c));
    brand.add(new Label("LUMEN SALVAGE", 60, 0, { font: { ...UI, size: 26, weight: 700 }, color: 0x173e49 }));
    brand.add(new Label("COURTYARD 07  /  RECOVERY EXPEDITION", 61, 32, { font: { ...SMALL, size: 11 }, color: 0x365c63 }));
    const progress = this.ui.add(new Anchor({ x: "right", y: "top", w: 236, h: 98, safe: 30 }));
    progress.add(new Graphics2D().roundedRect(0, 0, 236, 98, 8, { color: 0x173e49, alpha: 0.94 }));
    progress.add(new Label("ENERGY CORES RECOVERED", 18, 13, { font: { ...SMALL, size: 11 }, color: 0xb6d2c2 }));
    this.status = progress.add(new Label("00 / 06", 18, 31, { font: { ...TITLE, size: 32 }, color: 0xf6d895 }));
    this.objective = progress.add(new Label("FIND THE SIX GOLDEN SIGNALS", 18, 74, { font: { ...SMALL, size: 10 }, color: 0xc5ded1 }));
    const hull = this.ui.add(new Anchor({ x: "left", y: "bottom", w: 250, h: 92, safe: 30 }));
    hull.add(new Graphics2D().roundedRect(0, 0, 250, 92, 8, { color: 0x173e49, alpha: 0.94 }));
    this.energy = hull.add(new Label("COURIER INTEGRITY  /  3", 14, 10, { font: { ...SMALL, size: 12 }, color: 0xdbe6d6 }));
    for (let i = 0; i < 3; i++) {
      hull.add(new Graphics2D(14 + i * 75, 38).rect(0, 0, 68, 6, 0x41626a));
      this.hullBars.push(hull.add(new Graphics2D(14 + i * 75, 38).rect(0, 0, 68, 6, 0xb4e3c9)));
    }
    this.viewLabel = hull.add(new Label("PERSPECTIVE VIEW  /  V TO SWITCH", 14, 53, { font: { ...SMALL, size: 9 }, color: 0xaecdc6 }));
    this.dashLabel = hull.add(new Label("SHIFT / DASH  READY", 14, 71, { font: { ...SMALL, size: 9 }, color: 0xe5d6a1 }));
    hull.add(new Graphics2D(160, 77).rect(0, 0, 72, 3, 0x41626a));
    this.dashFill = hull.add(new Graphics2D(160, 77).rect(0, 0, 72, 3, 0xe5d6a1));
    const foot = this.ui.add(new Anchor({ x: "right", y: "bottom", safe: 36, dy: -8 }));
    foot.add(
      new Label(
        "WASD  Move    SPACE  Jump    SHIFT  Dash    Q / E  Orbit    V  View    ESC  Pause",
        0,
        0,
        { font: { ...SMALL, size: 12 }, color: 0x163e4a, align: "right" },
      ),
    );
    const notice = this.ui.add(new Anchor({ x: "center", y: "top", dy: 110 }));
    this.notification = notice.add(new Label("", 0, 0, { font: UI, align: "center", color: 0x173e49 }));
    this.intro = this.introPanel();
    this.pauseMenu = this.panel(
      "Taking a breather",
      "Your courier is safe here.",
      "RESUME",
      "pause",
    );
    this.pauseMenu.visible = false;
    this.winMenu = this.panel(
      "The light returns",
      "All six energy cores recovered. The courtyard is alive.",
      "PLAY AGAIN",
      "restart",
    );
    this.winMenu.visible = false;
    this.ui.add(
      new TouchControls({
        stick: { left: "left", right: "right", up: "up", down: "down" },
        buttons: [
          { action: "jump", label: "UP" },
          { action: "dash", label: "DASH" },
          { action: "pause", label: "II" },
        ],
        size: 60,
      }),
    );
    this.sync(0);
  }
  private tree(x: number, z: number): void {
    const w = this.world3D;
    this.mesh(w, this.cylinder(0.17, 1.6), 0x786e55, x, 1.85, z);
    for (const [dx, y, dz, r, c] of [
      [0, 3.3, 0, 1.1, 0x638f70],
      [-0.65, 2.9, 0.1, 0.8, 0x81a279],
      [0.65, 3.15, 0.1, 0.9, 0x4c806b],
      [0, 3.7, -0.1, 0.7, 0xa5b582],
    ])
      this.mesh(w, this.sphere(r), c, x + dx, y, z + dz);
  }
  private introPanel(): Anchor {
    const p = this.ui.add(new Anchor({ x: "left", y: "center", safe: 64, w: 350, h: 368 }));
    p.add(new Graphics2D().roundedRect(0, 0, 350, 368, 12, { color: 0x173b47, alpha: 0.97 }).rect(0, 0, 350, 3, 0xe7c886));
    p.add(new Label("RECOVERY EXPEDITION / 01", 28, 26, { font: { ...SMALL, size: 12 }, color: 0xaed4c3 }));
    p.add(new Label("Bring back", 28, 68, { font: { ...TITLE, size: 46 }, color: 0xe5ebe0 }));
    p.add(new Label("the light.", 28, 118, { font: { ...TITLE, size: 46 }, color: 0xf2d391 }));
    p.add(new Label("Six lost cores. One quiet courtyard.\nLeap over patrols and return the\nenergy to the central beacon.", 28, 187, { font: { ...SMALL, size: 16 }, color: 0xb6cdc6 }));
    p.add(new Button("BEGIN SALVAGE", 28, 278, 294, 48, {
      action: "start", style: { font: { ...UI, size: 17 }, fill: 0xe4d59e, text: 0x173c47, textShadow: null, hover: 0xffeabb, border: null, bevel: null },
    }));
    p.add(new Label("ENTER TO BEGIN     /     SPACE TO JUMP", 28, 342, { font: { ...SMALL, size: 10 }, color: 0x94bcb2 }));
    return p;
  }
  private panel(
    title: string,
    sub: string,
    button: string,
    action: string,
  ): Anchor {
    const p = this.ui.add(
      new Anchor({ x: "center", y: "center", w: 680, h: 272 }),
    );
    p.add(
      new Graphics2D().roundedRect(0, 0, 680, 272, 20, {
        color: 0x163b49,
        alpha: 0.96,
      }),
    );
    p.add(
      new Label("BLACKIRON  /  THE 3D COLLECTION", 340, 26, {
        font: SMALL,
        align: "center",
        color: 0x9acabc,
      }),
    );
    p.add(
      new Label(title, 340, 61, {
        font: TITLE,
        align: "center",
        color: 0xf8e4b6,
      }),
    );
    p.add(
      new Label(sub, 340, 135, {
        font: SMALL,
        align: "center",
        color: 0xe0e6d8,
      }),
    );
    p.add(
      new Button(button, 190, 195, 300, 48, {
        action,
        style: {
          font: UI,
          fill: 0xd7ddb5,
          text: 0x173c47,
          textShadow: null,
          hover: 0xf2eac9,
          border: null,
          bevel: null,
        },
      }),
    );
    return p;
  }
  override onAction(name: string, pressed: boolean): void {
    if (!pressed) return;
    if (name === "view" && !this.pausedFlag) {
      this.orthographic = !this.orthographic;
      this.camera3D.projection = this.orthographic ? "orthographic" : "perspective";
      this.viewLabel.text = `${this.orthographic ? "ORTHOGRAPHIC" : "PERSPECTIVE"} VIEW  /  V TO SWITCH`;
      this.uiChanged();
    } else if (name === "start" || (!this.started && name === "confirm")) {
      this.started = true;
      this.intro.visible = false;
      this.uiChanged();
    } else if (name === "restart" || (this.state.won && name === "confirm"))
      this.app.scenes.change(new SalvageScene());
    else if (name === "pause" && this.started && !this.state.won) {
      this.pausedFlag = !this.pausedFlag;
      this.pauseMenu.visible = this.pausedFlag;
      this.timeScale = this.pausedFlag ? 0 : 1;
      this.uiChanged();
    } else if (name === "jump" && this.started && !this.pausedFlag)
      this.jump = true;
    else if (name === "dash" && this.started && !this.pausedFlag)
      this.dash = true;
  }
  override update(dt: number): void {
    if (dt <= 0 || !this.started || this.pausedFlag || this.state.won) return;
    const input = this.app.input;
    const v = input.vector("left", "right", "up", "down");
    const orbit = input.axis("orbitLeft", "orbitRight");
    this.angle += orbit * dt * 1.5;
    this.placeCamera();
    const { x: dx, z: dz } = this.camera3D.groundDirection(v.x, v.y, this.direction);
    const beforeY = this.state.y;
    const beforeX = this.state.x, beforeZ = this.state.z;
    const event = stepSalvage(this.state, dx, dz, this.jump, dt, { dash: this.dash });
    this.jump = this.dash = false;
    this.moving = Math.min(1, Math.hypot(this.state.x - beforeX, this.state.z - beforeZ) / Math.max(0.001, dt * 5.4));
    this.stride += dt * this.moving * 13;
    if (v.x || v.y) this.hero.rotation.y = Math.atan2(dx, dz);
    if (event.dashed) this.app.audio.play("dash");
    if (this.state.dashRemaining > 0) {
      this.debris.burst({ x: this.state.x, y: 0.3, z: this.state.z, color: palette.teal, count: 1, speed: 0.6, lifetime: 0.25, size: 0.12 });
    }
    for (const i of event.collected) {
      this.cores[i].visible = false;
      this.coreMarkers[i].visible = false;
      this.debris.burst({ x: CORES[i][0], y: 1.1, z: CORES[i][1], color: palette.gold, count: 22, speed: 3.3 });
      this.notification.text = `ENERGY CORE ${this.state.collected.filter(Boolean).length} / 6 RECOVERED`;
      this.noticeTime = 1.8;
      this.app.audio.play("collect", { pitch: 1 + i * 0.1 });
    }
    if (event.hurt) {
      this.debris.burst({ x: beforeX, y: 0.8, z: beforeZ, color: 0xd37961, count: 28, speed: 4 });
      this.shake.kick(0.32, 0.3);
      this.notification.text = this.state.energy === 3 ? "COURIER RECALLED / RECOVERED CORES RETAINED" : "PATROL CONTACT / JUMP TO EVADE";
      this.noticeTime = 2;
      this.app.audio.play("hurt");
      this.app.haptic("heavy");
    }
    if (event.won) {
      this.debris.burst({ x: 0, y: 1.8, z: 0, color: palette.gold, count: 64, speed: 5.5, lifetime: 1.4 });
      this.winMenu.visible = true;
      this.beacon.emissiveIntensity = 2;
      this.uiChanged();
      this.app.audio.play("win");
    }
    if (beforeY > 0.02 && this.state.y === 0 && !event.hurt) {
      this.debris.burst({ x: this.state.x, y: 0.12, z: this.state.z, color: palette.stone, count: 7, speed: 1.4, lifetime: 0.3, size: 0.08 });
      this.app.audio.play("land");
    }
    this.shake.update(dt);
    this.noticeTime = Math.max(0, this.noticeTime - dt);
    this.notification.alpha = Math.min(1, this.noticeTime * 3);
    this.sync(dt);
  }
  private sync(dt: number): void {
    const s = this.state,
      t = s.time;
    this.hero.position.set(s.x, s.y, s.z);
    this.contact.position.set(s.x, 0.05, s.z);
    this.contact.setScale(1 + s.y * 0.1);
    for (let i = 0; i < this.legs.length; i++) {
      this.legs[i].z = Math.sin(this.stride + i * Math.PI) * 0.18 * this.moving;
      this.legs[i].y = Math.max(0, Math.cos(this.stride + i * Math.PI)) * 0.08 * this.moving;
    }
    this.hero.visible = s.invulnerable <= 0 || Math.floor(t * 12) % 2 === 0;
    this.rotor.rotation.y = t * 14;
    for (let i = 0; i < this.cores.length; i++) {
      this.cores[i].position.y = 1 + Math.sin(t * 2 + i) * 0.16;
      this.cores[i].rotation.y = t * 0.8 + i;
    }
    for (let i = 0; i < this.drones.length; i++) {
      const p = dronePosition(t, i);
      this.drones[i].position.set(p.x, 0, p.z);
      this.drones[i].rotation.y = -t * 0.4 - i * Math.PI;
    }
    this.placeCamera();
    const count = s.collected.filter(Boolean).length;
    this.status.text = `${String(count).padStart(2, "0")} / 06`;
    this.objective.text = count === 6 ? "RETURN TO THE CENTRAL BEACON" : "FIND THE SIX GOLDEN SIGNALS";
    this.energy.text = `COURIER INTEGRITY  /  ${s.energy}`;
    this.dashFill.scaleX = 1 - s.dashCooldown / SALVAGE_DASH.cooldown;
    this.dashLabel.text = s.dashCooldown > 0 ? `SHIFT / DASH  ${s.dashCooldown.toFixed(1)}s` : "SHIFT / DASH  READY";
    for (let i = 0; i < this.hullBars.length; i++) this.hullBars[i].visible = i < s.energy;
  }
  private placeCamera(): void {
    const offset = this.shake.offset;
    const cx = this.state.x * 0.35 + offset.x,
      cz = this.state.z * 0.35 + offset.z;
    this.camera3D.target.set(cx, 0.4 + offset.y, cz);
    this.camera3D.position.set(
      cx + Math.sin(this.angle) * 24,
      20 + offset.y,
      cz + Math.cos(this.angle) * 24,
    );
  }
}
export default async function main(app: App): Promise<void> {
  app.input.map({
    left: ["KeyA", "ArrowLeft", "GamepadLeftStickLeft"],
    right: ["KeyD", "ArrowRight", "GamepadLeftStickRight"],
    up: ["KeyW", "ArrowUp", "GamepadLeftStickUp"],
    down: ["KeyS", "ArrowDown", "GamepadLeftStickDown"],
    jump: ["Space", "GamepadA"],
    dash: ["ShiftLeft", "ShiftRight", "GamepadB"],
    confirm: ["Enter"],
    pause: ["Escape", "GamepadStart"],
    orbitLeft: ["KeyQ"],
    orbitRight: ["KeyE"],
    view: ["KeyV"],
  });
  app.audio.defineSfx("collect", {
    wave: "sine",
    freq: 680,
    freqEnd: 1200,
    duration: 0.18,
    volume: 0.25,
  });
  app.audio.defineSfx("hurt", {
    wave: "triangle",
    freq: 180,
    freqEnd: 70,
    duration: 0.2,
    volume: 0.2,
  });
  app.audio.defineSfx("land", { wave: "triangle", freq: 95, freqEnd: 50, duration: 0.06, volume: 0.09 });
  app.audio.defineSfx("dash", { wave: "sine", freq: 100, freqEnd: 540, duration: 0.15, volume: 0.18 });
  app.audio.defineSfx("win", {
    wave: "sine",
    freq: 520,
    freqEnd: 1100,
    duration: 0.6,
    volume: 0.3,
  });
  app.scenes.change(new SalvageScene());
}
