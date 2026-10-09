# Changelog

## Generic iOS export contract (2026-10-08)

- iOS exports accept version, build-number, bundle-ID, team-ID and signing overrides without changing saved configuration. Shared export metadata resolution validates inputs before building or replacing output.
- Exported plists reference Xcode marketing/build settings so archive-time version overrides reach the final binary. Signing is explicit: external, automatic or unsigned; simulator runs remain unsigned.
- Each iOS export includes a portable `kiln-export.json` manifest with engine identity, project/scheme paths and export defaults. No build-provider variables, credentials or publishing behavior are part of the engine.
- Added export contract regressions and a macOS acceptance command that relocates a real export, builds a simulator app and unsigned device archive, and checks their final identity/version values.

## Post-0.16 engine hardening (2026-09-23)

- Native 3D meshes use 4× MSAA on adapters that support multisampled RGBA8 color, resolve and Depth32, with a single-sample fallback. The 3D pass resolves before 2D/UI composition. The macOS CI run includes a GPU readback test for partially covered edges.
- Compatible consecutive opaque native meshes share an indexed instanced draw, including their shadow pass. Transparent meshes retain ordered individual draws; a hardware GPU readback test checks two independent instance colors.
- glTF textures preserve independent U and V wrap modes and all six core minification filters in WebGL2 and native rendering. Mip chains are generated on both hosts; invalid native sampler values are rejected instead of silently accepted.
- The local 3D scene editor can pick a visible mesh, edit its position, rotation and scale, and Shift-drag it on a horizontal plane. Edits are undoable document changes; Escape cancels a drag.
- Local CI passed 15 jobs and 405 Bun tests on Apple M1 Pro. Browser/native content comparison passed with hardware-only native GPU selection; a four-minute browser soak passed with 120 restarts and stable estimated allocation. See [the current upgrade evidence](docs/ENGINE-HARDENING-2026-09-23.md) for scope and remaining gaps.

## UI layout and theme hardening (2026-09-23)

- Settings sliders now use one measured label column and the same track geometry for
  drawing and pointer input; their fonts and columns update when text size changes.
  Pause and settings menus use an opaque content panel so underlying scenes do not
  visually collide with their controls.
- Existing panels, labels and buttons now follow theme changes while keeping explicit per-widget styling; buttons can use themed nine-slice skins for their normal, hover, pressed and disabled states.
- Fitted UI anchors use design coordinates and recalculate their fit when a scene attaches to the real viewport. Sprite bounds participate in container layout, focus skips unavailable controls, and pointer hit tests use current UI transforms before the first draw.
- Scroll containers measure sprite bounds and update child transforms as soon as their position changes, so pointer hit tests do not wait for a draw.
- Nine-slice corners shrink to fit narrow frames and buttons; frame slice caches refresh when the atlas, sprite or inset changes.
- `auditUILayout(scene)` in the testkit reports visible controls outside the fitted viewport, overlapping controls and invalid hit-target sizes. It respects hidden ancestors and scroll clipping and supports exemptions for intentional overlap.
- The local CI pipeline passed all 14 jobs on this Mac, including Rust, browser GPU, native FPS, exports and native goldens. The final TypeScript and Bun suite checks were rerun after the diagnostic additions.

## Native persistence fix (2026-09-13)

- Rust hosts return storage write/removal failures to the platform adapter, so `Store.save()` reports false to games.
- Save files are written to a temporary sibling and renamed only after a complete write; failed replacement preserves the prior in-memory snapshot and file.
- Existing void-returning hosts remain compatible. This change does not add disk-failure acknowledgment to iOS UserDefaults.
- Covered by native adapter tests, Rust storage failure/retry tests, and a private consumer game's macOS process-restart acceptance.

## Lowline city example

- Added Lowline as a fifth core example: a procedural 2D coastal city with walking, drivable cars, traffic, pedestrians, police pursuit, a courier mission and free roam.
- Added reusable `ArcadeVehicle2D` and `ArcadeWorld2D` APIs for top-down driving, static collision, sliding and actor separation.
- Added city browser regression coverage and included the example in the gallery, local/hosted CI configuration and reproducible web builds. Desktop web scope is documented in the example.


- Fixed Signal Breach mouse controls in embedded browsers without pointer capture: right-drag aiming, left-click firing and buffered short clicks. Added reusable pointer-event fallback and chorded-button regression coverage.

## 0.15.0 — Signal Breach and reusable FPS systems

- Added Signal Breach, a browser FPS with a procedural relay station, two weapons, three security waves, elevated routes, relays, pause/settings and complete win/lose/restart flows.
- Added FirstPersonLook, PointerLockInput, CharacterController3D, CombatWorld3D, Weapon3D, Projectile3D, NavigationGrid3D and camera-relative stereo audio helpers.
- Added a WebGL2 viewmodel depth layer, beveled cuboids, dependent physics cleanup and particle pool disposal. Locked pointer events no longer enter the canvas UI.
- Added mission/GPU, capsule/combat, lifecycle and isolated browser-input tests; added the fourth game to reproducible builds and the gallery.
- See [FPS scope and evidence](docs/FPS.md), including browser input verification and remaining device limits.

## 0.14.0 — Content and native 3D foundation

