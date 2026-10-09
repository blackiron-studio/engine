# Blackiron 0.16: native FPS and reliable exports

13 September 2026. Blackiron keeps its own generic runtime and renderer. Game-specific rules, levels, missions and styling remain in the examples. This release extends the existing Signal Breach FPS to desktop native hosts and hardens the export system. It does not establish Unity/Godot parity or certify every device.

## Native gameplay and rendering

`createPhysics3D()` selects browser Wasm Rapier or the native Rust bridge. `CharacterController3D` and `CombatWorld3D` accept either backend. The shared capsule motor retains its acceleration, gravity, coyote time, jump buffering, autostep and slope configuration; native shape casts handle collision and dynamic-body impulses. Teleports immediately update collider positions. Combat ray filtering tolerates a shooter that has already been removed, which is necessary for its remaining projectiles.

`PhysicsWorld3D.create()` remains the browser-specific factory for applications that need raw Rapier APIs. The portable factory returns `PhysicsBackend3D`; native bodies expose their collider handles without pretending to implement every browser Rapier method. Raw joints and advanced Rapier APIs are not portable. Browser and native Rapier versions differ; deterministic cross-platform multiplayer is not promised.

Native `Mesh3D.renderLayer = "viewmodel"` uses a separate near depth band, preserves weapon self-occlusion, and excludes weapons from world shadows. Both the blue weapon behind a red wall and the control case with ordinary world depth are checked against captured native pixels.

The native renderer reuses uniform buffers and bind groups across frames when their resource bindings remain compatible. Same-sized deforming geometry updates vertex buffers in place; unchanged indices are not uploaded again. Shadow/texture changes invalidate bindings. An explicit GPU test checks buffer/bind-group identity through 120 submissions and checks resource retirement. This proves allocation reuse, not a particular FPS improvement. The native host also coalesces resource updates when multiple script frames arrive before presentation, preventing lost geometry/texture deltas.

`App.frame(dt, { render: false })` runs input and simulation without drawing, for replay, fast-forward and acceptance testing. The native FPS acceptance runs the full shared game mission this way, then separately captures real native rendering. The flagship itself is also checked with a normal rendered native golden.

## Input and procedural text

`NativePointerLockInput` requests OS mouse capture and waits for acknowledgment. Deltas are consumed once, held mouse actions clear on release/focus loss, and scene disposal releases capture. Desktop hosts forward raw relative motion and mouse buttons. A cursor-position fallback handles hosts that supply no raw motion; raw events take precedence so motion is not counted twice. Mobile FPS controls are not supplied; Signal Breach declares web and desktop targets only.

`Texture3D.fromText()` generates label/sign textures through browser Canvas, native glyph services, or the built-in bitmap font for headless use. Signal Breach now uses this shared API instead of omitting its signage outside the browser.

Live macOS checking confirmed native gameplay, mouse-button firing and pause. The Mac locked before the final cursor-fallback movement check; that final interaction is not certified. Capture lifecycle and motion precedence/consumption have automated tests.

## Export behavior

- Web builds replace only managed web outputs, preserving sibling desktop and mobile packages.
- Native bundles and platform packages build in sibling staging directories. Failed builds retain the prior output. Publication errors roll back; an unsuccessful rollback preserves a recovery copy and reports its location. Locks reject concurrent exports to the same destination. These are application-level recovery guarantees, not a power-loss-safe filesystem transaction.
- Single-file HTML includes managed assets, glTF buffers/images, physics/audio Wasm and declared font resources. The resource resolver is part of Blackiron's platform API; arbitrary game code using raw `fetch()` for unrelated remote resources is not rewritten. Nested CSS `@import` is rejected explicitly. The HTML file itself is replaced only after its full content is written.
- Explicit project targets are enforced before export work. `native` is a wildcard for native platforms; desktop/mobile names allow narrower declarations. Unsafe source/ancestor paths and symlink aliases are rejected.
- Native font packaging fails on missing or unsupported declared fonts instead of silently delivering an incomplete package. Local TTF/OTF and compatible local/remote stylesheets are supported; packaged resources may require network access at build time.
- iOS custom output paths include the game bundle. Cargo checks framework freshness on each export. Projects target ARM64 devices and Apple Silicon simulators; Intel simulator binaries are not supplied.
- Android preflight rejects an incomplete NDK, including directories without metadata or clang.
- Cargo export builds use lockfiles. Project `version` (default `1.0.0`) and `buildNumber` (default `1`) populate platform metadata instead of a hardcoded engine release.

Example project metadata:

```json
{
  "name": "My game",
  "entry": "src/main.ts",
  "version": "1.2.0",
  "buildNumber": 7,
  "targets": ["web", "macos", "windows", "linux"]
}
```

Native adapter selection prefers hardware through native APIs, then hardware OpenGL, before allowing known software/emulated adapters. `BLACKIRON_REQUIRE_HARDWARE_GPU=1` rejects that fallback. Logs include adapter/backend/type. An adapter log and a build do not replace performance tests on the intended physical device.

## Executed validation

[Machine-readable evidence](validation/engine-0.16.json) records the final local results and limitations. Logs and captures remain in `.blackiron/verification`.

- Local CI covers typechecking, Bun tests, Rust kernel/host tests, browser GPU/content/game checks, native content, the shared native FPS mission, offline export acceptance, reproducible web outputs and all native example goldens.
- The shared FPS mission covers movement, jumping, the authored staircase, pause/resume, weapon changes/reload, all three combat waves, all relays/victory, defeat and restart disposal on browser and native physics.
- Offline acceptance serves only the exported HTML and a test-result endpoint. glTF + external buffers/PNG, embedded GLB skin pose, Rapier 3D, physics/audio Wasm compilation, font decoding and rendered WebGL2 pixels pass with no external asset requests. Browser GPU: ANGLE Metal on Apple M1 Pro.
- The packaged macOS FPS runs on Apple M1 Pro Metal with software fallback disabled. QuickJS was used; the V8 export configuration has not been revalidated here.
- Lumen's custom-path iOS project and framework build successfully for the ARM64 simulator and unsigned device target. This is compile/package evidence; a physical-device playthrough is still absent.
- Native GPU buffer-retention tests were explicitly executed on this Mac. Standard Rust test runs leave that GPU-dependent test marked ignored; CI's rendering tests run separately.

## Platform coverage and remaining work

| Target | Native/GPU path | Current evidence |
|---|---|---|
| Browser | WebGL2; ANGLE selects the system graphics backend | GPU/game/content checks and standalone export acceptance |
| macOS | Native wgpu/Metal | Packaged FPS, full native mission and visual regressions |
| iOS | Swift/JavaScriptCore + wgpu/Metal on CAMetalLayer | ARM64 simulator and unsigned device builds; physical runtime unverified |
| Windows | Native wgpu, including DX12 | Export implementation; no fresh Windows build/device run |
| Linux | Native wgpu Vulkan/OpenGL | Export implementation; no fresh Linux build/device run |
| Android | Native GameActivity/QuickJS + wgpu Vulkan/GLES | Incomplete local SDK/NDK blocks APK verification |

Remaining substantial work includes native instancing and multisample anti-aliasing, GPU skinning, native GPU timing and process-memory inspection, broader glTF/material fidelity, richer visual authoring, mobile FPS controls, signed distribution workflows and physical-device soak/performance coverage. Native rendering remains one draw per mesh. Existing historical performance/soak reports describe their tested bundles, not this release. No new full-duration soak or all-platform performance certification is claimed.
