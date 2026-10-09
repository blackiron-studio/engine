# Blackiron: quality and capability roadmap

Updated 9 September 2026. Blackiron remains our engine. Godot and Unity are engineering benchmarks, not migration targets. The previous roadmap overstated parity: feature names and a green unit suite did not prove correct lifecycle, real-time safety, import fidelity, visual quality or production export support. The [historical roadmap](ROADMAP-2026-09-03.md) records those earlier decisions; this document supersedes its status and its exclusion of 3D.

## The product direction

Keep one shared runtime for scenes, input, UI, audio, saves and tooling. Preserve a lightweight 2D path, with retained vector graphics alongside sprites and rigs. Use projected ground coordinates for sprite-based 2.5D. Provide an explicit 3D scene with mesh geometry, depth-tested rendering, perspective or orthographic cameras, and materials. Orthographic 3D is a second valid way to build 2.5D games; neither mode should force the other into its coordinate system.

Improve **Wisp Hollow** and **Highground** in place. Add **Lumen Salvage** as the missing 3D example. These three games are acceptance fixtures and design constraints for reusable engine features. Each should be playable, visually coherent, pausable and restartable, with instructions and useful failure feedback. Avoid adding unrelated showcases to hide deficiencies in the main games.

This delivery establishes a stronger foundation. It does not establish general-purpose Godot or Unity parity. Blackiron can be the right path for a small studio that accepts maintaining its engine; the proof is repeatable shipping quality in these games, not a growing feature checklist.

Neon Bastion is now a concrete minimum reference for geometry-based 2.5D. The [comparison and acceptance fixture](NEON-BENCHMARK.md) records the resulting stylized shading, per-instance tint, camera, ground movement and feedback work. Highground keeps its projected island design; Lumen demonstrates both perspective and orthographic views.

## Fixes in this upgrade

| Confirmed defect | Change | Verification |
|---|---|---|
| Physics continues under pause/overlays; worlds leak | Scene-owned physics, scaled simulation, idempotent disposal | Integration tests for overlays, hit stop, pause, transitions, destruction |
| Mutation skips child updates; stale scenes continue ticking | Mutation-safe traversal and scene-change guards | Self-removal, reparent and transition regressions |
| Hidden UI intercepts input; z order ignored | Ancestor visibility and visual-order hit tests | Hidden panel and overlapping-control regressions |
| Pointer edges repeat at 120 Hz; held rebind sticks | Separate UI edge consumption; release old bindings | High-refresh and rebinding regressions |
| Animation blending aliases unrelated objects | Object identity keys | Multiple-target blending regression |
| Nested physics ignores parent scale/rotation | Full ancestor transform conversion | Rotated/scaled-parent regression; collider dimensions remain explicit world units |
| Failed storage writes report success | Propagate backend write failure | Quota/unavailable-storage regression |
| Wasm vertex capacity uses obsolete stride | Shared protocol stride for typed-array views | Capacity-edge regression and rebuilt Wasm |
| Atlas cannot grow for a wide image | Dimension-aware bounded growth | Wide/tall/exact-size packing tests |
| Glyph overflow invalidates queued UVs | Preserve already queued glyph work | Overflow regression |
| Native stereo callback writes half its buffer | Specify frames versus samples in ABI | Stereo buffer regression |
| Projected sort drops retained allocation | Keep scratch capacity across flushes | Rust regression and sort benchmark |

Implementation status and command results belong in [upgrade validation](UPGRADE-VALIDATION.md). A proposal or test plan is not evidence that a platform has passed.

## Current capability boundaries

The 0.14 [foundation upgrade](FOUNDATION-UPGRADE.md) implements the next layer of this roadmap. Its evidence table is authoritative for this delivery; the milestones below still describe the broader production gates.

| Area | Current Blackiron direction | Gate before claiming production parity |
|---|---|---|
| 2D | Sprites, rigs, particles, tiles, vector shapes, lights, UI | Consistent typography, animation import semantics, reliable asset hot reload and packaging |
| 2.5D | Projected height/depth, terrain, picking, sprite shadows | Camera rotations, tall-object occlusion, picking at every elevation, controller/mobile acceptance |
| Basic 3D | WebGL2/native meshes, texture maps, glTF subset, CPU skinning, clips, depth and shadows | Broader glTF conformance, native batching/MSAA, GPU skinning, navigation and device coverage |
| Physics | Rapier 2D and basic 3D with scene ownership | Shape-transform contract, continuous-collision stress, cross-host determinism criteria |
| Audio | Synth/sample/streaming with native ABI hardening | Fully bounded allocation-free callback, background decoding, interruption/device-loss stress |
| Content workflow | Code/procedural art, faithful Aseprite subset, scene/prefab JSON, references, undo and persistent editor | Visual manipulation, import dependency tracking, migrations and broader codecs |
| Exports | Existing web/native packaging | Tested release builds on each target OS/device; signing, store integration, crash reporting |
| Quality tooling | Unit/integration tests, native goldens, browser GPU checks, profiler | CI execution across supported environments, performance and memory budgets, soak testing |

Basic 3D now has a separate versioned native mesh packet and wgpu depth/shadow/material pass. Canvas still reports unsupported 3D. Native and WebGL2 capabilities differ as documented in the upgrade report.

## Next milestones and acceptance gates

1. **Release reliability.** Put the engine under version control, run CI on pinned Bun/Rust, and require clean typechecking, regressions, reference images and reproducible exports. Exercise every example for 30 minutes and 100 scene restarts. No monotonically growing resource counts; no uncaught errors. Rebaseline images only after human review of the intended art change.
2. **Measured performance.** Record CPU update, submission, GPU time, draw calls, triangle count, target memory and live resources separately. At 1280×720 target 60 fps with p95 frame time below 16.7 ms on named devices. Test 2D/2.5D at 10k objects and 3D at 1k mesh instances. Optimize allocation and visibility before reducing visual quality. Publish measurements and device names; an FPS overlay alone is insufficient.
3. **3D content and native rendering.** Extend the versioned kernel protocol with mesh/material resources and a wgpu opaque/depth/shadow pass. Match WebGL and native scenes within explicit image tolerances. Then add glTF 2.0 buffers, materials and animation, followed by Rapier 3D shapes/character movement and navigation. Validate unload/reload, context loss, shadow stability and repeated instancing.
4. **Art and animation fidelity.** Preserve Aseprite frame durations, trimmed origins, rotated atlas entries and reverse/ping-pong tags. Add font shaping and fallback coverage. Make procedural styles reusable through palettes, geometry and material presets. Use the reference games to judge coherent lighting, silhouette, scale, motion and feedback.
5. **Authoring and shipping.** Add versioned scene/prefab data, persistent inspector edits, dependency-aware reload and input replays. Ship a complete small game to web and one mobile/desktop store. Sign builds, migrate saves, handle suspended apps and device loss, and collect crashes. Only then extend the platform matrix.

The milestone after this pass is a validated vertical slice of each flagship game across chosen shipping targets. Full Godot/Unity breadth remains a continuing engineering program; claiming it now would repeat the old roadmap's mistake.
