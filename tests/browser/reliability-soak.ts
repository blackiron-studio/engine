import { WebGL2Renderer } from "../../src/render/webgl2.ts";
import { bakeAtlas } from "../../src/art/atlas.ts";
import { defaultPost } from "../../src/render/types.ts";
import { Scene3D, Mesh3D } from "../../src/three/scene.ts";
import { Geometry3D } from "../../src/three/geometry.ts";
import { Material3D } from "../../src/three/material.ts";
import { Texture3D } from "../../src/three/texture.ts";
import {
  createSceneRegistry,
  type SceneInstance,
} from "../../src/content/scene.ts";
import { Node3D } from "../../src/three/node.ts";
import { ResourceCache, ResourceScope } from "../../src/content/resources.ts";
const params = new URLSearchParams(location.search),
  seconds = Number(params.get("seconds") ?? 1800);
const canvas = document.querySelector("canvas")!,
  renderer = new WebGL2Renderer(canvas, 1280, 720, { scale: 1 });
renderer.resize(1280, 720, 1);
renderer.uploadAtlas(bakeAtlas());
renderer.profiling = true;
const gl = canvas.getContext("webgl2")!,
  extension = gl.getExtension("WEBGL_debug_renderer_info");
const device = extension
  ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
  : gl.getParameter(gl.RENDERER);
const geometry = Geometry3D.box(),
  material = new Material3D({ shading: "lambert", toneMapped: false }),
  scene = new Scene3D(1280, 720),
  post = defaultPost();
scene.camera3D.position.set(25, 22, 32);
scene.camera3D.lookAt(0, 0, 0);
scene.camera3D.projection = "orthographic";
scene.camera3D.orthoHeight = 35;
scene.environment.shadows = true;
scene.environment.fogDensity = 0;
for (let i = 0; i < 1000; i++) {
  const mesh = scene.world3D.add(new Mesh3D(geometry, material));
  mesh.position.set((i % 40) - 20, 0, Math.floor(i / 40) - 12);
  mesh.setScale(0.7);
  mesh.tint = 0x336655 + (i % 8) * 0x080b0c;
}
const registry = createSceneRegistry();
let instance: SceneInstance | null = null,
  scope: ResourceScope | null = null,
  cycles = 0,
  loads = 0,
  disposals = 0;
let finishing = false;
let pendingLoad: Promise<unknown> = Promise.resolve();
const cache = new ResourceCache({
  load: async () => {
    loads++;
    return new Texture3D(4, 4, new Uint8Array(64).fill(255));
  },
  dispose: (t) => {
    disposals++;
    t.dispose();
  },
  bytes: (t) => t.data.byteLength,
});
const samples: { mode: string; cpu: number; frame: number }[] = [],
  resources: unknown[] = [],
  errors: string[] = [];
let started = performance.now(),
  previous = started,
  lastReport = started,
  frame = 0,
  maxMemory = 0,
  minSteadyMemory = Infinity;
