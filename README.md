# Blackiron Engine

Blackiron Engine is an open-source TypeScript game engine by **Blackiron** for 2D, projected 2.5D and basic 3D. It shares scenes,
input, audio, UI, saves and tooling across games. A Rust/Wasm kernel accelerates 2D
rendering, physics and audio. The new 3D path adds explicit mesh scenes and GPU depth,
lighting and shadows on WebGL2 and native wgpu/Metal. Version 0.14 adds reusable
scene/prefab documents, texture maps, glTF/GLB, skeletal animation, Rapier 3D,
persistent editing and resource/GPU diagnostics. See the [foundation upgrade](docs/FOUNDATION-UPGRADE.md)
for supported scope, examples and executed validation.

Version **0.17.0** completes the Blackiron rename: `blackiron.json`, the `blackiron` CLI,
`@blackiron-studio/engine` imports and `blackiron.export/v1` manifests are the canonical interfaces.
Older Kiln projects require the backed-up, one-time [migration](docs/MIGRATION-0.17.md).
The CLI entry point is `bun cli/blackiron.ts`.
This repository includes the reusable engine, starter templates and demonstration games.
Studio games are maintained separately and are not included here.
The package is available from source; it has **not** been published to npm.

Start with the five flagship games: **Wisp Hollow** (`examples/demo`, 2D), **Highground**
(`templates/isometric`, 2.5D), **Lumen Salvage** (`examples/lumen`, 3D), **Signal Breach** (`examples/breach`, 3D FPS), and **Lowline** (`examples/lowline`, 2D open city). The first two
are the existing games, improved in place. Run `bun run gallery` to play them together.

Version 0.15 adds reusable first-person input, capsule movement, combat, weapons and
navigation, demonstrated by Signal Breach. See [FPS APIs and validation](docs/FPS.md). Lowline adds reusable arcade vehicle dynamics and circle collision through `@blackiron-studio/engine/physics`; [play and extend the city](examples/lowline/README.md).

Version 0.16 extends the shared FPS controller, combat and weapon layer to native hosts, adds native mouse capture and portable sign textures, and makes exports preserve the previous package on build failure. See [the native/export upgrade](docs/ENGINE-UPGRADE-0.16.md) for validation and remaining limits.

The [current roadmap](docs/ROADMAP.md) defines the remaining work toward Godot/Unity
quality. The [current validation](docs/ENGINE-UPGRADE-0.17.md) separates verified features
from platform and feature gaps. This engine is under active development; historical
sections below describe how earlier releases were built, not a claim of current parity.

```
engine/
  src/
    platform/ the host seam: time, frames, pixel ratio, assets, image decoding, storage;
              WebPlatform, HeadlessPlatform, NativePlatform (talks to a host object)
    core/     math, seeded rng, tweens, events, fixed-step clock, tile grids, grid and hex helpers
    art/      headless pixel painter, materials, ramps, 5x7 font, sprite registry, autotiles,
              imported PNG and Aseprite sheets, atlas packer
    render/   Renderer contract; WebGL2 (native targets, lights, bloom chain, glyph text,
              LUT / grain / scanlines), Canvas 2D fallback, NativeRenderer (streams into the
              host's kernel), recording fake
    kernel/   the kernel protocol and the TypeScript reference; the Wasm build embedded
    content/  versioned scenes/prefabs, codecs, undo/redo, resource caches and scopes
    three/    Scene3D, cameras, textured materials, glTF, animation, physics, WebGL2/native meshes
    physics/  PhysicsWorld over the kernel's rapier2d: bodies, colliders, joints, queries
    scene/    Node, Node2D, Scene, Camera2D, Sprite, AnimatedSprite, TileMap, ParallaxLayer,
              LightLayer, Light2D, ParticleEmitter, Motes, CloudShadows, Label, Panel,
              NineSlice, Button, Bar, Anchor, Row, Column, Grid, FocusGroup, TouchControls, VirtualSticks,
              TextInput, ScrollContainer, RichText, Tooltip, physics bodies, AnimationPlayer,
              StateMachine, themes, transitions, SpritePool (thousands of sprites in the kernel),
              IsoTileMap and projected cameras (isometric, tilt, height on any node)
    audio/    synth and generative music "moods" over an AudioBackend: the kernel's DSP in an
              AudioWorklet on the web, on AVAudioEngine natively; samples on both
    input/    ActionMap (keys, pad buttons to named actions), Pointer (multi-touch), GamepadInput
    save/     versioned Store with migrations; localStorage or memory
    app/      App: platform, canvas, loop, layout modes, scene stack, debug overlay, capture,
              profiler (per node and per system, F4)
    testkit/  headless App, synthetic input, drawn-sprite assertions
  cli/        blackiron dev | build | export web|ios|desktop|android | run ios|desktop|android | verify | atlas | new | test
  host/       the generic native host (Rust): winit, V8 or QuickJS, cpal, fontdue, gilrs; draws
              through the kernel
  kernel/     the compiled kernel (Rust): batching, node tables, particles, audio, physics and
              the wgpu renderer every native host shares; build.ts
  native/ios/ the iOS host: Swift, JavaScriptCore, a CAMetalLayer the kernel draws into (copied
              into every exported project)
  templates/  blank, topdown, platformer, tactics, physics, isometric starters for `blackiron new`
  examples/demo/   Wisp Hollow, the 2D flagship
  examples/lumen/  Lumen Salvage, the 3D flagship
  examples/bench/  the stress scene: tiles, sprites, particles, lights, text
  tests/           engine tests (bun test)
```

