# Kiln 0.14 foundation upgrade

9 September 2026. This upgrade keeps Kiln and its three flagship games: Wisp Hollow (2D), Highground (projected 2.5D), and Lumen Salvage (3D). Highground keeps its island projection. The native-content and Neon scenes are renderer acceptance fixtures, not replacement games.

## Delivered systems

| Area | Implemented | Practical boundary |
|---|---|---|
| Reliability | Pinned Bun/Rust/TypeScript and locks; sequential local CI; repeat clean web builds with SHA-256 comparisons; real-hardware timed soak and resource churn | Local macOS evidence does not establish the hosted Windows/Linux matrix or physical mobile readiness |
| Resource ownership | Async deduplicating reference-counted cache; leases; scene scopes; failure retry; disposal after late load completion; teardown drains cleanup after errors | Resource authors must supply disposal and acquire shared assets through leases; this is not automatic JS heap collection |
| Scene content | Versioned JSON scene trees, prefabs, overrides, scoped IDs, typed codecs, deferred references, bounded undo/redo | Built-in codecs cover Node, Node2D, Sprite, Node3D, Mesh3D and PointLight3D; game-specific types need codecs |
| Import fidelity | Aseprite restored trim rectangles, clockwise-packed rotation recovery, per-frame timing, reverse/ping-pong tags; validation of bounds | Not a complete Aseprite project/layer importer; test coverage targets sheet exports |
| 3D assets | Texture3D, UV primitives, base/normal/metallic-roughness/emissive maps, opaque/mask/blend; glTF2/GLB buffers/images/hierarchies | Defined glTF subset, detailed below |
| Animation | Quaternion transforms; shortest-arc interpolation; STEP/LINEAR/CUBICSPLINE clips; per-instance four-weight skinning | Skinning runs on CPU; no retargeting, animation graph editor or GPU crowd skinning |
| Physics | Browser Rapier and native Rust Rapier; dynamic/fixed/kinematic bodies, box/sphere/capsule/fixed triangle mesh, CCD, sensors, events, raycasts and transform bindings | Identity parent transforms for bound visuals; primitive dimensions are world units; native common API is narrower than browser raw Rapier |
| Native meshes | Versioned retained resource packet and wgpu mesh/depth/shadow pass; textured lighting, alpha and HUD/post composition; desktop PNG/JPEG decoding | One draw per mesh and single-sample rendering; browser retains instancing/MSAA; no native GPU timer yet |
| Authoring | Local scene tree and JSON property/document editor, add/delete, undo/redo, atomic disk save/load, revision conflict detection, 3D orbit preview | Code-first editor, no drag gizmos, asset browser, visual shader authoring or complete 2D art-registry preview |
| Diagnostics | Nonblocking WebGL GPU queries; render/mesh counters; geometry/texture counts and estimated GPU bytes on web/native; resource-cache bytes/references | GPU bytes are estimates, not driver/process residency; no heap snapshot viewer, native GPU timestamps or allocation call stacks |

Lumen's courtyard gate now comes from `examples/lumen/assets/scenes/main.kiln.json`. Its silhouette, materials and layout are preserved. The existing game uses the same runtime mesh renderer as imported content.

## Using resources and glTF

```ts
import { ResourceCache } from "@kiln/engine/content";
import { loadGltf, Scene3D } from "@kiln/engine/three";

// Keep the cache outside individual scenes if they share these assets.
const models = new ResourceCache({
  load: (url: string) => loadGltf(app.platform, url),
  dispose: asset => asset.dispose(),
  bytes: asset => asset.bytes,
});
const scene = new Scene3D(1280, 720);
const asset = await scene.resources.acquire(models, "assets/character.glb");
const model = scene.resources.own(asset.instantiate());
scene.world3D.add(model);
if (model.clips[0]) model.player.play(model.clips[0]);
app.scenes.change(scene);
```

The scope releases in reverse order: the instance before its shared asset lease. A scene detaching disposes its resources; create fresh scenes/scopes for replacements. An instance owns its deformed skin geometry, while static geometry/material maps belong to the shared asset. Do not call `asset.dispose()` while another instance uses it. Disposed handles should be released by game code too; explicit GPU disposal cannot collect JS objects still held by the caller.

