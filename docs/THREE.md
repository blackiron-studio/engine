# Basic 3D in Kiln

`@kiln/engine/three` adds a mesh world to the existing scene lifecycle. Y is up; X/Z is the ground plane. The world renders before the usual 2D world and HUD, through the existing post-processing pipeline. No external game engine is involved.

```ts
import { Scene3D, Geometry3D, Material3D, Mesh3D } from "@kiln/engine/three";

class Courtyard extends Scene3D {
  override ready() {
    this.background = 0xb9cdd0;
    this.camera3D.position.set(12, 10, 14);
    this.camera3D.lookAt(0, 0, 0);
    this.environment.sunDirection.set(-0.6, 1, 0.4);
    this.environment.shadows = true;

    // Share these objects: matching geometry/material pairs render with instancing.
    const cube = Geometry3D.box();
    const stone = new Material3D({ color: 0xd6c9ac, roughness: 0.8 });
    for (let i = 0; i < 20; i++) {
      const mesh = this.world3D.add(new Mesh3D(cube, stone));
      mesh.position.set(i % 5 * 2 - 4, 0.5, Math.floor(i / 5) * 2 - 3);
    }
  }
}
```

For geometry-based 2.5D, set `camera3D.projection = "orthographic"` and `camera3D.orthoHeight = 20`. For perspective, `fov` is the vertical field of view in degrees. Both modes support `project(point, width, height)` and `screenRay(x, y, width, height)`. A ray's `intersectGround(height)` returns a world-space point or null.

`camera3D.setIsometric(height = 26.8, width = 39, distance = 35)` sets an equal-axis orthographic view around the current target. `orthoWidth` is an optional minimum horizontal span, so narrow viewports show the whole arena. `groundDirection(screenX, screenY, out?)` converts action axes into yaw-relative XZ movement, keeping analog strength and limiting diagonal speed. `screenToGround(x, y, width, height, elevation = 0)` picks a horizontal plane; use weapon height for aiming. Lumen's **V** key switches between perspective and orthographic presentation without changing its gameplay coordinates.

## Geometry, materials and lighting

Primitives: box, plane, sphere, cylinder, cone, torus and flat ring. `Geometry3D.ring(outerRadius = 1, innerRadius = outerRadius * 0.85, segments = 32)` makes an annulus on XZ, facing +Y. Set `innerRadius = 0` for a disc. Rings are useful for floor markings, selection, telegraphs and procedural contact shadows; place them slightly above the supporting surface to avoid coplanar depth fighting. The `Geometry3D` constructor also accepts positions, normals and triangle indices. Positions/normals must be finite, and indices must address existing vertices. Transforms compose through parents, including nonuniform scale. `rotation` contains XYZ Euler angles in radians.

Materials expose colour, roughness, metallic amount, emissive colour/intensity, opacity, double-sided rendering, and three shading modes:

| `shading` | Behavior |
| --- | --- |
| `"standard"` (default) | Metallic/roughness direct-light BRDF and hemisphere ambient. Existing scenes keep their appearance. |
| `"lambert"` | A display-space palette multiplied by `lambertAmbient + lambertDiffuse × lighting`. Direct lights and sun shadows still work, without specular highlights or the standard material's hemisphere ambient. |
| `"unlit"` | Authored base colour and emission, with no normal, BRDF, point-light or shadow calculations in the surface shader. GPU depth still applies. |

`lambertAmbient` defaults to `0.48`; `lambertDiffuse` defaults to `0.52`. These control Lambert shading only. `toneMapped` defaults to `true`, preserving existing ACES tone mapping and environment exposure. Set it to `false` to bypass both: unlit colours then reproduce their authored RGB values before fog and scene post effects. Fog, bloom and grading remain available in all modes. The legacy `unlit` property remains an alias; an explicit `shading` constructor option takes precedence.

For a stylized isometric palette similar to Neon Bastion:

```ts
this.environment.sunColor = 0xffffff;
this.environment.sunIntensity = 1;
this.environment.sunDirection.set(-0.5, 1, 0.3);
const palette = new Material3D({
  shading: "lambert", toneMapped: false,
  lambertAmbient: 0.48, lambertDiffuse: 0.52,
});
const cube = Geometry3D.box();
const cover = this.world3D.add(new Mesh3D(cube, palette));
cover.tint = 0x38565d;
const robot = this.world3D.add(new Mesh3D(cube, palette));
robot.tint = 0x8debd9;
```

`Mesh3D.tint` defaults to white and multiplies the material's base colour per instance. It does not mutate the shared material or change its emissive colour. Opaque meshes with different tints still batch when their geometry, material and rendering flags match. Animate `tint` for hit flashes or reuse a single material for many coloured cuboids. Per-instance tint is recorded by the headless fake too.

The renderer supports a directional sun, up to eight ranked point lights, and distance fog. Transparent meshes sort back to front and do not write depth; intersecting transparent geometry still needs care.