## Quick start

```bash
git clone https://github.com/blackiron-studio/engine.git
cd engine
bun install
bun test                       # engine + demo tests
bun run typecheck
cd examples/demo && bun run dev    # http://localhost:4200
```

Every project shows a frame-rate pill in the bottom-right corner (fps, frame time, draw calls;
`"fps": true` in `blackiron.json`, F3 toggles it, `?fps=0` hides it). The backquote key opens the
full debug overlay with the target size and a frame-time graph, and F8 captures a PNG.
`bun run gallery` serves every project.

## A game in four files

`blackiron.json` declares the project:

```json
{ "name": "My Game", "entry": "src/main.ts", "art": "src/art.ts",
  "viewport": { "width": 1280, "height": 720, "scale": "fit" },
  "render": { "scale": "native", "snap": "world" },
  "renderer": "auto", "background": "#101018",
  "fonts": ["https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@500;700&display=swap"],
  "post": { "bloom": 0.6, "bloomThreshold": 0.6, "vignette": 0.3, "lut": "dusk" } }
```

`viewport.scale` is `fit` (letterbox), `integer` (whole multiples, for retro), `none` or
`expand` (fill the window and let the logical size follow its aspect; UI uses `Anchor`).
`render.scale` is `native` or a multiplier; `render.snap` is `world`, `all` or `none`.

`src/art.ts` paints sprites; nothing else lives here so `blackiron atlas` can import it headlessly:

```ts
import { defineSprite, ramp } from "@blackiron-studio/engine/art";
export const HERO = defineSprite("hero", { w: 12, h: 16, origin: [0.5, 0.95] }, (p) => {
  p.box(3, 7, 6, 7, ramp("#c0574a"));
  p.ball(6, 4.5, 3.4, 3.4, ramp("#e2b48d"));
});
```

`src/main.ts` builds scenes from nodes. It exports one `main` function that receives the
App; the CLI wraps it in the right bootstrap for each target (a `<canvas>` on the web, the
host bridge natively), so the game never knows which platform it is on:

```ts
import "./art.ts";
import type { App } from "@blackiron-studio/engine/app";
import { Scene, Sprite, Label } from "@blackiron-studio/engine/scene";

class Main extends Scene {
  hero!: Sprite;
  override ready() {
    this.hero = this.world.add(new Sprite("hero", this.width / 2, this.height / 2));
    this.ui.add(new Label("ARROWS TO MOVE", this.width / 2, 8, { align: "center" }));
  }
  override update(dt: number) {
    const v = this.app.input.vector("left", "right", "up", "down");
    this.hero.x += v.x * 80 * dt;
    this.hero.y += v.y * 80 * dt;
  }
}

export default async function main(app: App) {
  app.input.map({ left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"], up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"] });
  app.scenes.change(new Main());
}
```

Rules code stays out of nodes. The demo keeps its whole game in `game.ts` as a plain state
object plus a `tick` function, and its scenes only mirror that state into sprites. That is
what makes the rules testable with `bun test` and portable later.

## CLI

Run commands through `bun cli/blackiron.ts`, or use the `blackiron` executable
when linking the source package locally. Native validation remains available in the manual
[Native and GPU validation workflow](.github/workflows/native.yml).