`loadGltf` reads external resources through Platform and resolves them relative to the model URL. Browser and Swift use their image decoders; the desktop host decodes PNG and ordinary RGB/grayscale JPEG. CMYK/high-bit-depth JPEG is rejected. An optional image decoder can be supplied by the caller.

Supported glTF: JSON and GLB, embedded/external buffers and PNG/JPEG images, interleaved/normalized/sparse accessors, indexed/nonindexed triangle primitives, generated flat normals where absent, node TRS/matrices, skins/inverse bind matrices and animation tracks. Required unsupported extensions fail explicitly. Compressed geometry, morph targets, nontriangle modes, alternate UV sets and texture transforms are rejected. Vertex colours and occlusion maps produce warnings and are not rendered. Texture sampler fidelity is limited to nearest/linear filtering and a shared wrap mode: no mipmap filter chain or independently authored S/T wrapping. Normal-map scale and advanced material extensions are not fully implemented. These limits prevent a claim of universal glTF conformance.

## Scene documents and prefabs

```ts
import { createSceneRegistry } from "@kiln/engine/content";
import type { Node3D } from "@kiln/engine/three";

const instance = createSceneRegistry().instantiate({
  format: "kiln.scene", version: 1,
  prefabs: {
    crate: { id: "mesh", type: "Mesh3D", props: { color: 0xcaa779 } },
  },
  root: { id: "room", type: "Node3D", children: [
    { id: "a", prefab: "crate", overrides: { mesh: { position: [2, 0, 0] } } },
    { id: "b", prefab: "crate", overrides: { mesh: { position: [-2, 0, 0] } } },
  ] },
});
scene.resources.own(instance);
scene.world3D.add(instance.root as Node3D);
```

Prefab contents have scoped IDs such as `a/mesh`. Codecs create nodes and register cleanup with their resource scope. A codec's optional `apply` resolves links after every node exists. Unknown types, unresolved references, cycles, unsafe object keys and oversized expansion fail. Geometry/material pooling happens within a scene instance, rather than forcing each mesh to allocate another identical primitive.

Run `bun run gallery --port 4287`, then open `/lumen/dev/editor`. The editor reads/writes `assets/scenes/<name>.kiln.json` within the project and saves atomically. It detects stale revisions and rejects cross-origin writes. The development server binds loopback. Lumen's imported JSON is picked up on the next bundle/reload; the editor preview updates immediately. The editor is intended for trusted local project content.

## Physics integration

```ts
const physics = await scene.enablePhysics3D();
physics.createBody({
  type: "fixed", position: { x: 0, y: -0.5, z: 0 },
  shape: { kind: "box", halfExtents: [10, 0.5, 10] },
});
physics.createBody({
  position: { x: 0, y: 3, z: 0 },
  shape: { kind: "sphere", radius: 0.5 }, ccd: true,
}, visualTransform); // Transform3D under an identity world parent
physics.onBodyCollision = (a, b, started) => { /* game rules */ };
```

Scene3D owns stepping and disposal, including pause overlays, time scale and hit stop. Concurrent initialization shares one pending promise; an initialization completing after detach is disposed. The browser exposes its raw Rapier world for advanced use. Native supports the common basic interface; do not assume browser-only joints/controllers are portable. Browser/native Rapier versions differ, so identical trajectories and deterministic multiplayer across hosts are not promised. Lumen retains its existing ground movement helpers and game rules; the native-content fixture exercises general rigid-body physics.

## Diagnostics and budgets

Set `renderer.profiling = true` to enable asynchronous WebGL timer queries. `renderer.diagnostics` exposes timing, mesh statistics and memory estimates. Missing/disjoint GPU readings remain null. Query queues and rolling sample windows are bounded. `renderer.collectGarbage()` processes disposable GPU resources; normal rendering also retires unused resources. Native diagnostics expose retained mesh resources and bytes through the host ABI.

`performance-budgets.json` defines the desktop workload at 1280×720: alternating 10,000 2D quads and 1,000 lit, shadow-casting mesh instances. CPU submission p95 and GPU rolling p95 each have an 8.3 ms budget; estimated GPU allocation is bounded at 256 MiB, with at least 100 resource/content replacements. rAF pacing is reported separately and gated at the target frame interval plus 0.5 ms for timestamp granularity. These are renderer workloads, not full AI/physics game simulations. The cache resource in this soak is not itself uploaded; the separate 100-cycle GPU test explicitly uploads/unloads geometry and textures.

