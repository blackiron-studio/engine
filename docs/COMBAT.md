# Combat, line of sight and aiming (2D and 2.5D)

Generic systems for action games on flat and isometric maps: line of sight and fog of war on
grids, a combat world with teams, hits, knockback and explosions, data-defined weapons,
pooled projectiles, destructible tiles with chain reactions, aiming on projected maps and
arcing throws. None of it draws or plays sound; games listen to events and dress them.

`examples/sentry-yard` (Sentry Yard) uses all of it on an isometric yard with raised walls,
crates, barrels and turrets.

| Module | Import | What |
|---|---|---|
| `core/sight.ts` | `@blackiron-studio/engine/core` | `castGridRay`, `canSee`, `visibilityField`, `inSightCone`, `FogOfWar` |
| `combat/health.ts` | `@blackiron-studio/engine/combat` | `Health`: hit points, armour pool, resistances, grace window |
| `combat/world.ts` | same | `CombatWorld2D`, `gridWalls`, `physicsWalls` |
| `combat/weapon.ts` | same | `WeaponDef2D`, `Weapon2D` |
| `combat/projectiles.ts` | same | `Projectiles2D`, `hitscanShot`, `slopeTo` |
| `combat/destructible.ts` | same | `DestructibleGrid` |
| `combat/aim.ts` | same | `pickGround`, `screenDirToWorld`, `TwinStickAim`, `AimAssist` |
| `combat/throw.ts` | same | `Thrown2D`, `launchVelocity`, `predictThrow`, `heightField` |

## Line of sight

A `SightGrid` is any grid: `cols`, `rows`, world units per `cell`, `opaque(col, row)` for cells
that block at any height, and an optional `height(col, row)` for cells with a top (raised
blocks, low walls, ledges). It is called for cells outside the map too, so a game decides
whether the edge blocks.

```ts
const grid: SightGrid = {
  cols: map.cols, rows: map.rows, cell: 32,
  opaque: (c, r) => !map.inBounds(c, r) || map.get(c, r) === BARREL,
  height: (c, r) => map.elevationAt(c, r) * 16,
};
canSee(grid, guard.x, guard.y, player.x, player.y, { range: 300, eye: 18, facing: guard.facing, fov: 1.7 });
```

- `castGridRay(grid, x0, y0, x1, y1, { z0, z1 })` walks every cell the segment crosses
  (Amanatides–Woo) and returns the first that blocks it, with the face it entered through.
  A cell blocks when it is opaque or taller than the ray where the ray crosses it, so a low
  wall is seen and shot over. A ray through the exact corner between two blocking cells is
  blocked; beside one open cell it squeezes past.
- `canSee` checks range and cone first, then the ray from the viewer's eye (ground under it
  plus `eye`) to the target's height. The target's own cell is left out, so walls are seen.
- `visibilityField(grid, x, y, radius, { eye, facing, fov })` returns every cell a viewer sees
  as a byte grid, by symmetric shadowcasting: if A sees B, B sees A, and the walls that bound
  a room are lit. With heights, cells taller than the eye block; seeing over a low wall onto
  a taller one behind it is `canSee`'s job.
- `FogOfWar` keeps what any viewer sees now and what has ever been seen. `update(viewers)`
  returns only the cells whose visibility flipped, so a renderer retints those alone.
  `saveExplored` and `loadExplored` round-trip the explored cells as a short string.

## Combat world

```ts
const world = new CombatWorld2D({ walls: gridWalls(grid), destructibles });
const player = world.add({ x, y, radius: 9, height: 26, team: "player", health: new Health(100), vx: 0, vy: 0 });
world.on("damage", (e) => flash(e.target));
world.on("explode", (b) => boom(b.x, b.y, b.radius));
```

- Targets are plain objects: position, radius, team, `Health`, and optionally a height range
  (`z`, `height`) for shots that carry one, velocity for knockback and a mass.
- Walls are a `RayBlocker2D`: `gridWalls(grid)` (heights included) or `physicsWalls(world, mask)`
  for collider-built maps.
- `trace` returns the nearest wall or living hostile target along a segment; teammates are
  passed through unless `friendlyFire` is on. `ignore` keeps the shooter out of its own shot;
  `radius` thickens it for projectiles.