| Command | What it does |
|---|---|
| `blackiron dev [--port 4200] [--open]` | Serves the project, bundles on request, reloads the page on change. `/dev/atlas.png` shows the baked atlas; `POST /dev/screenshot` saves one. |
| `blackiron gallery [dirs...] [--port 4200]` | Serves the demo and every starter behind one menu page, each under its own path. Extra project directories can be added. |
| `blackiron build [--report] [--target native]` | Minified bundle in `dist/` with an `index.html`. `--report` prints raw and gzipped sizes. `--target native` writes `dist/native/` instead: the game as one script for a host, the prebaked atlas and a manifest. |
| `blackiron export web --single-file` | The build plus one self-contained HTML file with the bundle inlined. |
| `blackiron export ios [--out dir]` | An Xcode project in `dist/ios/<Name>/`: the Swift and Metal host, the native build as bundle resources, and a `project.yml` for XcodeGen. Open it in Xcode or archive it from the command line. |
| `blackiron run ios [--device "iPhone 17 Pro"]` | Exports, builds with `xcodebuild` for the simulator, boots the device, installs and launches the app. |
| `blackiron run desktop [--js v8\|quickjs] [--snapshot out.png]` | Builds the game and the host and opens a window; V8 by default on desktops. |
| `blackiron verify [--host desktop\|ios\|android\|all] [--update]` | Renders every project's `snapshots` scenarios on a host with a fixed clock and scripted taps, and compares the pixels with the goldens in `<project>/snapshots/<host>/`. `--update` accepts the current renders. |
| `blackiron atlas [--out atlas] [--split]` | Bakes every sprite without a browser into `atlas.png` and `atlas.json`; `--split` also writes one PNG per sprite. |
| `blackiron new <dir> [--template <name>]` | Scaffolds a project from `templates/<name>`; `--list` shows them. |
| `blackiron test` | Runs `bun test` in the project. |

## Starters

`blackiron new mygame --template <name>` copies one of these and points it at the engine. Each is a
complete, small game with the same skeleton: rules as pure state in `src/game.ts` with tests,
sprites in `src/art.ts`, title, play and over scenes, and a README that says where to change
things. They are part of the engine's own typecheck and `bun test`, so an API change that
breaks a starter fails the build.

| Template | What it is | What it exercises |
|---|---|---|
| `blank` | One scene, one sprite, arrow keys | The minimum |
| `topdown` | Scrolling tile world, gems to gather, slimes that chase, hearts | TileMap with autotiles, y-sorted actors, camera follow, particles, saves, touch |
| `platformer` | ASCII level, gravity, coyote jump, one-way platforms, coins, spikes, a flag | Autotiled TileMap collision, animation states, ParallaxLayer, touch buttons |
| `tactics` | Turn-based grid, four units a side, terrain, ranges, an enemy phase | Flood fill and pathfinding, pointer hit-testing, tweened moves, anchored HD panel |
| `physics` | Crate Yard: a runner in a yard of crates and balls, a name field, a scrolling log | Physics bodies and the character controller, AnimationPlayer and StateMachine, RichText, TextInput, ScrollContainer, Tooltip, theme, transitions, positional sound |

Until the package is published, projects point at the engine source directly.
The engine is resolved through `paths` in each project's `tsconfig.json`, which Bun's bundler and test runner both honour, so projects need no `bun install` at all. The CLI is called as `bun <engine>/cli/blackiron.ts`; the template wires this up.

## Renderer

Two backends behind one interface. WebGL2 batches every sprite, rect and glyph of a frame
over three textures (atlas nearest, atlas linear, glyph cache) into an offscreen target at
the display's native resolution, accumulates a half-resolution light target from
`LightLayer` and multiplies it in, runs a two-level bloom chain, then composes saturation,
contrast, brightness, tint, an optional LUT, vignette, grain and scanlines in one pass,
with the UI layer drawn last from its own untouched target. Canvas 2D is the compatibility
fallback: sprites, text, lights and the simple post chain, no LUT, grain or sprite tint.

Post settings live on each scene (`scene.post`) and start from the `post` block in
`blackiron.json`, so a hit flash is one tween on `post.tintAmount`.

## Lights, text, tiles

```ts
const lights = this.world.add(new LightLayer(0x2c3560));           // ambient
const lantern = lights.add(new Light2D({ radius: 320, color: 0xffb060, flicker: 0.1 }));
lantern.follow(state.player);
ember.emissive = true;                                             // unlit and blooming

new Label("EMBERS 12", 0, 0, { font: { family: "Instrument Sans", size: 22, weight: 700 }, shadow: 0 });
const hud = this.ui.add(new Anchor({ x: "right", y: "top", safe: 16 }));

const map = new TileMap({ data: rows, legend, tileSize: 32,
  tiles: { 1: { autotile: "ground" }, 2: "platform", 3: { frames: ["coin.0", "coin.1"], fps: 8 } },
  solid: [1], oneWay: [2] });
const r = map.moveBody(player, dx, dy);
```

## Platform seam

`src/platform/` is the only place the engine touches the host. `WebPlatform` wraps the DOM;
`HeadlessPlatform` runs tests and the CLI; `NativePlatform` talks to a host object that a
shell installs as `globalThis.__blackironHost`. Every layer above is shared.

## Kernel

