import {
  Geometry3D,
  Material3D,
  Mesh3D,
  Node3D,
  PointLight3D,
  Texture3D,
  Vec3,
  type Scene3D,
  type PhysicsBackend3D,
  NavigationGrid3D,
} from "@blackiron-studio/engine/three";
import { Rng } from "@blackiron-studio/engine/core";
import { RELAYS, SOLIDS } from "./level.ts";
export const P = {
  chalk: 0xcbd0bd,
  light: 0xddd8bd,
  steel: 0x718c88,
  dark: 0x263d45,
  black: 0x142b34,
  orange: 0xef8147,
  cyan: 0x68f4d1,
  red: 0xff6854,
  ground: 0x627d79,
};
/** Game-specific art, exclusively constructed with engine geometry/material APIs. */
export class BreachArt {
  readonly cube: Geometry3D;
  readonly sphere: Geometry3D;
  readonly cylinder: Geometry3D;
  readonly ring: Geometry3D;
  private materials = new Map<string, Material3D>();
  readonly root: Node3D;
  readonly relays: Node3D[] = [];
  readonly relayLamps: Material3D[] = [];
  readonly rotor: Node3D;
  readonly panelTexture: Texture3D;
  readonly weaponRoot = new Node3D();
  readonly weaponModels: Node3D[] = [];
  readonly muzzle: Mesh3D;
  constructor(
    readonly scene: Scene3D,
    readonly physics: PhysicsBackend3D,
  ) {
    this.root = scene.world3D;
    this.cube = scene.resources.own(Geometry3D.beveledBox());
    this.sphere = scene.resources.own(Geometry3D.sphere(1, 12, 8));
    this.cylinder = scene.resources.own(Geometry3D.cylinder(1, 1, 16));
    this.ring = scene.resources.own(Geometry3D.torus(1, 0.055, 32, 6));
    const pixels = new Uint8Array(128 * 128 * 4),
      rng = new Rng(17);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const i = (y * 128 + x) * 4;
        const seam = x < 2 || y < 2 || y === 64;
        const n = seam ? 153 : 230 + rng.int(-6, 6);
        pixels.set([n, n, n, 255], i);
      }
    this.panelTexture = scene.resources.own(
      new Texture3D(128, 128, pixels, "linear", "repeat"),
    );
    for (const s of SOLIDS) {
      const color =
        s.kind === "floor"
          ? P.ground
          : s.kind === "cover"
            ? P.dark
            : s.kind === "wall"
              ? P.steel
              : s.kind === "step"
                ? P.chalk
                : P.light;
      const m = this.box(this.root, s.x, s.y, s.z, s.w, s.h, s.d, color);
      if (s.kind !== "cover") m.material = this.mat(color, false, true);
      physics.createBody({
        type: "fixed",
        position: { x: s.x, y: s.y, z: s.z },
        shape: { kind: "box", halfExtents: [s.w / 2, s.h / 2, s.d / 2] },
      });
      if (s.kind === "cover") {
        this.box(
          this.root,
          s.x,
          s.y + s.h / 2 + 0.06,
          s.z,
          s.w + 0.12,
          0.12,
          s.d + 0.12,
          P.chalk,
        );
        for (const side of [-1, 1]) {
          this.box(
            this.root,
            s.x + side * (s.w / 2 + 0.012),
            s.y,
            s.z,
            0.05,
            0.22,
            s.d * 0.7,
            P.orange,
          );
          for (let k = 0; k < 4; k++)
            this.box(
              this.root,
              s.x + side * (s.w / 2 + 0.04),
              s.y - 0.5 + k * 0.22,
              s.z,
              0.035,
              0.06,
              s.d * 0.45,
              P.steel,
            );
        }
      }
    }
    // Surface expansion joints, inset light lanes and painted docking lines.
    for (let z = -29; z < 25; z += 4) {
      this.box(this.root, 0, 0.014, z, 49, 0.022, 0.035, P.dark);
      for (const x of [-12, 12])
        this.box(this.root, x, 0.03, z, 0.065, 0.035, 2.2, P.cyan, true);
    }
    for (let x = -24; x < 25; x += 4)
      this.box(this.root, x, 0.016, -3, 0.025, 0.025, 56, P.dark);
    for (const s of [-1, 1]) {
      for (let z = -29; z < 26; z += 7) {
        this.box(this.root, s * 24.2, 3.4, z, 1.3, 6.8, 1.4, P.chalk);
        this.box(this.root, s * 23.48, 3.9, z, 0.09, 2.2, 0.16, P.cyan, true);
      }
      // Overhead spine with repeated structural ribs, open to the sky.
      this.box(this.root, s * 13, 8, -4, 1.1, 0.8, 54, P.dark);
      for (let z = -25; z < 22; z += 9) {
        this.box(this.root, s * 13, 4, z, 0.7, 8, 0.8, P.chalk);
        physics.createBody({
          type: "fixed",
          position: { x: s * 13, y: 4, z },
          shape: { kind: "box", halfExtents: [0.35, 4, 0.4] },
        });
        this.box(this.root, s * 13, 7.4, z, 1.8, 0.18, 1.1, P.orange);
      }
      // Gallery railings leave the staircase opening clear.
      for (const x of [s * 13.7, s * 22.3]) {
        this.box(this.root, x, 3.24, -10, 0.12, 0.1, 18, P.dark);
        this.box(this.root, x, 2.73, -10, 0.06, 0.06, 18, P.steel);
        for (let z = -18; z < 0; z += 3)
          this.box(this.root, x, 2.74, z, 0.1, 1.05, 0.1, P.dark);
      }
      this.box(this.root, s * 18, 2.23, -18.7, 8.7, 0.06, 0.16, P.orange);
      // Conduit banks against the outside walls.
      for (let k = 0; k < 3; k++)
        this.box(
          this.root,
          s * (23 - k * 0.26),
          1.2,
          -10,
          0.15,
          0.15,
          28,
          P.dark,
        );
      for (let i = 0; i < 6; i++) {
        this.box(
          this.root,
          s * 29,
          3 + (i % 3) * 2,
          -32 + i * 12,
          5,
          6 + (i % 3) * 4,
          5,
          P.steel,
        );
        this.box(
          this.root,
          s * 30,
          12 + (i % 4),
          -30 + i * 12,
          0.6,
          6,
          0.6,
          P.dark,
        );
      }
    }
    // Entry arch and long industrial skyline give the arena a recognizable silhouette.
    this.box(this.root, 0, 8.4, 23, 27, 1.1, 1.4, P.chalk);
    this.box(this.root, 0, 7.79, 22.9, 18, 0.12, 0.4, P.cyan, true);
    for (let i = 0; i < 9; i++) {
      this.box(
        this.root,
        -37 + i * 9,
        5 + (i % 4) * 2,
        -41,
        5,
        10 + (i % 4) * 4,
        6,
        i % 2 ? P.chalk : P.steel,
      );
    }
    // Central reactor: layered base, magnetic ring, rotating vanes and radiant core.
    this.mesh(this.root, this.cylinder, 0, 2.95, -5, 2.8, 0.3, 2.8, P.chalk);
    this.mesh(this.root, this.cylinder, 0, 4.4, -5, 1.3, 2.8, 1.3, P.black);
    this.mesh(
      this.root,
      this.cylinder,
      0,
      4.4,
      -5,
      0.7,
      2.95,
      0.7,
      P.cyan,
      true,
    );
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      this.box(
        this.root,
        Math.cos(a) * 1.5,
        4.3,
        -5 + Math.sin(a) * 1.5,
        0.24,
        3.4,
        0.24,
        P.chalk,
      );
    }
    for (const y of [3.1, 5.75]) {
      this.mesh(this.root, this.cylinder, 0, y, -5, 2.15, 0.3, 2.15, P.dark);
      this.mesh(
        this.root,
        this.ring,
        0,
        y + 0.16,
        -5,
        2.02,
        2.02,
        2.02,
        P.orange,
        true,
      );
    }
    this.rotor = this.root.add(new Node3D()).setPosition(0, 6.2, -5);
    for (let i = 0; i < 4; i++) {
      const vane = this.box(this.rotor, 0, 0, 0, 0.25, 0.5, 5.5, P.chalk);
      vane.rotation.y = (i * Math.PI) / 2;
    }
    this.root.add(new PointLight3D(P.cyan, 11, 11)).setPosition(0, 4, -5);
    // Relay consoles show progress with geometry and emissive rings.
    for (const [i, p] of RELAYS.entries()) {
      const node = this.root.add(new Node3D()).setPosition(p.x, p.y, p.z);
      this.relays.push(node);
      this.box(node, 0, 0.55, 0, 1.4, 1.1, 1.2, P.dark);
      this.box(node, 0, 1.14, 0, 1.65, 0.16, 1.4, P.chalk);
      const lamp = new Material3D({
        color: P.orange,
        emissive: P.orange,
        emissiveIntensity: 1.6,
      });
      this.relayLamps.push(lamp);
      const screen = node
        .add(new Mesh3D(this.cube, lamp))
        .setPosition(0, 1.31, 0)
        .setScale(0.9, 0.13, 0.7);
      screen.castShadow = false;
      this.mesh(node, this.ring, 0, 2.7, 0, 0.65, 0.65, 0.65, P.orange, true);
      for (let k = 0; k <= i; k++)
        this.box(node, -0.3 + k * 0.3, 0.65, 0.611, 0.12, 0.3, 0.025, P.chalk);
      physics.createBody({
        type: "fixed",
        position: { x: p.x, y: p.y + 0.6, z: p.z },
        shape: { kind: "box", halfExtents: [0.75, 0.6, 0.65] },
      });
    }
    // Side service ramp with real sloped triangle collision (rise 1.2m over 5m).
    const vertices = new Float32Array([
      -4, 0, 13, -1, 0, 13, -1, 1.2, 8, -4, 1.2, 8,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const ramp = scene.resources.own(
      new Geometry3D(
        vertices,
        new Float32Array([
          0, 0.972, 0.233, 0, 0.972, 0.233, 0, 0.972, 0.233, 0, 0.972, 0.233,
        ]),
        indices,
      ),
    );
    const rm = this.root.add(new Mesh3D(ramp, this.mat(P.orange)));
    rm.material.doubleSided = true;
    physics.createBody({
      type: "fixed",
      shape: { kind: "trimesh", vertices, indices },
    });
    this.box(this.root, -2.5, 0.6, 7, 3, 1.2, 2, P.dark);
    physics.createBody({
      type: "fixed",
      position: { x: -2.5, y: 0.6, z: 7 },
      shape: { kind: "box", halfExtents: [1.5, 0.6, 1] },
    });
    this.sign("07", 0, 1.35, -1.97, 1.5, 1.45, P.chalk, P.dark);
    this.sign("RELAY / 07", 0, 5, -31.42, 10, 2.5, P.chalk, P.dark);
    this.sign("WEST / 01", -18, 1.12, 1.03, 6.2, 0.65, P.dark, P.light);
    this.sign("EAST / 02", 18, 1.12, 1.03, 6.2, 0.65, P.dark, P.light);
    this.sign("HIGH VOLTAGE", -8, 0.97, 11.53, 2.8, 0.45, P.orange, P.dark);
    this.sign("RESTRICTED", 8, 0.97, 11.53, 2.8, 0.45, P.orange, P.dark);
    // Each weapon is a real first-person mesh model in the engine's depth layer.
    this.root.add(this.weaponRoot);
    for (let i = 0; i < 2; i++) {
      const gun = this.weaponRoot.add(new Node3D());
      this.weaponModels.push(gun);
      this.box(gun, 0, -0.04, -0.18, 0.21, 0.19, 0.57, P.dark);
      this.box(gun, 0, 0.045, -0.19, 0.225, 0.05, 0.51, P.chalk);
      this.box(gun, 0, -0.21, 0.03, 0.12, 0.28, 0.17, P.black).rotation.x =
        -0.2;
      this.box(gun, 0, -0.18, -0.19, 0.14, 0.23, 0.17, P.steel).rotation.x =
        0.12;
      if (i === 0) {
        this.box(gun, 0, 0.03, -0.55, 0.1, 0.095, 0.35, P.black);
        this.box(gun, 0, 0.13, -0.12, 0.095, 0.12, 0.14, P.dark);
        this.box(gun, 0, 0.15, -0.041, 0.061, 0.036, 0.008, P.cyan, true);
      } else {
        for (const x of [-0.075, 0.075])
          this.box(gun, x, 0, -0.48, 0.1, 0.11, 0.32, P.black);
        this.box(gun, 0, -0.035, -0.4, 0.25, 0.11, 0.17, P.orange);
      }
      this.box(gun, 0.109, 0, -0.2, 0.01, 0.055, 0.2, P.cyan, true);
      for (let k = 0; k < 5; k++)
        this.box(
          gun,
          0.112,
          -0.045,
          -0.34 + k * 0.05,
          0.013,
          0.045,
          0.012,
          P.steel,
        );
      this.box(gun, -0.02, -0.2, 0.22, 0.14, 0.14, 0.3, P.orange).rotation.x =
        -0.24;
      this.box(gun, -0.03, -0.13, 0.06, 0.14, 0.11, 0.17, P.black);
      gun.visible = i === 0;
    }
    this.muzzle = this.mesh(
      this.weaponRoot,
      this.sphere,
      0,
      0,
      -0.78,
      0.06,
      0.06,
      0.2,
      P.orange,
      true,
    );
    this.muzzle.visible = false;
    const flag = (n: Node3D) => {
      if (n instanceof Mesh3D) {
        n.renderLayer = "viewmodel";
        n.castShadow = n.receiveShadow = false;
        n.frustumCulled = false;
      }
      for (const c of n.children) if (c instanceof Node3D) flag(c);
    };
    flag(this.weaponRoot);
  }
  private sign(
    text: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    ink: number,
    background: number,
  ): void {
    const texture = this.scene.resources.own(
      Texture3D.fromText(text, {
        width: text.length < 4 ? 128 : 512,
        height: 128,
        size: text.length < 4 ? 100 : 55,
        color: ink,
        background,
      }),
    );
    const geometry = this.scene.resources.own(
      new Geometry3D(
        [-0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0],
        [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        [0, 1, 2, 0, 2, 3],
        [0, 0, 0, 1, 1, 1, 1, 0],
      ),
    );
    const mesh = this.root
      .add(
        new Mesh3D(
          geometry,
          new Material3D({
            map: texture,
            shading: "lambert",
            toneMapped: false,
            lambertAmbient: 0.4,
            lambertDiffuse: 0.5,
          }),
        ),
      )
      .setPosition(x, y, z)
      .setScale(w, h, 1);
    mesh.castShadow = false;
  }
  mat(color: number, glow = false, panel = false): Material3D {
    const key = `${color}/${glow}/${panel}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new Material3D({
        color,
        shading: glow ? "unlit" : "lambert",
        toneMapped: false,
        lambertAmbient: 0.32,
        lambertDiffuse: 0.6,
        roughness: 0.8,
        metallic: 0.12,
        emissive: glow ? color : 0,
        emissiveIntensity: glow ? 0.18 : 0,
        map: panel ? this.panelTexture : undefined,
      });
      this.materials.set(key, m);
    }
    return m;
  }
  mesh(
    parent: Node3D,
    g: Geometry3D,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number,
    glow = false,
  ): Mesh3D {
    return parent
      .add(new Mesh3D(g, this.mat(color, glow)))
      .setPosition(x, y, z)
      .setScale(w, h, d);
  }
  box(
    parent: Node3D,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: number,
    glow = false,
  ): Mesh3D {
    return this.mesh(parent, this.cube, x, y, z, w, h, d, color, glow);
  }
  drone(heavy: boolean): { root: Node3D; core: Mesh3D; rotor: Node3D } {
    const root = this.root.add(new Node3D()),
      rotor = root.add(new Node3D());
    this.mesh(
      root,
      this.sphere,
      0,
      0,
      0,
      0.66,
      0.43,
      0.54,
      heavy ? P.dark : P.chalk,
    );
    this.box(root, 0, 0, -0.4, 0.62, 0.18, 0.25, P.black);
    const core = this.mesh(
      root,
      this.sphere,
      0,
      0,
      -0.56,
      0.22,
      0.12,
      0.08,
      P.red,
      true,
    );
    for (const s of [-1, 1]) {
      this.box(
        root,
        s * 0.75,
        -0.06,
        0,
        0.65,
        0.19,
        0.48,
        heavy ? P.orange : P.steel,
      );
      this.mesh(rotor, this.ring, s * 0.93, 0.12, 0, 0.36, 0.36, 0.36, P.dark);
      this.box(root, s * 0.76, -0.35, -0.1, 0.12, 0.4, 0.18, P.black);
    }
    this.box(root, 0, 0.39, 0.1, 0.06, 0.32, 0.06, P.black);
    this.mesh(
      root,
      this.sphere,
      0,
      0.57,
      0.1,
      0.075,
      0.075,
      0.075,
      P.red,
      true,
    );
    return { root, core, rotor };
  }
  navigation(): NavigationGrid3D {
    return new NavigationGrid3D(48, 56, 1, -24, -31, (x, z) => {
      for (const s of SOLIDS)
        if (
          s.kind !== "floor" &&
          Math.abs(x - s.x) < s.w / 2 + 0.8 &&
          Math.abs(z - s.z) < s.d / 2 + 0.8
        )
          return null;
      if (x > -5 && x < 0 && z > 5 && z < 14) return null;
      for (const sign of [-1, 1])
        for (let rz = -25; rz < 22; rz += 9)
          if (Math.abs(x - sign * 13) < 1.15 && Math.abs(z - rz) < 1.2)
            return null;
      for (const p of RELAYS)
        if (Math.hypot(x - p.x, z - p.z) < 1.5) return null;
      return 0;
    });
  }
}
