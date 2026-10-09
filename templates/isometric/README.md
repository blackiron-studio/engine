# Highground

Kiln's 2.5D example is a small exploration game set on sunlit island terraces. All art is painted in TypeScript: layered tree canopies, stone cliffs, flowers, grass, water, the explorer, coins and effects. The engine projects ground coordinates and height into a depth-sorted isometric view.

Find all 30 sun coins, hop up ledges, and place crates on the island. The island chart shows terrain, coins and your position. Collecting every coin opens the completion card; **Explore again** starts a new run.

- **WASD / arrow keys / left stick / D-pad:** move relative to the screen. Stick travel controls speed with a radial deadzone.
- **Space:** jump; gamepad A also works.
- **Click:** place one crate on the selected land cell.
- **Escape:** pause and settings.
- **R:** restart; gamepad Y also works.

`bun run dev` starts the game. `bun run build` creates the browser build. `bun test` checks save restoration, fog updates, the completion/restart loop, grounded camera/shadows, jump buffering/coyote time, analog speed, canopy occlusion and effect lifetime.

The explorer has four directions and separate procedural stride poses, plus a persistent foot ring. Contact shadows, the ring and the camera follow the actual terrace surface while the explorer jumps. Only foreground canopies overlapping the explorer fade; props retain their normal depth order. Jump input has a 120 ms buffer and 100 ms coyote window. Takeoff and landing use short surface bursts, the hero stretches/squashes, and landings add a restrained camera impulse. Coins bob and turn, then produce a short `+1` and a pulse in the objective counter. Effects expire above the terrace instead of incorrectly bouncing at absolute height zero.

The HUD prioritizes the coin objective and its progress bar, with crates kept secondary. Controls reflect keyboard remapping or controller use; the frame counter is off by default (F3 toggles it). This desktop/controller example does not yet include touch movement controls. Crates demonstrate projected placement and saving; they are decorative, not climbable collision geometry.

The island seed, collected coin cell IDs, crate positions, player position, explored cells and effect random state are saved. A resumed game restores its exact layout and does not respawn collected coins. Older count-only saves retain the coin total by retiring that many deterministic coin cells; their original crate positions were never recorded and cannot be reconstructed.

Coin placement stays within the player's connected land component, using one-level jump links. Fog changes only when the player crosses into another cell, and only the cells entering or leaving visibility are retinted. Coins, pollen and sparks use retained kernel pools. This example uses the sprite-based 2.5D projection path; the separate 3D example demonstrates geometric depth and mesh rendering.