The scene tree, UI and game rules stay in TypeScript. Everything that scales with sprite,
tile and particle counts runs in `kernel/`, a small Rust library with no dependencies:
the renderer writes one command stream per frame (`src/kernel/protocol.ts`) and the kernel
expands it into vertices and draw commands, owns retained batches (`TileMap` writes its
tiles once and draws with one culled command per frame), particle emitters and node tables
(`SpritePool`: sprites the kernel moves, animates, culls and draws with no script work per
sprite). On iOS it is a static library the script reaches through no-copy typed arrays; on
the web it is 71 KB of WebAssembly embedded in the bundle; in tests it is the TypeScript
reference in `src/kernel/ts.ts`, which `tests/kernel.test.ts` and `tests/nodes.test.ts`
hold to the Wasm build vertex for vertex. With the `render` feature the kernel also carries
the wgpu renderer (`kernel/src/render/`), so the desktop, Android and iOS hosts draw
through one implementation.

```bash
bun kernel/build.ts        # needs Rust with the wasm32 and aarch64-apple-ios(-sim) targets
```

Under device conditions on iOS (JavaScriptCore without a JIT) the bench project went from
40 FPS at 20.8 ms per frame to 60 FPS at 6.1 ms. `?kernel=ts` runs the reference on the web
for comparison; `kernel` and `kernelOptions` in `blackiron.json` choose and size it.

## Hosts

| Platform | Host | Export |
|---|---|---|
| Web | the browser (WebGL2, AudioWorklet) | `blackiron export web` |
| iOS | Swift + JavaScriptCore, the kernel's renderer on a CAMetalLayer (`native/ios`) | `blackiron export ios`, `blackiron run ios` |
| macOS, Windows, Linux | the generic host (`host/`) | `blackiron export desktop`, `blackiron run desktop` |
| Android | the generic host behind GameActivity | `blackiron export android`, `blackiron run android` |

The generic host is one Rust program: winit opens the window and delivers input, the
kernel's wgpu renderer draws through Metal, Vulkan, DirectX 12 or OpenGL, V8 runs the game
on desktops (QuickJS on Android, and as the fallback everywhere; `--js` picks), cpal plays
what the kernel synthesiser renders, fontdue rasterises
the bundled fonts, gilrs reads controllers on desktops and the generated BlackironActivity forwards Android controllers and haptics over JNI. It consumes the same bundle as the iOS host
(`blackiron build --target native`) and speaks the same host protocol, so a game needs no
changes to run on it. `blackiron-host <bundle> --snapshot out.png --snapshot-frame 60 --exit`
writes a frame without a display session for tests; `--tap X,Y:FRAME` scripts input and
`--fixed-dt 16.667` makes the clock synthetic so the frame is reproducible.

Building the host needs Rust; the Android export also needs the Android SDK and NDK,
Java 17, Gradle and `cargo-ndk`. Windows and Linux builds run on those platforms with
their own C toolchains (the host bundles QuickJS in C).

## Physics, animation and UI

```ts
// blackiron.json: "physics": { "gravity": [0, 1400], "pixelsPerMeter": 100 }
const crate = this.world.add(new RigidBody2D({ shape: { rect: [32, 32] }, collider: { friction: 0.6 } }, 300, 100));
crate.add(new Sprite("crate"));
const hero = this.world.add(new CharacterBody2D({ shape: { capsule: [26, 9] }, snap: 6 }, 160, 400));
hero.velocity.y += 1400 * dt;   // gravity is the game's to apply
hero.moveAndSlide(dt);          // slides along walls and floors; hero.grounded afterwards
const zone = this.world.add(new Area2D({ shape: { circle: 22 } }, 900, 300));
zone.onEnter = (other) => { if (other === hero) collect(); };
const hit = this.app.physics?.raycast(hero.x, hero.y, 0, 1, 400);

const anim = this.add(new AnimationPlayer());
anim.define("squash", { properties: [{ target: sprite, property: "scaleY", keys: [[0, 0.7], [0.3, 1, "outQuad"]] }] });
new StateMachine(anim).add("idle", { clip: "idle" }).add("run", { clip: "run" }).transition("idle", "run", () => speed > 0);

this.ui.add(new TextInput(-160, 20, 320, 44, { placeholder: "Your name", onSubmit: start }));
const log = this.ui.add(new ScrollContainer(0, 0, 300, 150));
log.content.add(new RichText("[b]Hello[/b] [color=#ffc857]world[/color] [icon=star]", 0, 0, { wrap: 280 }));
this.app.scenes.change(new PlayScene(), { transition: "wipe", duration: 0.7 });
this.app.audio.play("thud", { x: crate.x, y: crate.y });
this.app.audio.setMood("yard", { crossfade: 1.2 });
```

Physics is rapier2d compiled into the kernel: the same results on every platform. On the
web the module is fetched only by games that enable it.

## The kernel owns the scene (0.8)

- **SpritePool.** A node table in the kernel: `pool.spawn({ sprite, x, y, vx, vy, life })`
  once, then the kernel integrates velocity, gravity and damping, bounces, wraps or kills at
  the bounds, plays frame animations, expires, culls and draws every frame. `pool.get(h)`
  reads a node back, `pool.set(h, {...})` changes it, `pool.attachPhysics(world)` makes
  nodes follow physics bodies in bulk. The bench moves 10,000 sprites in 0.9 ms of script on
  the web (3.3 ms as script nodes) and at 60 FPS with QuickJS on the Android emulator.
