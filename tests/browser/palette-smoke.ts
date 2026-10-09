import type { WebGL2Renderer } from "../../src/render/webgl2.ts";
import { defaultPost } from "../../src/render/types.ts";
import {
  Geometry3D,
  Material3D,
  Mesh3D,
  Scene3D,
  Vec3,
} from "../../src/three/index.ts";

/** Actual GPU regressions for palette shading, colored instancing, and flat markings. */
export function paletteSmoke(
  renderer: WebGL2Renderer,
  gl: WebGL2RenderingContext,
) {
  const scene = new Scene3D(800, 600);
  scene.camera3D.projection = "orthographic";
  scene.camera3D.orthoHeight = 6;
  scene.camera3D.position.set(0, 0, 10);
  scene.camera3D.lookAt(0, 0, 0);
  scene.environment.shadows = false;
  scene.environment.fogDensity = 0;
  const post = defaultPost();
  const background = 0x102030;
  function draw(): void {
    renderer.begin(background);
    renderer.render3D(scene.collectFrame3D());
    renderer.end(post);
    const error = gl.getError();
    if (error !== gl.NO_ERROR)
      throw new Error(`Palette smoke GL error ${error}`);
  }
  function pixel(point: Vec3): number[] {
    const screen = scene.camera3D.project(point, 800, 600),
      rgba = new Uint8Array(4);
    gl.readPixels(
      Math.floor(screen.x),
      599 - Math.floor(screen.y),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    );
    return Array.from(rgba);
  }
  function expectPixel(
    actual: number[],
    expected: number[],
    label: string,
  ): void {
    if (expected.some((value, i) => Math.abs(actual[i] - value) > 2))
      throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  const rgb = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  const cube = Geometry3D.box(),
    material = new Material3D({ shading: "unlit", toneMapped: false });
  const tints = [0x336699, 0xcc5522, 0x33aa66];
  const meshes = tints.map((tint, i) => {
    const mesh = scene.world3D
      .add(new Mesh3D(cube, material))
      .setPosition((i - 1) * 2, 0, 0)
      .setScale(1.5);
    mesh.tint = tint;
    return mesh;
  });
  draw();
  if (renderer.stats3D.drawCalls !== 1)
    throw new Error(
      `Per-instance tint broke batching: ${renderer.stats3D.drawCalls} draws`,
    );
  const tintPixels = meshes.map((mesh) => pixel(mesh.position));
  tintPixels.forEach((value, i) =>
    expectPixel(value, rgb(tints[i]), `Tint ${i}`),
  );
  meshes[1].tint = 0x8844dd;
  draw();
  expectPixel(pixel(meshes[1].position), rgb(0x8844dd), "Live tint update");
  expectPixel(
    pixel(meshes[0].position),
    rgb(tints[0]),
    "Neighbor tint isolation",
  );
  material.color = 0x808080;
  draw();
  expectPixel(
    pixel(meshes[0].position),
    rgb(tints[0]).map((c) => Math.round((c * 128) / 255)),
    "Material × instance tint",
  );

  // Force the instance buffer beyond its initial capacity and sample separated instances.
  scene.world3D.clear();
  material.color = 0xffffff;
  const grid: Mesh3D[] = [];
  for (let i = 0; i < 400; i++) {
    const mesh = scene.world3D
      .add(new Mesh3D(cube, material))
      .setPosition(
        ((i % 20) - 9.5) * 0.26,
        (Math.floor(i / 20) - 9.5) * 0.26,
        0,
      )
      .setScale(0.2);
    mesh.tint = tints[i % tints.length];
    grid.push(mesh);
  }
  draw();
  const coloredInstanceCount = renderer.stats3D.meshes;
  if (renderer.stats3D.drawCalls !== 1 || coloredInstanceCount !== 400)
    throw new Error(
      `Colored instance growth: ${coloredInstanceCount} meshes in ${renderer.stats3D.drawCalls} draws`,
    );
  for (const i of [0, 127, 255, 399])
    expectPixel(
      pixel(grid[i].position),
      rgb(tints[i % tints.length]),
      `Instance ${i} after growth`,
    );

  // A camera-facing plane makes N·L exact so Lambert's two controls can be measured.
  scene.world3D.clear();
  const lambert = new Material3D({
    color: 0x6496c8,
    shading: "lambert",
    toneMapped: false,
    lambertAmbient: 0.25,
    lambertDiffuse: 0.5,
  });
  const panel = scene.world3D.add(new Mesh3D(Geometry3D.plane(2, 2), lambert));
  panel.rotation.x = Math.PI / 2;
  scene.environment.sunColor = 0xffffff;
  scene.environment.sunIntensity = 1;
  scene.environment.sunDirection.set(0, 0, 1);
  draw();
  const lambertLit = pixel(new Vec3());
  expectPixel(lambertLit, [75, 113, 150], "Lambert ambient + diffuse");
  scene.environment.sunDirection.set(0, 0, -1);
  draw();
  const lambertAmbient = pixel(new Vec3());
  expectPixel(
    lambertAmbient,
    [25, 38, 50],
    "Lambert unlit-facing ambient floor",
  );
  lambert.lambertAmbient = 0.6;
  lambert.lambertDiffuse = 0;
  draw();
  expectPixel(pixel(new Vec3()), [60, 90, 120], "Lambert control updates");
  lambert.shading = "unlit";
  scene.environment.exposure = 5;
  draw();
  expectPixel(
    pixel(new Vec3()),
    [100, 150, 200],
    "Unlit bypasses lights and exposure",
  );
  lambert.toneMapped = true;
  draw();
  const toneMapped = pixel(new Vec3());
  if (Math.abs(toneMapped[0] - 100) < 10)
    throw new Error(`Tone mapping switch had no effect: ${toneMapped}`);

  // A real annulus must leave its central hole empty rather than filling a disc.
  scene.world3D.clear();
  scene.environment.exposure = 1;
  scene.camera3D.position.set(0, 10, 0);
  scene.camera3D.lookAt(0, 0, 0);
  const ring = scene.world3D.add(
    new Mesh3D(Geometry3D.ring(1, 0.5, 48), material),
  );
  ring.tint = 0x55dd99;
  draw();
  const ringCenter = pixel(new Vec3()),
    ringBand = pixel(new Vec3(0.75, 0, 0));
  expectPixel(ringCenter, rgb(background), "Annulus central hole");
  expectPixel(ringBand, rgb(ring.tint), "Annulus band");
  if (renderer.stats3D.triangles !== 96)
    throw new Error(`Annulus triangle count ${renderer.stats3D.triangles}`);

  return {
    tintPixels,
    coloredInstanceCount,
    coloredInstanceDraws: 1,
    lambertLit,
    lambertAmbient,
    toneMapped,
    ringCenter,
    ringBand,
  };
}
