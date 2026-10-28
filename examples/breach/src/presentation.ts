import {
  Geometry3D,
  Material3D,
  Mesh3D,
  Node3D,
  PointLight3D,
  Texture3D,
  SkyDome3D,
  skyTexture,
  surface,
  heightToNormal,
  terrainGeometry,
  computeNormals,
  type SurfaceKind,
  type Material3DOptions,
  type SurfaceOptions,
  type SurfaceTextures,
  type Scene3D,
  type PhysicsBackend3D,
  NavigationGrid3D,
} from "@blackiron-studio/engine/three";
import { noise } from "@blackiron-studio/engine/art";
import { RELAYS, SOLIDS } from "./level.ts";

/** Palette shared by the world and the HUD: storm slate, station cyan, relay amber. */
export const P = {
  chalk: 0xe9e6da,
  light: 0xd6d2c4,
  steel: 0x7d8c95,
  dark: 0x1c2831,
  black: 0x0a1016,
  orange: 0xff8a3d,
  amber: 0xffb347,
  cyan: 0x5ff3d8,
  red: 0xff4b3e,
  ground: 0x4f5559,
  hazard: 0xe8ac2a,
};

// ------------------------------------------------------------------ baked surface cache
// Textures are baked once per process and shared by every BreachScene (restarts are instant).
// They are never handed to scene.resources, so a scene teardown does not dispose them.

type Texel = { h: number; c: [number, number, number]; r: number; m: number };
const baked = new Map<string, SurfaceTextures>();
let sky: Texture3D | undefined;

function bake(key: string, size: number, bump: number, fn: (u: number, v: number) => Texel): SurfaceTextures {
  let s = baked.get(key);
  if (s) return s;
  const n = size * size,
    height = new Float32Array(n),
    albedo = new Uint8Array(n * 4),
    mr = new Uint8Array(n * 4),
    b = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const t = fn((x + 0.5) / size, (y + 0.5) / size),
        i = y * size + x;
      height[i] = t.h;
      albedo.set([b(t.c[0]), b(t.c[1]), b(t.c[2]), 255], i * 4);
      mr.set([255, b(t.r), b(t.m), 255], i * 4);
    }
  const tex = (d: Uint8Array) => new Texture3D(size, size, d, "linear", "repeat", "repeat", "linear-mipmap-linear");
  s = {
    map: tex(albedo),
    normalMap: tex(heightToNormal(height, size, size, bump)),
    metallicRoughnessMap: tex(mr),
    material: { roughness: 1, metallic: 1 },
  };
  baked.set(key, s);
  return s;
}

function baseSurface(key: string, kind: SurfaceKind, o: SurfaceOptions): SurfaceTextures {
  let s = baked.get(key);
  if (!s) baked.set(key, (s = surface(kind, o)));
  return s;
}

const frac = (v: number) => v - Math.floor(v);
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Diagonal safety stripes: chipped yellow paint over dark steel. */
const hazardSurface = () =>
  bake("hazard", 256, 3, (u, v) => {
    const stripe = frac((u + v) * 2) < 0.5 ? 1 : 0;
    const wearN = noise.fbm(u * 6, v * 6, { seed: 41, octaves: 5, period: 6 }) * 0.5 + 0.5;
    const chip = noise.smoothstep(0.68, 0.74, wearN);
    const grime = noise.fbm(u * 3, v * 3, { seed: 43, octaves: 4, period: 3 }) * 0.5 + 0.5;
    const grain = noise.perlin(u * 96, v * 96, 44, 96) * 0.04;
    let c: [number, number, number] = stripe > 0.5 ? [0.86, 0.6, 0.12] : [0.07, 0.075, 0.08];
    c = mix(c, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], grime * 0.5);
    c = mix(c, [0.36, 0.37, 0.38], chip);
    return { h: 0.6 - chip * 0.25 + grain, c: [c[0] + grain, c[1] + grain, c[2] + grain], r: 0.55 + grime * 0.25 - chip * 0.2, m: chip * 0.9 };
  });

/** Open steel floor grating with dark voids below. */
const grateSurface = () =>
  bake("grate", 256, 4, (u, v) => {
    const n = 10,
      fx = frac(u * n),
      fy = frac(v * n * 2),
      bar = Math.max(noise.smoothstep(0.24, 0.16, Math.min(fx, 1 - fx) * 2), noise.smoothstep(0.3, 0.2, Math.min(fy, 1 - fy) * 2));
    const grime = noise.fbm(u * 4, v * 4, { seed: 51, octaves: 4, period: 4 }) * 0.5 + 0.5;
    const brush = noise.perlin(u * 4, v * 128, 52, 4) * 0.05;
    const metal: [number, number, number] = mix([0.42, 0.44, 0.46], [0.22, 0.21, 0.2], grime * 0.7);
    const c = mix([0.015, 0.017, 0.02], [metal[0] + brush, metal[1] + brush, metal[2] + brush], bar);
    return { h: bar, c, r: bar > 0.5 ? 0.38 + grime * 0.35 : 0.95, m: bar * (0.9 - grime * 0.4) };
  });

/** Wind-driven sea swell for the ocean normal map. */
const oceanSurface = () =>
  bake("ocean", 256, 1.6, (u, v) => {
    const h = noise.fbm(u * 5, v * 5, { seed: 61, octaves: 5, period: 5 }) * 0.6 + noise.ridged(u * 3, v * 9, { seed: 62, octaves: 3, period: 3 }) * 0.3;
    return { h, c: [0.05, 0.08, 0.1], r: 0.1, m: 0 };
  });