- Reference-counted resource caches/scopes, robust teardown and faithful Aseprite trim/rotation/timing import.
- Versioned scene/prefab documents, typed codecs/references, undo/redo and persistent local editor; Lumen gate authored as scene data.
- UV textures and material maps, glTF/GLB loading, transform clips and CPU skeletal skinning.
- Scene-owned Rapier 3D on browser and native hosts, including collision events and cleanup.
- Native wgpu mesh/depth/shadow/material pass, PNG/JPEG desktop decoding and iOS bridge.
- GPU timing queries, resource/memory estimates, pinned toolchains, reproducibility, local CI and real-hardware soak harnesses.
- See [Foundation upgrade](docs/FOUNDATION-UPGRADE.md) for executed evidence and remaining limitations.

## 0.12.3

- Atlas edges: sprites whose whole border is opaque (tiles, panels) are extruded one texel into
  the padding, so a tile drawn at any scale never blends with the clear gap at its edge. That
  gap was the dark seam between tiles on the WebGL path. `SpriteSpec.edge` ("auto", "extrude",
  "clear") overrides it per sprite; imported sets take it in their spec.
- `VirtualSticks`: analog touch sticks by screen zone (left, right, any, or a rectangle), read as
  vectors; a survivors game moves with one and aims with the other.
- Desktop host: a scripted run (a snapshot) keeps the size it asked for, counts time and taps
  by the frames the script submitted rather than the frames the GPU showed, and ignores every
  physical input. macOS shrank a phone-tall window to the display now and then, a lost surface
  dropped a frame, and a pad button at startup pressed Play: three ways a golden went wrong.
- Desktop host: a scripted run (a snapshot) shows no window at all, keeps the size it asked
  for, counts time and taps by the frames the script submitted rather than the frames the GPU
  showed, and ignores every physical input. Before, `kiln verify` popped a window per snapshot
  and took focus; macOS shrank a phone-tall window to the display now and then; a lost surface
  dropped a frame; and a pad button at startup pressed Play. Goldens are stable and silent.
- `SettingsScene.toggleExtra(label, key)` adds a row for a boolean a game keeps in settings, and
  `PauseScene` takes `settingsOptions` so the in-game settings show the same rows.

## 0.12.2

- `Scene.fitUI(designW, designH)`: lay the UI out for a fixed design size; it is scaled to fit and centred, a backdrop fills the rest, and the fit survives every resize. `Scene.wide` and `Scene.orientation` say which layout to use.
- Viewport `landscape` and `portrait` alternates: a different design size when the container is wider than tall (or the reverse), so a phone game can lay out for a desktop; `layoutFor` is exported and pure.
- `UndoStack` in core: a bounded stack of snapshots for undo.
- `ConfirmScene` in the shell: a yes-or-no question over the game that pops itself; the first row or `confirm` says yes, `back` says no.
- `MenuScene` wraps its subtitle to the menu's width, so a `ConfirmScene` message never runs off a phone screen.
- `HintLayer` wraps long hints to its `maxWidth` (the screen less a margin by default), using the scene module's `wrapText`.

## 0.12.1 — Streaming music

- Music streams from the kernel on every host. `audio.loadMusic(name, bytes)` hands the
  encoded file (OGG Vorbis, MP3, FLAC, WAV, AAC in MP4) to the kernel's decoder, built from
  symphonia behind the `codecs` feature; it decodes a packet at a time on the audio thread,
  a few thousand frames ahead of the play head, so a track costs its compressed size plus
  about 40 KB of PCM instead of its whole decoded length. `playMusic(name)` plays it with the
  new `CMD_STREAM`, `unloadMusic` drops it, `isStreamed` says whether it streamed.
- Loops crossfade: the last 512 frames of a pass are held back and blended into the first
  frames of the next, so the seam has no click and no gap; the kernel test plays six loops of
  a short file and checks every block sounds.
- The web loads `audio.wasm` (the codec build, served and bundled next to `physics.wasm`)
  into the worklet when present, and falls back to the plain kernel and whole samples when it
  is not. iOS and the Rust host link the codec build. The Rust host and iOS bridges expose
  `loadStream` and `closeStream`; the C ABI gains `kiln_audio_stream_begin/write/open/close`.
- Kernel voices read streams with fractional resampling and pitch, so a 44.1 kHz file plays
  right on a 48 kHz device.

## 0.12.0 — Parity pass: lights, materials, audio, tiles, rigs, locale

- Render protocol 5 (`src/kernel/protocol.ts`, both kernels, WebGL2 and wgpu): twelve floats
  per vertex, a flags word of blend (normal, additive, erase), texture slot and material, and
  three ops. `LIGHT` draws a procedural point light shaded against the scene's normals; `QUAD`
  fills four points (shadow geometry erases with it); `MESH` draws textured triangles. A
  fourth pass, `scratch`, is where a shadowed light draws before it is added to the light.
- Normal maps: `defineSprite(…, { normal: "bevel" })` derives one from the sprite's shape and
  shading, or a painter draws it; imported images take `normal: "bevel"` or a normal image's
  URL. The atlas bakes them beside the colour (`atlas.normals`, `atlas_n.bin` for native
  builds); the scene pass writes a normal buffer and lights read it. `Light2D` gained `height`.
- Shadows: `Light2D({ shadows: true, shadowStrength })` is cut by `LightOccluder2D` polygons
  and by tile maps with `occlude: true` (solid-tile edges, merged into runs). Occluders
  register with the `LightLayer` in the scene; segments gather each frame in the layer's space.