- **One renderer.** The wgpu renderer moved from the host into the kernel behind a C ABI;
  the Swift host became a thin shell (JavaScriptCore, audio, input, a CAMetalLayer) and
  its Metal shaders are gone. The 2D effects path is shared. The new WebGL2 mesh path still requires a native counterpart.
- **V8 on desktops.** The host's script bindings are engine-neutral (`host/src/script/`),
  with QuickJS and V8 behind one interface. The bench's script-heavy mode (10,000 script
  sprites) runs at 85 ms a frame on QuickJS and 2.7 ms on V8. Android keeps QuickJS: Deno's
  prebuilt V8 has no Android library. On iOS, JavaScriptCore is inspectable from Safari's
  Develop menu (the context is named "Blackiron").
- **Profiler.** `app.profiler.enable()` (or F4) times every node's `update` and `render`
  by class or name and the frame's sections (input, update, physics, tweens, draw, present),
  averaged over recent frames; `app.profiler.report()` for code, an overlay panel on screen.
- **Visual harness.** `blackiron verify` renders each project's `snapshots` scenarios with a
  synthetic 60 Hz clock and scripted taps on the desktop host, the iOS Simulator or an
  Android device, and compares them with golden PNGs (a diff image on failure). Under that
  clock the platform reports `deterministic`, so an unseeded game seeds from a constant and
  the FPS pill is hidden; seed anything else from `app.rng` and two runs match.
- **CI.** `.github/workflows/ci.yml` runs the tests on Linux, builds the host with V8 on
  Linux, Windows and macOS, runs the harness on lavapipe, WARP and Metal, and uploads the
  demo builds as artifacts. Windows and Linux binaries cannot be produced from a Mac; CI is
  where they come from.

## Isometric and 2.5D (0.9)

Set `scene.camera.projection` and the world layer gains a third axis: ground (x, y) plus a
height z on every `Node2D`. The kernel projects positions through one matrix (2:1 isometric
diamonds, a three-quarter tilt, or plain top-down with height) and sorts the whole pass by a
depth key, so sprites, tiles, pools and shadows order themselves; the UI layer stays flat.
`IsoTileMap` takes a tile grid and an elevation grid and builds floors and cliff faces as a
world-space batch, with per-cell tint for fog of war and `heightAt` for whatever stands on
it. `castShadow` draws a blob shadow from the atlas's `shadow` sprite; pools get `gravityZ`
and a floor so coins hover and sparks arc without script. `camera.screenToWorld(sx, sy, z)`
picks cells at a height. The Highground starter (`templates/isometric`) shows all of it.
The proposal, with what is still open (90° camera steps, a mesh pass), is in
`docs/proposals/0.9-isometric.html`.

## The shell (0.10)

The parts every game rebuilds, as optional modules under `@blackiron-studio/engine/shell`. A game
takes what it wants; the core never depends on them.

```ts
import { PauseScene, TitleScene, bindShellActions, createSaveSlots, createSettings } from "@blackiron-studio/engine/shell";

bindShellActions(app);                       // up, down, confirm, back, pause, unless the game bound them
const settings = createSettings(app);        // volumes, shake, reduced motion, text scale, bindings; applied on load
const saves = createSaveSlots<Progress>({ key: "mygame", version: 1, slots: 3, initial: () => ({ level: 1 }), summarize: (p) => `level ${p.level}` });
app.scenes.change(new TitleScene({ title: "My Game", entries: [{ label: "Play", onPick: () => app.scenes.change(new PlayScene()) }] }));
// in the game: app.scenes.push(new PauseScene({ settings, onQuit }), { overlay: true });
```

`Settings` is one persisted document that reaches the engine: audio volumes and mute,
`app.accessibility` (camera shake scale, reduced motion, text scale, which the camera,
transitions and theme honour), and key bindings through `app.input`. `SaveSlots` keeps
numbered slots with an index of summaries. `Hints` shows one hint at a time from a list of
conditions, writing the key or button for `{action}` on the device the player last used,
and remembers what was seen. The menus (`TitleScene`, `PauseScene`, `SettingsScene`,
`ControlsScene`, `SaveSlotsScene`) are `MenuScene`s: a themed column of rows driven by
actions, pointer or touch, that pop themselves on back. Highground wires all of it.

## The style bible

`defineStyle({ palette, outline, rim })` once next to the art: the bake snaps every sprite
to the palette and gives `style: "full"` sprites the outline and a rim light, so procedural
painters and hand-placed pixels read as one hand's work. Draw pixel art as rows of
characters with a legend (`defineRowSprite`, `defineRowAnimation`, `stackRows`,
`mirrorRows`); swap the legend to recolour a character.

