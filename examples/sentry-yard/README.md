# Sentry Yard

An isometric shooting range that fights back. Six sentry turrets guard a walled yard. Three
of them stand on raised pads. Clear all six with a rifle, a shotgun and five grenades. Use
brick walls and crate stacks as cover until they break, and set off fuel barrels near
anything you want gone.

Run `bun run dev` here (or `bun run build` for `dist/`). It shows the combat, line of sight
and aiming modules in one small game.

## Play

| | Keyboard and mouse | Gamepad |
|---|---|---|
| Move | WASD or arrows | Left stick or d-pad |
| Aim | Mouse | Right stick (with aim assist) |
| Fire | Left click or Space | RT |
| Grenade | Hold right-click or G to aim, release to throw | Hold LT, release |
| Reload | R | X |
| Weapons | 1 rifle, 2 shotgun, Q swap | Y or RB |
| Restart / pause | T / Esc | Select / Start |

Sentries sweep a cone, shown as a tint on the ground. Step into the cone where they can see
you and they turn and fire slow bolts at you. Low cover stops the bolts. You see only what
your operative sees, and the yard you have explored stays dimmed on the map. To hit a turret
up on a pad, aim at the pad, not at the floor in front of it. The reticle snaps up onto the
block under the cursor. The yard saves each time you wreck a sentry and when you quit to the
title, and Continue resumes from that save.

## What it shows

| Engine piece | Where in the game |
|---|---|
| `FogOfWar`, `visibilityField` (core) | The player's sight and explored yard; each sentry's cone |
| `canSee` with heights | Sentries see over crates but not over brick walls; pads lift their eyes |
| `CombatWorld2D`, `Health`, `gridWalls` | Teams, armour, knockback, hits stopped by tiles of any height |
| `Weapon2D`, `hitscanShot` | Rifle (automatic, bloom) and shotgun (8 pellets, knockback) |
| `Projectiles2D`, `slopeTo` | Sentry bolts arc up or down to their target and hit cover in between |
| `DestructibleGrid` | Bricks crack then fall, crates split, barrels burst and chain |
| `pickGround`, `screenDirToWorld` | Mouse aim onto raised blocks; stick directions follow the screen |
| `TwinStickAim`, `AimAssist` | Mouse or stick, whichever moved last; gentle pull on a stick only |
| `Thrown2D`, `predictThrow`, `launchVelocity` | The grenade arc drawn while aiming is the path it takes |
| `Beams` | Rifle and shotgun tracers that travel from the barrel to the hit |
| `SpritePool` `align` and `stretch`, `Trails` | Sentry bolts and sparks point where they fly; bolts leave a red trail |
| `LightPool` | Muzzle and explosion flashes; each bolt carries a moving glow |
| `Decals`, `IsoTileMap.surfaceAt` | Bullet holes and scorch on wall faces, crates and the ground; a broken tile takes its marks |
| `defineDirections`, `Heading`, `AnimatedSprite` turning | The operative and sentries turn through their eight painted views, with a short blend at each change |
| `definePoints`, `pointInWorld` | The muzzle flash and tracer leave the painted barrel of whichever view is showing |

`src/yard.ts` is the whole game rule set with no rendering. It runs headless in
`tests/yard.test.ts`. `src/scenes/play.ts` turns its events into sprites, sound and screen
shake. `src/units.ts` holds the tile and cell sizes the two share. That way the
simulation never loads the art.

## Art

Every sprite is painted in code in `src/art.ts`. That covers the slabs, walls, crates,
barrels, the eight-way sentries and operative, and the effects, including the spark and bolt
streaks, the bullet hole and the scorch mark. Nothing is imported, and there is no generated art.

## Validation

`bun test` here runs 19 tests:

- The simulation: spotting, cover, barrel chains, raised targets, grenade prediction, saves.
- The scenes headless: the art, the title, retiling, the grenade arc, fog writes, the end card.
- The shot effects: tracers and bullet holes, bolts with a trail and a light, and a broken
  tile clearing its own marks.
- Turning: a half turn passes through the views in between, blends, and fires from the
  painted barrel.

## Not included

There is one yard and one enemy type. Sentries do not move, flank or hear you; perception,
AI movement and an encounter director are the next engine batch. There are no touch controls.