```sh
bun install --frozen-lockfile
bun run check:ci
bun run check:reliability                     # 30 real minutes
KILN_SOAK_SECONDS=240 bun run check:reliability # short regression, not a full soak
bun kernel/build.ts                          # Wasm and iOS XCFramework
```

The soak records the tested bundle SHA-256 and hardware. The profiler reports a rolling window, so the current harness additionally records each workload's worst rolling GPU p95. Stable allocation has an explicit 64 KiB spread allowance for alternating transient geometry. This detects the exercised retained-resource growth; it is not a comprehensive JS/native heap leak proof.

## Executed validation

Final local CI: **10/10 jobs passed** on 9 September 2026, using Bun 1.3.13 and Rust 1.98.1. [Committed evidence](validation/foundation-0.14.json) records commands, timings and result details. Raw logs and captures remain under `.kiln/verification/`.

| Check | Result |
|---|---|
| TypeScript unit/integration suite | 359 passed; 17,846 assertions; includes 100 scene-owned physics replacements and error-path cleanup |
| Rust kernel / native host | 18 / 5 tests passed, including native 3D contact and PNG/JPEG decoding |
| GPU regressions | Passed depth/shadows/instancing/palette, texture UV/alpha, skin deformation and 100 uploaded-resource unload cycles |
| Flagship games | Wisp Hollow, Highground and Lumen browser checks passed |
| Native visual regressions | 16 passed, zero baseline updates or unsupported skips in the final run |
| Browser/native content fixture | Passed; 0.126% of normalized pixels exceed colour tolerance, below the 2% acceptance threshold |
| Reproducible web exports | All three games byte-identical across two clean local builds |
| Native iOS compilation | Device/simulator XCFramework built; all Swift host sources typechecked for arm64 iOS 16 simulator |
| Persistent editor | Actual save, reload and restoration of the Lumen gate name verified through the browser UI |
| 30-minute hardware soak | Passed on Apple M1 Pro/ANGLE Metal; 108,005 frames, 901 balanced loads/disposals, zero recorded errors |

The 30-minute run measured CPU p95 **2.7 ms (2D)** / **3.2 ms (3D)** and rAF p95 **16.7 ms**. Estimated GPU bytes ranged from **43,732,496 to 43,733,408** (a 912-byte spread). Its final rolling GPU p95 was **4.33 ms**. That long run used the earlier bundle hash recorded in the evidence; final cleanup changes and the improved per-workload GPU harness are covered by the final short run separately. No claim is made that the long run measured every workload’s GPU p95 throughout its duration.

The **four-minute final-source run also passed**: 120 balanced loads/disposals, zero errors, CPU p95 **2.7 ms (2D)** / **3.6 ms (3D)**, and worst observed rolling GPU p95 **1.56 ms (2D)** / **2.38 ms (3D)**. Both workloads had rAF p95 **16.7 ms** and the same 912-byte allocation spread. All ten performance/resource gates passed. The report includes both bundle hashes. An initial short-run shutdown false alarm was traced to checking a still-pending final-frame resource load; the harness now awaits its late-disposal path, and the failed attempt is preserved.

The engine was initialized as a local Git repository on `codex/engine-foundation`. The initial source snapshot includes existing engine history as files, not reconstructed historical commits.

## Remaining production gates

The four requested areas now have working implementations, but they are not complete Godot/Unity-equivalent subsystems. The next acceptance work is broader asset conformance, native batching/MSAA and GPU skinning; a richer visual editor and heap/native GPU inspection; hosted OS matrix execution; physical mobile thermal/performance tests; longer playthroughs of each actual game; and store-ready signed exports. Navigation, animation graphs, shader graphs, complex prefab migration and comprehensive device-loss stress remain separate projects.

No remote is configured for this repository, so a hosted CI run cannot be claimed. The available iPad was offline; compiling the iOS framework and Swift sources is not physical-device verification. No signing, store submission or external publication was performed.
