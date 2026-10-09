# First-person games in Kiln 0.16

Signal Breach is Kiln's fourth flagship game and first FPS. The existing Wisp Hollow, Highground and Lumen Salvage remain intact. Signal Breach is a complete compact single-player mission: a procedural relay station, two weapons, three security waves / twelve drones, three relay objectives, stairs/ramp/platforms, health/ammo recovery, pause/settings, victory, defeat and restart.

The 0.16 upgrade runs the shared mission on native Rust Rapier and wgpu as well as WebGL2. macOS QuickJS/Metal is verified; Windows/Linux desktop exports are enabled but require their own validation. See [native/export evidence](ENGINE-UPGRADE-0.16.md).

## Engine APIs versus game content

| Reusable engine system | Signal Breach supplies |
|---|---|
| `PointerLockInput` / `NativePointerLockInput` | Canvas capture request from a user gesture; fire bindings and pause policy |
| `FirstPersonLook` | Sensitivity/FOV defaults, recoil and weapon sway |
| `CharacterController3D` | Capsule dimensions, move/sprint speed and jumping tuning |
| `Weapon3D` | Rifle/scattergun definitions, models, sounds and feedback |
| `CombatWorld3D` | Damage handlers, team policy and health rules |
| `Projectile3D` | Security projectile speed, damage, visual and lifetime |
| `NavigationGrid3D` | Walkable sampling from the authored station; drone pursuit/attack behaviour |
| `spatialAudio3D` | Sound definitions, listener pose and audible distance |
| `Mesh3D.renderLayer` | First-person weapon meshes marked `viewmodel` |
| `Geometry3D.beveledBox` | Procedural architectural and weapon proportions/palettes |

The engine modules have no knowledge of relays, wave counts, enemy names or weapon IDs. Different weapon configurations are tested against the same implementation. Navigation is a sampled height surface with cardinal A* traversal, clearance supplied by the author and bounded search; it is not a general navigation-mesh solution.

## Basic integration

```ts
import {
  Scene3D, PhysicsWorld3D, CharacterController3D,
  FirstPersonLook, CombatWorld3D, Weapon3D, Vec3,
} from "@kiln/engine/three";

const scene = new Scene3D(1280, 720);
const physics = await scene.enablePhysics3D();
if (!(physics instanceof PhysicsWorld3D))
  throw new Error("The FPS capsule controller currently requires browser Rapier");
const motor = scene.resources.own(new CharacterController3D(physics, {
  position: new Vec3(0, 0.05, 4), height: 1.8, radius: 0.32,
  speed: 6, stepHeight: 0.35, maxSlope: Math.PI / 4,
}));
const look = new FirstPersonLook();
const combat = scene.resources.own(new CombatWorld3D(physics));
const weapon = new Weapon3D({
  id: "custom-rifle", magazine: 20, reserve: 100, interval: 0.15,
  reloadSeconds: 1.4, damage: 15, range: 70, automatic: true,
});
```

In each fixed update, consume relative mouse motion once, call `look.mouse(dx, dy)`, move the capsule with `motor.move(look.movement(strafe, forward), dt, { jump, sprint })`, and set the camera from `motor.position + eyeHeight` with `look.apply(camera, eye)`. Motor position denotes the **feet**. Scene3D steps its physics after the scene update, so the controller computes its next kinematic translation first. Grounded state, coyote time, jump buffering, air control, slope limits, ground snapping, ceiling blocking and optional autostep are part of the motor. Physical collider dimensions are explicit world units.

Call `weapon.update(dt)`, then `weapon.trigger(fireHeld, look.forward())`. It returns zero or more normalized shot directions while managing cadence, semi-auto edges, magazine, reserve and reload state. For every shot, call `combat.hitscan(eye, direction, range, damage, shooterCollider, source)`. The nearest physical collider stops the ray even when it has no damage handler. Register targets with `combat.register(collider.handle, damageable)` and retain the returned unregister function. Projectiles sweep the complete travelled segment; they do not skip a thin wall simply because they move quickly.

Browser capsule controllers register dependent cleanup with their physics world and can be disposed before or during scene teardown. Do not use raw Rapier handles after disposing the world. `Particles3D.dispose()` releases its owned geometry; retain pools through scene resource scopes.

## Browser input and viewmodels

`PointerLockInput` is DOM-specific, exported from `@kiln/engine/input`. It owns its listeners, relative mouse delta and held mouse-button codes (`Mouse0`, `Mouse1`, etc.). Request capture in a real user gesture; browsers can reject it. `onChange` and `onError` allow the game to pause or present a fallback. A consumed mouse delta is not replayed on later catch-up simulation steps. Capture transitions clear the ordinary canvas pointer, and locked mouse events bypass 2D UI routing. Disposing the input releases held buttons and capture.