## Importing art

`blackiron art import knight.png --name knight --anim "walk=down:4,5;up:1;left:2,6;right:3,7"
--anim "attack=right:8,9" --mirror attack --event attack:9=hit --anim hurt=13 --hold hurt=0.4`
turns a generated or drawn sheet into game pixels: the background is keyed out, each pose
found, the real pixel size measured and resampled, colours snapped to the palette, frames
stood on one baseline. It writes `assets/knight.png`, `knight.json` (facings, events, holds,
hitboxes, pitch, height) and a preview; the art module says
`defineSpriteSet("knight", "assets/knight.json")` and a scene plays `knight.walk` on an
`AnimatedSprite` whose `facing` picks the side. `blackiron art check` lints the assets folder
against the style bible; `blackiron art brief` prints the prompt that gets art back in the right
shape. Sheets from Aseprite import the same way. `assets/` ships with every build.

## Rigs

`blackiron art parts knight.png --frame 3 --cut head=20,11,33,31 --cut torso=... --name knight-rig`
cuts one frame into parts on a shipped template (`humanoid`, `quadruped`, `flyer`, `blob`)
and works out the bone pivots from where the parts sat. `defineRig("knight-rig", ...)` loads
it; `new Rig2D("knight-rig")` stands it up; `play("walk")`, `layer("upper", "swing")`,
`crossfade("run", 0.2)`, `blend("walk", "run", speed)`, `reach("weapon", x, y)` (two-bone IK),
`aim("head", x, y)`, `face(dx)` and `onEvent` drive it with the engine's procedural clips
(idle, walk, run, swing, thrust, hurt, fall, cast, carry) or keyframed clips from JSON.
`Skin2D` cuts a single sprite into a weighted mesh that bones bend, on its own or following a
rig. `examples/knight` shows the sheet and the rig side by side; Wisp Hollow's hero is the rig.

## Lights, shadows and materials

`Light2D` is a procedural light shaded against the normals of what it falls on: give a sprite
`normal: "bevel"` (or a normal painter, or a normal image for imports) and its edges catch the
light. `Light2D({ shadows: true })` is cut by `LightOccluder2D` polygons and by tile maps with
`occlude: true`. `sprite.material = { kind: "flash", p0: 0.8 }` flashes white; `dissolve`,
`outline` and `silhouette` are the other materials, all one draw. Nothing here needs a shader
of your own.

## Tiles

Tiles never show seams: the atlas extrudes every sprite with an opaque border one texel into its padding, so linear sampling at a tile's edge reads the tile, not the gap. `edge: "clear"` keeps the gap for a sprite that wants an outline material at its border.

Autotiles come in two shapes: sixteen by edge mask, or forty-seven blob tiles (`{ mode: "blob" }`)
that handle corners. `blackiron art tileset ground.png --tile 16 --terrain blob` slices a sheet in
`BLOB_MASKS` order, checks every seam the terrain joins, and writes a manifest `defineTileSet`
loads. `TileMap.pathfind(from, to)` is A*; `attachPhysics(world)` turns solid runs into merged
colliders and one-way rows into platforms.

## Audio, physics, locale

`audio.setEffects("music", { lowpass: 600, reverb: { mix: 0.3 } })` puts a filter, a reverb or
an echo on a bus in the kernel. `await audio.loadMusic("theme", await platform.loadBytes("music/theme.ogg"))`
then `audio.playMusic("theme")` streams a track: the kernel keeps the compressed file and decodes
as it plays, with a crossfaded loop, on the web (`audio.wasm`), iOS and the desktops alike. `world.shapeCast` sweeps a shape; `oneWay` colliders let a
character jump up through a platform. `createI18n({ messages })` and `t("coins", { count })`
handle plurals, selects and Intl formatting; `Row({ reverse: true })` for right-to-left.
`app.accessibility.announce(text)` reaches the screen reader on every platform with one.

## Feel

`scene.hitStop(0.05)` freezes the world for a few frames while the UI keeps time;
`scene.timeScale = 0.3` is slow motion. `TextPops` is pooled floating text for damage
numbers. Moods take `drums`, a chord `progression`, `arp` and `drive`, so a game's music
has a beat without shipping samples.

## Native hosts

The engine runs as one script inside the host's JavaScript engine (JavaScriptCore on Apple
platforms) and never touches a DOM. Instead of drawing, `NativeRenderer` fills a single
vertex buffer and a short command list per frame and hands them to the host together with
the post-processing settings, so the host's GPU code is a small fixed pipeline rather than a
port of the engine:

