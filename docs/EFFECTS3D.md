# 3D effects: sprites, decals, flashes, debris, springs and shapes

Version 0.22 moves the parts of a good-looking 3D shooter that are not about any one game into
the engine: effect sprites that draw in one batch, scorch marks, short light flashes, debris
that tumbles and bounces, springs for recoil and hit jolts, a view punch and landing dip, and a
builder for hard-surface models. The recipes stay in the game: what a rifle's muzzle flash looks
like, how a drone burns or what a crate is made of. Signal Breach (`examples/breach`) uses all
of it. Its `src/fx.ts` holds the recipes and `src/models.ts` the guns, drones and props.

| Piece | Where | Use |
|---|---|---|
| `Mesh3D.opacity`, `glow`, `uvRect` | three | Fade, glow into bloom and pick a texture cell per instance, without a material per mesh |
| `Effects3D`, `EffectHandle3D` | three | Pooled billboard, streak and flat sprites; `decal` keeps long-lived marks in their own ring |
| `EffectAtlas3D`, `standardEffectCells` | three | The sprite textures in one image, painted in code; add your own cells |
| `LightPool3D` | three | A few point lights kept ready for flashes, optionally riding a node |
| `Debris3D` | three | Take a part out of a model and let it fly, bounce, smoke and sink |
| `Spring` | core | A damped spring on one number; same motion at any frame rate |
| `FirstPersonLook.punch`, `land`, `update`, `viewForward` | three | A view kick that springs back and an eye dip on landing |
| `ShapeBuilder3D`, `arcPoints`, `mirrorOutline` | three | Bevelled boxes, extrusions and lathes with edge strips, merged into one geometry per material |
| `eulerFromBasis` | three | Euler angles for an orthonormal basis (point a node along a direction) |

## Per-instance opacity, glow and texture cell

```ts
spark.opacity = 0.6;             // multiplies the material's opacity; 0 skips the mesh
spark.glow = 2;                  // adds its own colour × 2 as emission, so it feeds bloom
spark.uvRect[0] = 0.5;           // [u, v, width, height] of the texture window it shows
atlas.apply(spark, "dot");       // or let an EffectAtlas3D set the window for a named cell
```

These sit next to `tint` and travel with each instance, so meshes that differ only in them still
share one draw. A mesh below full opacity draws blended. Blended meshes are sorted back to front
as before, and neighbours in that order with the same geometry, material and flags now merge into
one instanced draw. A field of smoke puffs, sparks and tracers from one atlas is one draw call.
WebGL2 and the native wgpu renderer behave the same (the native uniform packet grew to 180 floats
and gained an instanced blended pipeline).

## Effect sprites

```ts
const fx = this.world3D.add(new Effects3D({ capacity: 360, decals: 72, seed: "my-game" }));

fx.spawn({
  texture: "smoke",               // a standard cell; "smoke", "fire" and "star" have variants
  position: muzzle,
  velocity: forward.clone().multiplyScalar(0.5),
  lifetime: 0.8,
  size: 0.05, endSize: 0.3,
  colors: [0xb8d0d4, 0x9aa0a8],
  opacity: 0.32, fadeIn: 0.08, fadeOut: 0.3,
  gravity: -0.35,                  // negative rises
  drag: 1.2,
  spin: 0.8,
});

// A tracer: a streak that grows out of the muzzle and never trails behind it.
fx.spawn({ texture: "streak", kind: "streak", position: muzzle, velocity: dir.clone().multiplyScalar(240),
  lifetime: 0.12, size: 0.03, stretch: 0.02, maxLength: 4, fromOrigin: true, colors: [0xbff8ff], glow: 3 });

// A scorch mark on the floor, kept in the decal ring so sparks never push it out.
fx.decal({ texture: "scorch", kind: "flat", position: hit.point, normal: hit.normal,
  lifetime: 30, size: 2.5, colors: [0x000000], opacity: 0.8, fadeOut: 0.85 });
```

- `kind`: `billboard` (the default) faces the camera. `streak` stretches along its motion and
  turns about it to face the camera. `flat` lies on `normal`.
- Colours run through one to three stops over the life (`mid` places the middle one). Size moves
  from `size` to `endSize`, eased by `grow`. Opacity fades in over the first `fadeIn` of the
  life and out from `fadeOut` to the end.
- `follow: node` keeps a sprite at `position` in that node's space (a charge glowing on a
  drone's eye) and ends it with the node.
- `lifetime: Infinity` keeps a sprite until its handle frees it, for sprites the game drives
  itself. `EffectHandle3D` has `alive`, `position`, `moveTo(position, velocity?)`, `opacity`
  and `free()`.
- When every sprite is busy, the next one that ends by itself is reused, so a long-lived sprite
  is never stolen. `activeCount` and `reset()` help tests and restarts.
- Sprites are turned to `options.camera`, or the scene's `camera3D`, as the frame is drawn.
  Positions are world space, so add `Effects3D` untransformed.

