# Knight

A generated sprite sheet, imported, twice over. `assets/knight-source.png` is sixteen poses of
a knight as an image model drew them: transparent ground with a faint halo, pixels that wobble
between four and six source pixels, poses wherever they landed.

- `bun run import` turns it into `assets/knight.png` and `knight.json` through `kiln art
  import`, with facings (`walk=down:4,5;up:1;left:2,6;right:3,7`), a mirrored attack that
  fires `hit` on its second frame, a held hurt pose and a hitbox. `src/art.ts` loads it with
  one `defineSpriteSet` call; the scene plays `knight.walk` and sets `facing`.
- `bun run parts` cuts frame 3 into seven parts (head, torso, cape as the far arm, sword arm,
  sword, two legs) with `kiln art parts`, which packs them and works out the bone pivots.
  `defineRig` loads them and `new Rig2D("knight-rig")` walks, swings and falls with the
  engine's procedural clips.

Move with WASD or the arrows, Space to attack, H to be hurt, V to celebrate, E to pick up,
Shift to guard. The left knight is the sheet, the right one the rig; they move together.
The strip along the top is every frame the importer found, in reading order.