| Host provides | Engine provides |
|---|---|
| `now`, storage, bundled files, `loadImage` | `__blackiron.frame(t)`, `pointer`, `key`, `resize`, `visibility` |
| `uploadTexture(slot, w, h, rgba)` for the atlas, glyph cache and LUT | `uploadTexture` calls when they change |
| `submit(vertices, count, commands, count, post)` once per frame | commands: begin, pass (world, light, overlay), draw, end |
| `rasterizeGlyph(family, size, weight, style, ch)` with the platform's text engine | the same glyph cache the WebGL2 backend uses |
| `screen` (points, scale, safe-area insets) | letterboxed layout, present rect, safe insets for `Anchor` |

`native/ios/` is the iOS host: `BlackironRuntime` owns the JSContext and the bridge, `BlackironHost`
implements the table above (CoreText for glyphs, `UserDefaults` for storage, the app bundle
for files) and `MetalRenderer` plays the command list into the same targets and bloom chain
as WebGL2, with `Shaders.metal` carrying the composite. The shaders ship as source in the
app's `Blackiron/` folder and compile on first launch, so building needs no Metal toolchain.
`blackiron export ios` copies the host next to the native build and generates the Xcode project; the `ios` block in `blackiron.json` sets the
bundle id, orientation, minimum iOS version, icon and signing team.

iOS exports accept build-system inputs without changing `blackiron.json`:

```sh
blackiron export ios --out generated/ios --version 1.0.0 --build-number 42 \
  --bundle-id com.example.game --signing external
```

CLI values override `version`, `buildNumber`, `ios.bundleId`, `ios.team` and
`ios.signing` in `blackiron.json`. `--team-id` takes a ten-character Apple team ID.
Versions must be `major.minor.patch`; build numbers are positive integers up to
2100000000. Defaults are version `1.0.0`, build number `1`, and a bundle ID derived
from the game name. Invalid inputs fail before export work or output replacement.

Signing modes are `external` (let the archive command or CI supply signing),
`automatic` (Xcode automatic signing, with a team supplied now or at build time),
and `unsigned` (disable signing explicitly). Without an explicit mode, a configured
team selects `automatic`; otherwise exports use `external`. `blackiron run ios` always
exports and builds unsigned for the simulator. Exporting requires no publisher
credentials and makes no store calls.

The generated plist references `$(MARKETING_VERSION)` and
`$(CURRENT_PROJECT_VERSION)` with export defaults stored in Xcode settings. An
archive command can override these, along with `PRODUCT_BUNDLE_IDENTIFIER` and
`DEVELOPMENT_TEAM`, without regenerating the project. A build adapter supplies
credentials, selects signing, allocates build numbers and publishes the result.
Blackiron does not interpret any provider-specific environment variables.

Each iOS export contains `blackiron-export.json` (`schema: "blackiron.export/v1"`) with the
engine name/version, target, relative `projectPath`, scheme, bundle ID, version,
build number, signing mode and optional team ID. These values describe export
defaults; later Xcode overrides are reflected in the final app's `Info.plist`.
The exported Swift host, native game bundle, assets and kernel XCFramework are
self-contained and can be moved to another build directory.

`bun run check:ios-export` on macOS performs a real CLI export, removes the
original source after relocating the project, builds for the simulator and
archives for a device with signing disabled, then checks overridden identity and
version values in both final apps. Evidence is saved under
`.blackiron/verification/ios-export-contract/`. This checks packaging and compilation;
it does not validate distribution credentials or store submission.

Also native on iOS: sound (the kernel synthesiser on `AVAudioEngine`), the project's fonts
(bundled by `blackiron export ios` and registered with CoreText), game controllers, haptics
(`app.haptic("light")`), and an app icon generated from a sprite (`ios.icon`).

## Decisions taken in 0.10

- The shell is a library, not a framework: functions and scenes a game composes, with the
  engine core unaware of them. Godot and Unity ship none of this; templates carry it.
- Settings own their effect: `Settings` applies itself to audio, accessibility, theme and
  input rather than games reading values, so a setting changed in any menu is live at once.
- Saves are versioned stores per slot with an index, not one blob: slots migrate on their
  own and the title can list summaries without loading anything.

## Decisions taken in 0.9

- Projection is a property of the camera and applies per pass in the kernel; positions are
  projected, linear parts (scale, rotation) stay in screen space, so sprites are billboards.
- Ordering is a stable sort by depth key inside the kernel, not a depth buffer: blending
  stays correct and WebGL2 needs nothing new. Floors carry a negative bias so anything on a
  cell draws over it; shadows sit between the floor and their node.
- Physics stays on the ground plane; height is gameplay and presentation.

## Decisions taken in 0.8

- Node tables are flat records (32 floats each) the script can view directly where the host
  allows (Wasm, JavaScriptCore) and mirror with dirty ranges where it cannot (QuickJS, V8),
  so one `SpritePool` API serves every platform.