const SURFACES = {
  floor: () => baseSurface("floor", "tiles", { color: "#6a7074", accent: "#3b4044", repeat: 2, size: 512, wear: 0.45, variation: 0.16, seed: 3 }),
  concrete: () => baseSurface("concrete", "concrete", { color: "#86857f", accent: "#46443f", size: 512, wear: 0.6, seed: 5 }),
  darkConcrete: () => baseSurface("darkConcrete", "concrete", { color: "#4f555b", accent: "#25282c", size: 256, wear: 0.5, seed: 9 }),
  panel: () => baseSurface("panel", "metal", { color: "#5a6873", accent: "#1f262c", repeat: 2, size: 256, wear: 0.5, seed: 11 }),
  bare: () => baseSurface("bare", "metal", { color: "#8b9198", accent: "#30353a", repeat: 1, size: 256, wear: 0.35, seed: 13 }),
  hex: () => baseSurface("hex", "hex", { color: "#2b3946", accent: "#0b1115", repeat: 4, size: 256, seed: 15 }),
};

// ------------------------------------------------------------------ geometry helpers

/** Box-projected UVs at `scale` repeats per world unit, for any local positions/normals. */
function boxUV(p: ArrayLike<number>, n: ArrayLike<number>, s: number): number[] {
  const uv: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const ax = Math.abs(n[i]),
      ay = Math.abs(n[i + 1]),
      az = Math.abs(n[i + 2]);
    if (ay >= ax && ay >= az) uv.push(p[i] * s, p[i + 2] * s);
    else if (ax >= az) uv.push(p[i + 2] * s, p[i + 1] * s);
    else uv.push(p[i] * s, p[i + 1] * s);
  }
  return uv;
}

/** A tube along a polyline (pipes, cables), UV'd along its length. */
function tubeGeometry(points: [number, number, number][], r: number, sides = 6): Geometry3D {
  const pos: number[] = [],
    nor: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)],
      b = points[Math.min(points.length - 1, i + 1)];
    let tx = b[0] - a[0],
      ty = b[1] - a[1],
      tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // Side vector perpendicular to the tangent and world up (or X for vertical runs).
    let ux = 0,
      uy = 1,
      uz = 0;
    if (Math.abs(ty) > 0.9) {
      ux = 1;
      uy = 0;
    }
    let sx = ty * uz - tz * uy,
      sy = tz * ux - tx * uz,
      sz = tx * uy - ty * ux;
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl;
    sy /= sl;
    sz /= sl;
    const bx = sy * tz - sz * ty,
      by = sz * tx - sx * tz,
      bz = sx * ty - sy * tx;
    if (i > 0) {
      const p = points[i - 1];
      along += Math.hypot(points[i][0] - p[0], points[i][1] - p[1], points[i][2] - p[2]);
    }
    for (let k = 0; k <= sides; k++) {
      const t = (k / sides) * Math.PI * 2,
        c = Math.cos(t),
        s = Math.sin(t),
        nx = sx * c + bx * s,
        ny = sy * c + by * s,
        nz = sz * c + bz * s;
      pos.push(points[i][0] + nx * r, points[i][1] + ny * r, points[i][2] + nz * r);
      nor.push(nx, ny, nz);
      uv.push(along * 2, (k / sides) * Math.PI * 2 * r * 2);
    }
  }
  for (let i = 0; i < points.length - 1; i++)
    for (let k = 0; k < sides; k++) {
      const a = i * (sides + 1) + k,
        b = a + sides + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return new Geometry3D(pos, nor, idx, uv);
}

const catenary = (a: [number, number, number], b: [number, number, number], sag: number, n = 14): [number, number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
  });