const gpuWindows = {
  "2d": { samples: 0, maxP95Ms: 0 },
  "3d": { samples: 0, maxP95Ms: 0 },
};
function restart() {
  instance?.dispose();
  scope?.dispose();
  renderer.collectGarbage();
  if (cache.stats.entries !== 0)
    throw new Error("Resource cache retained an unloaded scene");
  scope = new ResourceScope();
  pendingLoad = scope.acquire(cache, "shared").catch((e) => {
    if (
      !finishing ||
      !String(e).includes("Resource lease released before loading completed")
    )
      errors.push(String(e));
  });
  instance = registry.instantiate({
    format: "blackiron.scene",
    version: 1,
    root: {
      id: "detail",
      type: "Node3D",
      children: [
        {
          id: "cube",
          type: "Mesh3D",
          props: { position: [0, 3, 0], color: 0xf2bb64 },
        },
      ],
    },
  });
  scene.world3D.add(instance.root as Node3D);
  cycles++;
}
const percentile = (values: number[], p: number) => {
  const a = values.sort((a, b) => a - b);
  return a.length ? a[Math.ceil(a.length * p) - 1] : null;
};
function summary() {
  const mode = (name: string) => {
    const data = samples.filter((s) => s.mode === name);
    return {
      samples: data.length,
      cpuMedianMs: percentile(
        data.map((s) => s.cpu),
        0.5,
      ),
      cpuP95Ms: percentile(
        data.map((s) => s.cpu),
        0.95,
      ),
      frameP95Ms: percentile(
        data.map((s) => s.frame),
        0.95,
      ),
    };
  };
  return {
    status: errors.length ? "FAIL" : "PASS",
    device,
    userAgent: navigator.userAgent,
    resolution: [1280, 720],
    elapsedSeconds: (performance.now() - started) / 1000,
    frames: frame,
    restarts: cycles,
    loads,
    disposals,
    errors,
    mode2D: mode("2d"),
    mode3D: mode("3d"),
    gpu: renderer.diagnostics.gpu,
    gpuWindows,
    estimatedGpuBytes: { steadyMin: minSteadyMemory, max: maxMemory },
    resourceSamples: resources,
  };
}
async function finish() {
  finishing = true;
  instance?.dispose();
  scope?.dispose();
  // The final frame may have started an asynchronous acquisition. Wait for its
  // late-disposal path before checking balance or reporting a leak.
  await pendingLoad;
  geometry.dispose();
  renderer.collectGarbage();
  if (cache.stats.entries !== 0 || loads !== disposals)
    errors.push("Unbalanced load/unload");
  const report = summary();
  report.status = errors.length ? "FAIL" : "PASS";
  await fetch("/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  document.querySelector("pre")!.textContent = JSON.stringify(report, null, 2);
  renderer.destroy();
}
function tick(now: number) {
  try {
    const elapsed = (now - started) / 1000,
      mode = Math.floor(elapsed / 15) % 2 === 0 ? "3d" : "2d";
    if (frame % 120 === 0) restart();
    const begin = performance.now();
    renderer.begin(0x122832);
    if (mode === "3d") {
      scene.world3D.rotation.y = Math.sin(elapsed * 0.1) * 0.1;
      renderer.render3D(scene.collectFrame3D());
    } else {
      renderer.setPass("world");
      for (let i = 0; i < 10000; i++)
        renderer.rect(
          (i % 125) * 10,
          Math.floor(i / 125) * 9,
          8,
          7,
          0x668c96 + (i % 4) * 0x111111,
        );
    }
    renderer.end(post);
    const cpu = performance.now() - begin,
      error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`GPU error ${error}`);
    if (frame > 120) samples.push({ mode, cpu, frame: now - previous });
    if (samples.length > 120000) samples.splice(0, 60000);
    previous = now;
    frame++;
    // Ignore windows that straddle workload changes; keep the worst rolling
    // 240-query p95 for each workload instead of only the final 2D window.
    if (frame % 60 === 0 && elapsed % 15 > 6) {
      const gpu = renderer.diagnostics.gpu;
      if (gpu.p95Ms !== null) {
        gpuWindows[mode].samples++;
        gpuWindows[mode].maxP95Ms = Math.max(
          gpuWindows[mode].maxP95Ms,
          gpu.p95Ms,
        );
      }
    }
    const bytes = renderer.diagnostics.estimatedGpuBytes;
    maxMemory = Math.max(maxMemory, bytes);
    if (frame > 120) minSteadyMemory = Math.min(minSteadyMemory, bytes);
    if (now - lastReport >= 15000) {
      resources.push({
        seconds: elapsed,
        ...renderer.diagnostics.mesh,
        cache: cache.stats,
      });
      lastReport = now;
      void fetch("/progress", {
        method: "POST",
        body: JSON.stringify({
          seconds: Math.round(elapsed),
          frames: frame,
          restarts: cycles,
          bytes,
        }),
      });
    }
    if (elapsed >= seconds) {
      void finish();
      return;
    }
    requestAnimationFrame(tick);
  } catch (error) {
    errors.push(String((error as Error).stack ?? error));
    void finish();
  }
}
window.addEventListener("error", (e) => errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
requestAnimationFrame(tick);
