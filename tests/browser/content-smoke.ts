import { WebGL2Renderer } from "../../src/render/webgl2.ts";
import { defaultPost } from "../../src/render/types.ts";
import { Scene3D, Mesh3D } from "../../src/three/scene.ts";
import { Geometry3D } from "../../src/three/geometry.ts";
import { Material3D } from "../../src/three/material.ts";
import { Texture3D } from "../../src/three/texture.ts";
import { Skin3D, Transform3D } from "../../src/three/animation.ts";
import { mat4Identity } from "../../src/three/math.ts";
export function contentSmoke(
  renderer: WebGL2Renderer,
  gl: WebGL2RenderingContext,
) {
  const scene = new Scene3D(800, 600),
    post = defaultPost();
  post.bloom = 0;
  post.vignette = 0;
  post.saturation = 1;
  post.contrast = 1;
  scene.camera3D.position.set(0, 0, 5);
  scene.camera3D.lookAt(0, 0, 0);
  scene.camera3D.projection = "orthographic";
  scene.camera3D.orthoHeight = 6;
  scene.environment.shadows = false;
  scene.environment.fogDensity = 0;
  const draw = () => {
    renderer.begin(0x102030);
    renderer.render3D(scene.collectFrame3D());
    renderer.end(post);
    const error = gl.getError();
    if (error) throw new Error(`Content GPU error ${error}`);
  };
  const pixel = (x: number, y: number) => {
    const p = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return Array.from(p);
  };
  const g = new Geometry3D(
    [-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 1, 2, 0, 2, 3],
    [0, 1, 1, 1, 1, 0, 0, 0],
  );
  const texture = new Texture3D(
      2,
      2,
      [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255],
      "nearest",
      "clamp",
    ),
    material = new Material3D({
      map: texture,
      shading: "unlit",
      toneMapped: false,
    });
  scene.world3D.add(new Mesh3D(g, material));
  draw();
  const corners = [
    pixel(300, 400),
    pixel(500, 400),
    pixel(300, 200),
    pixel(500, 200),
  ];
  if (
    corners[0][0] < 250 ||
    corners[0][1] > 5 ||
    corners[1][1] < 250 ||
    corners[2][2] < 250
  )
    throw new Error(
      "Texture UV orientation or color failed: " + JSON.stringify(corners),
    );
  texture.update(new Uint8Array(16).fill(0));
  material.alphaMode = "MASK";
  draw();
  const hole = pixel(400, 300);
  if (hole[0] !== 16 || hole[1] !== 32 || hole[2] !== 48)
    throw new Error("Alpha mask did not discard");
  scene.world3D.clear();
  g.dispose();
  texture.dispose();
  renderer.collectGarbage();
  const baseline = renderer.diagnostics.mesh;
  for (let i = 0; i < 100; i++) {
    const temporary = new Texture3D(1, 1, [i, 255 - i, 150, 255]),
      geometry = Geometry3D.box();
    scene.world3D.add(
      new Mesh3D(
        geometry,
        new Material3D({ map: temporary, shading: "unlit", toneMapped: false }),
      ),
    );
    draw();
    scene.world3D.clear();
    temporary.dispose();
    geometry.dispose();
    renderer.collectGarbage();
    const now = renderer.diagnostics.mesh;
    if (
      now.geometries > baseline.geometries ||
      now.textures > baseline.textures
    )
      throw new Error("GPU resources grew after unload");
  }
  const triangle = new Geometry3D(
    [-1, -1, 0, 1, -1, 0, 0, 1, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 1, 2],
  );
  const mesh = scene.world3D.add(
      new Mesh3D(
        triangle,
        new Material3D({
          color: 0xffcc22,
          shading: "unlit",
          toneMapped: false,
        }),
      ),
    ),
    joint = new Transform3D();
  const skin = new Skin3D(
    mesh,
    [joint],
    [mat4Identity()],
    new Float32Array(12),
    new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  );
  skin.update();
  draw();
  const before = pixel(400, 300);
  joint.x = 3;
  skin.update();
  draw();
  const after = pixel(400, 300);
  if (before[0] < 240 || after[0] !== 16)
    throw new Error("Skinned vertex updates did not reach GPU");
  skin.dispose();
  triangle.dispose();
  scene.world3D.clear();
  renderer.collectGarbage();
  return {
    corners,
    alphaMask: hole,
    skinBefore: before,
    skinAfter: after,
    unloadCycles: 100,
    resources: renderer.diagnostics.mesh,
  };
}