/** Game-specific art, exclusively constructed with engine geometry/material APIs. */
export class BreachArt {
  readonly cube: Geometry3D;
  readonly sphere: Geometry3D;
  readonly cylinder: Geometry3D;
  readonly ring: Geometry3D;
  private materials = new Map<string, Material3D>();
  private boxes = new Map<string, Geometry3D>();
  private cylinders = new Map<string, Geometry3D>();
  readonly root: Node3D;
  readonly relays: Node3D[] = [];
  readonly relayLamps: Material3D[] = [];
  readonly relayLights: PointLight3D[] = [];
  readonly relayBeams: Mesh3D[] = [];
  readonly rotor: Node3D;
  readonly beacons: Mesh3D[] = [];
  readonly weaponRoot = new Node3D();
  readonly weaponModels: Node3D[] = [];
  readonly muzzle: Mesh3D;
  readonly muzzleLight: PointLight3D;
  readonly s: Record<string, Material3D>;
  constructor(
    readonly scene: Scene3D,
    readonly physics: PhysicsBackend3D,
  ) {
    this.root = scene.world3D;
    const own = <T extends Geometry3D>(g: T) => scene.resources.own(g);
    this.cube = own(Geometry3D.beveledBox());
    this.sphere = own(Geometry3D.sphere(1, 20, 14));
    this.cylinder = own(Geometry3D.cylinder(1, 1, 24));
    this.ring = own(Geometry3D.torus(1, 0.055, 40, 8));
    const surf = this.surf;
    this.s = {
      floor: surf(SURFACES.floor(), { roughness: 0.95 }),
      concrete: surf(SURFACES.concrete()),
      darkConcrete: surf(SURFACES.darkConcrete()),
      panel: surf(SURFACES.panel(), { metallic: 0.3, roughness: 0.95 }),
      panelOrange: surf(SURFACES.panel(), { metallic: 0.35, color: 0xd9824a }),
      bare: surf(SURFACES.bare(), { metallic: 0.7, roughness: 0.85 }),
      hex: surf(SURFACES.hex(), { metallic: 0.8, roughness: 0.9 }),
      grate: surf(grateSurface(), { metallic: 0.75 }),
      hazard: surf(hazardSurface()),
      ocean: surf(oceanSurface(), { metallic: 0, roughness: 0.14, color: 0x9fb3c0 }),
    };
    const s = this.s,
      root = this.root;

    // ------------------------------------------------------------ sky, sea and horizon
    sky ??= skyTexture({
        zenith: "#0d1420",
        horizon: "#6d6577",
        ground: "#10171f",
        sunDirection: { x: -0.78, y: 0.46, z: -0.42 },
        sunColor: "#ff9a52",
        sunSize: 1.4,
        sunGlow: 0.75,
        clouds: 0.68,
        cloudColor: "#3c4252",
        stars: 0,
        seed: 21,
        resolution: 1024,
      });
    root.add(new SkyDome3D(scene.camera3D, sky));
    const sea = root.add(new Mesh3D(own(terrainGeometry({ width: 700, depth: 700, segments: 2, uvScale: 0.035 })), s.ocean)).setPosition(0, -14, 0);
    sea.castShadow = sea.receiveShadow = false;

    // ------------------------------------------------------------ authored solids
    for (const so of SOLIDS) {
      if (so.kind === "floor") this.tbox(root, so.x, so.y, so.z, so.w, so.h, so.d, s.floor, 0.25, 0);
      else if (so.kind === "wall") this.tbox(root, so.x, so.y, so.z, so.w, so.h, so.d, s.concrete, 0.22, 0);
      else if (so.kind === "platform") {
        this.tbox(root, so.x, so.y, so.z, so.w, so.h, so.d, s.concrete, 0.3, 0.04);
        this.tbox(root, so.x, so.y + so.h / 2 + 0.012, so.z, so.w - 0.16, 0.024, so.d - 0.16, s.grate, 0.5, 0);
      } else if (so.kind === "step") {
        this.tbox(root, so.x, so.y, so.z, so.w, so.h, so.d, s.panel, 0.5, 0.015);
        this.tbox(root, so.x, so.y + so.h / 2 + 0.006, so.z + so.d / 2 - 0.06, so.w - 0.1, 0.012, 0.1, s.hazard, 1.2, 0);
      }
      physics.createBody({
        type: "fixed",
        position: { x: so.x, y: so.y, z: so.z },
        shape: { kind: "box", halfExtents: [so.w / 2, so.h / 2, so.d / 2] },
      });
      if (so.kind === "cover") this.barrier(so.x, so.y, so.z, so.w, so.h, so.d);
    }

    // Floor dressing: guide-light lanes, painted walkways and safety borders.
    for (let z = -29; z < 25; z += 4)
      for (const x of [-12, 12]) {
        this.box(root, x, 0.012, z, 0.12, 0.02, 1.6, P.cyan, true).castShadow = false;
      }
    for (const x of [-11.4, 11.4, -12.6, 12.6]) this.paint(x, -3, 0.09, 54, 0xc9c3b1);
    this.hazardFrame(0, -5, 7.4, 7.4, 0.42);
    for (const p of RELAYS) if (p.y < 1) this.hazardFrame(p.x, p.z, 3.4, 3.2, 0.3);
    this.paint(0, 19.5, 6, 0.18, 0xc9c3b1);
    this.paint(0, 17.5, 6, 0.18, 0xc9c3b1);

    // ------------------------------------------------------------ perimeter walls
    for (const sg of [-1, 1]) {
      const fx = sg * 24.5;
      // Kick plates, a hazard band and a high LED strip on both long walls.
      this.tbox(root, fx - sg * 0.05, 0.35, -3, 0.1, 0.7, 56, s.panel, 0.5, 0);
      this.tbox(root, fx - sg * 0.06, 0.79, -3, 0.08, 0.18, 56, s.hazard, 1, 0);
      this.box(root, fx - sg * 0.04, 5.72, -3, 0.06, 0.06, 56, 0xbfe9ff, true).castShadow = false;
      for (let z = -29; z < 26; z += 7) {
        this.tbox(root, sg * 24.2, 3.4, z, 1.3, 6.8, 1.4, s.darkConcrete, 0.3, 0.04);
        this.tbox(root, sg * 23.52, 3.4, z, 0.08, 6.4, 0.9, s.bare, 0.5, 0.01);
        this.box(root, sg * 23.46, 3.9, z, 0.06, 2.4, 0.12, P.cyan, true).castShadow = false;
        this.tbox(root, sg * 23.5, 0.5, z, 0.12, 1, 1.5, s.hazard, 1, 0);
      }
      // Wall-mounted pipe runs, clamped at every pilaster.
      for (const [y, r] of [
        [5.05, 0.13],
        [5.4, 0.09],
        [4.75, 0.06],
      ] as const) {
        const pipe = root.add(new Mesh3D(own(tubeGeometry([[sg * 24.25, y, -31], [sg * 24.25, y, 25]], r, 10)), y === 5.05 ? s.panelOrange : s.bare));
        pipe.castShadow = false;
      }
      // Overhead spine with repeated structural ribs, an LED underside and sagging cables.
      this.tbox(root, sg * 13, 8, -4, 1.1, 0.8, 54, s.panel, 0.5, 0.03);
      this.box(root, sg * 13, 7.58, -4, 0.2, 0.04, 53, 0xd6f6ff, true).castShadow = false;
      const pillars = [-25, -16, -7, 2, 11, 20];
      for (const z of pillars) {
        this.tbox(root, sg * 13, 4, z, 0.7, 8, 0.8, s.concrete, 0.35, 0.03);
        this.tbox(root, sg * 13, 0.45, z, 0.9, 0.9, 1, s.hazard, 1, 0.02);
        physics.createBody({
          type: "fixed",
          position: { x: sg * 13, y: 4, z },
          shape: { kind: "box", halfExtents: [0.35, 4, 0.4] },
        });
        this.tbox(root, sg * 13, 7.4, z, 1.8, 0.18, 1.1, s.panelOrange, 0.5, 0.02);
        this.box(root, sg * 13, 7.28, z, 1.2, 0.04, 0.12, P.amber, true).castShadow = false;
      }
      for (let i = 0; i < pillars.length - 1; i++)
        for (const off of [-0.35, 0.35]) {
          const c = root.add(new Mesh3D(own(tubeGeometry(catenary([sg * 13 + off, 7.55, pillars[i]], [sg * 13 + off, 7.55, pillars[i + 1]], 0.55 + (off > 0 ? 0.25 : 0)), 0.03, 5)), this.mat(0x111417)));
          c.castShadow = false;
        }
      // Gallery railings leave the staircase opening clear.
      for (const x of [sg * 13.7, sg * 22.3]) {
        this.tbox(root, x, 3.24, -10, 0.1, 0.08, 18, s.hazard, 1.4, 0.01);
        this.box(root, x, 2.73, -10, 0.05, 0.05, 18, 0x2b3238);
        for (let z = -18; z < 0; z += 3) this.box(root, x, 2.74, z, 0.08, 1.05, 0.08, 0x2b3238);
      }
      this.tbox(root, sg * 18, 2.23, -18.7, 8.7, 0.06, 0.16, s.hazard, 1.4, 0);
      // Conduit banks against the outside walls.
      for (let k = 0; k < 3; k++) {
        const x = sg * (23 - k * 0.26);
        const pipe = root.add(new Mesh3D(own(tubeGeometry([[x, 1.2, -24], [x, 1.2, 4]], 0.075, 8)), k === 1 ? s.panelOrange : s.bare));
        pipe.castShadow = false;
        for (let z = -22; z < 4; z += 4) this.box(root, x, 1.2, z, 0.2, 0.2, 0.08, 0x22282d);
      }
      // Outer service towers rising behind the walls: concrete cores, lit floors, antennas.
      for (let i = 0; i < 6; i++) {
        const h = 6 + (i % 3) * 4,
          y = 3 + (i % 3) * 2,
          z = -32 + i * 12;
        this.tbox(root, sg * 29, y, z, 5, h, 5, s.darkConcrete, 0.25, 0.05);
        this.tbox(root, sg * 29, y + h / 2 + 0.25, z, 5.3, 0.5, 5.3, s.panel, 0.5, 0.03);
        for (let f = 6.6; f < y + h / 2 - 0.4; f += 1.6)
          this.box(root, sg * 26.47, f, z, 0.05, 0.16, 3.8, (i + Math.round(f)) % 3 ? 0xffc77d : 0x9fe9ff, true).castShadow = false;
        const mh = 6;
        this.mesh(root, this.cylinder, sg * 30, 12 + (i % 4), -30 + i * 12, 0.12, mh, 0.12, 0x2a3036);
        this.beacon(sg * 30, 12 + (i % 4) + mh / 2 + 0.15, -30 + i * 12);
      }
    }

    // ------------------------------------------------------------ north wall and entry arch
    this.tbox(root, 0, 7.3, -31.4, 50, 0.3, 0.3, s.panelOrange, 0.5, 0.02);
    this.box(root, 0, 7.1, -31.3, 48, 0.05, 0.05, P.amber, true).castShadow = false;
    for (const x of [-20, -10, 10, 20]) {
      this.tbox(root, x, 3.6, -31.2, 1.6, 7.2, 0.6, s.darkConcrete, 0.3, 0.03);
      this.box(root, x, 3.6, -30.88, 0.08, 4, 0.04, P.cyan, true).castShadow = false;
    }
    this.tbox(root, 0, 3.6, -31.35, 12, 4.2, 0.3, s.hex, 0.5, 0.02);
    this.tbox(root, 0, 8.4, 23, 27, 1.1, 1.4, s.concrete, 0.3, 0.05);
    this.tbox(root, 0, 7.82, 23, 26.6, 0.06, 1.2, s.hazard, 1, 0);
    this.box(root, 0, 7.77, 22.9, 18, 0.08, 0.3, 0xd6f6ff, true).castShadow = false;
    for (const x of [-13.2, 13.2]) this.tbox(root, x, 3.9, 23, 1.0, 7.8, 1.2, s.concrete, 0.35, 0.04);
    // Skyline: refinery blocks, lit floors and radio masts fading into the storm.
    for (let i = 0; i < 9; i++) {
      const h = 10 + (i % 4) * 4,
        x = -37 + i * 9,
        y = 5 + (i % 4) * 2;
      this.tbox(root, x, y, -41, 5, h, 6, i % 2 ? s.darkConcrete : s.panel, 0.25, 0.05);
      for (let f = y - h / 2 + 2; f < y + h / 2 - 1; f += 1.7)
        if ((i * 7 + f * 3) % 5 > 1.2) this.box(root, x, f, -37.95, 3.8, 0.14, 0.05, (i + Math.floor(f)) % 4 ? 0xffc77d : 0x9fe9ff, true).castShadow = false;
      if (i % 3 === 1) {
        this.mesh(root, this.cylinder, x + 1.2, y + h / 2 + 3, -41, 0.09, 6, 0.09, 0x2a3036);
        this.beacon(x + 1.2, y + h / 2 + 6.1, -41);
      }
      if (i % 3 === 0) for (let k = 0; k < 3; k++) this.tbox(root, x - 1.2 + k * 1.2, y + h / 2 + 0.6, -41, 0.8, 1.2, 0.8, s.bare, 0.5, 0.05);
    }
    for (const [x, z, h] of [
      [-46, -72, 46],
      [38, -66, 38],
      [70, -10, 30],
      [-72, 6, 34],
    ] as const) {
      this.mesh(root, this.cylinder, x, h / 2 - 8, z, 0.7, h, 0.7, 0x20262c);
      this.mesh(root, this.cylinder, x, h / 2 - 8, z, 2.2, 0.3, 2.2, 0x20262c).position.y = h * 0.62 - 8;
      this.beacon(x, h - 7.6, z, 0.35);
    }
    // Station legs plunging into the sea, only visible from the gallery and the title view.
    for (const x of [-22, 22]) for (const z of [-28, 22]) this.mesh(root, this.cylinder, x * 1.15, -7.5, z * 1.1, 2.4, 13, 2.4, 0x3a3f44);

    // ------------------------------------------------------------ central reactor
    this.mesh(root, this.cylinder, 0, 2.86, -5, 2.8, 0.32, 2.8, 0x2a3138);
    this.tcyl(root, 0, 2.86, -5, 2.6, 0.34, s.hex, 0.6);
    this.mesh(root, this.cylinder, 0, 4.4, -5, 0.62, 2.95, 0.62, P.cyan, true).castShadow = false;
    const glass = this.mesh(root, this.cylinder, 0, 4.4, -5, 0.95, 2.9, 0.95, 0x9ff5ff);
    glass.material = new Material3D({ color: 0x8fe8f0, roughness: 0.08, metallic: 0, opacity: 0.22, alphaMode: "BLEND", emissive: 0x2a8f88, emissiveIntensity: 0.25 });
    glass.castShadow = false;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      this.tbox(root, Math.cos(a) * 1.15, 4.3, -5 + Math.sin(a) * 1.15, 0.22, 3.4, 0.22, s.bare, 0.6, 0.02).rotation.y = -a;
    }
    for (const y of [3.1, 5.75]) {
      this.tcyl(root, 0, y, -5, 1.55, 0.3, s.panel, 0.6);
      this.mesh(root, this.ring, 0, y + 0.17, -5, 1.45, 1.45, 1.45, P.orange, true).castShadow = false;
    }
    this.rotor = root.add(new Node3D()).setPosition(0, 6.2, -5);
    for (let i = 0; i < 4; i++) {
      const vane = this.tbox(this.rotor, 0, 0, 0, 0.25, 0.5, 5.5, s.panelOrange, 0.6, 0.03);
      vane.rotation.y = (i * Math.PI) / 2;
    }
    this.mesh(this.rotor, this.cylinder, 0, 0, 0, 0.45, 0.7, 0.45, 0x22282e);

