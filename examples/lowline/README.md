# Lowline

A top-down coastal city: walk the streets, borrow a car, collect an archive, escape the patrols and finish one last courier dispatch.

Run `bun run dev` here or `bun run gallery` from the engine. This is the fifth core example, alongside Wisp Hollow, Highground, Lumen Salvage and Signal Breach. It is an original game inspired by the early top-down open-city genre.

## Play

- **WASD / arrows:** walk; in a car, W accelerates, S brakes/reverses, A/D steer.
- **E:** enter/exit a nearby civilian car, collect the archive or deliver it.
- **Space:** handbrake/drift. **Shift:** sprint on foot.
- **M:** expand the city map. **H:** horn. **N:** mute.
- **Escape:** pause/resume. **Enter:** start, resume or continue after a result.
- **R:** new dispatch while paused, after a result or during free roam.

Walk toward the amber coupe and press E. Drive north to Northstar Records and press E near the amber marker. Picking up the archive starts a two-level pursuit: use speed and city blocks to break police sightlines for eight seconds. Then deliver to Pier 09. A successful delivery awards $2,400 and unlocks free roaming. Slow down before exiting vehicles; blocked doors cannot place the player inside a building.

## Built with Blackiron

Everything visible uses Blackiron's scene tree, retained `Graphics2D`, camera, WebGL2 renderer, post-processing, text, UI and synthesized audio. No external game renderer or downloaded art is used. Static building geometry is retained and culled by the engine. Traffic, pedestrians, patrol counts and skid marks are bounded.

`@blackiron-studio/engine/physics` now exports:

- **ArcadeVehicle2D:** configurable acceleration, braking/reverse, steering, lateral grip and handbrake handling. Call `step(dt, { throttle, steer, handbrake }, world)` before rendering its position and angle.
- **ArcadeWorld2D:** static rectangle obstacles, substepped circle movement with wall sliding, safe-position queries and weighted separation of circular actors.

These APIs do not depend on Lowline's roads, mission, art, input mappings or police rules. They are lightweight arcade dynamics; they do not implement rigid-body suspension or oriented vehicle collision meshes. `city.ts` authors this city's orthogonal road routes; `game.ts` owns the courier and pursuit rules; `presentation.ts` owns retained city/vehicle art; `main.ts` connects the simulation to Blackiron.

## Validation and scope

`bun run check:lowline` runs the actual WebGL2 game, walks to a car, enters it, drives to the archive, and escapes a police pursuit on the road network. It also checks delivery/free roam, pause, defeat and restart. The complete mission, including the final delivery, uses actual vehicle movement without teleporting. `bun test` covers collisions, frame-rate consistency, mission transitions, vehicle exits and scene replacement. `bun run check:reproducible` includes this example.

This first release targets desktop web browsers with a keyboard. It is a compact city sandbox with one mission, not a full GTA-scale game: no weapons, interiors, multiplayer, persistent campaign, touch controls or native-device certification. Vehicle colliders are circles; traffic follows authored loops and police use the authored road graph. The next useful expansions are additional mission types and districts, richer traffic rules, vehicle variety and an independent 2.5D city presentation using the same simulation.
