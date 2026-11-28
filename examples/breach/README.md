# Signal Breach

A single-player 3D FPS inside an offshore relay station. Defeat three security waves and reboot three relays to restore the signal. Built with Blackiron's reusable first-person input, capsule controller, weapon, combat, projectile and navigation systems.

Run `bun run dev` here, or `bun run gallery` from the engine. This first release targets desktop browsers with WebGL2. Click **Enter the station** to request mouse capture. If the browser cannot capture the mouse, hold the **right mouse button and drag to aim**, and **left-click to fire** (including while aiming). Chrome supports the normal unrestricted FPS mouse controls. Press Enter to start with keyboard aiming; click the game to attempt capture or activate the mouse fallback.

| Control | Action |
|---|---|
| Mouse | Look while captured |
| Left mouse / J | Fire |
| WASD | Move |
| Shift | Sprint |
| Space | Jump |
| 1 / 2 | Pulse rifle / scattergun |
| R | Reload |
| E | Reboot a nearby relay after clearing its security wave |
| Escape | Release capture and pause |
| F1 | Control settings |
| Arrow keys | Keyboard aiming fallback |
| M | Mute |
| Backtick | Engine/game diagnostics |

Sensitivity, inverted vertical look, field of view, forward/jump rebindings and best score persist on the device. A relay restores 30 integrity and ammunition. Drones fire visible projectiles that can be dodged or blocked by cover. The west/east galleries have climbable stairs; the service ramp uses a triangle-mesh collider. Relays must be reached at their actual elevation.

The station, drones, weapon models, material textures and signs are generated in code. Guns, drones and props are modelled with the engine's `ShapeBuilder3D` (bevelled boxes, extrusions and lathes with edge strips). Shots, impacts, drone charges and bolts, explosions and smoke use `Effects3D` sprites from one atlas (one draw call for all of them), `LightPool3D` flashes and scorch decals. A destroyed drone breaks into its parts through `Debris3D`: they tumble, bounce off the station, burn and smoke. Gun recoil, sway and hit jolts are `Spring`s; the view punches with each shot and dips on landing. The world uses real mesh depth, lighting, directional shadows, MSAA and post effects. The first-person weapon has its own depth layer. Internal rendering is 1280×720, avoiding an automatic 4× pixel workload on Retina displays; canvas UI still fits the browser viewport.

- `src/level.ts`: station collision layout, relays, wave composition and weapon definitions.
- `src/presentation.ts`: procedural architecture, textures, signage and the drone and weapon rigs.
- `src/models.ts`: hard-surface models for the guns, drones, crate caps, consoles, drums, sign and barrier frames and pillar collars.
- `src/fx.ts`: the effect recipes (muzzle flashes, tracers, impacts, bolts, damage smoke, explosions, debris), built on the engine's 3D effects.
- `src/main.ts`: mission, enemy behaviour, HUD, input bindings and audio.
- `src/game.test.ts`: scene lifecycle, modal input and actual ramp traversal.
- [Engine FPS documentation](../../docs/FPS.md): APIs, scope, evidence and limitations.
- [3D effects](../../docs/EFFECTS3D.md): the sprites, flashes, debris, springs and shape builder it uses.

This is a compact complete arena mission, not a large campaign. Mouse capture requires browser/user-gesture support. On phones and tablets the HUD, title and menus use a touch layout (`src/touch.ts`: text of 11 pt or more, 44 pt targets) with a move stick, a look stick under the right thumb and Fire, Jump, Reload, Swap and Pause buttons; it is checked headless with `blackiron screens` and `src/phone.test.ts`, not yet on a real device, and the project's targets do not include iOS or Android. There is no networking, native FPS export, HRTF audio or general navmesh in this release. Gamepad action bindings exist but physical controller validation is outstanding.
