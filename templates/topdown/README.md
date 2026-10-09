# Topdown

A top-down collect-and-avoid game at 32 px density: a scrolling tile map with autotiled dark patches, a hero with walk frames, gems to gather, slimes that chase, hearts, HD text, touch and gamepad input, and a best score that saves. Rules live in `src/game.ts` as pure state and are tested without a browser.

```bash
bun run dev        # http://localhost:4200
bun test
```

## Where to change things

- `src/game.ts` holds the world size, the tuning numbers in `RULES`, world generation and the `tick` function. Everything about how the game plays is here.
- `src/art.ts` paints every sprite with the engine's materials. Add a sprite with `defineSprite`, then use its name in a `Sprite` node.
- `src/scenes/meadow.ts` builds the `TileMap`; `play.ts` mirrors the state into nodes each frame.
- `src/fonts.ts` names the web fonts loaded from `blackiron.json`.
- `tests/game.test.ts` shows how to test rules with a seeded world.
