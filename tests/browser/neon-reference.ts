/** Renderer acceptance fixture derived from the user-supplied Neon Bastion reference.
 * This is a static/animated visual scene, not a gameplay port or another example game.
 * All scene drawing uses Kiln meshes, materials, hierarchy and the public renderer API.
 */
import { bakeAtlas } from "../../src/art/atlas.ts";
import { WebGL2Renderer } from "../../src/render/webgl2.ts";
import { defaultPost } from "../../src/render/types.ts";
import {
  Geometry3D,
  Material3D,
  Mesh3D,
  Node3D,
  Scene3D,
  Vec3,
} from "../../src/three/index.ts";

type Color = readonly [number, number, number];
const C = {
  floor: [0.105, 0.19, 0.23],
  edge: [0.18, 0.31, 0.35],
  cyan: [0.39, 0.9, 0.79],
  orange: [1, 0.34, 0.15],
  gold: [1, 0.68, 0.3],
  dark: [0.045, 0.09, 0.12],
  white: [0.78, 0.94, 0.93],
} as const;
const color = (rgb: Color): number =>
  rgb.reduce(
    (packed, value) =>
      (packed << 8) | Math.round(Math.min(1, Math.max(0, value)) * 255),
    0,
  );
const covers = [
  { x: -4.7, z: -3.6, w: 3, d: 1.5 },
  { x: 4.7, z: 3.6, w: 3, d: 1.5 },
  { x: -4.6, z: 4.6, w: 1.5, d: 3 },
  { x: 4.6, z: -4.6, w: 1.5, d: 3 },
  { x: 0, z: -7.3, w: 2.2, d: 1.2 },
  { x: 0, z: 7.3, w: 2.2, d: 1.2 },
];
const gates = [
  [-9.8, -9.8],
  [9.8, -9.8],
  [9.8, 9.8],
  [-9.8, 9.8],
];
const scene = new Scene3D();
const cube = Geometry3D.box();
const materials = new Map<number, Material3D>();
const rings = new Map<string, Geometry3D>();
const geometryIds = new Set<number>();
let boxCount = 0,
  ringCount = 0;
function material(glow: number): Material3D {
  let m = materials.get(glow);
  if (!m) {
    // Neon mixes (0.48 + 0.52*N·L) toward 1.25 by glow. Lambert can match
    // that response directly, without adding speculative bloom or point lights.
    m = new Material3D({
      shading: "lambert",
      toneMapped: false,
      lambertAmbient: 0.48 * (1 - glow) + 1.25 * glow,
      lambertDiffuse: 0.52 * (1 - glow),
    });
    materials.set(glow, m);
  }
  return m;
}
function box(
  parent: Node3D,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  tint: Color,
  yaw = 0,
  glow = 0,
): Mesh3D {
  const mesh = parent
    .add(new Mesh3D(cube, material(glow)))
    .setPosition(x, y, z)
    .setScale(w, h, d);
  mesh.rotation.y = yaw;
  mesh.tint = color(tint);
  mesh.castShadow = false;
  boxCount++;
  geometryIds.add(cube.id);
  return mesh;
}
function ring(
  parent: Node3D,
  x: number,
  y: number,
  z: number,
  radius: number,
  width: number,
  tint: Color,
  glow = 0,
): Mesh3D {
  const key = `${radius}:${width}`;
  let geometry = rings.get(key);
  if (!geometry) {
    geometry = Geometry3D.ring(radius, Math.max(0, radius - width), 32);
    rings.set(key, geometry);
  }
  const mesh = parent
    .add(new Mesh3D(geometry, material(glow)))
    .setPosition(x, y, z);
  mesh.tint = color(tint);
  mesh.castShadow = false;
  ringCount++;
  geometryIds.add(geometry.id);
  return mesh;
}
const w = scene.world3D;
box(w, 0, -0.65, 0, 24, 1.2, 24, C.dark);
for (let x = -11; x <= 11; x += 2)
  for (let z = -11; z <= 11; z += 2) {
    const variation = ((x * 7 + z * 13 + 400) % 9) * 0.0019;
    box(w, x, -0.08, z, 1.965, 0.15, 1.965, [
      C.floor[0] + variation,
      C.floor[1] + variation,
      C.floor[2] + variation,
    ]);
  }
