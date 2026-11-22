# Shot effects: streaks, beams, trails, pooled lights and decals

These are general-purpose scene pieces for the look of action games on flat and projected
(isometric, tilt) maps. They know nothing about weapons. A game decides colours, widths,
timings and which surface gets which mark. Sentry Yard (`examples/sentry-yard`) uses all of
them.

| Piece | Where | Use |
|---|---|---|
| `camera.screenVector`, `screenAngle`, `screenLength` | `Camera2D` | How a world direction looks on screen |
| `align: "velocity"`, `stretch` | `SpritePool` spawns and pool options | Sparks, bolts, rain, arrows, casings that point along their flight |
| `Beams` | scene node | Tracers, lasers, lightning, tethers, aim lines |
| `Trails` | scene node | Ribbons behind projectiles, dashes, thrown things |
| `LightPool` | scene node inside a `LightLayer` | Muzzle flashes, impacts, explosions, glows that move |
| `Decals` | scene node | Bullet holes, scorch, blood, footprints, tyre marks |
| `IsoTileMap.surfaceAt` | `IsoTileMap` | Which face or top a hit lands on, snapped onto it |

## Screen directions

`camera.screenVector(dx, dy, dz)` is a world direction through the projection's linear part
and the zoom, in screen pixels. `screenAngle` is its angle and `screenLength` its length. In
an isometric view a step along +x goes right and down the screen, and +z goes straight up. A
flat camera returns the direction as it is and ignores `dz`, as flat drawing does.

## Particles that point where they fly

```ts
const sparks = new SpritePool({ sprite: "spark.streak", additive: true, align: "velocity", stretch: 0.01 });
sparks.spawn({ x, y, z, vx, vy, vz, life: 0.2 });
```

`align: "velocity"` turns each node's +x axis along its velocity as drawn, through the
camera's projection, every frame. Draw the art pointing right. `rot` and `vrot` add on top.
`stretch` multiplies the x scale by `1 + speed * stretch`, where speed is in screen units
before zoom. Fast nodes become long streaks and slow ones shrink back. Both work in the
kernel itself, with the same results in the WebAssembly, native and TypeScript kernels.
They cost nothing per node in script, and a node at rest keeps its own rotation.

## Beams

```ts
const beams = scene.world.add(new Beams({ segment: 20 }));
beams.spawn(x0, y0, z0, x1, y1, z1, { speed: 2600, head: 88, width: 2.2, color: 0xfff3d0, glow: 0xffa040 });
```

A beam is a glowing strip between two world points, with a height at each end. It is a wide
glow under a narrow core, drawn as stretched additive strips that bloom picks up. It is cut
into segments of at most `segment` world units, and each segment sorts at its own depth, so
a wall in front of part of the beam hides that part.

- A whole beam (`speed: 0`) fades over `life` and narrows with `thin`. Use `life: Infinity`
  for one that stays, such as an aim line, and update it with `move(handle, …)`.
- With a `speed`, only a section `head` units long travels from A to B. The tracer is seen
  leaving the barrel and arriving. It fades toward its tail (`taper`) and is gone once it
  has passed B.
- `emissive` (on by default) keeps beams bright in a dark, lit scene.

`spawn` returns a handle for `move`, `free` and `alive`. A full node replaces its oldest beam.

## Trails

```ts
const trails = scene.world.add(new Trails({ time: 0.16, width: 5, endWidth: 0.6, color: 0xffb4a4, endColor: 0xff3a2a }));
// every frame, for each live projectile:
trails.push(bolt.id, bolt.x, bolt.y, bolt.z);
```

The game pushes a key and the current position each frame. The node keeps recent points and
draws a tapered ribbon through them. Width, colour and alpha blend from head to tail, by age
(`time`) and, when set, by distance (`length`). Points older than `time` drop off. Once the
key stops being pushed, the trail retracts into its last point and is removed. Each segment
sorts at its own depth. `free(key)` drops a trail at once.

## Pooled lights

```ts
const lights = scene.world.add(new LightLayer(0xb0b6c4)).add(new LightPool({ capacity: 24 }));
lights.flash(x, y, z, { color: 0xffc27a, radius: 105, life: 0.05 });   // dies over its life
lights.track(bolt.id, bolt.x, bolt.y, bolt.z, { color: 0xff5a3a, radius: 58 });  // every frame
```

- `flash` lights a point for `life` seconds along a `curve`: "linear", "quad" (the default),
  "smooth", "hold", or a function of t.
- `track` keeps a light on something that moves while the game keeps calling it, and fades
  it over `fade` once the calls stop.
- The pool holds `capacity` lights. When full, the dimmest gives way to a brighter newcomer,
  and a newcomer dimmer than all of them is dropped. `flash` returns false in that case.

Lights draw into the light target. That target multiplies the scene and stops at 1, so a
flash can only brighten what the ambient light dimmed. Sentry Yard uses a slightly dim,
cool ambient light and raises `post.brightness` to give the level back.

## Decals

```ts
const decals = scene.world.add(new Decals({ capacity: 180, cell: 32 }));
const at = map.surfaceAt(hit.x, hit.y, hitZ, hit.nx, hit.ny);
if (at.visible) decals.mark(at.x, at.y, at.z, { sprite: "hole", normal: at.normal, randomRot: true, scale: [0.75, 1.1] });
```

Paint decal art as seen straight on: a round hole is a circle. The node lays each mark on its
surface through the projection.

- With no `normal`, or `[0, 0, 1]`, the mark lies on the ground. With a wall normal such as
  `[1, 0, 0]`, it stands on the wall face, squashed to the face's angle.
- Each mark stays for `stay` seconds and then fades over `fade`.
- The node is a ring of `capacity` slots, and the oldest mark goes first.
- Random rotations and sizes come from the node's seed.
- In projected layers a mark sorts with the tile it lies on, just above that tile's floor or
  face, so actors standing there still draw over it. `cell` must match the map's.
- `freeCell(col, row)` removes the marks on one tile, such as one just destroyed. It leaves a
  neighbour's face on the shared edge alone. `freeWhere(test)` removes any others.

`IsoTileMap.surfaceAt(x, y, z, nx, ny)` takes a hit point, its height and the face normal the
ray entered through, as combat traces and `castGridRay` report. It returns the cell, the
point snapped onto the face, the normal, and whether the hit was on top. It also returns
whether the map draws that face: faces toward the camera, above the neighbour's floor.

## Placement and sorting

`Beams`, `Trails`, `LightPool` and `Decals` take positions in their parent's ground space,
offset by the node's own position. Leave them at the world's origin. Their own rotation and
scale are not applied. In projected layers every item, segment or mark gets its own depth
key from its world point.