- `damage` applies armour and resistances, knockback scaled by mass, and emits `damage` and
  `kill`.
- `impact` applies a trace's hit: the target, or the destructible cell behind the wall face,
  and the splash if the payload has one.
- `explode` hurts targets and destructible cells within reach, fading by `falloff` (0 flat,
  1 linear, 2 steeper) from the blast to each target's edge; walls shelter what is behind
  them. Destroyed explosive cells schedule their own blast after `delay` on the world clock,
  which `update(dt)` advances, so chain reactions are ordered and repeatable.

## Weapons and projectiles

A `WeaponDef2D` is data: damage, `interval`, magazine, reserve, reload time, range,
automatic or semi, bursts, pellets, spread, bloom (per shot, cap, recovery), recoil,
projectile speed and radius (hitscan without), knockback, damage kind and splash.

```ts
const rifle = new Weapon2D({ id: "rifle", damage: 14, interval: 0.11, magazine: 30, reloadSeconds: 1.3, range: 380, automatic: true, spread: 0.025, bloom: 0.035, bloomMax: 0.24, bloomRecovery: 0.8 }, seed);
for (const shot of rifle.step(dt, { fire, angle })) projectiles.shoot(rifle.def, shot, x, y, { team, source: player, z: 12, slope });
```

- `step` returns the shots fired this frame, each with its `age` (how long ago in the frame it
  went off), so a gun fires at the same rate at 30, 60 or 144 fps and projectiles start where
  they would have been. A semi-automatic pull made while the gun cycles is remembered for
  `buffer` seconds. Spread comes from a seeded `Rng`.
- `Projectiles2D` pools projectiles and sweeps each step through `trace`, so fast shots do not
  tunnel; a full pool recycles the oldest. `shoot` picks a projectile or a hitscan from the
  definition.
- `slope` is height gained per unit travelled. `slopeTo(z0, z1, distance)` aims a shot up onto
  a ledge or down from one; without it shots fly level and raised blocks stop them.

## Destructible tiles

```ts
const destructibles = new DestructibleGrid(map, {
  [CRATE]: { hp: 45, stages: [CRATE_SPLIT], broken: RUBBLE, resist: { bullet: 0.8, explosive: 2 } },
  [BARREL]: { hp: 18, broken: OIL, explode: { radius: 92, damage: 80, delay: 0.14 } },
}, { cell: 32 });
```

The map is anything with `cols`, `rows`, `get` and `set` (`TileMap`, `IsoTileMap`,
`TileMapData`). Damage swaps in stage tiles as hit points fall and the broken tile at zero,
through the map's own `set`, so tile maps re-autotile and rebuild. A broken tile may have its
own entry to break again. Anything derived from the map (colliders, elevation, paths) is the
game's to rebuild: read `takeChanges()` each frame or listen to `on("change")`. `save()` and
`load()` round-trip every damaged cell, and `load` reports the restored cells through
`takeChanges()` too.

## Aiming on projected maps

- `pickGround(camera, sx, sy, heightAt, { maxZ, step })` finds the first surface the view ray
  meets coming down from `maxZ`, so the cursor lands on top of a raised block rather than on
  the floor behind it.
- `screenDirToWorld(camera, x, y, dx, dy)` turns a stick's screen direction into a ground
  direction: up on the stick walks or aims up the screen, whatever the projection.
- `TwinStickAim` follows whichever of the right stick or the mouse moved last and keeps the
  last aim when neither does.
- `AimAssist` picks the target nearest the aim line inside a cone, weighs distance, skips
  targets `canSee` rejects, and bends the aim toward it by `strength`. A locked target is kept
  through a wider `sticky` cone so the aim does not flick between two. Use it for sticks and
  leave the mouse alone.

## Throws

`Thrown2D` steps at a fixed 1/120 s with gravity, floor bounces that lose speed, wall and
cliff bounces that flip the speed that hit them, rolling drag and rest. `predictThrow` runs
the same steps, so the arc drawn while aiming is exactly the path the throw takes at any
frame rate. `launchVelocity` lands on a target point, and `heightField(grid)` turns a sight
grid into the ground a throw bounces on (opaque cells are walls).

## Not included yet

Perception (hearing, suspicion), AI movement (steering, flow fields, cover search), an
encounter director, decals, triggers and interactables are the next batch.
