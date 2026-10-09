# Platformer

A side-view platformer at 32 px density: a long ASCII level drawn by an autotiled `TileMap`, gravity, a jump with coyote time and a jump buffer, one-way platforms, coins, spikes that send you back to the start, a flag to reach, parallax hills and clouds, HD text, and touch and gamepad input. Physics run through the engine's tile collision helper and are tested without a browser.

```bash
bun run dev        # http://localhost:4200
bun test
```

## Where to change things

- `src/game.ts` has the level as text (`LEVEL`), the legend, the tuning numbers in `RULES` and the `tick` function.
- `src/art.ts` paints the ground autotile set, the hero, coins, spikes, the flag and the backdrop.
- `src/scenes/backdrop.ts` shows `ParallaxLayer` with repeating sprites; `play.ts` draws the level and the hero from the state.
- `tests/game.test.ts` covers landing, jumping, coins, spikes and finishing.

Edit `LEVEL` and reload: `#` is solid, `=` a one-way platform, `o` a coin, `^` a spike, `P` the start and `F` the flag.
