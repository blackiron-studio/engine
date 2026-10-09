import type { App } from "../../../src/app/app.ts";
import {
  Scene3D,
  Geometry3D,
  Material3D,
  Mesh3D,
  Transform3D,
  loadGltf,
} from "../../../src/three/index.ts";
export default async function main(app: App) {
  const scene = new Scene3D(800, 600);
  scene.background = 0x142536;
  scene.camera3D.position.set(0, 1, 8);
  scene.camera3D.lookAt(0, 1, 0);
  scene.camera3D.projection = "orthographic";
  scene.camera3D.orthoHeight = 6;
  scene.environment.shadows = false;
  scene.environment.fogDensity = 0;
  const asset = await loadGltf(app.platform, "assets/model.glb");
  scene.resources.own(asset);
  const model = scene.resources.own(asset.instantiate());
  scene.world3D.add(model);
  model.setPosition(-2, 0, 0);
  model.setScale(2);
  model.clips[0].sample(0.5);
  model.skins[0].mesh.material.toneMapped = false;
  const physics = await scene.enablePhysics3D();
  physics.createBody({
    type: "fixed",
    position: { x: 0, y: -0.5, z: 0 },
    shape: { kind: "box", halfExtents: [5, 0.5, 5] },
  });
  const falling = scene.world3D.add(new Transform3D());
  falling.position.set(1, 3, 0);
  const ball = scene.resources.own(Geometry3D.sphere(0.5));
  falling.add(
    new Mesh3D(
      ball,
      new Material3D({ color: 0x33cc88, shading: "unlit", toneMapped: false }),
    ),
  );
  physics.createBody({ shape: { kind: "sphere", radius: 0.5 } }, falling);
  const floor = scene.resources.own(Geometry3D.box(8, 0.1, 1));
  scene.world3D
    .add(
      new Mesh3D(
        floor,
        new Material3D({
          color: 0x607b86,
          shading: "unlit",
          toneMapped: false,
        }),
      ),
    )
    .setPosition(0, -0.05, 0);
  app.scenes.change(scene);
  scene.post.bloom = 0;
  scene.post.vignette = 0;
}