- The renderer lives in the kernel and hosts pass a surface: raw window handles from winit
  or a CAMetalLayer from Swift. Presenting stays where the platform's frame pacing is.
- Script engines are behind a value-passing interface; typed arrays are copied at the
  boundary. That cost is paid once per call, and V8's JIT pays it back many times over.
- V8 is a build feature (`--features v8`, on by default for desktop builds), never a
  runtime download; the prebuilt library comes from Deno's rusty_v8 releases.
- Screenshot tests use a synthetic clock and logical-unit taps so every host renders the
  same frame; tolerance absorbs GPU-to-GPU antialiasing differences.

## Decisions taken in 0.7

- Physics lives in the kernel behind a single call-style entry point, so hosts bind one
  function rather than a wide API, and the web loads it separately to keep small games small.
- Sound is stereo in the kernel; panning and positional attenuation are kernel and engine
  work, not host work.
- Clipping is a protocol command (scissor) so every renderer supports scroll containers
  the same way.
- UI widgets fall back to the App's theme instead of hard-coded looks.

## Decisions taken in 0.6

- One generic host rather than one per platform. Apple gets the Swift host for its own
  APIs; everything else shares the Rust one, and Android is that host behind GameActivity.
- The host protocol stays the boundary: the generic host implements the same `__blackironHost`
  surface as Swift, so the engine and the games do not know which one they are on.
- The JavaScript engine is a detail behind copying wrappers. QuickJS is small and builds
  everywhere; a JIT engine can replace it on platforms that allow one.

## Decisions taken in 0.5

- Sound is rendered by the kernel everywhere. The Web Audio graph of 0.3 is gone; the
  browser runs the same DSP in an AudioWorklet, so a game sounds the same on every platform.
- Fonts are bundled at export time, including Google Fonts resolved to TrueType, rather than
  fetched on device.
- Controllers map to the web's `Gamepad*` codes so one action map serves both.

## Decisions taken in 0.4

- The kernel is a data protocol, not an API surface: one stream in, vertices and commands
  out. Adding a host means playing back four command kinds.
- The reference implementation is the specification. The Rust build must match it, and the
  test suite runs without a Rust toolchain.
- Retained data (tile batches, emitters) lives in kernel memory and is written through
  typed-array views, never copied.
- Nodes decide per frame whether a kernel is present, so Canvas 2D and the fake renderer keep
  working unchanged.

## Decisions taken in 0.3

- The engine's own JavaScript runs on device; games are not transpiled. JavaScriptCore is
  a system framework on Apple platforms, so the app stays small and the host stays thin.
- The host protocol is data, not calls: one typed-array submit per frame, so a Metal, Vulkan
  or OpenGL host is the same few hundred lines.
- Games export `main(app)`; the CLI owns bootstrapping per target.
- Text keeps using the platform text engine (CoreText natively) through the glyph cache.

## Decisions taken in 0.2

- Native render scale by default, with world sprites snapped to art pixels.
- 32 px tiles on 1280×720 as the density new projects start from; 16 px retro stays a config switch.
- Web-font text through a Canvas 2D glyph cache, not signed-distance fonts.
- Lighting as a multiplied light map, not normal maps.
- Canvas 2D is compatibility only.
- Imported art packs into the same atlas as painted art.

## Decisions taken in 0.1

- One RNG, `mulberry32`, everywhere; sprites, worlds and tests all derive from it.
- Sprites are functions, not files. The painter runs on a plain byte buffer, so art bakes
  in tests and in the CLI as well as in the browser.
- Text is a baked 5x7 font drawn as sprites; no DOM text, no glyph cache.
- Particles live in the layer root's space so trails stay behind moving emitters.
- The scene stack only runs the top scene. Overlays are nodes inside a scene.

## Historical exclusions in 0.8 (superseded by the current roadmap)

Editor (games are generated, not edited), 3D, networking, WebGPU on the web (WebGL2 stays),
normal-mapped lighting, store integrations (in-app purchases, achievements), V8 on Android
(needs a source build of V8), a node hierarchy inside the kernel (tables are flat; parent
transforms stay in script), a Chrome DevTools server for V8. The CI workflow is written but
has not run: the engine is not in a git repository yet.

### Screens of every shape

The viewport in `blackiron.json` names a design size and how it scales (`fit`, `integer`, `expand`), with a `landscape` or `portrait` alternate for the other orientation. Inside a scene, `Anchor`, `Row`, `Column` and `Margin` follow the edges; `scene.wide` and `scene.orientation` say which layout to lay out; and `scene.fitUI(designW, designH)` shows a screen designed at one size on any other, scaled, centred and backed, kept through every resize.

## License

Engine source, templates and first-party example assets are licensed under the
[MIT license](LICENSE). Third-party dependencies retain their own licenses; see
[third-party notices](THIRD_PARTY_NOTICES.md). The engine license does not require
you to publish your game source or assets.