- Materials: `Sprite.material` and `SpriteOptions.material`: `flash` (toward white by p0),
  `dissolve` (hash threshold with a burn band in the tint colour), `outline` (one texel in the
  tint colour; the atlas now pads two texels), `silhouette`. The Canvas 2D fallback approximates
  the flash and draws the rest plainly.
- Audio: per-bus effects in the kernel (`CMD_BUS_FX`): a low-pass, a Schroeder reverb and a
  delay line. `audio.setEffects("music", { lowpass, reverb: { mix, size }, echo: { time,
  feedback, mix } })`; effects survive an unlock. Voices now mix into per-bus buffers.
- Physics: `world.shapeCast(shape, x, y, dx, dy, max, mask)` sweeps a rect, circle or capsule;
  `ColliderOptions.oneWay` and `setOneWay` make platforms a character passes through from
  below and when moving up. The character controller moves from the body's live position, so
  several moves between steps compose.
- Tiles: blob autotiles (`defineAutotile(set, spec, paint, { mode: "blob" })`, 47 tiles by
  `BLOB_MASKS`; `autotileMask8`, `blobIndex`); `TileMap.pathfind` (A* with a heap, optional
  diagonals without corner cutting) and `pathPoints`; `TileMap.attachPhysics(world)` builds
  merged box colliders and one-way platforms; `kiln art tileset <png> --tile 16 --terrain
  blob|edges` slices a sheet, checks the seams a terrain joins, and writes a manifest that
  `defineTileSet` loads as an autotile set.
- Rigs: `crossfade(clip, seconds)` and `blend(a, b, t)` weight base clips (the blend keeps the
  two cycles in phase); `reach(bone, x, y)` solves two-bone IK, `aim(bone, x, y)` turns one
  bone; `Skin2D` cuts a sprite into a weighted triangle grid that bones deform, on its own or
  following a `Rig2D`.
- Localization: `src/i18n` (`@kiln/engine/i18n`): message tables per locale, `t(key, values)`
  with `{name}`, ICU-style plural and select, Intl numbers and dates, fallbacks by base locale,
  `watch` for re-rendering, `rtl`, `I18n.preferred`. `Row`/`Column` take `reverse`.
- Accessibility and input: `app.accessibility.announce(text)` reaches the web's live region,
  VoiceOver on iOS and TalkBack on Android; `FocusGroup` announces the focused control. Input
  methods compose on the web (`compositionend`, `isComposing`). Containers `Margin`, `Pages`,
  `Tabs`.
- Wisp Hollow: bevel normals on the trees and the knight, trunk occluders, a shadowing lantern.
  The knight example flashes on a hurt.

## 0.11.0 — Sprite sets and rigs

- Sprite sets (`src/art/spritesets.ts`): `defineSpriteSet("knight", "assets/knight.json")`
  reads the manifest `kiln art import` now writes. Animations carry facings (`down`, `up`,
  `left`, `right`), a `mirror` flag so one side stands for both, per-frame `events`, a `hold`
  for single-frame poses and `hitboxes`. `AnimatedSprite` gained `facing`, `face(x, y)`,
  `onEvent`, `hitbox()`, `mirrored` and `willFinish`: `play("knight.walk")` picks the frames
  for the way it faces, flips a mirrored side, fires "hit" on the frame the sword lands, and a
  held hurt finishes on its own. Plain `defineAnimation` names (`knight.walk.right`) exist too.
- Cutout rigs (`src/scene/rig.ts`, `src/art/rigs.ts`): `Rig2D` builds bones from a template
  (`humanoid`, `quadruped`, `flyer`, `blob` ship) and hangs part sprites on them, drawn in
  the template's order and mirrored by facing. Procedural clips give every rig idle, walk,
  run, swing, thrust, hurt, fall, cast and carry with no keyframes; `clipFromKeys` turns
  keyframed JSON into a clip; `layer("upper", "swing")` swings the arms while the legs walk;
  clips fire events ("step", "hit", "cast") and one-shots report `onFinished`.
- `kiln art parts <sheet.png> --frame 3 --cut head=x,y,w,h ...` cuts one frame into a rig's
  parts, packs them and works out every bone's pivot from where the parts sat, so the rest
  pose is the drawing. `defineRig("knight-rig", "assets/knight-rig.json")` loads it and
  `new Rig2D("knight-rig")` stands it up.
- `kiln art import` takes `--anim walk=down:4,5;up:1;left:2,6;right:3,7`, `--mirror`,
  `--event attack:9=hit`, `--hold hurt=0.4`, `--hitbox 9=x,y,w,h`, and records the pitch, the
  cast height and the anchor in the manifest. `kiln art check` lints imported sheets against
  the style bible (off-palette colours, missing pitch, cast heights that drift). `kiln art
  brief` prints the prompt to hand an artist or an image model so what comes back imports.
- `registerAssetLoader` lets any module queue work for the App's asset pass.
- `examples/knight` shows the sheet and the rig side by side, moving together; Wisp Hollow's
  hero is the rigged knight by default, K cycles rig, sheet, painted.

## 0.10.2 — The style bible

- `defineStyle({ palette, outline, rim })` in `src/art/style.ts`: the atlas bake snaps every
  sprite to the game's palette and gives sprites styled `"full"` the outline and a rim light.
  Painters compose freely; the bake makes the result one hand's work. `SpriteSpec.style` is
  `"full"`, `"palette"` (default) or `"none"`.
