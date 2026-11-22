# Turning: directional views, headings and named points

Figures painted from several directions turn smoothly. The body turns at a limited speed and
shows the painted view for the way it faces. When the view changes, the old painting fades out
over the new one, and points such as a muzzle follow the view that is showing. None of this
knows about soldiers or guns: the paintings, turn speeds and frame choices stay in the game.
Sentry Yard (`examples/sentry-yard`) uses all of it.

| Piece | Where | Use |
|---|---|---|
| `defineDirections` | art | The painted views of a figure and the screen angle each faces, mirrored or not |
| `defineDirectionalAnimation` | art | Frames per view, with a fallback chain for views that lack them |
| `definePoints`, `pointOf` | art | Named points per frame (muzzle, hand, hat) |
| `Heading` | core | Turn toward a target angle at a limited speed; pure logic, usable in a simulation |
| `AnimatedSprite.heading`, `turn`, `blend` | scene | Show the view for the heading, blending view changes |
| `AnimatedSprite.point`, `pointInWorld` | scene | Where a named point is after mirroring, on screen or in the world |
| `camera.groundDelta`, `groundDeltaOf` | scene | The world offset that draws at a given screen offset from a sprite |

## Direction sets

```ts
// Three paintings: side (facing right), front three-quarter (lower right), back three-quarter (upper right).
defineDirections("guard", { views: { side: 0, front: 0.7, back: -0.7 }, mirror: true });
```

Each view names the screen angle it faces, in radians: 0 is right and π/2 is straight down the
screen. With `mirror`, every view is also shown flipped at π − its angle, so three paintings
cover six directions and five cover eight. Paint one side only. A view facing straight up or
down the screen is its own mirror.

The view shown is the nearest one by angle, so each boundary is halfway between two views. The
views need not be evenly spaced: in the example above, side covers 20° either side of
horizontal and front and back cover the rest. The mirror flip happens only where a view meets
its own mirror, straight toward or away from the camera, never in the middle of the side view.

A dead zone (`deadZone`, 4° by default) keeps a view until the angle is that far past the
boundary, both ways. An aim that sits right on a boundary never flickers.

Views are picked on screen, so a heading means the same thing on any layer. On an isometric
map, world +x runs right and down the screen and shows the front three-quarter view; in a flat
UI layer it shows the side view.

## Directional animations

```ts
defineDirectionalAnimation("guard.idle", { directions: "guard", frames: (v) => [`guard.${v}.idle`] });
defineDirectionalAnimation("guard.walk", { directions: "guard", frames: (v) => [0, 1, 2, 3].map((i) => `guard.${v}.walk${i}`), fps: 10 });
defineDirectionalAnimation("guard.fire", { directions: "guard", frames: { side: ["guard.side.fire"], front: ["guard.front.fire"] }, fallback: "guard.idle" });
defineDirectionalAnimation("guard.kick", { directions: "guard", frames: { side: ["guard.side.kick"] }, fallback: "guard.fire", hold: 0.08 });
```

`frames` gives sprite names per painted view, as a map or as a function of the view name.
Leave a view out where the animation has no frames for it. `fallback` names the animation that
stands in for those views, and chains: in the example, a kick on the back view shows the idle
painting. Frame timing, looping, held poses and frame events work as they do for other
animation sets. The walk keeps its place when the view changes.

## Heading

```ts
const body = new Heading({ angle: 0, halfTurn: 0.15, catchUp: 1.2, catchUpHalfTurn: 0.06 });
body.target = aim;   // every frame
body.update(dt);
body.angle;          // where the body faces
```

- **Turn speed:** the body turns toward `target` along the shorter way at `halfTurn` seconds
  per half turn. A turn from front to back passes through the side. `halfTurn: 0` snaps, for
  a turret.
- **Same at any frame rate:** the result doesn't depend on the step size, so a simulation and
  a renderer at different rates agree.
- **Catch-up:** when the body is more than `catchUp` radians behind, it turns at
  `catchUpHalfTurn` until it is within that. Then it slows to the normal speed, so a body
  never looks like it is shooting backwards.
- **Behind:** a target straight behind keeps the way the body was already turning.

Aim stays the game's own: shots, aim lines and the simulation use the aim angle, and only the
body lags. `timeToFace(angle)` answers how long a turn will take, for AI or tests. `towards(dx,
dy)` and `snap()` cover movement directions and spawning.

## The sprite

```ts
const guard = scene.world.add(new AnimatedSprite("guard.idle", x, y));
guard.turn = new Heading({ angle: facing, halfTurn: 0.2 });
// each frame:
guard.turn.target = facing;
guard.play(moving ? "guard.walk" : "guard.idle");
```

With a `turn`, the sprite steps it in `update` and copies its angle to `heading`. Without one,
set `heading` yourself. Each update the sprite picks the view for the heading through its
layer's projection, the camera's under the scene's world, and plays the frames for that view,
mirrored when the view is.

When the view changes, the outgoing painting draws on top of the new one and fades out over
`blend` seconds (60 ms by default). It sits at the same spot, just in front in depth, so you
see one figure turning. Mirror flips blend the same way. Tint, the flash material and alpha
apply to both. `direction` is the view showing, and `blending` says whether a fade is running.
`refreshView()` picks the view at once, after changing the heading.

## Named points

```ts
definePoints("guard.side.fire", { muzzle: [14, -22] });
const m = guard.pointInWorld("muzzle", 4);   // [x, y, z] in the parent's space
if (m) fx.spawn({ sprite: "flash", x: m[0], y: m[1], z: m[2] });
```

Points are given per frame in sprite units from the sprite's origin, as painted. `point(name)`
returns one for the frame showing, mirrored with the view and scaled with the node; during a
blend it is the incoming view's. `pointInWorld(name, forward)` turns it into a world position.
On a projected layer that is the ground point and height that draw at that spot. It is moved
`forward` world units toward the camera first, so a flash spawned there sorts in front of the
figure. `camera.groundDelta(u, v, forward)` does the same for any screen offset.

## Simulation

`Heading` has no drawing. An enemy's simulated body can turn with it, so a guard needs time to
face you before it can fire. Give the sprite the same values, or set its `heading` from the
simulated one. The simulation never depends on views, blends or points.
