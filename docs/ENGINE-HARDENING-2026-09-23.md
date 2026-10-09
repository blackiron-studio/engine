# Kiln engine hardening — 23 September 2026

Kiln remains the engine for the games in this repository. This pass improves native 3D edge quality and draw throughput, glTF sampler fidelity, and basic visual authoring. It does **not** establish Godot or Unity parity. Those products have much broader editor, importer, renderer, profiler, platform and distribution coverage.

## Changes

| Area | Behavior now | Boundary |
|---|---|---|
| Native 3D edges | The wgpu mesh pass renders at 4× MSAA when RGBA8 color/resolve and Depth32 support it, then resolves to the existing scene target before 2D/UI composition. The shadow map stays single-sample. | An adapter without those capabilities uses 1×. Browser WebGL2 has its own antialiasing path. This is edge antialiasing, not a complete postprocessing stack. |
| Native instancing | Consecutive compatible opaque meshes share one indexed draw and one instanced shadow draw, with separate transforms, colors and mirrored winding. A GPU readback test checks independent instance colors. | Transparent meshes and incompatible or nonconsecutive meshes remain separate draws. A measured high-instance performance budget is still needed. |
| glTF samplers | U and V wrap modes and all six core minification filters are preserved through imported textures, WebGL2 and native packets. The browser generates mipmaps; native uploads a CPU-generated mip chain. Unsupported values fail explicitly. | Texture transforms, material extensions, morph targets and complex rig conformance remain open. Native mip generation is a basic box filter, not a color-space-aware offline texture pipeline. |
| Scene editor | Visible triangle picking selects the nearest mesh. The inspector edits 3D position, rotation and scale; Shift-drag moves a node on a horizontal plane, converts through its parent transform and commits one undoable edit. Escape cancels. | The editor is still a local JSON-backed tool. It lacks full 3D gizmos, robust prefab-instance editing, asset dependency tracking and production workflow polish. |

## Executed checks

[A concise machine-readable validation record](validation/engine-2026-09-23.json) accompanies these results.

- Local `bun run check:ci`: 15 of 15 jobs passed on Apple M1 Pro, Bun 1.3.13 and Rust 1.98.1. The jobs include 405 Bun tests, Rust kernel/host tests, browser WebGL 3D checks, native content/FPS captures, example and export checks, reproducible web builds and native goldens. Logs and the machine-readable result are in `.kiln/verification/ci/`.
- The explicit native 4× MSAA test passed on this GPU. It reads back a resolved triangle and checks for partially covered edge pixels and GPU validation errors. Regular Rust test runs leave this hardware-dependent test ignored; the macOS CI job executes it.
- The explicit native instancing GPU test passed on this GPU. It renders two differently colored objects in one indexed draw and reads both colors back. All three ignored hardware GPU regression tests passed when run explicitly.
- Native packet regressions passed: independent V wrapping is accepted, older packets without `wrapT` still parse, and invalid filter/wrap values are rejected.
- `KILN_REQUIRE_HARDWARE_GPU=1 bun run check:native-content` passed. Its normalized 800×600 browser/native comparison differed in 0.000654 of pixels against a 0.02 tolerance. This also exercises embedded GLB/PNG content, UVs, CPU skin pose and basic Rapier contact.
- The editor preview was checked in a browser: selecting a pillar, changing its Y rotation and X scale, and undoing restored the previous values. No scene file was saved. The Shift-drag gesture has geometry/parent-transform tests, but it was not exercised by automated browser input.
- Wyrmdeck's current game uses Kiln's renderer and UI. Its route, battle, reward and deck screens were revised and inspected in a browser; cards now move through finite hand/draw/discard piles, opponents play named cards, and the collection pages through all cards. This is a playable demo, not a Hearthstone-quality production UI or a 300-card release.
- `KILN_SOAK_SECONDS=240 bun run check:reliability` passed in Headless Chrome using ANGLE Metal on the Apple M1 Pro at 1280×720. It completed 14,389 frames, 120 scene loads/disposals and no reported errors. Measured p95 CPU time was 1.3 ms for the 2D workload and 2.0 ms for 3D; GPU p95 was 1.126 ms. Estimated GPU allocation stayed between 43,732,496 and 43,733,408 bytes. This is a four-minute local soak, not the 30-minute or multi-device release gate.
- `git diff --check` and TypeScript typechecking passed.

These are local checks, not a hosted OS/device matrix. The full current-source browser soak result is in `.kiln/verification/reliability/result.json`; historical soak reports should not be treated as evidence for this revision.

## Work still required for a parity claim

1. **3D throughput and animation:** GPU skinning and measured high-instance/animated scenes with stable CPU, GPU and memory budgets. Native instancing covers compatible opaque runs; CPU skinning remains the portable path.
2. **Content fidelity:** glTF conformance fixtures for PBR extensions, texture transforms, morph targets and complex rigs, with matched browser/native captures and unload/reload stress. The basic mip filter path needs broader fixture coverage.
3. **Authoring:** full 3D gizmos, prefab-instance workflows, live resource dependency reload, richer diagnostics, GPU timing on native hosts and process-memory inspection.
4. **Platform release evidence:** physical Windows, Linux, Android and iOS runs, device-specific frame/memory/thermal budgets, long soaks, signed packages and release lifecycle checks. A successful local export or simulator build is not device certification.

The next acceptance gate should be a visually authored 3D scene with many repeated meshes and an animated character, measured on both browser and native hosts. That will force instancing, skinning, import and editor work to prove themselves together instead of passing isolated feature tests.