- Pixel art as text in `src/art/rows.ts`: `defineRowSprite`, `defineRowAnimation`,
  `paintRows`, `mirrorRows`, `stackRows`, `placeRows`. Rows plus a legend draw a sprite with
  intent; the same rows under another legend are another character.
- `kiln art import <sheet.png>`: a generated or scanned sprite sheet becomes game pixels. The
  ground is keyed out, poses are found (or a grid sliced), the source pixel size is measured
  and the image resampled to it, colours snap to the project's palette, and every frame is
  stood on one baseline in a sheet plus an Aseprite-style JSON that `defineSheet` imports.
  `--anim name=0,1` tags animations. The pure pipeline lives in `src/art/normalize.ts`.
- Imported images take the style bible too (`ImageSpriteSpec.style`), and a project's
  `assets/` folder rides along in web and native builds.
- Headless runs read assets from disk under the working directory, decoding PNGs with the
  engine's own decoder (`src/art/png.ts`), so tests and tools see imported sheets.
- The importer reads the pixel grid off the drawing itself: colour edges give the pitch and
  the cell boundaries, so generated art whose pixels wobble between four and six source
  pixels still resamples square. Poses are blobs at least a fifth the size of the largest;
  smaller bits (a sword tip, sparkles) join the nearest pose and poses never merge.
- `examples/knight`: sixteen poses of a generated knight imported with one command and
  driving idle, walk, attack, hurt, victory, pickup and guard in a small scene.
- Native builds and `kiln atlas` bake imported sheets into the prebaked atlas, so imported
  art reaches iOS, Android and the desktops, not only the browser. Wisp Hollow's hero is the
  imported knight by default; K swaps to the painted lantern-bearer for a side-by-side.
- `--shrink 2` on the importer halves the frames, so a character drawn at sixty pixels can
  join a cast drawn at thirty.

## 0.10.1 — Feel

- `Scene.timeScale` and `Scene.hitStop(seconds)`: the world's time can slow or freeze for a
  moment while the UI layer keeps real time. Tweens, banners and menus keep moving; the
  fight stops on the frame a heavy hit lands.
- `TextPops` (`src/scene/fx.ts`): pooled floating text for damage numbers and pickups, rising
  and fading, recycling the oldest entry when full.
- Moods gain `drums` (kick, snare, hat), `progression` (chord roots per bar), `arp` and
  `drive`, so generated music has a beat and a shape.
- `MenuScene.back()` ignores a second call in the same frame: one key can drive both the
  `back` and `pause` actions, and the second call used to pop the scene under the menu.
- `kiln new` gives a project its own `typescript` and `@types/bun` dev dependencies and a
  `typecheck` script, so a project typechecks from its own folder.

## 0.10.0 — The shell

Menus, settings, saves and hints as optional modules under `@kiln/engine/shell`. A game
uses any of them or none; nothing in the engine core depends on them.

### Settings (`src/shell/settings.ts`)
- `createSettings(app)`: one persisted document (master, music and effects volume, mute,
  screen shake, reduced motion, text scale, key bindings, seen hints, a free `extra` bag)
  applied to the engine on load and on every `set`: audio volumes, `app.accessibility`,
  the theme's font size, and `app.input` bindings. `rebind`, `resetBindings`,
  `defaultBindingsOf`, `setExtra`/`get`, `onChange`.

### Save slots (`src/shell/saves.ts`)
- `createSaveSlots<T>({ key, version, slots, initial, summarize, migrate })`: numbered
  slots, each its own versioned store, plus an index with a summary and timestamp per slot.
  `list`, `load`, `save`, `autosave` (the current slot), `delete`, `newest`.

### Hints (`src/shell/hints.ts`)
- `Hints`: a list of specs (`when`, `until`, `action`, `delay`, `duration`, `once`) shown
  one at a time; `{action}` in the text becomes the key or button bound to it on the
  device last used (`app.input.lastDevice`). `HintLayer` draws the current hint in the UI.
  Seen hints persist through the settings.

### Menus (`src/shell/menus.ts`)
- `MenuScene`: a themed, centred column of rows driven by actions and the pointer.
  `TitleScene`, `PauseScene` (overlay that ducks the audio, with Resume, Settings, Quit),
  `SettingsScene` (sliders and toggles bound to the settings), `ControlsScene` (press a key
  or button to rebind, reset to defaults), `SaveSlotsScene`. Stacked menus hide the rows
  under them. `bindShellActions` binds up/down/left/right/confirm/back/pause where a game
  has not.

### Engine
- `Slider` widget; `app.accessibility` (`shakeScale`, `reducedMotion`, `textScale`) honoured
  by camera shake and scene transitions; `audio.masterVolume`, `audio.pause()`/`resume()`.
- `ActionMap.lastDevice` (keyboard, gamepad or touch); `bind` drops routes for codes no
  longer bound.
- Stores now go through the platform's storage on native hosts (they were memory-only
  there, so nothing persisted); scripted runs use memory so goldens start from nothing.

### Highground
- Title screen with Play, Continue (once there is a save) and Settings; Escape pauses;
  walking, jumping, crates and pause each get a hint once; quitting and coins autosave.
  Goldens: `title`, `play` (tap through the title), `jump`.

## 0.9.0 — Isometric and 2.5D worlds

Milestones 1 to 3 of `docs/proposals/0.9-isometric.html`.

