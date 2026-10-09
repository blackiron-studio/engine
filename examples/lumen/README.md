# Lumen Salvage

A 3D courtyard adventure made entirely from procedural geometry. Recover six energy cores, avoid the patrol drones and return to the central beacon.

Run `bun run dev` here, or `bun run gallery` from the engine. WebGL2 is required for the 3D renderer.

- WASD/arrows or touch stick: move relative to the camera.
- Space or touch UP: jump over patrols.
- Shift or touch DASH: dash with a 1.7-second cooldown; solid cover still blocks movement.
- Q/E: orbit the camera.
- V: switch between perspective 3D and orthographic 2.5D.
- Escape: pause/resume. Enter starts the game and restarts after completion.

Three hits return the courier to its starting point; recovered cores are retained for the current run. The final screen starts a fresh run. The example demonstrates Scene3D, primitive geometry, per-instance tint, shared materials, hierarchy animation, ground rings, lighting/shadows, both camera modes, pooled mesh effects, camera shake, canvas UI, synth audio and action input. The opening panel and HUD leave the arena readable; core recovery, patrol contact, landing and dash have distinct feedback. Rules are deterministic and tested separately from rendering. Ground movement uses Kiln's reusable swept-circle controller; jump and objective rules remain game code. This is planar gameplay with real 3D rendering, not a general 3D physics solver.
