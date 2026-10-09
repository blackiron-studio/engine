# Graphics without sprites

`Graphics2D` retains tessellated triangles and draws them through the existing renderer. Build shapes once, then animate the node's transform. It supports simple concave polygons in either winding, ellipses, rounded rectangles and round-capped polylines. Geometry is culled in screen space and uses the atlas white texel; no image assets are needed.

```ts
import { Graphics2D } from "@blackiron-studio/engine/scene";
const badge = scene.world.add(new Graphics2D(100, 120));
badge.roundedRect(-32, -20, 64, 40, 10, 0x284e60);
badge.ellipse(0, 0, 12, 12, { color: 0xf3c775, alpha: 0.9 });
badge.polygon([[-4, 0], [0, -8], [4, 0], [0, 8]], 0xffe6ad);
```

Call `clearGraphics()` to rebuild a shape. `clear()` retains its existing Node meaning: remove child nodes. `triangleCount` reports tessellation size. Polygon holes and intersecting outlines are unsupported. Stroke joins overlap; translucent strokes can darken at joints. These are filled triangles without analytic antialiasing, so inspect the result at your target pixel density.

Wisp Hollow demonstrates this API in an actual game: its hero, trees, shrubs, rocks, shrine, trail and HUD panels use retained geometry. Its existing sprite/rig alternatives remain available with K.

# Choosing a dimension

- Use `Scene` and `Node2D` for flat 2D. Lighting, particles and procedural graphics work alongside imported art.
- Use projected `Camera2D`, node height and `IsoTileMap` for sprite-based 2.5D. Highground demonstrates terrain height, ground picking, jump arcs and depth sorting.
- Use `Scene3D`, `Node3D` and `Mesh3D` for actual 3D. Choose an orthographic camera for geometry-based 2.5D, or perspective for 3D. Lumen Salvage demonstrates the latter.

These modes share the application, scene lifecycle, input and canvas UI. 3D coordinates use Y up and X/Z as the ground plane. Existing projected 2.5D uses X/Y ground plus Z height; conversions must be explicit when mixing data. 2D `PhysicsWorld` must not be treated as a 3D solver.