### Projected layers (`kernel/src/lib.rs`, `src/kernel/ts.ts`)
- `Camera2D.projection`: `topDown` (height lifts things), `isometric` (2:1 diamonds, any tile
  size) or `tilt` (three-quarter view). The world layer becomes a projected pass: ground
  (x, y, z) goes through one matrix to screen and a depth key, and the kernel sorts the
  pass by that key (stable, ties in stream order), so sprites, tiles, pools and shadows
  order themselves. Flat games are untouched.
- `Node2D.z`, `worldZ`, `castShadow`, `shadowAlpha`, `depthBias`: height on any node, a blob
  shadow the kernel draws from the atlas's `shadow` sprite, shrinking and fading with height.
- `camera.worldToScreen(x, y, z)`, `screenToWorld(sx, sy, z)` and `visibleRect()` work under
  every projection; follow targets carry their height.
- New stream ops: `PROJECTION`, `PROJECTION_END`, `TRANSFORM3` (a node's ground transform and
  height), `BATCH3` (world-space batches). Vertex format unchanged.

### Isometric maps (`src/scene/isotilemap.ts`)
- `IsoTileMap`: a tile grid plus an elevation grid; floors at their height, cliff faces down
  to lower neighbours, per-cell tint and alpha for fog of war, `heightAt`, `cellAt`,
  `setElevation`. It is a world-space batch (14 floats per instance) the kernel projects,
  culls and sorts. Stacked levels are maps at a height.
- Painter helpers: `isoDiamond`, `isoFaceLeft`, `isoFaceRight`, `isoBlock`.

### Pools with height (`src/scene/nodes.ts`, `kernel/src/nodes.rs`)
- Node tables gain `z`, `vz`, a depth bias and a shadow flag, with `gravityZ` and a `floor`
  (stop or bounce) per pool: coins hover and sparks arc and land with no script per node.

### Highground (`templates/isometric`)
- A new starter: an island of plateaus from noise, a four-way hero that walks and jumps onto
  ledges, fog of war revealed as it moves, coins in a pool, sparks that bounce, click to drop
  a crate on the cell under the pointer. Runs in the browser and through the native hosts.

### Host
- Scripted runs (a snapshot or a fixed clock) ignore window occlusion. A covered window used
  to pause the game and stall the harness at random; the loop also wakes on a timer now.
- V8's typed-array copies are alignment-safe and native panics stay out of the engine.

## 0.8.0 — The kernel owns the scene

Phase 3 of the roadmap: the engine core.

### Node tables (`kernel/src/nodes.rs`, `src/scene/nodes.ts`)
- `SpritePool`: sprites that live in the kernel. Spawn once with position, velocity, look,
  lifetime and animation; the kernel integrates, applies gravity and damping, bounces,
  wraps or kills at the bounds, plays frame lists, expires, culls and draws. Read back with
  `get`, change with `set`, follow physics bodies in bulk with `attachPhysics`. A new
  stream op (`NODES`) draws a table; the reference kernel and the Wasm build agree.
- The bench moves its bugs in a pool by default (`?pool=0` for script nodes): 10,000
  sprites cost 0.9 ms of script on the web instead of 3.3 ms, and the Android emulator holds
  60 FPS with QuickJS.

### One renderer (`kernel/src/render/`)
- The wgpu renderer moved from the Rust host into the kernel (feature `render`) with a C
  ABI for surfaces, textures, frames and captures. The Rust host passes winit's raw window
  handles; the Swift host passes a CAMetalLayer. `MetalRenderer.swift` and `Shaders.metal`
  are gone; the iOS host is JavaScriptCore, audio, input and a view.
- Verified on macOS (Metal), the iPhone simulator (Metal) and the Android emulator (OpenGL ES).