A `PointLight3D(color, intensity, range)` is a regular 3D node. `environment.shadows` enables the directional depth map with PCF filtering. Tune `shadowMapSize`, `shadowExtent`, `shadowTarget` and `shadowBias` for the visible scene. This is one directional shadow volume, not cascaded shadows. Opaque rendering uses real GPU depth testing. WebGL2 supports up to 4× MSAA according to GPU support; the current native mesh pass is single-sample.

`renderer.stats3D` reports visible/culled meshes, triangles, main draw calls and shadow draw calls. Reuse primitive geometry and materials; creating one identical Geometry3D per object prevents instancing. Mesh bounding spheres provide conservative frustum culling. Geometry buffers are cached, inactive buffers expire, explicit `geometry.dispose()` releases them on a subsequent 3D frame, and renderer destruction releases the stage. Do not dispose shared geometry while another mesh uses it.

## Ground movement and feedback

The ground helpers in this module operate on X/Z positions independently of the renderer. They provide exact circular footprints against axis-aligned cover, swept movement, sliding and overlap recovery. They are intended for planar walkers, arena dashes and projectile queries. They do not replace Rapier or provide general 3D rigid bodies, slopes, moving platforms or navigation. Lumen uses the shared movement helper for its courier and collision-safe dash; its jump, drone damage and collectible rules remain game code.

`Particles3D(capacity = 128, seed?)` is a retained pool of tinted cube particles. Add it to `world3D`, then call `burst({ x, y, z, color, count, speed, lifetime, size })`. Coordinates and optional `floor` are local to the pool. It returns the number emitted, drops overflow, reuses one geometry/material, and advances only with scene simulation time. `reset()` clears live particles. The private seeded effects RNG does not consume gameplay randomness. These are small mesh debris and spark effects; there is no particle collision against scene geometry.

`CameraShake3D(seed?)` provides a private deterministic shake phase. Call `kick(strength, duration)`, then `update(dt)` once per simulation step. Apply its `offset` to both camera position and target to translate the view without changing aim direction. Always build the camera from its unshaken base pose; repeatedly adding offsets to the previous pose would drift. This helper never mutates the camera or the gameplay RNG.

## Content, physics and diagnostics (0.14)

See [Foundation upgrade](FOUNDATION-UPGRADE.md) for loading glTF/GLB, scene ownership, persistent editing and validation commands. Geometry accepts UVs; Texture3D supplies base-colour, normal, metallic/roughness and emissive maps. Materials support opaque, mask and blend alpha modes. Imported animations support STEP, LINEAR and CUBICSPLINE tracks and four-weight CPU skinning.

Scene3D.enablePhysics3D() owns a Rapier 3D world on web and native. It supports dynamic/fixed/kinematic bodies, primitive shapes, fixed triangle meshes, CCD, sensors, events, raycasts and visual transform binding. Physics steps with scene time and disposes on detach. Visual bindings require identity parent transforms and explicit world-unit collider dimensions. The existing ground helpers remain useful for Lumen's deliberately planar movement.

## Boundaries

- WebGL2 and the native wgpu host render mesh worlds. Canvas reports unsupported 3D; the headless fake records frames.
- Native meshes currently use one draw per mesh and single-sample rendering; WebGL2 supports instancing and MSAA. Native GPU timing is unavailable.
- One 3D world can render per frame. Pause/settings overlays work; multiple composed 3D worlds need a render-pass API.
- glTF coverage is a defined subset: no morph targets, compressed primitives, alternate UV sets, texture transforms or animation retargeting. Vertex colour/occlusion omissions produce warnings. See the upgrade report for sampler limits.
- CPU skinning is intended for modest animated-model counts. No animation graph editor, navmesh, GI, shader graph or general character controller is supplied.

Run `bun run check:3d` for actual GPU depth, shadows, instancing, texture orientation, alpha-mask, skin deformation and 100 uploaded-resource unload cycles. `bun run check:native-content` compares a textured/skinned GLB and physics scene across browser/native. `bun run check:showcases` exercises all three existing games.

## Neon visual acceptance fixture

`bun run check:neon` reconstructs the supplied Neon Bastion arena with Kiln APIs: shared cuboids, per-instance colours, flat rings, cover trims, gates and four articulated figures. Its Lambert response and orthographic basis match the reference's lighting and camera math. It is a renderer acceptance scene, not an additional flagship game or gameplay port; the source reference is never modified.

The command writes a fixed 1440×900 canvas capture and diagnostics to `.kiln/verification/neon/frame.png` and `result.json`. Diagnostics include WebGL errors, framing error against the reference projection, geometry/draw counts and CPU scene-collection/submission measurements. Those timings exclude GPU completion and display FPS. The fixture explicitly records differences, including omitted world-radial fog; passing does not claim identical images.

Use `bun run check:neon --serve --port 4213` to inspect the generated scene at `http://127.0.0.1:4213/`; append `?animate=1` for the figure animation study. The bundle and `index.html` remain in the verification directory for another local server. Chrome runs with an isolated temporary profile and a bounded termination path.