    // ------------------------------------------------------------ relay consoles
    for (const [i, p] of RELAYS.entries()) {
      const node = root.add(new Node3D()).setPosition(p.x, p.y, p.z);
      this.relays.push(node);
      this.tbox(node, 0, 0.55, 0, 1.4, 1.1, 1.2, s.panel, 0.6, 0.04);
      this.tbox(node, 0, 1.14, 0, 1.65, 0.16, 1.4, s.bare, 0.6, 0.03);
      this.tbox(node, 0, 0.08, 0, 1.6, 0.16, 1.4, s.hazard, 1, 0.02);
      const lamp = new Material3D({ color: P.amber, emissive: P.amber, emissiveIntensity: 0.25, shading: "unlit", toneMapped: false });
      this.relayLamps.push(lamp);
      const screen = node.add(new Mesh3D(this.cube, lamp)).setPosition(0, 1.31, 0).setScale(0.9, 0.13, 0.7);
      screen.castShadow = false;
      this.mesh(node, this.ring, 0, 2.7, 0, 0.65, 0.65, 0.65, P.orange, true).castShadow = false;
      const beam = this.mesh(node, this.cylinder, 0, 2.05, 0, 0.05, 1.3, 0.05, P.amber, true);
      beam.castShadow = false;
      this.relayBeams.push(beam);
      for (const sx of [-0.62, 0.62]) this.mesh(node, this.cylinder, sx, 1.95, 0, 0.035, 1.5, 0.035, 0x2a3036);
      this.box(node, 0, 2.7, 0, 1.3, 0.04, 0.04, 0x2a3036);
      for (let k = 0; k <= i; k++) this.box(node, -0.3 + k * 0.3, 0.65, 0.611, 0.12, 0.3, 0.025, P.chalk, true).castShadow = false;
      const light = node.add(new PointLight3D(P.amber, 14, 8)).setPosition(0, 2.2, 0.6);
      this.relayLights.push(light);
      physics.createBody({
        type: "fixed",
        position: { x: p.x, y: p.y + 0.6, z: p.z },
        shape: { kind: "box", halfExtents: [0.75, 0.6, 0.65] },
      });
    }

