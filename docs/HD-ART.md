# High-resolution procedural art

Blackiron paints art in code. Since the visual upgrade it paints smooth, anti-aliased,
high-resolution illustration as well as pixel art, and bakes textured 3D surfaces, skies and
organic shapes. Everything runs headless and identically on WebGL2 and the native hosts.

## 2D: high-resolution sprites

```ts
import { defineSprite, pen, path, linear, radial, conic, noise } from "@blackiron-studio/engine/art";

defineSprite("ui.coin", { w: 24, h: 24, density: 3 }, (p) => {
  const v = pen(p);                       // draws in logical units (here 24 x 24)
  v.circle(12, 12, 10, radial(9, 8, 12, [[0, "#fff3b0"], [1, "#e09a2c"]]));
  v.ring(12, 12, 8, 1.2, "#b86e14", { opacity: 0.6 });
  p.bevel({ size: 2, strength: 0.5 });
  p.dropShadow({ dy: 1.5, blur: 2, opacity: 0.4 });
});
```

- `density` is texels per logical unit. The sprite's size in the game stays `w` x `h`; the
  painter is `w * density` texels. Use 2 for art drawn near 1:1 on a 2x display, 3-4 for UI
  and small icons that are scaled up. High-resolution sprites sample smoothly and skip the
  palette style bible by default (`smooth`, `style` override).
- `pen(painter)` draws anti-aliased vector shapes in logical units: `fill(path, paint)`,
  `stroke(path, width, paint)`, `circle`, `ellipse`, `rect`, `roundRect`, `ring`, `line`,
  `flood`, with `save/restore/translate/scale/rotate`.
- `path()` builds shapes: `moveTo/lineTo/quadTo/cubicTo/close`, `arc`, `ellipse`, `circle`,
  `rect`, `roundRect(x,y,w,h,r | [tl,tr,br,bl])`, `polygon`, `smoothPolygon` (Catmull-Rom
  blobs for leaves, clouds, hair), `star`.
- Paints: a colour, `linear(x0,y0,x1,y1,stops)`, `radial(cx,cy,r,stops,ry?)`,
  `conic(cx,cy,angle,stops)`, or a function `(x, y) => [r, g, b, a]`.
- Options on every fill: `opacity`, `blend` (`normal`, `multiply`, `screen`, `overlay`,
  `soft-light`, `add`, `darken`, `lighten`, `inside` = paint only on existing pixels,
  `behind`, `erase`), and `rule: "evenodd"` for holes.
- Painter effects (radii in logical units): `blur(r)`, `dropShadow({dx,dy,blur,color,opacity,spread})`,
  `glowOutside(color, blur, opacity)`, `innerShadow({...})`, `bevel({size,strength,lx,ly})`,
  `gradientMap(stops)`, `shade((x,y,u,v) => rgba | null, {mode})`, `layer(fn, {mode, opacity})`,
  `composite(src, {...})`, `bleed()`, `blank()`, `copy()`.
- Noise (`noise.*`): `perlin`, `fbm`, `ridged`, `turbulence`, `worley` (cells: `f1`, `f2`,
  `id`), `warped`, `hash01`, `smoothstep`. Pass `period` to tile seamlessly.
- Tiles: paint them opaque to the edge; the atlas extrudes their edges so they never seam.
  Use the same `density` on every tile of a TileMap and pass `smooth: true` when drawing
  batches, nodes or pools (single sprites pick it up from the region).
- Built-ins `__ring` and `__disc` are now smooth and round at any size; `__blob` and
  `__cone` sample smoothly.

### Art direction that reads as professional

- Draw silhouettes first, then three values of light: a gradient body, a darker occlusion
  where shapes meet, a bright rim or bevel toward the light. Keep one light direction (top
  left) across every sprite.
- Layer soft shadows under objects (`dropShadow`, or an ellipse at low opacity) so things
  sit on the ground.
- Use a restrained palette with one accent colour; tint shadows toward blue or purple and
  lights toward warm.
- Ground and large surfaces need texture: `shade` with `fbm` and `worley`, not flat fills.
- Use 2D lights, bloom and the colour grade (`post`) for mood; keep UI crisp and legible.

## 3D: surfaces, sky and shapes

```ts
import { surfaceMaterial, SkyDome3D, terrainGeometry, blobGeometry, texturedBoxGeometry } from "@blackiron-studio/engine/three";

const stone = surfaceMaterial("tiles", { color: "#e2d6bc", repeat: 4, size: 512 });
scene.world3D.add(new SkyDome3D(scene.camera3D, { zenith: "#4f86c4", horizon: "#e4ecea", sunDirection: scene.environment.sunDirection, clouds: 0.4 }));
scene.world3D.add(new Mesh3D(terrainGeometry({ width: 200, depth: 200, height: (x, z) => ..., uvScale: 0.2 }), surfaceMaterial("grass")));
scene.world3D.add(new Mesh3D(texturedBoxGeometry(4, 1, 2, { uvScale: 0.5, bevel: 0.04 }), surfaceMaterial("bricks")));
scene.world3D.add(new Mesh3D(blobGeometry({ radius: 1, roughness: 0.3, flattenBelow: 0.3 }), surfaceMaterial("rock")));
```

- `surface(kind, opts)` / `surfaceMaterial(kind, opts)`: tileable colour, normal and
  metallic-roughness maps for `tiles`, `concrete`, `plaster`, `metal`, `hex`, `grass`, `dirt`,
  `rock`, `sand`, `planks`, `bricks`, `cobbles`. Options: `color`, `accent`, `repeat`,
  `size`, `seed`, `bump`, `variation`, `wear`, plus any Material3D option.
- Textures need world-scaled UVs: `texturedBoxGeometry`, `terrainGeometry({uvScale})`,
  `tiledPlaneGeometry`, `blobGeometry({uvScale})`. Built-in primitives stretch 0..1 per face.
- `SkyDome3D(camera, skyOptions)` follows the camera, unlit and unfogged; set the
  environment fog colour near the sky's horizon colour.
- `Material3D({ fog: false })` excludes a material from distance fog.
- Metals reflect the environment's sky and ground colours (a hemisphere reflection in both
  the WebGL and native shaders), so polished metal no longer goes black away from lights.
- `texturedCylinderGeometry` and `boxUVs(positions, normals, scale)` give world-scaled UVs to
  cylinders and to any geometry you build.
- `skyTexture(options)` caches by options, so scene restarts reuse the baked sky.
- Do not spread a `Material3D` into new options (`{...mat}`): it copies the material's
  `id`. Build materials from plain option objects instead.

## Seeing the result without windows

`bun scripts/shoot.ts <project> --steps "frames:3;shot:title;key:Enter;frames:90;shot:play"`
renders the game in headless Chrome and writes PNGs to `.blackiron/shots/<project>/`. Steps:
`frames:N`, `key:Code`, `hold:Code:N`, `press:action`, `tap:x,y`, `eval:js`, `shot:name`.
Steps split only before a step name, so `eval` code may contain semicolons; `--size WxH`
renders another layout (for example `--size 540x960` for portrait).
