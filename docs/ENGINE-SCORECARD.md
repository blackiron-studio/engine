# Blackiron engine capability assessment

9 September 2026 · local version 0.13.0 · historical pre-upgrade baseline

**These scores predate the 0.14 foundation upgrade.** Native meshes, glTF, textures, skeletal animation, 3D physics, serialized scenes and persistent editing now exist. See [the current implementation and evidence](ENGINE-UPGRADE-0.16.md). This table is retained as a baseline; its percentages are not current measurements.

Blackiron is a useful specialized engine for small code-authored 2D and stylized 2.5D games, with an early basic 3D renderer. It is not yet a general-purpose peer of Godot or Unity. Continuing Blackiron is compatible with the user's direction; the immediate goal should be reliable reusable systems and repeatable shipping, not feature-count parity.

## Method and scope

These are subjective engineering estimates of practical capability, authoring usability/integration and demonstrated maturity. They are not measured feature coverage, speed ratios, bug probabilities or fractions of remaining development effort. Treat nonzero estimates as roughly ±10 percentage points, not statistical confidence intervals. A zero means no corresponding engine subsystem was found, not that a game could never implement it.

The references are [Godot's stable feature list](https://docs.godotengine.org/en/stable/about/list_of_features.html) and the [Unity 6.0 manual](https://docs.unity3d.com/6000.0/Documentation/Manual/UnityManual.html). They establish comparison scope; they do not supply these scores. Unity's supported first-party tooling/packages count; third-party marketplace breadth is excluded. Scores refer to useful practical systems, not every possible premium feature. Unity is not assumed superior in every area.

Rubric: 0 absent; 25 early or narrow; 50 useful with major limits; 75 broadly capable but materially less mature; 100 roughly comparable practical scope and workflow. Full source, tooling and validation evidence inform the assessment; this is not proof of exhaustive bug absence. The example games are evidence that engine APIs work, not the subject being graded.

The equal-weight mean of the 25 fields below is 39.4% against Godot and 31.0% against Unity, rounded to **about 40% / 30%**. This is a transparent summary of this selected scorecard, not an objective industry index. Graphics fields overlap, and different project priorities would change the aggregate. Marketplace/community, XR, consoles and specialized film/enterprise tools are excluded; adding those would lower the broad-product comparison.

## Field scores

| Engine field | vs Godot | vs Unity | Evidence and limiting gap |
|---|---:|---:|---|
| Runtime and scene architecture | 60% | 50% | Shared lifecycle, transforms, fixed stepping and overlays; reusable serialized scenes and stronger ownership contracts remain incomplete. |
| 2D rendering | 70% | 60% | Sprites, tiles, rigs, vectors, lights and post effects; typography, vector edge quality and broader production coverage lag. |
| 2.5D / isometric support | 65% | 55% | Projected sprites plus orthographic meshes; sprite occlusion and complex elevated-world workflows remain limited. |
| 3D rendering | 30% | 20% | Depth, primitives, shadows, instancing and cameras work; web-only, with no imported animated-model pipeline. |
| Materials, lighting and VFX | 40% | 25% | Useful stylized shading, lights, fog and particles; no 3D material maps, mature shader authoring, GI or comparable VFX tooling. |
| Procedural graphics / art | 75% | 65% | Strong code-driven painters, palettes, rigs and geometry; narrower tooling and geometry/material range. |
| 2D physics | 60% | 55% | Rapier bodies, joints, casts and character helpers; integration stress coverage and authoring tools lag. |
| 3D physics | 5% | 5% | Planar circle/box sweeps only; no general 3D rigid-body solver, joints or mesh collision. |
| 2D animation | 50% | 40% | Tracks, state machines, rigs and blending; import fidelity and visual authoring are incomplete. |
| 3D animation | 5% | 5% | Transform animation can articulate primitive hierarchies; no skeletal skinning, imported clips or retargeting. |
| UI, text and accessibility | 45% | 35% | Controls, layout, themes and accessibility options; shaping, fallback and mature authoring support lag. |
| Audio | 50% | 40% | Synth, samples, streaming and buses; advanced spatial audio, mixing tools and device stress validation lag. |
| Input and controllers | 65% | 55% | Actions, rebinding, pointer, gamepad and touch; broad device validation and tooling remain limited. |
| AI and navigation | 25% | 15% | Grid/hex pathfinding; no general navmesh, crowd avoidance or navigation authoring pipeline. |
| Asset import and management | 25% | 15% | PNG, atlases and Aseprite sheets; fidelity bugs, no 3D importer or dependency-tracked content pipeline. |
| Scene and level editing | 10% | 5% | Inspection and code-defined content; no comparable persistent scene/prefab editor. |
| Scripting API and development workflow | 55% | 45% | TypeScript modules, CLI, dev workflow and testkit; limited editor integration, plugin contracts and API stability evidence. |
| Save/load and settings | 50% | 45% | Versioned stores, slots and settings; no general scene persistence or integrated cloud-save workflow. |
| Debugging and profiling | 30% | 20% | CPU timings, counters and inspection; no comparable GPU profiler, frame debugger or memory analysis. |
| Performance and scaling infrastructure | 40% | 25% | Batching, instancing, culling, pools and sort optimization; limited streaming/LOD and sustained scale validation. |
| Platform exports | 30% | 20% | Web/native packaging exists and desktop 2D has local evidence; native 3D absent, mobile shipping validation incomplete. |
| Networking / multiplayer | 0% | 0% | No engine-level replication, RPC, prediction or multiplayer framework found. |
| Production reliability and testing | 30% | 20% | Meaningful regression and image/GPU checks; insufficient CI execution, device, soak and release-history evidence. |
| Documentation and onboarding | 35% | 25% | API guides, CLI and examples exist; limited complete workflows, migration guidance and validated support matrix. |
| Localization / internationalization | 35% | 30% | Messages, plurals, RTL and locale formatting helpers; text shaping and layout validation remain incomplete. |

## Evidence map

Paths are relative to the engine root, <engine-root>.

- **Runtime and scene architecture:** `src/app/app.ts`, `src/scene/node.ts`, `src/scene/scene.ts`.
- **2D rendering:** `src/render`, `src/scene`, `src/art`.
- **2.5D / isometric support:** `src/scene/isotilemap.ts`, `src/three/camera.ts`, `src/three/ground.ts`.
- **3D rendering:** `src/three`, `docs/THREE.md`.
- **Materials, lighting and VFX:** `src/three/material.ts`, `src/three/shaders.ts`, `src/scene/fx.ts`.
- **Procedural graphics / art:** `src/art`, `src/scene/geometry.ts`, `src/three/geometry.ts`.
- **2D physics:** `src/physics/world.ts`, `src/scene/physics.ts`.
- **3D physics:** `src/three/ground.ts`.
- **2D animation:** `src/scene/animation.ts`, `src/scene/rig.ts`, `src/art/images.ts`.
- **3D animation:** `src/three/node.ts`, `src/three/scene.ts`.
- **UI, text and accessibility:** `src/scene/ui.ts`, `src/scene/widgets.ts`, `src/scene/text.ts`, `src/app/app.ts`.
- **Audio:** `src/audio`, `kernel`, `native/ios`.
- **Input and controllers:** `src/input`, `src/scene/touch.ts`.
- **AI and navigation:** `src/core/grid.ts`, `src/core/hex.ts`.
- **Asset import and management:** `src/art/images.ts`, `src/art/png.ts`, `src/art/atlas.ts`, `cli/commands`.
- **Scene and level editing:** `cli`, `src/core/undo.ts`.
- **Scripting API and development workflow:** `src/index.ts`, `src/testkit`, `cli/commands`.
- **Save/load and settings:** `src/save`, `src/shell/saves.ts`, `src/shell/settings.ts`.
- **Debugging and profiling:** `src/app/profiler.ts`, `src/render/webgl2.ts`.
- **Performance and scaling infrastructure:** `src/three/webgl.ts`, `kernel`, `docs/NEON-BENCHMARK.md`.
- **Platform exports:** `cli/commands`, `host`, `native`, `.github/workflows/ci.yml`.
- **Networking / multiplayer:** `src`, `cli`.
- **Production reliability and testing:** `tests`, `scripts`, `.github/workflows/ci.yml`, `docs/NEON-BENCHMARK.md`.
- **Documentation and onboarding:** `docs`, `templates`, `examples`.
- **Localization / internationalization:** `src/i18n/index.ts`, `src/scene/text.ts`.

## What is proven, and what is not

The latest recorded upgrade validation reports 339 tests / 17,155 assertions, successful TypeScript checking, real browser GPU checks, startup/pause/resume checks for the three games, and 14 passing desktop native image comparisons. Lumen is explicitly skipped in native checks because mesh 3D is web-only. These are prior pass results, not newly rerun tests for this assessment. See [Neon benchmark](NEON-BENCHMARK.md) and [upgrade validation](UPGRADE-VALIDATION.md).

The Neon-style acceptance scene uses Blackiron's own renderer: 319 visible meshes, 4,660 triangles and 11 main draws plus composition. Its short CPU submission sample was 0.70 ms median / 1.50 ms p95 on the recorded M1 Pro machine. This supports the ability to render that style. It does not establish a full shooter port, GPU frame time, long-session stability or speed parity with Godot/Unity. No identical-scene, identical-device benchmark against either engine was performed.

CI configuration exists, including native jobs and an iOS build. Execution of that CI was not established. Bun/Rust are not pinned there and the browser GPU checks are not wired into that workflow. Physical mobile tests, long audio/device interruption testing, sustained memory/frame-time budgets and a shipping release history remain unverified. The local engine directory is not currently a Git repository.

## Specific quality debt

- Aseprite loading averages durations, fails to preserve trimmed/rotated frame semantics, and does not correctly implement reverse/ping-pong tags. These are content-fidelity defects, not just missing convenience tools.
- Retained vector geometry has limited polygon/stroke semantics and no analytic antialiasing. Good-looking procedural output needs deliberate style constraints.
- Projected sprites sort as whole quads. Complex interpenetrating or tall objects need explicit occlusion solutions or the mesh path.
- 3D currently allows one world per frame and lacks native rendering, texture maps, model import and skeletal animation. Planar movement helpers do not establish 3D physics support.
- A CPU profiler and passing unit tests leave GPU stalls, resource growth and host/device behavior insufficiently characterized.
- Native audio ABI and synchronization fixes are valuable; background decoding, bounded real-time behavior and long device-interruption stress remain gates.

## Recommended order

1. **Release confidence:** version control, pinned reproducible tooling, executed CI, browser GPU regression gates, scene-restart/resource-leak checks and measured device budgets. Extend existing tests around observed failures instead of maximizing assertion counts.
2. **Reusable content:** versioned scene/prefab data, ownership and resource unloading, faithful Aseprite import and dependency-aware reload. Code-first and AI-assisted game creation still need these contracts even before a large visual editor.
3. **Complete the basic 3D path:** textured materials and glTF, skeletal clips, Rapier 3D and suitable navigation; bring mesh rendering to native with image and lifecycle parity checks.
4. **Authoring and diagnosis:** persistent inspector/scene editing, GPU timings/frame inspection, memory/resource visibility and asset error reporting.
5. **Ship and learn:** use Wisp Hollow, Highground and Lumen Salvage as acceptance games, preserving Highground's projected-island design. Ship a complete small game on the chosen targets and use actual production failures to set the next priorities.

Matching a bounded visual style is achievable well before matching a general-purpose engine. Blackiron should centralize reusable rendering, input, collision and content systems while games retain their own mechanics and art direction. A new engine feature earns confidence through repeatable integration and shipping evidence, not through its name appearing in an API.
