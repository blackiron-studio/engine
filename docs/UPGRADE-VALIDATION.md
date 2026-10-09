# Kiln 0.13 upgrade validation

**Historical 0.13 validation.** The later [0.14 foundation upgrade](FOUNDATION-UPGRADE.md) supersedes its native-3D/content limitations and test counts. The earlier results below remain a record of that pass.

9 September 2026. Engine source: `<engine-root>`. This upgrade keeps Kiln and improves the existing Wisp Hollow and Highground games. Lumen Salvage supplies the third, 3D example. The [roadmap](ROADMAP.md) is the proposal for the remaining quality and capability gaps; this report records work actually implemented and checked.

The later [Neon Bastion benchmark pass](NEON-BENCHMARK.md) adds further rendering, movement and presentation work. Its newer results supersede the test count, game screenshots, build sizes and game frame samples below; the original kernel/audio/Rust results remain the evidence for those unchanged components.

## Delivered

- Scene-owned physics with pause, time-scale, hit-stop and teardown fixes; safe tree mutation and input dispatch; correct UI hit order, held-key rebinding, animation target identity, nested body poses and failed-save reporting.
- Wasm/Rust protocol consistency, the 12-float vertex capacity fix, bounded/reused sort storage, dimension-aware atlas growth and stable paged GPU glyphs.
- Correct stereo frame/sample ABI. Rebuilt Wasm artifacts and iOS device/simulator XCFramework. iOS audio state now has synchronized ownership and a nonblocking callback fallback.
- Retained `Graphics2D` with concave polygon triangulation, ellipses, rounded rectangles, strokes, transform-aware culling and reusable cached vertices. Wisp Hollow uses it for its keeper, grove, shrine, paths and UI while preserving sprite/rig alternatives.
- Real 3D transforms, indexed geometry, perspective/orthographic cameras, picking, lit materials, depth, directional shadows, instancing, culling, transparency sorting and MSAA, integrated with existing UI and post effects. See [3D API](THREE.md).
- Highground's brighter procedural art, island title backdrop, HUD/map, connected collectibles, deterministic effects, completion/restart and complete saved world state. Existing count-only saves receive a documented migration fallback.
- Three featured games in the gallery. Missing native goldens now fail unless `--update` is requested; unsupported project targets are explicitly skipped and never counted as passing.

## Checks

| Check | Result |
|---|---|
| TypeScript typecheck | Pass |
| Bun unit/integration suite | 298 tests pass; runtime, geometry, games and 3D regressions included |
| Rust kernel, release + physics/codecs/render | 16 tests pass |
| Rust host, release | 4 tests pass |
| Original 13 audit probes | Correct behavior; nested-transform error within 0.000004 units; Wasm exposes 3072 floats for a draw needing 2880 |
| Original native audio ABI repro | All 1024 floats written for 512 stereo frames; no stale tail |
| Browser GPU regression | Zero GL errors at 50/60/64 quads with capacity 64; repeated glyph preserved across 5 texture pages |
| Browser 3D pixel regression | Correct front/back occlusion, exact HUD colour, 24,193 shadow-affected pixels; 27 visible meshes in 3 main + 2 shadow draws |
| Browser checks for actual Wisp Hollow / Highground / Lumen | All pass startup, input, pause/resume and nonempty GPU rendering, zero GL errors |
| Desktop native visual suite, QuickJS | 14 comparisons pass across existing projects; Lumen explicitly skipped as web-only |
| Production web builds | All 3 games build; gzip JS: Wisp 161.4 KB, Highground 150.9 KB, Lumen 144.6 KB |
| iOS build validation | Device + simulator kernel framework rebuilt; all Swift sources typechecked against simulator SDK |

Five deliberately changed Wisp/Highground baselines were inspected and updated. The nine unchanged native comparisons passed before rebaselining. The final run then passed all 14, with no further baseline writes. Original images and a pre-change source archive were retained in the evidence directory.

Lumen also has a complete-route test that wins through actual movement/collision/jumps without teleporting. Highground tests save/restore exact world state, avoid repeated fog updates, complete the coin objective and handle legacy saves. Wisp tests cover first-frame placement, pause, title pointer transitions, deterministic rules and safe zero-time updates.

## Performance evidence

Measured on Apple M1 Pro, 16 GB memory. The old and new projected-kernel benchmarks use the same prebuilt stream, 20 warmups and 150 measurements. At 30,000 sorted quads, Wasm median/p95 fell from **6.296/8.493 ms to 2.127/2.870 ms**. At 10,000, it fell from 1.776/2.090 ms to 0.614/0.813 ms. No draws were dropped. These numbers measure CPU kernel execution, excluding GPU execution and game logic.

Isolated Chrome showcase smoke checks at 1280×720 recorded the following CPU work for an `App.frame` call over 60 samples. These are short submission benchmarks, not GPU timings, frame-pacing guarantees, mobile results or soak tests:

| Game | Median / p95 CPU frame work | Main observations |
|---|---|---|
| Wisp Hollow | 1.2 / 2.4 ms | 16 render calls in the sampled scene |
| Highground | 0.3 / 0.7 ms | 13 render calls; fog work only at cell changes |
| Lumen Salvage | 1.7 / 3.5 ms | 310 meshes, 30,084 triangles, 33 main + 18 shadow draws |

## Reproduction and evidence

```sh
bun run typecheck
bun test
bun run check:3d
bun run check:showcases
KILN_NO_V8=1 bun cli/kiln.ts verify --host desktop --js quickjs
# In kernel/: cargo test --release --features 'physics codecs render'
# In host/:   cargo test --release
```

`check:showcases` uses isolated browser profiles and accepts an optional project directory. Set `CHROME_PATH` when Chrome is outside its default macOS location. Generated browser screenshots/results are under `.kiln/verification`. Broader logs, original-audit reruns, timing JSON, source backup and original images are in `<local-verification-artifacts>`.

## Practical limits

This release does not establish complete Godot/Unity parity. Native 3D, glTF/model import, full 3D physics/navigation, skeletal 3D animation, production content authoring and full cross-device release validation remain open. The 3D renderer supports one 3D world per frame with ordinary 2D scene overlays; material texture maps are not yet supported. The native 2D path was exercised on desktop; Android and physical iOS devices were not tested in this pass. iOS stream loading may produce brief silence because the callback deliberately declines a contended lock; background decoding/ownership handoff and audio soak tests remain necessary. Full text shaping and exact Aseprite import semantics also remain open. The repository still needs version control and live CI execution; it is currently a local source tree with a backup.