for (let i = -11; i <= 11; i += 2) {
  box(w, i, -0.42, 12.02, 1.8, 0.12, 0.04, C.edge);
  box(w, 12.02, -0.42, i, 0.04, 0.12, 1.8, C.edge);
}
for (const side of [-1, 1]) {
  box(w, side * 11.7, 0.08, 0, 0.14, 0.16, 23, C.edge);
  box(w, 0, 0.08, side * 11.7, 23, 0.16, 0.14, C.edge);
  for (let i = -9; i <= 9; i += 6) {
    box(w, side * 11.72, 0.18, i, 0.19, 0.035, 1.7, C.cyan, 0, 1);
    box(w, i, 0.18, side * 11.72, 1.7, 0.035, 0.19, C.cyan, 0, 1);
  }
}
ring(w, 0, 0.006, 0, 2.25, 0.025, C.edge);
ring(w, 0, 0.01, 0, 2.4, 0.03, C.edge);
for (let i = 0; i < 4; i++) {
  const yaw = (i * Math.PI) / 2;
  box(
    w,
    Math.sin(yaw) * 2.2,
    0.02,
    Math.cos(yaw) * 2.2,
    0.35,
    0.025,
    0.08,
    C.cyan,
    yaw,
    0.5,
  );
}
for (const b of covers) {
  box(w, b.x + 0.13, 0.015, b.z + 0.18, b.w + 0.45, 0.025, b.d + 0.45, C.dark);
  box(w, b.x, 0.58, b.z, b.w, 1.16, b.d, [0.2, 0.32, 0.35]);
  box(w, b.x, 1.19, b.z, b.w + 0.06, 0.12, b.d + 0.06, [0.29, 0.43, 0.45]);
  box(w, b.x, 0.2, b.z, b.w + 0.035, 0.09, b.d + 0.035, C.dark);
  box(w, b.x, 1.265, b.z, b.w * 0.7, 0.02, 0.07, C.cyan, 0, 0.6);
  for (let k = -1; k <= 1; k++)
    box(
      w,
      b.x + k * 0.33,
      0.73,
      b.z + b.d / 2 + 0.008,
      0.12,
      0.36,
      0.02,
      C.dark,
    );
}
for (const [x, z] of gates) {
  ring(w, x, 0.02, z, 0.9, 0.06, [0.54, 0.28, 0.17], 0.5);
  box(w, x, 0.12, z, 1.1, 0.24, 1.1, C.dark);
  for (const side of [-1, 1]) {
    box(w, x + side * 0.72, 0.6, z, 0.15, 1.2, 0.15, C.edge);
    box(w, x + side * 0.72, 1.23, z, 0.18, 0.08, 0.18, C.orange, 0, 1);
  }
  ring(w, x, 0.028, z, 0.94, 0.025, [0.4, 0.2, 0.13], 0.5);
}
interface Actor {
  root: Node3D;
  body: Node3D;
  left: Mesh3D;
  right: Mesh3D;
  gun: Mesh3D;
  muzzle: Mesh3D;
  phase: number;
  player: boolean;
}
const actors: Actor[] = [];
function actor(
  x: number,
  z: number,
  yaw: number,
  type: "player" | "chaser" | "shooter",
  phase: number,
): void {
  const root = w.add(new Node3D().setPosition(x, 0, z));
  root.rotation.y = yaw;
  root.name = `reference-${type}`;
  const body = root.add(new Node3D());
  const tint =
    type === "player" ? C.cyan : type === "shooter" ? C.gold : C.orange;
  const armor: Color =
    type === "player"
      ? [0.3, 0.5, 0.51]
      : type === "shooter"
        ? [0.42, 0.29, 0.21]
        : [0.51, 0.24, 0.19];
  ring(root, 0, 0.024, 0, 0.57, 0.56, [0.06, 0.12, 0.145]);
  if (type === "player") ring(root, 0, 0.031, 0, 0.66, 0.028, C.cyan, 0.5);
  const left = box(body, -0.18, 0.22, 0, 0.21, 0.38, 0.3, C.dark),
    right = box(body, 0.18, 0.22, 0, 0.21, 0.38, 0.3, C.dark);
  box(body, 0, 0.66, 0, 0.61, 0.54, 0.4, armor);
  box(body, 0, 0.69, -0.25, 0.42, 0.43, 0.18, C.dark);
  box(body, 0, 1.08, 0, 0.42, 0.36, 0.39, armor);
  box(body, 0, 1.1, 0.205, 0.33, 0.095, 0.03, tint);
  box(body, -0.39, 0.75, 0.08, 0.2, 0.33, 0.26, armor);
  box(body, 0.39, 0.75, 0.13, 0.2, 0.3, 0.28, armor);
  const gun = box(body, 0.25, 0.83, 0.45, 0.18, 0.18, 0.8, C.dark);
  box(body, 0.25, 0.84, 0.88, 0.13, 0.12, 0.14, tint);
  const muzzle = box(body, 0.25, 0.85, 1.02, 0.17, 0.16, 0.24, C.gold);
  muzzle.visible = false;
  if (type === "shooter") {
    box(body, 0, 1.32, -0.05, 0.06, 0.22, 0.06, C.dark);
    box(body, 0, 1.45, -0.05, 0.09, 0.07, 0.09, C.orange);
    ring(root, 0, 0.04, 0, 0.72, 0.035, C.orange, 1);
  }
  actors.push({
    root,
    body,
    left,
    right,
    gun,
    muzzle,
    phase,
    player: type === "player",
  });
}
actor(0, 0, Math.PI / 4, "player", 0.3);
actor(6, -1, -1.3, "chaser", 2);
actor(-7, -7, Math.PI / 4, "shooter", 1);
actor(-1, 5, 2.8, "chaser", 4);
function pose(time: number): void {
  for (const a of actors) {
    const walk = time * 4 + a.phase;
    a.body.y = Math.sin(walk) * 0.035;
    a.left.z = Math.sin(walk) * 0.13;
    a.right.z = -Math.sin(walk) * 0.13;
    const recoil = a.player ? Math.max(0, Math.sin(time * 6)) * 0.08 : 0;
    a.gun.z = 0.45 - recoil;
    a.muzzle.visible = a.player && recoil > 0.065;
  }
}
scene.environment.sunDirection.set(-0.5, 1, 0.3);
scene.environment.sunColor = 0xffffff;
scene.environment.sunIntensity = 1;
scene.environment.shadows = false;
scene.environment.fogDensity = 0;
scene.camera3D.position.set(30, 30, 30);
scene.camera3D.lookAt(0, 0, 0);
scene.camera3D.projection = "orthographic";
const capture = new URLSearchParams(location.search).has("capture");
const canvas = document.querySelector("canvas")!;
const renderer = new WebGL2Renderer(canvas, 1440, 900, { scale: "native" });
renderer.uploadAtlas(bakeAtlas());
const gl = canvas.getContext("webgl2")!;
const post = defaultPost();
post.vignette = 0.16;
const glErrors: number[] = [];
function resize(): void {
  const width = capture ? 1440 : innerWidth,
    height = capture ? 900 : innerHeight;
  renderer.setLogicalSize(width, height);
  renderer.resize(width, height, Math.min(devicePixelRatio || 1, 2));
  scene.resize(width, height);
  scene.camera3D.orthoHeight = 2 * Math.max(13.4, 19.5 / (width / height));
}
function draw(time: number): void {
  pose(time);
  renderer.begin(0x0a121a);
  renderer.render3D(scene.collectFrame3D());
  renderer.end(post);
}
function framing(): {
  maxErrorPx: number;
  inside: boolean;
  projection: string;
  orthoHeight: number;
} {
  const width = renderer.width,
    height = renderer.height,
    viewY = Math.max(13.4, 19.5 / (width / height)),
    viewX = (viewY * width) / height;
  let maxErrorPx = 0,
    inside = true;
  for (const point of [
    new Vec3(),
    new Vec3(12, 0, 12),
    new Vec3(-12, 0, -12),
    new Vec3(-12, 0, 12),
    new Vec3(12, 0, -12),
    new Vec3(6, 1.08, -1),
  ]) {
    const screen = scene.camera3D.project(point, width, height),
      x = (((Math.SQRT1_2 * (point.x - point.z)) / viewX + 1) * width) / 2,
      y =
        ((1 -
          (-0.40824829 * (point.x + point.z) + 0.81649658 * point.y) / viewY) *
          height) /
        2;
    maxErrorPx = Math.max(maxErrorPx, Math.hypot(screen.x - x, screen.y - y));
    inside &&=
      screen.x >= 0 && screen.x <= width && screen.y >= 0 && screen.y <= height;
  }
  return {
    maxErrorPx,
    inside,
    projection: scene.camera3D.projection,
    orthoHeight: scene.camera3D.orthoHeight,
  };
}
try {
  resize();
  for (let i = 0; i < 12; i++) draw(1.2);
  const timings: number[] = [];
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    draw(1.2 + i / 60);
    timings.push(performance.now() - start);
  }
  draw(1.2);
  glErrors.push(gl.getError());
  const view = framing(),
    sorted = [...timings].sort((a, b) => a - b);
  const opaqueGeometryPixels = new Uint8Array(4);
  const center = scene.camera3D.project(
    new Vec3(0, 0.8, 0),
    renderer.width,
    renderer.height,
  );
  gl.readPixels(
    Math.floor((center.x * renderer.stats.targetWidth) / renderer.width),
    renderer.stats.targetHeight -
      1 -
      Math.floor((center.y * renderer.stats.targetHeight) / renderer.height),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    opaqueGeometryPixels,
  );
  glErrors.push(gl.getError());
  const pass =
    glErrors.every((error) => error === gl.NO_ERROR) &&
    view.maxErrorPx < 0.01 &&
    view.inside &&
    renderer.stats3D.meshes > 300 &&
    renderer.stats3D.drawCalls <= 20 &&
    opaqueGeometryPixels[3] === 255 &&
    opaqueGeometryPixels[0] +
      opaqueGeometryPixels[1] +
      opaqueGeometryPixels[2] >
      100;
  const result = {
    status: pass ? "PASS" : "FAIL",
    reference: "Neon Bastion — read-only procedural scene benchmark",
    implementation:
      "Kiln Scene3D / orthographic Camera3D / Lambert materials / per-instance tint",
    glErrors,
    framing: view,
    stats: {
      ...renderer.stats3D,
      totalRendererDraws: renderer.stats.drawCalls,
    },
    construction: {
      boxes: boxCount,
      rings: ringCount,
      articulatedActors: actors.length,
      sharedGeometries: geometryIds.size,
      sharedMaterials: materials.size,
    },
    cpuSubmission: {
      label:
        "CPU scene collection + WebGL submission; includes driver work, excludes GPU completion and display FPS",
      warmupFrames: 12,
      samples: timings.length,
      meanMs: timings.reduce((a, b) => a + b, 0) / timings.length,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxMs: sorted[sorted.length - 1],
    },
    resolution: {
      logical: [renderer.width, renderer.height],
      target: [renderer.stats.targetWidth, renderer.stats.targetHeight],
    },
    referenceDifferences: [
      "Four articulated actors, rather than the reference title scene's player plus four enemies.",
      "Reference world-radial fog is omitted; no color-matching claim or screenshot identity threshold is used.",
      "Kiln renders full cuboids and 4× MSAA; the reference omits hidden bottom faces.",
    ],
    centerPixel: Array.from(opaqueGeometryPixels),
  };
  document.querySelector("pre")!.textContent = JSON.stringify(result, null, 2);
  document.body.dataset.status = result.status;
  document.querySelector("textarea")!.textContent = renderer.snapshot() ?? "";
  document.getElementById("summary")!.textContent =
    `${result.stats.meshes} meshes · ${result.stats.drawCalls} main draws · ${result.construction.articulatedActors} articulated actors · orthographic geometry`;
  (window as unknown as { kilnNeonReference: unknown }).kilnNeonReference = {
    result,
    scene,
    renderer,
  };
} catch (error) {
  document.querySelector("pre")!.textContent = JSON.stringify(
    { status: "FAIL", error: String(error) },
    null,
    2,
  );
  document.body.dataset.status = "FAIL";
}
addEventListener("resize", () => {
  resize();
  draw(1.2);
});
if (new URLSearchParams(location.search).has("animate")) {
  const tick = (time: number) => {
    draw(time / 1000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
