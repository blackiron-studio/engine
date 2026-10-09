import type { App } from "../../../src/app/app.ts";
import { exerciseBreach } from "../../shared/fps-mission.ts";
import {
  Scene3D,
  Geometry3D,
  Mesh3D,
  Material3D,
} from "../../../src/three/index.ts";
export default async function main(app: App) {
  await exerciseBreach(app, undefined, false);
  console.log("NATIVE_FPS_MISSION_PASS");
  const layer = new Scene3D(1280, 720);
  layer.environment.shadows = false;
  layer.environment.fogDensity = 0;
  layer.camera3D.position.set(0, 0, 4);
  layer.camera3D.lookAt(0, 0, 0);
  const geometry = layer.resources.own(Geometry3D.box());
  layer.world3D
    .add(
      new Mesh3D(
        geometry,
        new Material3D({
          color: 0xcc3333,
          shading: "unlit",
          toneMapped: false,
        }),
      ),
    )
    .setScale(8, 8, 0.2)
    .setPosition(0, 0, 1);
  const weapon = layer.world3D.add(
    new Mesh3D(
      geometry,
      new Material3D({ color: 0x3366cc, shading: "unlit", toneMapped: false }),
    ),
  );
  weapon.renderLayer = "viewmodel";
  let ticks = 0;
  layer.update = () => {
    weapon.renderLayer = ++ticks > 60 ? "world" : "viewmodel";
  };
  app.scenes.change(layer);
  layer.post.bloom = 0;
  layer.post.vignette = 0;
}