    // ------------------------------------------------------------ ramp
    const vertices = new Float32Array([-4, 0, 13, -1, 0, 13, -1, 1.2, 8, -4, 1.2, 8]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const ramp = own(
      new Geometry3D(
        vertices,
        new Float32Array([0, 0.972, 0.233, 0, 0.972, 0.233, 0, 0.972, 0.233, 0, 0.972, 0.233]),
        indices,
        [-4 * 0.5, 0, -1 * 0.5, 0, -1 * 0.5, 2.57, -4 * 0.5, 2.57],
      ),
    );
    root.add(new Mesh3D(ramp, this.surf(grateSurface(), { metallic: 0.75, doubleSided: true })));
    physics.createBody({ type: "fixed", shape: { kind: "trimesh", vertices, indices } });
    const rampSide = this.surf(SURFACES.panel(), { metallic: 0.55, roughness: 0.95, doubleSided: true });
    for (const x of [-4.05, -0.95]) {
      const sp = [x, 0, 13, x, 1.2, 8, x, 0, 8],
        side = own(new Geometry3D(sp, computeNormals(sp, [0, 1, 2]), [0, 1, 2], [13 * 0.4, 0, 8 * 0.4, 1.2 * 0.4, 8 * 0.4, 0]));
      root.add(new Mesh3D(side, rampSide));
      const len = Math.hypot(5, 1.2),
        rail = this.tbox(root, x, 0.66, 10.5, 0.1, 0.08, len, s.hazard, 1.4, 0);
      rail.rotation.x = Math.atan2(1.2, 5);
    }
    this.tbox(root, -2.5, 0.6, 7, 3, 1.2, 2, s.panel, 0.5, 0.03);
    this.tbox(root, -2.5, 1.212, 7, 2.9, 0.024, 1.9, s.grate, 0.5, 0);
    physics.createBody({
      type: "fixed",
      position: { x: -2.5, y: 0.6, z: 7 },
      shape: { kind: "box", halfExtents: [1.5, 0.6, 1] },
    });

    // ------------------------------------------------------------ props
    // Cargo crates and barrels stacked outside the playable floor and on the wall walk.
    const crate = (x: number, y: number, z: number, w: number, h: number, d: number, painted: boolean, ry = 0) => {
      const c = this.tbox(root, x, y + h / 2, z, w, h, d, painted ? s.panelOrange : s.panel, 0.7, 0.04);
      c.rotation.y = ry;
      const band = this.tbox(root, x, y + h * 0.82, z, w + 0.04, 0.12, d + 0.04, s.hazard, 1.6, 0);
      band.rotation.y = ry;
    };
    crate(-30, 0, 27, 2.4, 2.4, 2.4, true, 0.1);
    crate(-30, 2.4, 27, 2.2, 2, 2.2, false, -0.2);
    crate(-27, 0, 29, 2.4, 2.4, 4.6, false);
    crate(31, 0, 25, 2.4, 2.4, 2.4, false, -0.3);
    crate(26, 6, -31, 1.4, 1.4, 1.4, true, 0.2);
    crate(-26, 6, -30.6, 1.4, 1.2, 1.4, false, 0.4);
    for (const [x, z] of [
      [-21.8, -27.5],
      [-21.0, -28.3],
      [21.6, 22.6],
      [22.4, 23.6],
    ] as const) {
      this.mesh(root, this.cylinder, x, 0.55, z, 0.38, 1.1, 0.38, x < 0 ? 0x2f5a6a : 0xb5582a);
      this.mesh(root, this.cylinder, x, 0.82, z, 0.4, 0.06, 0.4, 0x1a1f23);
    }
    // Storage tanks behind the south wall.
    for (const x of [-16, 16]) {
      this.tcyl(root, x, 3, 30, 3, 6, s.bare, 0.4);
      this.mesh(root, this.sphere, x, 6, 30, 3, 1.2, 3, 0x6d757c);
    }

    // ------------------------------------------------------------ signage
    this.sign("07", 0, 1.35, -1.97, 1.5, 1.45, P.cyan, P.black);
    this.sign("RELAY / 07", 0, 5, -31.12, 10, 2.5, P.chalk, P.black);
    this.sign("WEST / 01", -18, 1.12, 1.03, 6.2, 0.65, P.amber, P.black);
    this.sign("EAST / 02", 18, 1.12, 1.03, 6.2, 0.65, P.amber, P.black);
    this.sign("HIGH VOLTAGE", -8, 0.97, 11.53, 2.8, 0.45, P.orange, P.black);
    this.sign("RESTRICTED", 8, 0.97, 11.53, 2.8, 0.45, P.orange, P.black);
    this.sign("NO ENTRY", 0, 7.4, 23.72, 3.2, 0.5, P.red, P.black, true);
    for (const sg of [-1, 1]) this.sign(sg < 0 ? "DECK A" : "DECK B", sg * 23.42, 5.1, 9.5, 2.6, 0.55, P.cyan, P.black, false, sg);

    // ------------------------------------------------------------ lights (<= 8 total)
    root.add(new PointLight3D(P.cyan, 16, 11)).setPosition(0, 4.2, -5);
    root.add(new PointLight3D(0xffa860, 14, 12)).setPosition(0, 6.8, 21);
    for (const sg of [-1, 1]) root.add(new PointLight3D(0x9fd8ff, 9, 9)).setPosition(sg * 22.5, 4.6, 8);
    this.muzzleLight = new PointLight3D(0xffc070, 0, 6);

    // ------------------------------------------------------------ first-person weapons
    this.root.add(this.weaponRoot);
    const gm = this.mat(0x2b3138, false, 0.45, 0.55),
      poly = this.mat(0x14181c, false, 0.7, 0.05),
      paint = this.mat(0xd96e30, false, 0.45, 0.2),
      bone = this.mat(0x8f8c84, false, 0.5, 0.05),
      chrome = this.mat(0x9aa3ab, false, 0.22, 0.9);
    const part = (gun: Node3D, m: Material3D, x: number, y: number, z: number, w: number, h: number, d: number) =>
      gun.add(new Mesh3D(this.cube, m)).setPosition(x, y, z).setScale(w, h, d);
    for (let i = 0; i < 2; i++) {
      const gun = this.weaponRoot.add(new Node3D());
      this.weaponModels.push(gun);
      part(gun, gm, 0, -0.04, -0.18, 0.2, 0.18, 0.57);
      part(gun, i === 0 ? paint : bone, 0, 0.045, -0.2, 0.215, 0.05, 0.5);
      part(gun, poly, 0, -0.21, 0.03, 0.11, 0.28, 0.16).rotation.x = -0.2;
      part(gun, gm, 0, -0.19, -0.2, 0.13, 0.24, 0.15).rotation.x = 0.12;
      part(gun, poly, 0, 0.085, -0.2, 0.06, 0.03, 0.44);
      for (let k = 0; k < 6; k++) part(gun, gm, 0, 0.105, -0.38 + k * 0.06, 0.07, 0.012, 0.025);
      if (i === 0) {
        gun.add(new Mesh3D(this.cylinder, chrome)).setPosition(0, 0.0, -0.6).setScale(0.03, 0.34, 0.03).rotation.x = Math.PI / 2;
        part(gun, poly, 0, 0.0, -0.55, 0.12, 0.11, 0.26);
        for (let k = 0; k < 4; k++) part(gun, gm, 0.062, 0.0, -0.64 + k * 0.05, 0.01, 0.06, 0.022);
        part(gun, poly, 0, 0.13, -0.14, 0.065, 0.06, 0.13);
        part(gun, gm, 0, 0.135, -0.215, 0.075, 0.075, 0.025);
        this.box(gun, 0, 0.14, -0.074, 0.04, 0.03, 0.006, P.cyan, true);
        this.box(gun, 0.096, -0.02, -0.05, 0.012, 0.11, 0.08, P.cyan, true);
      } else {
        for (const x of [-0.055, 0.055]) {
          const b = gun.add(new Mesh3D(this.cylinder, chrome)).setPosition(x, 0, -0.5).setScale(0.045, 0.36, 0.045);
          b.rotation.x = Math.PI / 2;
        }
        part(gun, poly, 0, -0.06, -0.4, 0.22, 0.09, 0.22);
        for (let k = 0; k < 4; k++) this.box(gun, -0.09 + k * 0.06, -0.035, -0.12, 0.035, 0.035, 0.07, P.red, true);
        this.box(gun, 0, 0.055, -0.62, 0.025, 0.02, 0.02, P.amber, true);
      }
      this.box(gun, 0.105, 0, -0.22, 0.008, 0.045, 0.2, i === 0 ? P.cyan : P.amber, true);
      for (let k = 0; k < 5; k++) part(gun, gm, 0.108, -0.05, -0.34 + k * 0.05, 0.012, 0.04, 0.012);
      part(gun, i === 0 ? gm : paint, -0.02, -0.2, 0.22, 0.13, 0.14, 0.3).rotation.x = -0.24;
      part(gun, poly, -0.03, -0.13, 0.06, 0.13, 0.1, 0.17);
      part(gun, poly, -0.02, -0.29, 0.34, 0.12, 0.05, 0.08).rotation.x = -0.24;
      gun.visible = i === 0;
    }
    this.muzzle = this.mesh(this.weaponRoot, this.sphere, 0, 0, -0.78, 0.06, 0.06, 0.2, 0xffe2a8, true);
    this.muzzle.visible = false;
    this.weaponRoot.add(this.muzzleLight);
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

  private surf = (t: SurfaceTextures, o: Material3DOptions = {}): Material3D =>
    new Material3D({ ...t.material, map: t.map, normalMap: t.normalMap, metallicRoughnessMap: t.metallicRoughnessMap, ...o });

  /** Visual swap when a relay comes back online: lamp, ring, beam and light go cyan. */
  activateRelay(i: number): void {
    const lamp = this.relayLamps[i];
    lamp.color = lamp.emissive = P.cyan;
    for (const c of this.relays[i].children)
      if (c instanceof Mesh3D && c.geometry === this.ring) c.material = this.mat(P.cyan, true);
    this.relayBeams[i].material = this.mat(P.cyan, true);
    this.relayLights[i].color = P.cyan;
    this.relayLights[i].intensity = 12;
  }

  /** Animated accents: beacons blink, relay beams pulse. */
  animate(time: number): void {
    const on = Math.sin(time * 3.1) > 0.55;
    for (const b of this.beacons) b.visible = on;
    for (const [i, beam] of this.relayBeams.entries()) beam.setScale(0.05 + Math.sin(time * 4 + i) * 0.012, 1.3, 0.05 + Math.sin(time * 4 + i) * 0.012);
  }

  private beacon(x: number, y: number, z: number, r = 0.14): void {
    const b = this.mesh(this.root, this.sphere, x, y, z, r, r, r, 0xff3b30, true);
    b.castShadow = false;
    this.beacons.push(b);
  }

  /** A cover barrier: painted steel body, grated cap, hazard bands and vents. */
  private barrier(x: number, y: number, z: number, w: number, h: number, d: number): void {
    const s = this.s,
      root = this.root,
      reactor = w >= 6;
    this.tbox(root, x, y, z, w, h, d, reactor ? s.hex : s.panel, 0.55, 0.05);
    this.tbox(root, x, y + h / 2 + 0.06, z, w + 0.12, 0.12, d + 0.12, s.bare, 0.6, 0.03);
    if (!reactor) this.tbox(root, x, y + h / 2 + 0.125, z, w - 0.1, 0.01, d - 0.1, s.grate, 0.6, 0);
    this.tbox(root, x, y - h / 2 + 0.11, z, w + 0.04, 0.22, d + 0.04, s.hazard, 1.2, 0);
    for (const side of [-1, 1]) {
      this.box(root, x + side * (w / 2 + 0.012), y + 0.1, z, 0.04, 0.05, d * 0.7, reactor ? P.cyan : P.amber, true).castShadow = false;
      for (let k = 0; k < 4; k++) this.box(root, x + side * (w / 2 + 0.03), y - 0.45 + k * 0.16, z, 0.035, 0.05, d * 0.45, 0x1c2228);
    }
  }

  private hazardFrame(cx: number, cz: number, w: number, d: number, t: number): void {
    const s = this.s.hazard;
    for (const sz of [-1, 1]) this.tbox(this.root, cx, 0.006, cz + sz * (d / 2), w + t, 0.012, t, s, 1.2, 0).castShadow = false;
    for (const sx of [-1, 1]) this.tbox(this.root, cx + sx * (w / 2), 0.006, cz, t, 0.012, d - t, s, 1.2, 0).castShadow = false;
  }

  private paint(x: number, z: number, w: number, d: number, color: number): void {
    const m = this.root.add(new Mesh3D(this.cube, this.mat(color, false, 0.75, 0))).setPosition(x, 0.004, z).setScale(w, 0.008, d);
    m.castShadow = false;
  }

  /** A box with world-scaled UVs, geometry cached per size. */
  tbox(parent: Node3D, x: number, y: number, z: number, w: number, h: number, d: number, m: Material3D, uv = 0.5, bevel = 0.03): Mesh3D {
    const key = `${w}/${h}/${d}/${uv}/${bevel}`;
    let g = this.boxes.get(key);
    if (!g) {
      const b = bevel > 0 ? Geometry3D.beveledBox(w, h, d, Math.min(bevel, w / 3, h / 3, d / 3)) : Geometry3D.box(w, h, d);
      g = this.scene.resources.own(new Geometry3D(b.positions, b.normals, b.indices, boxUV(b.positions, b.normals, uv)));
      this.boxes.set(key, g);
    }
    return parent.add(new Mesh3D(g, m)).setPosition(x, y, z);
  }

  /** A Y-axis cylinder with world-scaled UVs. */
  tcyl(parent: Node3D, x: number, y: number, z: number, r: number, h: number, m: Material3D, uv = 0.5): Mesh3D {
    const key = `${r}/${h}/${uv}`;
    let g = this.cylinders.get(key);
    if (!g) {
      const segs = 32,
        c = Geometry3D.cylinder(r, h, segs),
        p = c.positions,
        out: number[] = [];
      for (let i = 0; i < p.length / 3; i++) {
        if (i < (segs + 1) * 2) out.push((Math.floor(i / 2) / segs) * Math.PI * 2 * r * uv, (p[i * 3 + 1] + h / 2) * uv);
        else out.push(p[i * 3] * uv, p[i * 3 + 2] * uv);
      }
      g = this.scene.resources.own(new Geometry3D(c.positions, c.normals, c.indices, out));
      this.cylinders.set(key, g);
    }
    return parent.add(new Mesh3D(g, m)).setPosition(x, y, z);
  }

  /** Backlit LED signage panel in a steel frame. `facing` rotates it to face +x/-x walls. */
  private sign(text: string, x: number, y: number, z: number, w: number, h: number, ink: number, background: number, south = false, facing = 0): void {
    const short = text.length < 4;
    const texture = this.scene.resources.own(
      Texture3D.fromText(text, {
        width: short ? 128 : 512,
        height: 128,
        size: short ? 100 : 55,
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
      .add(new Mesh3D(geometry, new Material3D({ map: texture, shading: "unlit", toneMapped: false, color: 0xe6e6e6 })))
      .setPosition(x, y, z)
      .setScale(w, h, 1);
    mesh.castShadow = false;
    if (south) mesh.rotation.y = Math.PI;
    if (facing) mesh.rotation.y = (-facing * Math.PI) / 2;
    const frame = facing
      ? this.box(this.root, x + facing * 0.03, y, z, 0.05, h + 0.1, w + 0.1, 0x1a1f24)
      : this.box(this.root, x, y, z + (south ? 0.03 : -0.03), w + 0.1, h + 0.1, 0.05, 0x1a1f24);
    frame.castShadow = false;
  }

  /**
   * Shared solid-colour material. `glow` makes an unlit emissive accent that feeds bloom;
   * otherwise a PBR paint with the given roughness and metalness.
   */
  mat(color: number, glow = false, roughness = 0.55, metallic = 0.25): Material3D {
    const key = `${color}/${glow}/${roughness}/${metallic}`;
    let m = this.materials.get(key);
    if (!m) {
      m = glow
        ? new Material3D({ color, shading: "unlit", toneMapped: false, emissive: color, emissiveIntensity: 0.55 })
        : new Material3D({ color, roughness, metallic });
      this.materials.set(key, m);
    }
    return m;
  }
  mesh(parent: Node3D, g: Geometry3D, x: number, y: number, z: number, w: number, h: number, d: number, color: number, glow = false): Mesh3D {
    return parent.add(new Mesh3D(g, this.mat(color, glow))).setPosition(x, y, z).setScale(w, h, d);
  }
  box(parent: Node3D, x: number, y: number, z: number, w: number, h: number, d: number, color: number, glow = false): Mesh3D {
    return this.mesh(parent, this.cube, x, y, z, w, h, d, color, glow);
  }
  drone(heavy: boolean): { root: Node3D; core: Mesh3D; rotor: Node3D } {
    const root = this.root.add(new Node3D()),
      rotor = root.add(new Node3D()),
      hull = this.mat(heavy ? 0x2a3036 : 0xbfc4c6, false, heavy ? 0.4 : 0.35, heavy ? 0.7 : 0.35),
      armour = this.mat(heavy ? 0xd2652a : 0x3a444d, false, 0.45, 0.4),
      dark = this.mat(0x111518, false, 0.6, 0.3);
    const add = (g: Geometry3D, m: Material3D, x: number, y: number, z: number, w: number, h: number, d: number) =>
      root.add(new Mesh3D(g, m)).setPosition(x, y, z).setScale(w, h, d);
    add(this.sphere, hull, 0, 0, 0, 0.66, 0.43, 0.54);
    add(this.cube, dark, 0, 0, -0.4, 0.62, 0.2, 0.25);
    add(this.cube, armour, 0, 0.25, -0.05, 0.5, 0.08, 0.6);
    const core = this.mesh(root, this.sphere, 0, 0, -0.56, 0.2, 0.11, 0.08, P.red, true);
    this.box(root, 0, -0.02, -0.535, 0.5, 0.025, 0.02, P.red, true);
    for (const s of [-1, 1]) {
      add(this.cube, armour, s * 0.75, -0.06, 0, 0.65, 0.19, 0.48);
      add(this.cube, dark, s * 0.75, 0.05, 0, 0.5, 0.04, 0.34);
      rotor.add(new Mesh3D(this.ring, dark)).setPosition(s * 0.93, 0.12, 0).setScale(0.36, 0.36, 0.36);
      this.box(rotor, s * 0.93, 0.12, 0, 0.62, 0.015, 0.06, 0x111518);
      add(this.cube, dark, s * 0.76, -0.35, -0.1, 0.12, 0.4, 0.18);
      this.box(root, s * 0.76, -0.56, -0.1, 0.06, 0.04, 0.06, P.red, true);
    }
    add(this.cube, dark, 0, 0.39, 0.1, 0.05, 0.32, 0.05);
    this.mesh(root, this.sphere, 0, 0.57, 0.1, 0.06, 0.06, 0.06, P.red, true);
    return { root, core, rotor };
  }
  navigation(): NavigationGrid3D {
    return new NavigationGrid3D(48, 56, 1, -24, -31, (x, z) => {
      for (const s of SOLIDS)
        if (s.kind !== "floor" && Math.abs(x - s.x) < s.w / 2 + 0.8 && Math.abs(z - s.z) < s.d / 2 + 0.8) return null;
      if (x > -5 && x < 0 && z > 5 && z < 14) return null;
      for (const sign of [-1, 1])
        for (let rz = -25; rz < 22; rz += 9) if (Math.abs(x - sign * 13) < 1.15 && Math.abs(z - rz) < 1.2) return null;
      for (const p of RELAYS) if (Math.hypot(x - p.x, z - p.z) < 1.5) return null;
      return 0;
    });
  }
}
