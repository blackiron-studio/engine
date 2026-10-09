import { exerciseBreach } from "../shared/fps-mission.ts";
import main, { BreachScene } from "../../examples/breach/src/main.ts";
import { App } from "../../src/app/app.ts";
import {
  Vec3,
  Scene3D,
  Mesh3D,
  Geometry3D,
  Material3D,
} from "../../src/three/index.ts";
import { RELAYS } from "../../examples/breach/src/level.ts";
import config from "../../examples/breach/blackiron.json";
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
async function capture(app: App, name: string) {
  await fetch("/capture?name=" + name, {
    method: "POST",
    body: app.canvas!.toDataURL("image/png"),
  });
}
try {
  const app = await App.create({ canvas: "#blackiron", config: config as any });
  const s = await exerciseBreach(app, capture);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) app.frame(1 / 60);
  };
  const gl = app.canvas!.getContext("webgl2")!;
  check(gl.getError() === gl.NO_ERROR, "WebGL error");
  check(errors.length === 0, errors.join("; "));
  const times: number[] = [];
  for (let i = 0; i < 120; i++) {
    const t = performance.now();
    frame();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const result = {
    status: "PASS",
    checks: [
      "startup",
      "movement",
      "jump",
      "pause/resume",
      "weapons/reload",
      "authored staircase",
      "all three combat waves",
      "three relays/victory",
      "defeat",
      "restart resource release",
      "GPU submission",
    ],
    diagnostics: s.diagnostics,
    renderer: app.renderer.diagnostics,
    frameCpuMs: { median: times[60], p95: times[114] },
    errors,
    scope:
      "Real WebGL2 and game simulation; mouse pointer lock requires a separate user-gesture test.",
  };
  const layer = new Scene3D(1280, 720);
  layer.environment.shadows = false;
  layer.environment.fogDensity = 0;
  layer.camera3D.position.set(0, 0, 4);
  layer.camera3D.lookAt(0, 0, 0);
  layer.post.bloom = 0;
  layer.post.vignette = 0;
  const geometry = layer.resources.own(Geometry3D.box());
  layer.world3D
    .add(
      new Mesh3D(
        geometry,
        new Material3D({
          color: 0xcc3333,
          shading: "unlit",
          toneMapped: false,
        }),
      ),
    )
    .setScale(8, 8, 0.2)
    .setPosition(0, 0, 1);
  const weaponMesh = layer.world3D.add(
    new Mesh3D(
      geometry,
      new Material3D({ color: 0x3366cc, shading: "unlit", toneMapped: false }),
    ),
  );
  weaponMesh.renderLayer = "viewmodel";
  app.scenes.change(layer);
  frame(2);
  const pixel = new Uint8Array(4);
  gl.readPixels(640, 360, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  check(pixel[2] > 150 && pixel[0] < 80, "Viewmodel was occluded by the world");
  weaponMesh.renderLayer = "world";
  frame(2);
  gl.readPixels(640, 360, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  check(
    pixel[0] > 150 && pixel[2] < 80,
    "World geometry stopped respecting depth",
  );
  result.checks.push("viewmodel depth layer with world-depth control");
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
  app.destroy();
} catch (error) {
  await fetch("/result", {
    method: "POST",
    body: JSON.stringify({
      status: "FAIL",
      error: String((error as Error).stack ?? error),
      errors,
    }),
  });
}
