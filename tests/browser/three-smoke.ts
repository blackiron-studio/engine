import { contentSmoke } from "./content-smoke.ts";
import { paletteSmoke } from "./palette-smoke.ts";
import { graphicsSmoke } from "./graphics-smoke.ts";
import { bakeAtlas } from "../../src/art/atlas.ts";
import { WebGL2Renderer } from "../../src/render/webgl2.ts";
import { defaultPost } from "../../src/render/types.ts";
import {
  Scene3D,
  Geometry3D,
  Material3D,
  Mesh3D,
  PointLight3D,
} from "../../src/three/index.ts";
const errors: string[] = [];
window.onerror = (event) => {
  errors.push(String(event));
  document.body.dataset.status = "FAIL";
  document.querySelector("pre")!.textContent = JSON.stringify(errors);
};
async function run(): Promise<void> {
  try {
    const graphics = await graphicsSmoke();
    const canvas = document.querySelector("canvas")!;
    const renderer = new WebGL2Renderer(canvas, 800, 600, { scale: 1 });
    renderer.resize(800, 600, 1);
    renderer.uploadAtlas(bakeAtlas());
    const gl = (renderer as any).gl as WebGL2RenderingContext;
    const palette = paletteSmoke(renderer, gl);
    const content = contentSmoke(renderer, gl);
    const scene = new Scene3D(800, 600);
    scene.camera3D.position.set(0, 0, 8);
    scene.camera3D.lookAt(0, 0, 0);
    scene.environment.shadows = false;
    scene.environment.fogDensity = 0;
    const cube = Geometry3D.box();
    const red = scene.world3D
      .add(new Mesh3D(cube, new Material3D({ color: 0xff0000, unlit: true })))
      .setScale(2);
    red.z = 1;
    const blue = scene.world3D
      .add(new Mesh3D(cube, new Material3D({ color: 0x0000ff, unlit: true })))
      .setScale(2);
    blue.z = -2;
    const post = defaultPost();
    function draw() {
      renderer.begin(0x13202e);
      renderer.render3D(scene.collectFrame3D());
      renderer.setPass("overlay");
      renderer.rect(20, 20, 100, 20, 0x00ff00);
      renderer.end(post);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) errors.push("GL " + error);
    }
    function pixel(x: number, y: number) {
      const p = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return Array.from(p);
    }
    draw();
    const first = pixel(400, 300),
      hud = pixel(40, 570);
    if (first[0] <= first[2]) errors.push("Depth ordering first " + first);
    if (hud[1] < 200 || hud[0] > 40) errors.push("HUD corrupted " + hud);
    red.z = -5;
    draw();
    const second = pixel(400, 300);
    if (second[2] <= second[0]) errors.push("Depth ordering second " + second);
    scene.world3D.clear();
    scene.camera3D.position.set(8, 7, 10);
    scene.camera3D.lookAt(0, 0.5, 0);
    scene.environment.shadows = true;
    scene.environment.fogDensity = 0.008;
    const ground = scene.world3D.add(
      new Mesh3D(
        Geometry3D.plane(18, 18),
        new Material3D({ color: 0x718a81, roughness: 0.9 }),
      ),
    );
    ground.castShadow = false;
    const mat = new Material3D({
      color: 0x398d9e,
      metallic: 0.4,
      roughness: 0.3,
    });
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++)
        scene.world3D
          .add(new Mesh3D(cube, mat))
          .setPosition(x * 2, 0.8, z * 2)
          .setScale(0.85, 1.6, 0.85);
    scene.world3D
      .add(
        new Mesh3D(
          Geometry3D.sphere(),
          new Material3D({ color: 0xffb856, metallic: 0.75, roughness: 0.15 }),
        ),
      )
      .setPosition(0, 3, 0)
      .setScale(3);
    scene.world3D.add(new PointLight3D(0x35dcff, 35, 10)).setPosition(-4, 3, 2);
    scene.world3D.add(new Mesh3D(cube, mat)).setPosition(1000, 0, 0);
    post.bloom = 0.2;
    post.vignette = 0.22;
    draw();
    if (renderer.stats3D.culled !== 1)
      errors.push("Culling failed " + renderer.stats3D.culled);
    if (renderer.stats3D.drawCalls !== 3)
      errors.push("Instancing failed " + renderer.stats3D.drawCalls);
    if (renderer.stats3D.shadowDrawCalls < 1) errors.push("No shadow draws");
    const withShadows = new Uint8Array(800 * 600 * 4);
    gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, withShadows);
    scene.environment.shadows = false;
    draw();
    const withoutShadows = new Uint8Array(withShadows.length);
    gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, withoutShadows);
    let shadowPixels = 0;
    for (let i = 0; i < withShadows.length; i += 4)
      if (
        withoutShadows[i] +
          withoutShadows[i + 1] +
          withoutShadows[i + 2] -
          withShadows[i] -
          withShadows[i + 1] -
          withShadows[i + 2] >
        25
      )
        shadowPixels++;
    if (shadowPixels < 100)
      errors.push("Shadow map did not darken scene pixels " + shadowPixels);
    scene.environment.shadows = true;
    draw();
    const result = {
      graphics,
      palette,
      content,
      shadowPixels,
      status: errors.length ? "FAIL" : "PASS",
      errors,
      first,
      second,
      hud,
      stats: renderer.stats3D,
      renderer: gl.getParameter(gl.RENDERER),
    };
    document.querySelector("pre")!.textContent = JSON.stringify(
      result,
      null,
      2,
    );
    document.body.dataset.status = result.status;
  } catch (error) {
    document.querySelector("pre")!.textContent = String(error);
    document.body.dataset.status = "FAIL";
  }
}
void run();