For embedded browsers that cannot capture the mouse, opt into `setDragFallback(true)` after capture fails. Right-drag accumulates relative aiming deltas, while left and auxiliary buttons feed the action map. The fallback uses pointer events and button masks, so preventing compatibility mouse events and pressing multiple buttons together do not break firing. `release()` disables the fallback and releases held actions. Signal Breach enables it automatically and buffers brief fire presses until the next simulation update. Use `KILN_TEST_MOUSE_FALLBACK=1 bun run check:fps-input` to test this path with the capture API deliberately unavailable; this is recorded as simulated unavailability, not successful capture.

Set `mesh.renderLayer = "viewmodel"` on first-person meshes. WebGL2 renders these after world geometry using a reserved near depth band, preserving self-occlusion without a mid-pass multisampled depth clear. They do not cast world shadows. World meshes continue to occlude each other normally. This is currently a **WebGL2 capability**; the native encoder rejects viewmodels explicitly. The general native 3D renderer remains available for games such as Lumen.

`spatialAudio3D` returns camera-relative stereo pan and distance gain for Kiln's existing audio API. It does not claim HRTF, environmental occlusion or a full 3D audio renderer.

## Validation commands

```sh
bun test
bun run typecheck
bun run check:fps             # real WebGL2; complete mission, failure and restart
bun run check:fps-input       # isolated browser; capture, trusted inputs and paced GPU check
KILN_HEADED=1 bun run check:fps-input  # visible test browser for capture on supported desktops
bun run check:ci              # existing engine/native regressions plus FPS
bun run check:reproducible    # all four flagship web builds twice
```

The strict input runner passed mouse capture, relative mouse aiming, mouse firing, Escape/pause, recapture, held-button cleanup, settings and rebinding persistence across reload. It uses trusted Chrome DevTools input in its own isolated Chrome instance. Initial attempts failed with `WrongDocumentError`; starting on a blank page and explicitly navigating after attaching the test protocol resolved that startup issue. A visible-browser hands-on playthrough remains outstanding because the Mac was locked when computer-use validation was attempted.

For hosts that reject capture with that root-document error, `KILN_ALLOW_UNAVAILABLE_POINTER_LOCK=1 bun run check:fps-input` explicitly records capture as **UNAVAILABLE** and tests the mouse-drag fallback instead. It does not turn unavailable capture into a passing capture test. The default command requires actual capture.

The historical 0.15 20-second, 1,200-frame paced gameplay sample passed on the Apple M1 Pro (Chrome WebGL2 through ANGLE Metal) at 1280×720: CPU p95 **2.8 ms**, frame interval p95 **16.8 ms**, GPU p95 **4.219 ms**, estimated GPU allocations **61,907,928 bytes**. Budgets were 8.3 ms CPU/GPU, 17.2 ms frame interval and 256 MiB estimated GPU memory. GPU p95 covers the final rolling 240 timer queries. This is a short single-device sample, not a long soak or cross-device certification. The complete local CI run passed all eleven jobs; 370 tests made 18,164 assertions, all four web builds reproduced, and native verification passed sixteen goldens with one expected web-only FPS skip. Hosted CI has not been run for this change.

The mission test drives the real engine and game, including actual hitscan damage and relay activation, and checks all three waves, victory, defeat, restart disposal and the authored staircase. It includes a pixel test showing that a weapon behind a wall renders in the viewmodel layer, while the same mesh in the world layer is correctly occluded. Unit tests cover capsule floors/walls/ceilings/stairs/slopes, two weapon configurations, projectile tunnelling, navigation, pointer-state cleanup, modal settings and fifteen repeated game restarts. The pointer lifecycle unit test uses a mock document and does not replace browser capture validation.

Results, screenshots and logs are in `.kiln/verification/breach`, `.kiln/verification/breach-input` and `.kiln/verification/ci`. A compact evidence record is stored in `docs/validation/fps-0.15.json` after verification.

## Limits

This delivery targets desktop FPS games. Use `createPhysics3D()` for a portable backend; `PhysicsWorld3D.create()` and its raw Rapier world remain browser-specific. The capsule motor, combat, viewmodel rendering and native relative mouse bridge now support desktop native hosts. Navigation cannot represent overlapping floors in one grid, and no navmesh or crowd solver is supplied. Networking, touch FPS controls, skeletal weapon reloads, campaign tooling, destructible environments and advanced spatial audio are outside this delivery. The new example demonstrates a reusable foundation; it does not establish Unity/Godot parity or broad device certification.