### The atlas

`EffectAtlas3D.standard()` paints `glow`, `dot`, three `smoke`, two `fire`, two `star`,
`flame`, `ring`, `scorch` and `streak` cells into one 512 × 512 texture. Each cell is white, with
the shape in alpha and a little shading in the grey, so the tint gives the colour. Build your own
with `new EffectAtlas3D({ ...standardEffectCells(), shard: { width: 32, height: 32, paint } })`,
where `paint(u, v)` returns `[luminance, alpha]`. `atlas.apply(mesh, name, variant)` points any
mesh at a cell (the cylinder of a muzzle flash, say) so it batches with the sprites.

## Light flashes

```ts
const lights = this.world3D.add(new LightPool3D(3));
lights.flash(muzzle, { color: 0x9ff4ff, intensity: 6, range: 5, lifetime: 0.06 });
lights.flash({ x: 0, y: 0, z: -0.3 }, { color: 0xff5050, intensity: 3, range: 3, lifetime: 0.5 }, bolt); // rides the bolt
```

A surface is lit by its eight strongest lights, so flashes come from a small fixed pool. When all
are busy, the one closest to finished gives way. `falloff` shapes the fade (2 drops fast and
lingers, 1 is even).

## Debris

```ts
const debris = this.world3D.add(new Debris3D(90));
debris.cast = (o, d, len) => combat.cast(o, d, len, player.collider.handle); // or debris.floor = 0
debris.launch(drone.arm, {
  velocity: out.multiplyScalar(4), spin: { x: 6, y: 2, z: 9 }, radius: 0.2, lifetime: 8,
  emit: [{ every: 0.12, slowdown: 0.8, spawn: (at) => fx.spawn({ texture: "smoke", position: at, /* … */ }) }],
  onStep: (node, age, dt) => { /* spin a rotor down, cool a glow */ },
  onBounce: (point, normal, speed) => { if (speed > 2) clank(); },
});
```

`launch` takes the node (and its subtree) out of its model where it is, keeping how it is
turned and its scale. The piece falls, tumbles, bounces off the level through the ray cast and
scrapes to a stop. It keeps emitting while alive, then sinks out of sight over its last `sink`
seconds. At `capacity` the oldest piece goes.

## Springs, punch and landing

```ts
import { Spring } from "@blackiron-studio/engine/core";

const back = new Spring(260, 22);  // stiffness, damping (Spring.critical(k) settles without overshoot)
back.kick(2.9);                    // on each shot
gun.position.z = rest + back.step(dt); // toward 0, or step(dt, target)
```

A spring is stepped in slices of at most 6 ms, so stiff springs stay stable and move the same
at 30, 60 or 144 fps. `FirstPersonLook` keeps three of them. `look.punch(pitch, yaw)` kicks the
view, and `look.land(fallSpeed)` dips the eye. Call `look.update(dt)` every frame. `apply` adds
the punch and the dip to the camera, while `forward()`, the aim, ignores them.
`viewForward()` is the punched direction. Read `look.dip.value` to make a viewmodel follow the
dip.

## Hard-surface models

```ts
const metal = new ShapeBuilder3D(3, 2.5);   // texture repeats per metre on faces and along edges
metal.box(0.1, 0.06, 0.5, { bevel: 0.006, at: [0, 0, -0.2] });
metal.extrude([[0, 0], [0.12, 0], [0.1, -0.18], [0.02, -0.16]], 0.04, { axis: "x", bevel: 0.004, corner: 0.01 });
metal.lathe([[0.02, 0], [0.024, 0.08], [0.018, 0.3]], { axis: "z", segments: 20, at: [0, 0.03, -0.45] });
const { body, edge } = metal.build();       // body faces, and bevel/rim strips for an edge texture
```

Outlines are drawn in a side (`x`), plan (`y`) or front (`z`) view and extruded across it. Rims
get a chamfer (`bevel`), and convex corners sharper than `sharp` degrees are cut (`corner`) and
smoothed otherwise. Lathes turn a profile about an axis, optionally `closed` into a ring, with
`uv: "unit"` to wrap a texture made for that body once around it. `buildOne()` merges body and
edges into one geometry. `arcPoints` and `mirrorOutline` help draw outlines. Keep one builder
per material and every part in that material becomes one mesh.

## Checks

- `tests/effects3d.test.ts`: sprites, decals, pooling, follow and handles; atlas cells; light
  flashes; debris bouncing and sinking; springs; punch and dip; shape building.
- `bun run check:3d`: 242 sprites with different colours, opacities, glows and cells draw in one
  call on real WebGL2. Glow and the texture window are checked by pixel.
- `kernel` `render::mesh` tests: blended neighbours batch in order and split on state, natively
  on Metal.
- `bun run check:fps`: Signal Breach plays through on WebGL2 with the new effects.
