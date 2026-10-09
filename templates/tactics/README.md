# Tactics

A turn-based grid skirmish at 32 px density: four units a side on a 20×12 board, terrain that costs movement or blocks it, movement ranges from the engine's flood fill, attacks with range and forest cover, an enemy phase that closes in, an HD info panel, and win or lose detection. Rules are pure and tested without a browser.

```bash
bun run dev        # http://localhost:4200
bun test
```

## Where to change things

- `src/game.ts` has the map as text, unit types in `TYPES`, and every rule: `reachable`, `targets`, `moveUnit`, `attack`, `endTurn` and the enemy's `enemyStep`.
- `src/art.ts` paints terrain with the engine's materials, both teams' units and the cursor.
- `src/scenes/play.ts` handles clicks, draws highlights and animates moves with tweens; its panel is anchored so it holds at any aspect ratio.
- `tests/game.test.ts` covers terrain costs, attacks, the enemy phase and victory.

Click a unit, click a highlighted tile to move, click a red-marked enemy to attack. End the turn with the button, the E key, or once every unit has acted.
