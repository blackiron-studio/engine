import { createSceneRegistry, parseSceneDocument } from "@blackiron-studio/engine/content";
import gateDocument from "../assets/scenes/main.blackiron.json";
import type { App } from "@blackiron-studio/engine/app";
import {
  Anchor,
  Button,
  type DrawContext,
  Graphics2D,
  Label,
  Node2D,
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
  SkyDome3D,
  blobGeometry,
  surfaceMaterial,
  terrainGeometry,
  texturedBoxGeometry,
} from "@blackiron-studio/engine/three";
import { noise } from "@blackiron-studio/engine/art";
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
const PAD_SIZE = 60;
/** Letters the touch buttons and reports them as tap targets; laid out as `TouchControls` lays its buttons. */
class PadLabels extends Node2D {
  constructor(private readonly labels: string[], private readonly size: number) {
    super();
  }
  override render(ctx: DrawContext): void {
    const scene = this.scene;
    if (!scene) return;
    const r = PAD_SIZE * 0.55;
    this.labels.forEach((label, i) => {
      const x = scene.uiWidth - PAD_SIZE * 1.2 - i * PAD_SIZE * 1.4, y = scene.uiHeight - PAD_SIZE * 1.2;
      ctx.text(label, x, y - this.size * 0.62, { align: "center", color: 0xffffff, alpha: 0.85, font: { ...UI, size: this.size, weight: 700 }, shadow: 0x0b1d24 });
      scene.reportTarget(label, x - r, y - r, r * 2, r * 2);
    });
  }
}
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
    // Late afternoon: a warm low sun, a cool sky fill, and haze that matches the horizon.
    this.background = 0xdfe8e6;
    env.ambient = 0xb7cde0;
    env.ambientIntensity = 0.5;
    env.groundColor = 0x6e6a4f;
    env.sunColor = 0xffdcae;
    env.sunIntensity = 3.4;
    env.sunDirection.set(-0.62, 0.72, 0.42);
    env.fogColor = 0xdbe5e3;
    env.fogDensity = 0.0042;
    env.exposure = 0.98;
    env.shadows = true;
    env.shadowMapSize = 2048;
    env.shadowExtent = 21;
    env.shadowBias = 0.0012;
    this.camera3D.fov = 46;
    this.camera3D.near = 0.1;
    this.camera3D.far = 160;
    this.camera3D.orthoHeight = 28;
    this.camera3D.orthoWidth = 38;
    this.post.bloom = 0.32;
    this.post.bloomThreshold = 0.78;
    this.post.vignette = 0.24;
    this.post.saturation = 1.1;
    this.post.contrast = 1.1;
    const w = this.world3D;
    w.add(new SkyDome3D(this.camera3D, { zenith: "#4f86c4", horizon: "#e4ecea", ground: "#8a9384", sunDirection: env.sunDirection, sunColor: "#ffe7c2", sunSize: 2.4, sunGlow: 0.5, clouds: 0.42, seed: 7 }));
    w.add(this.debris);
    const m = this.materials();
    // The land the courtyard sits on: a meadow that rolls up into hills, rocks and pines.
    const hill = (x: number, z: number) => {
      const r = Math.hypot(x, z);
      const lift = noise.smoothstep(17, 70, r);
      return -1.25 + lift * (4 + noise.fbm(x * 0.03, z * 0.03, { seed: 5, octaves: 4 }) * 7) + noise.fbm(x * 0.15, z * 0.15, { seed: 9, octaves: 3 }) * 0.25 * noise.smoothstep(14, 22, r);
    };
    const land = w.add(new Mesh3D(terrainGeometry({ width: 220, depth: 220, segments: 110, height: hill, uvScale: 0.22 }), m.grass));
    land.castShadow = false;
    this.scatter(w, hill, m);
    // The courtyard: a stone plinth, a tiled terrace, a low parapet, planters and a gate.
    this.slab(w, 0, -1.15, 0, 25, 2.1, 25, m.plinth, 0.4);
    this.slab(w, 0, -0.06, 0, 24.6, 0.12, 24.6, m.tiles, 1 / 8);
    for (const x of [-12, 12]) this.slab(w, x, 0.32, 0, 0.42, 0.64, 24.6, m.stone, 0.5);
    for (const z of [-12, 12]) this.slab(w, 0, 0.32, z, 24.6, 0.64, 0.42, m.stone, 0.5);
    for (const x of [-12, 12]) for (const z of [-12, 12]) this.slab(w, x, 0.45, z, 0.75, 0.9, 0.75, m.stone, 0.5);
    for (const o of OBSTACLES) {
      this.slab(w, o.x, 0.5, o.z, o.w, 1, o.d, m.brick, 0.5);
      this.slab(w, o.x, 1.04, o.z, o.w + 0.2, 0.14, o.d + 0.2, m.stone, 0.5);
      this.tree(o.x, o.z, m);
    }
    const gate = createSceneRegistry().instantiate(parseSceneDocument(gateDocument));
    this.resources.own(gate);
    w.add(gate.root);
    this.dressGate(gate.root as Node3D, m);
    this.slab(w, 0, 0.07, 0, 3.6, 0.14, 3.6, m.stone, 0.5).rotation.y = Math.PI / 4;
    this.mesh(w, this.cylinder(1.4, 0.24), palette.stone, 0, 0.23, 0).material = m.stone;
    this.beacon = new Material3D({
      color: palette.teal,
      emissive: 0x3fe0cf,
      emissiveIntensity: 1.4,
      metallic: 0.1,
      roughness: 0.18,
    });
    const crystal = w.add(new Mesh3D(Geometry3D.cone(0.55, 1.8, 6), this.beacon));
    crystal.position.set(0, 1.35, 0);
    const ring = w.add(new Mesh3D(this.torus(1.1, 0.07), m.brass));
    ring.position.set(0, 1.15, 0);
    ring.rotation.x = Math.PI / 2;
    const glow = w.add(new PointLight3D(0x5fe8d8, 3, 8));
    glow.position.set(0, 2, 0);
    // Brass inlays in the paving and planted beds along the parapet.
    for (const sign of [-1, 1]) {
      this.slab(w, sign * 10.9, 0.005, 0, 0.1, 0.03, 21, m.brass, 1);
      this.slab(w, 0, 0.005, sign * 10.9, 21, 0.03, 0.1, m.brass, 1);
      for (let i = 0; i < 9; i++) {
        const z = -8 + i * 2;
        this.slab(w, sign * 11.45, 0.12, z, 0.6, 0.22, 1.5, m.soil, 1);
        const bush = w.add(new Mesh3D(this.bushGeometry(i + (sign > 0 ? 20 : 0)), i % 3 === 0 ? m.bloom : m.leaf));
        bush.position.set(sign * 11.45, 0.36, z);
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
    this.buildUI();
    this.sync(0);
  }
  private surfaces: ReturnType<SalvageScene["buildMaterials"]> | null = null;
  private materials() {
    return (this.surfaces ??= this.buildMaterials());
  }
  private buildMaterials() {
    return {
      grass: surfaceMaterial("grass", { seed: 3, color: "#5a7a3f", accent: "#a19a5a", size: 256, wear: 0.55, variation: 0.6 }),
      tiles: surfaceMaterial("tiles", { seed: 4, color: "#e4d9c1", accent: "#b2a68f", repeat: 4, size: 512, wear: 0.45, variation: 0.35 }),
      stone: surfaceMaterial("plaster", { seed: 5, color: "#d6ccb6", accent: "#a5987f", size: 256 }),
      plinth: surfaceMaterial("rock", { seed: 6, color: "#7f8580", accent: "#4c524f", size: 256 }),
      brick: surfaceMaterial("bricks", { seed: 7, color: "#b06b4f", accent: "#d8cfbd", repeat: 4, size: 256, wear: 0.3 }),
      rock: surfaceMaterial("rock", { seed: 8, color: "#8b8a83", accent: "#5a5953", size: 256 }),
      soil: surfaceMaterial("dirt", { seed: 9, color: "#6a4f39", size: 128 }),
      bark: surfaceMaterial("planks", { seed: 10, color: "#6b5039", accent: "#3a2a1d", repeat: 6, size: 128 }),
      leaf: surfaceMaterial("grass", { seed: 11, color: "#4e8a55", accent: "#7fae5a", size: 128, bump: 1.6 }),
      leafLight: surfaceMaterial("grass", { seed: 12, color: "#79a85a", accent: "#b5c46a", size: 128, bump: 1.6 }),
      bloom: surfaceMaterial("grass", { seed: 13, color: "#c98fa6", accent: "#f0c4a8", size: 128, bump: 1.4 }),
      pine: surfaceMaterial("grass", { seed: 14, color: "#2f5a45", accent: "#4e7552", size: 128, bump: 1.8 }),
      brass: new Material3D({ color: 0xd9ad5f, metallic: 0.85, roughness: 0.3 }),
    };
  }
  /** A textured box, its texture repeating `uvScale` times per unit. */
  private slab(parent: Node3D, x: number, y: number, z: number, w: number, h: number, d: number, material: Material3D, uvScale: number): Mesh3D {
    const key = `slab:${w}:${h}:${d}:${uvScale}`;
    let g = this.primitiveCache.get(key);
    if (!g) {
      g = texturedBoxGeometry(w, h, d, { uvScale, bevel: Math.min(0.05, h * 0.3, w * 0.3, d * 0.3) });
      this.primitiveCache.set(key, g);
    }
    const mesh = parent.add(new Mesh3D(g, material));
    mesh.position.set(x, y, z);
    return mesh;
  }
  private bushGeometry(seed: number): Geometry3D {
    const key = `bush:${seed % 6}`;
    let g = this.primitiveCache.get(key);
    if (!g) {
      g = blobGeometry({ radius: 0.32, scaleY: 0.8, roughness: 0.32, frequency: 2.4, detail: 3, seed: seed % 6, uvScale: 2 });
      this.primitiveCache.set(key, g);
    }
    return g;
  }
  /** Gate stones from the scene document get stone surfaces at a true world scale. */
  private dressGate(root: Node3D, m: ReturnType<SalvageScene["buildMaterials"]>): void {
    const visit = (node: Node3D) => {
      if (node instanceof Mesh3D) {
        const s = node.scale;
        node.geometry = texturedBoxGeometry(s.x, s.y, s.z, { uvScale: 0.6, bevel: Math.min(0.06, s.x * 0.2, s.y * 0.2, s.z * 0.2) });
        node.scale.set(1, 1, 1);
        node.material = node.material.color === 0xffffff || (node.material.color & 0xff) > 0x90 ? m.stone : m.plinth;
        node.tint = 0xffffff;
      }
      for (const c of node.children) if (c instanceof Node3D) visit(c);
    };
    visit(root);
  }
  private tree(x: number, z: number, m: ReturnType<SalvageScene["buildMaterials"]>): void {
    const w = this.world3D;
    const trunk = w.add(new Mesh3D(Geometry3D.cylinder(0.14, 2.2, 10), m.bark));
    trunk.position.set(x, 2.1, z);
    const seed = Math.round(x * 7 + z * 13);
    for (const [dx, y, dz, r, light] of [
      [0, 3.45, 0, 1.15, 0],
      [-0.7, 3.0, 0.2, 0.85, 1],
      [0.72, 3.2, -0.1, 0.9, 0],
      [0.1, 3.95, 0.15, 0.75, 1],
      [-0.2, 3.1, -0.65, 0.7, 0],
    ] as const) {
      const crown = w.add(new Mesh3D(blobGeometry({ radius: r, roughness: 0.28, frequency: 1.8, detail: 3, seed: seed + Math.round(r * 10), scaleY: 0.85, uvScale: 1.5 }), light ? m.leafLight : m.leaf));
      crown.position.set(x + dx, y, z + dz);
    }
  }
  /** Rocks, pines and shrubs on the land around the courtyard, kept clear of the plinth. */
  private scatter(w: Node3D, hill: (x: number, z: number) => number, m: ReturnType<SalvageScene["buildMaterials"]>): void {
    const rocks = [0, 1, 2, 3].map((i) => blobGeometry({ radius: 1, roughness: 0.32, frequency: 1.4, detail: 2, seed: 30 + i, scaleY: 0.6, flattenBelow: 0.3, uvScale: 0.6 }));
    const pineCrown = [Geometry3D.cone(1.6, 3.2, 9), Geometry3D.cone(1.25, 2.6, 9), Geometry3D.cone(0.85, 2, 9)];
    const pineTrunk = Geometry3D.cylinder(0.22, 1.6, 8);
    const bush = [0, 1, 2].map((i) => blobGeometry({ radius: 0.9, roughness: 0.3, frequency: 1.9, detail: 2, seed: 50 + i, scaleY: 0.75, uvScale: 1 }));
    for (let i = 0; i < 230; i++) {
      const a = noise.hash01(i, 1, 77) * Math.PI * 2;
      const r = 17 + Math.pow(noise.hash01(i, 2, 77), 0.7) * 70;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = hill(x, z);
      const kind = noise.hash01(i, 3, 77);
      const k = 0.6 + noise.hash01(i, 4, 77) * 1.1;
      if (kind < 0.3) {
        const rock = w.add(new Mesh3D(rocks[i % 4], m.rock));
        rock.position.set(x, y - 0.15, z);
        rock.scale.set(k * 1.2, k, k * 1.1);
        rock.rotation.y = a * 3;
      } else if (kind < 0.75) {
        const trunk = w.add(new Mesh3D(pineTrunk, m.bark));
        trunk.position.set(x, y + 0.8 * k, z);
        trunk.scale.set(k, k, k);
        pineCrown.forEach((g, j) => {
          const c = w.add(new Mesh3D(g, m.pine));
          c.position.set(x, y + (2.4 + j * 1.25) * k, z);
          c.scale.set(k, k, k);
        });
      } else {
        const b = w.add(new Mesh3D(bush[i % 3], i % 2 ? m.leaf : m.leafLight));
        b.position.set(x, y + 0.35 * k, z);
        b.scale.set(k, k, k);
      }
    }
  }
  /**
   * How the interface is laid out on this screen. On a laptop everything keeps its designed
   * size and place. On a touch screen `ui.minPoints` / `ui.tabletPoints` (blackiron.json) grow
   * the UI layer, so it is only about 830-980 units wide and 470-550 tall: text is raised to
   * 11 points, buttons to 44, the on-screen controls take the bottom corners and the courier's
   * panel moves up under the title.
   */
  private look() {
    const s = this.screenInfo;
    const touch = s.touch;
    // Points one UI unit shows at, after the engine grew the layer.
    const per = s.pointsPerUnit * (this.width / Math.max(1, this.uiWidth));
    const text = (size: number) => (touch ? Math.max(size, Math.ceil(11 / per - 1e-6)) : size);
    const tap = (size: number) => (touch ? Math.max(size, Math.ceil(44 / per - 1e-6)) : size);
    return { touch, text, tap, short: this.uiHeight < 640, compact: touch && s.compact };
  }
  private uiKey = "";
  private uiNodes: Node2D[] = [];
  private brand!: Anchor;
  private progress!: Anchor;
  private hull!: Anchor;
  private touchPad!: TouchControls;
  private touchUI = false;
  private shortUI = false;
  private keyOfUI(): string {
    const s = this.screenInfo;
    return `${Math.round(this.uiWidth)}x${Math.round(this.uiHeight)}:${s.touch}:${s.pointsPerUnit.toFixed(4)}`;
  }
  override onResize(): void {
    if (this.uiKey && this.uiKey !== this.keyOfUI()) this.buildUI();
  }
  /** Builds the HUD and the panels for the screen at hand; again when the screen changes. */
  private buildUI(): void {
    for (const n of this.uiNodes) n.destroy();
    this.uiNodes = [];
    this.hullBars.length = 0;
    this.uiKey = this.keyOfUI();
    const L = this.look();
    this.touchUI = L.touch;
    this.shortUI = L.short;
    const top = <T extends Node2D>(n: T): T => this.addTop(n);
    const brand = (this.brand = top(new Anchor({ x: "left", y: "top", safe: 34, safeArea: true })));
    const brandSub = new Label("COURTYARD 07  /  RECOVERY EXPEDITION", 61, 32, { font: { ...SMALL, size: L.text(11) }, color: 0x9fc8bd });
    const brandBox = brand.add(new Graphics2D());
    brand.add(new Graphics2D().roundedRect(0, 0, 44, 44, 8, 0x0f2c36).polygon([[22, 6], [34, 22], [22, 38], [10, 22]], 0xe5c47c));
    brand.add(new Label("LUMEN SALVAGE", 60, 0, { font: { ...UI, size: 26, weight: 700 }, color: 0xf3ead2 }));
    brand.add(brandSub);
    // Sizes follow the type size, not a measurement: the web font may still be loading here.
    const brandW = 360 + (L.text(11) - 11) * 12;
    const brandH = 68 + (L.text(11) - 11);
    brandBox.roundedRect(-12, -12, brandW, brandH, 12, { color: 0x173e49, alpha: 0.9 });
    const brandBottom = 34 - 12 + brandH;

    const a = L.text(11), b = L.text(10), d = a - 11;
    const progress = (this.progress = top(new Anchor({ x: "right", y: "top", w: 236, h: 98, safe: 30, safeArea: true })));
    const progressBox = progress.add(new Graphics2D());
    progress.add(new Label("ENERGY CORES RECOVERED", 18, 13, { font: { ...SMALL, size: a }, color: 0xb6d2c2 }));
    this.status = progress.add(new Label("00 / 06", 18, 31 + d, { font: { ...TITLE, size: 32 }, color: 0xf6d895 }));
    this.objective = progress.add(new Label("FIND THE SIX GOLDEN SIGNALS", 18, 74 + d, { font: { ...SMALL, size: b }, color: 0xc5ded1 }));
    progress.w = Math.max(236, 36 + Math.ceil(28 * b * 0.6));
    progress.h = 98 + d + (b - 10);
    progressBox.roundedRect(0, 0, progress.w, progress.h, 8, { color: 0x173e49, alpha: 0.94 });

    // The courier's panel: bottom left on a laptop. On a touch screen the stick lives there, so
    // the panel sits under the title.
    const e = L.text(12), v = L.text(9);
    const barsY = 22 + e + 4, viewY = barsY + 15, dashY = viewY + v + 9, hullH = dashY + v + 12;
    const hull = (this.hull = top(
      L.touch
        ? new Anchor({ x: "left", y: "top", w: 250, h: hullH, safe: 22, dy: brandBottom + 8 - 22, safeArea: true })
        : new Anchor({ x: "left", y: "bottom", w: 250, h: hullH, safe: 30 }),
    ));
    hull.add(new Graphics2D().roundedRect(0, 0, 250, hullH, 8, { color: 0x173e49, alpha: 0.94 }));
    this.energy = hull.add(new Label("COURIER INTEGRITY  /  3", 14, 10, { font: { ...SMALL, size: e }, color: 0xdbe6d6 }));
    for (let i = 0; i < 3; i++) {
      hull.add(new Graphics2D(14 + i * 75, barsY).rect(0, 0, 68, 6, 0x41626a));
      this.hullBars.push(hull.add(new Graphics2D(14 + i * 75, barsY).rect(0, 0, 68, 6, 0xb4e3c9)));
    }
    this.viewLabel = hull.add(new Label(this.viewText(), 14, viewY, { font: { ...SMALL, size: v }, color: 0xaecdc6 }));
    this.dashLabel = hull.add(new Label(this.dashText(0), 14, dashY, { font: { ...SMALL, size: v }, color: 0xe5d6a1 }));
    const dashBarY = Math.round(dashY + v / 2 + 1.5);
    hull.add(new Graphics2D(160, dashBarY).rect(0, 0, 72, 3, 0x41626a));
    this.dashFill = hull.add(new Graphics2D(160, dashBarY).rect(0, 0, 72, 3, 0xe5d6a1));

    // Keys are listed for a keyboard; the on-screen controls label themselves.
    if (!L.touch) {
      const foot = top(new Anchor({ x: "right", y: "bottom", safe: 36, dy: -8 }));
      foot.add(
        new Label(
          "WASD  Move    SPACE  Jump    SHIFT  Dash    Q / E  Orbit    V  View    ESC  Pause",
          0,
          0,
          { font: { ...SMALL, size: 12 }, color: 0xf3ead2, align: "right", shadow: 0x0b1d24 },
        ),
      );
    }
    // Notices: under the top panels on a laptop; on a touch screen in the clear strip above
    // the stick and the buttons.
    const notice = top(L.touch ? new Anchor({ x: "center", y: "bottom", dy: -168, safeArea: true }) : new Anchor({ x: "center", y: "top", dy: 110 }));
    const previous = this.notification?.text ?? "";
    this.notification = notice.add(new Label(previous, 0, 0, { font: UI, align: "center", color: 0x173e49, maxWidth: L.touch ? Math.max(200, this.uiWidth - 340) : 0 }));
    this.notification.alpha = Math.min(1, this.noticeTime * 3);
    this.intro = this.introPanel(L, brandBottom);
    this.pauseMenu = top(this.panel(L, "Taking a breather", "Your courier is safe here.", "RESUME", "pause"));
    this.winMenu = top(this.panel(L, "The light returns", "All six energy cores recovered. The courtyard is alive.", "PLAY AGAIN", "restart"));
    // The engine's touch buttons letter themselves in the 10-unit bitmap font, 8 points on a
    // phone. On a touch screen they are left blank and lettered here, in the game's face.
    const pad = [
      { action: "jump", label: "UP" },
      { action: "dash", label: "DASH" },
      ...(L.touch ? [{ action: "view", label: "VIEW" }] : []),
      { action: "pause", label: L.touch ? "PAUSE" : "II" },
    ];
    this.touchPad = top(
      new TouchControls({
        stick: { left: "left", right: "right", up: "up", down: "down" },
        buttons: L.touch ? pad.map((b) => ({ action: b.action, label: "" })) : pad,
        // A touch screen shows its controls from the first frame, not after the first tap.
        always: L.touch,
        size: PAD_SIZE,
      }),
    );
    if (L.touch) this.touchPad.add(new PadLabels(pad.map((b) => b.label), L.text(13)));
    this.showPanels();
  }
  /** Adds a top-level piece of the interface, remembered so a new screen can rebuild it. */
  private addTop<T extends Node2D>(n: T): T {
    this.uiNodes.push(n);
    return this.ui.add(n);
  }
  private viewText(): string {
    const view = `${this.orthographic ? "ORTHOGRAPHIC" : "PERSPECTIVE"} VIEW`;
    return this.touchUI ? view : `${view}  /  V TO SWITCH`;
  }
  private dashText(cooldown: number): string {
    const state = cooldown > 0 ? `${cooldown.toFixed(1)}s` : "READY";
    return this.touchUI ? `DASH  ${state}` : `SHIFT / DASH  ${state}`;
  }
  /**
   * Which panels show now. A short screen (a phone, a tablet) has no room for the HUD next to
   * a panel, so the intro hides the courier's panel and pause and victory hide the HUD.
   */
  private showPanels(): void {
    const intro = !this.started, modal = this.pausedFlag || this.state.won;
    this.intro.visible = intro;
    this.pauseMenu.visible = this.pausedFlag;
    this.winMenu.visible = this.state.won;
    this.brand.visible = this.progress.visible = !(this.shortUI && modal);
    this.hull.visible = !(this.shortUI && (intro || modal));
    if (this.touchUI) this.touchPad.visible = !intro && !modal;
    this.uiChanged();
  }
  private introPanel(L: ReturnType<SalvageScene["look"]>, brandBottom: number): Anchor {
    const button = { font: { ...UI, size: 17 }, fill: 0xe4d59e, text: 0x173c47, textShadow: null, hover: 0xffeabb, border: null, bevel: null };
    const hint = L.touch ? "DRAG ON THE LEFT TO MOVE   /   UP TO JUMP" : "ENTER TO BEGIN     /     SPACE TO JUMP";
    if (L.compact) {
      // A phone: wider and shorter, with the text set wide, in the room under the title.
      const w = Math.min(470, this.uiWidth - 80), inner = w - 48, small = L.text(12), bh = L.tap(48);
      const p = this.addTop(new Anchor({ x: "left", y: "top", safe: 22, w, h: 0, safeArea: true }));
      const box = p.add(new Graphics2D());
      p.add(new Label("RECOVERY EXPEDITION / 01", 24, 18, { font: { ...SMALL, size: small }, color: 0xaed4c3 }));
      p.add(new Label("Bring back", 24, 40, { font: { ...TITLE, size: 38 }, color: 0xe5ebe0 }));
      p.add(new Label("the light.", 24, 80, { font: { ...TITLE, size: 38 }, color: 0xf2d391 }));
      p.add(new Label("Six lost cores. One quiet courtyard. Leap over patrols\nand return the energy to the central beacon.", 24, 134, { font: { ...SMALL, size: 16 }, color: 0xb6cdc6, maxWidth: inner }));
      p.add(new Button("BEGIN SALVAGE", 24, 186, inner, bh, { action: "start", style: button }));
      p.add(new Label(hint, 24, 186 + bh + 12, { font: { ...SMALL, size: small }, color: 0x94bcb2, maxWidth: inner, minScale: 1 }));
      p.h = 186 + bh + 12 + small + 16;
      box.roundedRect(0, 0, w, p.h, 12, { color: 0x173b47, alpha: 0.97 }).rect(0, 0, w, 3, 0xe7c886);
      p.dy = Math.max(brandBottom + 8, Math.round(brandBottom + (this.uiHeight - brandBottom - p.h) / 2)) - 22;
      return p;
    }
    // On a short screen the panel sits in the middle of the room under the title.
    const p = this.addTop(L.short
      ? new Anchor({ x: "left", y: "top", safe: 64, w: 350, h: 368, safeArea: true, dy: Math.max(brandBottom + 8, Math.round(brandBottom + (this.uiHeight - brandBottom - 368) / 2)) - 64 })
      : new Anchor({ x: "left", y: "center", safe: 64, w: 350, h: 368 }));
    p.add(new Graphics2D().roundedRect(0, 0, 350, 368, 12, { color: 0x173b47, alpha: 0.97 }).rect(0, 0, 350, 3, 0xe7c886));
    p.add(new Label("RECOVERY EXPEDITION / 01", 28, 26, { font: { ...SMALL, size: 12 }, color: 0xaed4c3 }));
    p.add(new Label("Bring back", 28, 68, { font: { ...TITLE, size: 46 }, color: 0xe5ebe0 }));
    p.add(new Label("the light.", 28, 118, { font: { ...TITLE, size: 46 }, color: 0xf2d391 }));
    p.add(new Label("Six lost cores. One quiet courtyard.\nLeap over patrols and return the\nenergy to the central beacon.", 28, 187, { font: { ...SMALL, size: 16 }, color: 0xb6cdc6 }));
    p.add(new Button("BEGIN SALVAGE", 28, 278, 294, 48, { action: "start", style: button }));
    p.add(new Label(hint, 28, 342, { font: { ...SMALL, size: L.text(10) }, color: 0x94bcb2 }));
    return p;
  }
  private panel(
    L: ReturnType<SalvageScene["look"]>,
    title: string,
    sub: string,
    button: string,
    action: string,
  ): Anchor {
    const w = Math.min(680, Math.round(this.uiWidth - 80)), mid = w / 2, bh = L.tap(48);
    const h = 272 + (bh - 48);
    const p = new Anchor({ x: "center", y: "center", w, h });
    p.add(
      new Graphics2D().roundedRect(0, 0, w, h, 20, {
        color: 0x163b49,
        alpha: 0.96,
      }),
    );
    p.add(
      new Label("BLACKIRON  /  THE 3D COLLECTION", mid, 26, {
        font: SMALL,
        align: "center",
        color: 0x9acabc,
      }),
    );
    p.add(
      new Label(title, mid, 61, {
        font: TITLE,
        align: "center",
        color: 0xf8e4b6,
      }),
    );
    p.add(
      new Label(sub, mid, 135, {
        font: SMALL,
        align: "center",
        color: 0xe0e6d8,
      }),
    );
    p.add(
      new Button(button, mid - 150, 195, 300, bh, {
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
      this.viewLabel.text = this.viewText();
      this.uiChanged();
    } else if (name === "start" || (!this.started && name === "confirm")) {
      this.started = true;
      this.showPanels();
    } else if (name === "restart" || (this.state.won && name === "confirm"))
      this.app.scenes.change(new SalvageScene());
    else if (name === "pause" && this.started && !this.state.won) {
      this.pausedFlag = !this.pausedFlag;
      this.timeScale = this.pausedFlag ? 0 : 1;
      this.showPanels();
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
      this.beacon.emissiveIntensity = 2;
      this.showPanels();
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
    this.dashLabel.text = this.dashText(s.dashCooldown);
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