### Script engines (`host/src/script/`)
- Host bindings are engine-neutral: natives take and return values, and QuickJS and V8
  implement one interface. V8 (Deno's prebuilt rusty_v8) is a build feature, on by default
  for desktop builds (`KILN_NO_V8=1` opts out); `kiln run desktop --js quickjs|v8` and
  `KILN_JS` choose at run time. Android has no prebuilt V8 and keeps QuickJS.
- The bench's script-heavy mode (10,000 script sprites): 85 ms a frame on QuickJS, 2.7 ms
  on V8, on the same machine.
- Typed arrays cross the boundary through alignment-safe copies, and a panic inside a native
  function is caught and logged instead of unwinding into the engine (an unaligned copy
  under V8 used to leave the event loop silently dead).
- iOS: the JavaScriptCore context is inspectable from Safari's Develop menu.

### Profiler (`src/app/profiler.ts`)
- `app.profiler.enable()` or F4: per-node `update` and `render` time by class or name,
  frame sections (input, update, physics, tweens, draw, present), averaged over a window;
  `report()`, `lines()` and an on-screen panel. Off, it costs one null check per node.

### Visual harness (`kiln verify`)
- Renders each project's `snapshots` scenarios (`kiln.json`) with a synthetic 60 Hz clock
  and scripted logical-unit taps on the desktop host, the iOS Simulator (environment
  variables through `simctl launch`) or an Android device (intent extras, the PNG pulled
  with `run-as`), then compares with `<project>/snapshots/<host>/<name>.png`. Failures write
  `.actual.png` and `.diff.png`; `--update` accepts renders. The hosts gained `--fixed-dt`
  and a `pointerLogical` bridge call, and set `deterministic` on the host object under a
  fixed clock: unseeded games then seed from a constant and the FPS pill stays hidden, so
  two runs render the same pixels. The demo's play scene takes its seed from the App's RNG
  for the same reason.

### CI (`.github/workflows/ci.yml`)
- Engine and kernel tests on Linux; host builds with V8 on Linux, Windows and macOS with
  the harness on lavapipe, WARP and Metal; demo builds uploaded as artifacts; an iOS
  simulator build of the demo on macOS.

## 0.7.1 — Loose ends from 0.7

- Android verified with the 0.7 host: physics, stereo audio and scissor clipping run on the
  emulator's OpenGL ES path at 60 FPS (Crate Yard).
- Controllers on Android. gilrs has no backend there, so `kiln export android` now generates
  `KilnActivity` (a GameActivity subclass) and `KilnInput`, which forward controller motion
  and buttons to the host over JNI (`host/src/android.rs`). The host maps Android axes and
  key codes to the same `Gamepad*` codes as the web, event by event, so a press and release
  inside one frame keep both edges. Hot-unplugging releases held keys.
- Haptics on Android go through `KilnInput.haptic`, which picks a system vibration effect
  (tick, click, heavy click) instead of a raw millisecond buzz.
- `Row` and `Column` place children by their layout box: text aligned "center" or "right"
  draws around its origin, so it now lines up with buttons and panels instead of drifting
  by half its width. Nodes can implement `layoutBox()`; `Label`, `RichText`, `Row` and
  `Column` do. New options: `origin: "center"` makes a stack self-centring under a centred
  `Anchor`, and `auto` (default true) re-runs layout every frame so children added later
  or text that reflows stay placed. The Crate Yard title uses one `Column` instead of
  hand-placed offsets.
- Tests for scene transitions (cover, swap at the midpoint, uncover, every kind covers the
  screen) and for the host text path a phone drives (tap focuses and raises the keyboard,
  typed pieces and edit keys reach the field, a tap away lowers it).

## 0.7.0 — Physics, animation, UI, audio

The second wave of engine features that Godot and Unity have and 0.6 did not.

### Physics (`kernel/src/physics.rs`, `src/physics/`, `src/scene/physics.ts`)
- rapier2d inside the kernel behind one call-style entry point, so every host binds one
  function. Games work in pixels; `pixelsPerMeter` converts. Deterministic and identical
  on every platform.
- `PhysicsWorld`: bodies (static, dynamic, kinematic), colliders (rect, circle, capsule,
  polygon) with friction, restitution, density, sensors and collision layers, joints
  (fixed, revolute, prismatic, spring, rope), raycasts, point and box queries, a
  kinematic character controller with slopes, snapping and autostep.
- Nodes: `RigidBody2D`, `StaticBody2D`, `KinematicBody2D`, `Area2D` (enter and exit),
  `CharacterBody2D` with `velocity` and `moveAndSlide`. Collision events route to the nodes.
- `physics` in `kiln.json` creates the world at start; `app.enablePhysics()` does it later.
  On the web the physics module (`physics.wasm`, 670 KB) is fetched only by games that
  use it; native hosts have it built in.

### Animation (`src/scene/animation.ts`)
- `AnimationPlayer`: keyframe tracks on any property (dotted paths included), sprite
  frame tracks, callback and sound triggers, easing per key, looping, queueing, blending
  from current values, `onFinished`.
- `StateMachine`: states bound to clips with enter, exit and update hooks, and ordered
  condition transitions (from a state or from `any`).

### UI (`src/scene/widgets.ts`, `src/scene/theme.ts`, `src/scene/transition.ts`)
- `TextInput` with focus, caret, editing keys, placeholder, max length, submit; typed text
  reaches it through a new text event path (browser keys, iOS on-screen keyboard through
  UIKeyInput, desktop key text and IME). Letters no longer fire actions while typing.
- `ScrollContainer` with wheel, drag and fling, a scrollbar, and clipping through a new
  scissor command in the kernel protocol (WebGL2, Metal, wgpu and Canvas 2D).
- `RichText` with `[b]`, `[i]`, `[color=…]`, `[icon=sprite]` and wrapping; `Grid`; `Tooltip`.
- `app.theme` and `app.setTheme`: labels, buttons and the new widgets take their font
  and colours from it when a game passes none.
- Scene transitions: `scenes.change(scene, { transition: "fade" | "wipe" | "slide" | "circle" })`.

### Audio
- The kernel renders stereo with constant-power panning; `play(name, { pan })` or
  `{ x, y }` with `audio.listener` for positional sound, attenuated by distance.
- Music crossfades: `setMood(name, { crossfade })`, `playMusic(sample, { loop, crossfade })`,
  `stopMusic(fade)`, `stop("sfx" | "music" | "all", fade)`; bus fades and looping samples in
  the kernel.
- The generic host decodes OGG Vorbis, MP3, FLAC, AAC and WAV samples through symphonia.

### Starter
- `templates/physics` ("Crate Yard"): a character in a yard of crates and balls, using every
  feature above, with a name field and a scrolling log.

## 0.6.0 — The generic host: desktop and Android

One native host in Rust (`host/`) for every platform that is not Apple-polished by the
Swift host: Windows, Linux, macOS and Android. It shares the kernel, the same protocol and
the same game bundles as the iOS and web builds.

### Host (`host/`)
- winit for windows, input and the Android activity; wgpu for the GPU (Metal, Vulkan,
  DirectX 12, OpenGL) with WGSL ports of the render passes; QuickJS for the game;
  cpal for audio output, pulling from the kernel synthesiser; fontdue for glyphs from the
  bundled fonts, with the platform's sans-serif as fallback; gilrs for controllers.
- The script reaches the kernel and the synthesiser through small copying wrappers, so
  the JavaScript engine is replaceable.
- `--snapshot out.png --snapshot-frame N --exit` and `--tap X,Y:FRAME` make headless
  screenshot tests possible on desktop; `KILN_SNAPSHOT` does the same through the environment.
- Saves live in the platform's config directory (`Kiln/<game>.json`) and in the app's data
  directory on Android; WAV samples decode in the host.

### CLI
- `kiln export desktop [--platform macos|windows|linux]`: a macOS app bundle with an icon,
  or a folder with the executable and the game in `Kiln/`. `kiln run desktop` builds and
  opens a window.
- `kiln export android`: a Gradle project with the host as a shared library behind
  GameActivity, the game as assets and an icon; `kiln run android` assembles the debug APK,
  installs and launches it on the connected device or emulator.
- `kiln build --target native` now bundles fonts for every host; the app icon painter is
  shared by all exports (`cli/icon.ts`).
- `android` block in `kiln.json`: `applicationId`, `orientation`.

## 0.5.0 — iOS parity: sound, fonts, controllers, haptics, icons

Everything a Godot iOS export gives a 2D game, natively: audio, the game's own fonts,
game controllers, haptics, an app icon and launch screen.

### Audio
- The synthesiser moved into the kernel (`kernel/src/audio.rs`): oscillators with
  PolyBLEP, exponential envelopes and sweeps, a low-pass biquad, vibrato, looped noise,
  samples, two buses and a click-free mute, driven by a lock-free command ring. Every
  platform renders the same PCM.
- Web: the kernel runs inside an AudioWorklet (`WorkletBackend`); samples decode with the
  browser and stream to the worklet. iOS: an `AVAudioSourceNode` pulls from the kernel
  (`KilnAudio.swift`); samples decode with CoreAudio (WAV, AIFF, MP3, AAC, FLAC, CAF).
- `AudioEngine` is now platform-independent over an `AudioBackend`; its API is unchanged.
  `sfxVolume` and `musicVolume` take effect immediately.

### Fonts
- `kiln export ios` bundles the project's fonts: local `.ttf`/`.otf` paths are copied and
  Google Fonts CSS URLs are resolved to TrueType files (cached in `.kiln/fonts`). The host
  registers them with CoreText and matches family, weight and style, so `Label.font` looks
  the same on device as on the web.

### Input and feel
- Game controllers on iOS through the GameController framework, mapped to the same
  `Gamepad*` codes the web build uses.
- `app.haptic(kind)` and `Platform.haptic`: UIKit feedback generators on iOS, the Vibration
  API where browsers have it. The demo taps on collect, hurt and game over.

### App bundle
- App icon generated from a sprite (`ios.icon`, or the hero, or the largest sprite) over the
  background colour; the launch screen uses the background colour too.

## 0.4.0 — The compiled kernel

The per-frame heavy loops moved into a small Rust library: machine code in native hosts,
WebAssembly on the web, with a TypeScript reference for tests. Under device conditions on
iOS (no JIT) the bench went from 40 FPS at 20.8 ms to 60 FPS at 6.1 ms.

### Kernel (`kernel/`, `src/kernel/`)
- A command stream per frame (sprite, rect, glyph, transform, pass, batch, particles) that the
  kernel expands into the 0.3 vertex format and BEGIN / PASS / DRAW / END command list.
- Retained batches: `TileMap` writes its tiles once into kernel memory and draws with one
  culled command per frame; animated tiles live in a second small batch.
- Particle emitters live in the kernel; `ParticleEmitter` steps and draws with one command.
- `TsKernel` (reference), `WasmKernel` (web, embedded base64), and the native bridge on iOS;
  `createKernel("auto" | "wasm" | "ts")`, `kernel` and `kernelOptions` in `kiln.json`, `?kernel=ts`.
- `bun kernel/build.ts` builds the Wasm module and `KilnKernel.xcframework`; `kiln export ios`
  links the framework and builds it first when missing.
- `tests/kernel.test.ts` checks the Wasm build against the reference vertex for vertex.

### Renderers
- `WebGL2Renderer` and `NativeRenderer` write the stream and play the kernel's command list
  back; WebGL2 uses 32-bit indices and one vertex upload per frame.
- `Renderer.kernel`, `drawBatch`, `drawParticles`; `DrawContext.batch`, `DrawContext.particles`.
- The Swift host exposes the kernel to the script as no-copy typed arrays and renders from
  kernel memory; `submit` now carries only the post settings and counts.

### Tooling
- `examples/bench`: tiles, sprites, particles, lights and text under one FPS pill, with
  `?n=&p=&cols=&rows=` overrides.
- The FPS pill and frame graph show whole-frame CPU time (`App.cpuMs`), not just the draw phase.
- iOS build products live in `<project>/.kiln/ios-build`, so `kiln run ios` stays incremental.

## 0.3.0 — Native iOS

The same game bundle runs natively on iOS: the engine executes in JavaScriptCore and draws
through Metal, with no web view. Web builds are unchanged apart from the entry convention.

### Entry convention
- Games export `default async function main(app: App)`. The CLI writes a bootstrap wrapper
  per target under `.kiln/` (a canvas on the web, the host bridge natively). The demo and
  all four starters follow it.

### Native protocol
- `NativeRenderer`: one vertex buffer plus begin, pass, draw and end commands per frame,
  post settings as a fixed float array, textures uploaded by slot (atlas, glyph cache, LUT).
- `NativePlatform` and `KilnHostApi`: time, storage, bundled files, images, glyph
  rasterisation and the screen description come from a host object; `App.bindHost()` installs
  the `__kiln` bridge the host drives (frame, pointer, key, resize, visibility, capture).
- `App` native mode: letterboxed layout from the screen in points, present rect in device
  pixels, safe-area insets, pointer mapping from touches to logical units.
- `Atlas.fromManifest` restores a prebaked atlas; `kiln build --target native` writes the
  bundle, atlas bytes, manifest and a project manifest to `dist/native/`.

### iOS host (`native/ios/`)
- Swift + Metal: `KilnRuntime` (JSContext, bridge, display loop, hardware keys),
  `KilnHost` (JSExport host, CoreText glyphs, UserDefaults storage, bundle files),
  `MetalRenderer` (scene, light, overlay and bloom targets, composite with LUT, grain,
  scanlines, vignette), `Shaders.metal`.
- `kiln export ios` generates an XcodeGen project with the host and the native build in a
  `Kiln/` bundle folder (shaders compile on device, so no Metal toolchain is needed);
  `kiln run ios` builds it for the simulator, boots the device, installs and launches.
- `ios` block in `kiln.json`: `bundleId`, `orientation`, `minVersion`, `icon`, `team`.

### Tests
- `tests/native.test.ts` runs the App against a fake host and checks the frame protocol,
  layout, light and glyph uploads, pointer mapping, storage and the atlas round trip.

## 0.2.0 — High-definition presentation

The same pixel-art engine, rendered at the display's native resolution with four times
the art density, real light, sharp text and imported art. Nothing from 0.1 was removed;
0.1 projects run unchanged and get native rendering by default.

### Platform seam
- `Platform` interface (time, frames, pixel ratio, asset bytes, image decoding, storage,
  visibility) with `WebPlatform` and `HeadlessPlatform`. The App and asset loaders go
  through it, which is the seam for future native shells.

### Rendering
- `render.scale: "native"` composes at the canvas backing store's size; numbers still
  multiply the logical size. `render.snap` controls sub-pixel placement.
- Bloom is a two-level chain at a quarter and an eighth of the target.
- Light pass: `LightLayer` and `Light2D` (point and cone, flicker, falloff) multiplied
  into the world; `Sprite.emissive` stays bright and blooms.
- Overlay target: the UI layer is composed last, unlit and ungraded.
- Web-font text through a glyph cache uploaded as a second texture; `Label.font`,
  `Button.style.font`, `renderer.measureText`.
- `Sprite.smooth` for linear-filtered imported art.
- LUT colour grading (`post.lut`: dusk, warm, cool, noir, vivid, faded, or 768 bytes),
  film grain and scanlines.
- Canvas 2D backend keeps sprites, text, tint, lighting and the simple post chain.
- `renderer.snapshot()` and F8 capture a PNG; under `kiln dev` it is saved to `screenshots/`.

### Art
- `ramp7` seven-tone ramps; painter `noise`, `hatch`, `radial`, `edges`, `lightFrom`,
  `remap`, `scaled`, masks (`mask`, `withMask`, `silhouette`).
- `materials`: bark, stone, cloth, metal, foliage, grass, planks, water.
- `defineAutotile` for sixteen-variant tile sets.
- Imported art: `defineImageSprite`, `defineImageGrid`, `defineSheet` (Aseprite JSON),
  packed into the same atlas at boot. The atlas grows to 2048 and 4096 as needed.

### Scene
- `TileMap` with autotiling, animated tiles and built-in collision (`moveBody`).
- `ParallaxLayer`, `Anchor`, `Row`, `Column`, `NineSlice`, `FocusGroup`, `TouchControls`.
- Overlay scenes: `scenes.push(scene, { overlay: true })`.
- `viewport.scale: "expand"` lets the logical size follow the window; `Scene.onResize`.

### Input and audio
- Gamepads through the standard mapping as key codes (`GamepadA`, `GamepadLeftStickLeft`).
- Multi-touch tracking on `Pointer`; on-screen stick and buttons.
- Audio samples (`app.loadSample`) next to the synth, sharing the mixer.

### Tooling
- `kiln gallery` serves the demo and every starter behind one menu.
- The dev server re-reads `kiln.json` on reload.
- Debug overlay shows the target size and a frame-time graph.
- Frame-rate pill in every project (`fps` in `kiln.json`, F3, `?fps=`), colour-coded by frame rate.
- `?scale=`, `?snap=`, `?renderer=`, `?debug=` URL overrides.

### Demo and starters
- Wisp Hollow and the four starters re-authored at 32 px on 1280×720 with HD text,
  anchored HUDs, touch and gamepad input; the demo adds lights and autotiled paths.

## 0.1.0 — First release

Scene tree, WebGL2 and Canvas 2D renderers with bloom, headless procedural pixel art,
synth audio, input actions, versioned saves, a CLI, the Wisp Hollow demo and four starters.
