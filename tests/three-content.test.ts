import { test, expect } from "bun:test";
import {
  AnimationClip3D,
  Skin3D,
  Transform3D,
} from "../src/three/animation.ts";
import { Geometry3D } from "../src/three/geometry.ts";
import { Material3D } from "../src/three/material.ts";
import { Mesh3D, Scene3D } from "../src/three/scene.ts";
import { mat4Identity } from "../src/three/math.ts";
import { PhysicsWorld3D } from "../src/three/physics.ts";
import { Native3DEncoder } from "../src/three/native.ts";
import { Texture3D } from "../src/three/texture.ts";
import { loadGltf } from "../src/three/gltf.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";
import { createTestApp, stepFrames } from "../src/testkit/index.ts";
import { Scene } from "../src/scene/scene.ts";
import { Node } from "../src/scene/node.ts";
test("quaternion interpolation takes shortest arc and cubic translation uses tangents", () => {
  const target = new Transform3D();
  const clip = new AnimationClip3D("turn", [
    {
      target,
      path: "rotation",
      interpolation: "LINEAR",
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 1, 0, 0, 0, -1]),
    },
  ]);
  clip.sample(0.5);
  expect(Math.abs(target.quaternion[3])).toBeCloseTo(1);
  const move = new AnimationClip3D("move", [
    {
      target,
      path: "translation",
      interpolation: "CUBICSPLINE",
      times: new Float32Array([0, 1]),
      values: new Float32Array([
        0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0,
      ]),
    },
  ]);
  move.sample(0.5);
  expect(target.x).toBeCloseTo(1.5);
});
test("skinning applies inverse bind, mesh transform and independent deformation", () => {
  const g = new Geometry3D(
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 1, 2],
  );
  const mesh = new Mesh3D(g);
  const joint = new Transform3D();
  joint.y = 2;
  mesh.x = 3;
  const skin = new Skin3D(
    mesh,
    [joint],
    [mat4Identity()],
    new Float32Array(12),
    new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  );
  skin.update();
  expect(mesh.geometry.positions[0]).toBeCloseTo(-3);
  expect(mesh.geometry.positions[1]).toBeCloseTo(2);
  expect(g.positions[1]).toBe(0);
  skin.dispose();
  expect(mesh.geometry.disposed).toBe(true);
  expect(g.disposed).toBe(false);
});
test("3D rigid body falls onto floor, ray queries and disposal work", async () => {
  const physics = await PhysicsWorld3D.create();
  physics.createBody({
    type: "fixed",
    position: { x: 0, y: -0.5, z: 0 },
    shape: { kind: "box", halfExtents: [5, 0.5, 5] },
  });
  const node = new Transform3D();
  node.y = 3;
  const body = physics.createBody(
    { shape: { kind: "sphere", radius: 0.5 }, ccd: true },
    node,
  );
  for (let i = 0; i < 180; i++) physics.step(1 / 60);
  expect(body.translation().y).toBeCloseTo(0.5, 1);
  expect(node.y).toBeCloseTo(body.translation().y);
  expect(
    physics.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10),
  ).not.toBeNull();
  expect(physics.stats.bodies).toBe(2);
  physics.dispose();
  physics.dispose();
  expect(physics.stats.bodies).toBe(0);
  expect(() => physics.step(1 / 60)).toThrow("disposed");
});
test("native mesh protocol retains static uploads, refreshes texture versions and clears stale resources", () => {
  const encoder = new Native3DEncoder(),
    scene = new Scene3D(),
    texture = new Texture3D(1, 1, [255, 0, 0, 255]),
    g = Geometry3D.box();
  scene.world3D.add(new Mesh3D(g, new Material3D({ map: texture })));
  const first = JSON.parse(encoder.encode(scene.collectFrame3D()));
  expect(first.geometries.length).toBe(1);
  expect(first.textures.length).toBe(1);
  expect(first.meshes[0].uniforms.length).toBe(172);
  const second = JSON.parse(encoder.encode(scene.collectFrame3D()));
  expect(second.geometries.length).toBe(0);
  expect(second.textures.length).toBe(0);
  texture.update([0, 0, 255, 255]);
  expect(
    JSON.parse(encoder.encode(scene.collectFrame3D())).textures.length,
  ).toBe(1);
  encoder.encode(null);
  expect(
    JSON.parse(encoder.encode(scene.collectFrame3D())).geometries.length,
  ).toBe(1);
});
test("glTF loader imports hierarchy, textured skin and clip, rejecting truncated buffers", async () => {
  const platform = new HeadlessPlatform({
    root: import.meta.dir + "/fixtures/gltf",
  });
  const asset = await loadGltf(platform, "model.gltf");
  const one = asset.instantiate(),
    two = asset.instantiate();
  expect(one.clips.length).toBe(1);
  expect(one.skins.length).toBe(1);
  one.clips[0].sample(0.5);
  one.updateSkins();
  expect(one.skins[0].mesh.geometry.positions[1]).toBeCloseTo(0.5);
  expect(two.skins[0].mesh.geometry.positions[1]).toBe(0);
  expect(one.skins[0].mesh.material.map?.width).toBe(2);
  one.dispose();
  two.dispose();
  asset.dispose();
  expect(() => asset.instantiate()).toThrow("disposed");
  const broken = new HeadlessPlatform();
  broken.loadBytes = async () =>
    new TextEncoder().encode(
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [
          { byteLength: 8, uri: "data:application/octet-stream;base64,AA==" },
        ],
      }),
    ).buffer;
  await expect(loadGltf(broken, "broken.gltf")).rejects.toThrow("Truncated");
});

test("glTF preserves independent U/V texture wrapping through the native packet", async () => {
  const platform = new HeadlessPlatform({ root: import.meta.dir + "/fixtures/gltf" });
  const read = platform.loadBytes.bind(platform);
  platform.loadBytes = async (url) => {
    const bytes = await read(url);
    if (!url.endsWith("model.gltf")) return bytes;
    const json = JSON.parse(new TextDecoder().decode(bytes));
    json.samplers = [{ wrapS: 33071, wrapT: 33648, magFilter: 9728, minFilter: 9984 }];
    json.textures[0].sampler = 0;
    return new TextEncoder().encode(JSON.stringify(json)).buffer;
  };
  const asset = await loadGltf(platform, "model.gltf");
  const instance = asset.instantiate();
  const map = instance.skins[0].mesh.material.map!;
  expect([map.wrap, map.wrapT]).toEqual(["clamp", "mirror"]);
  expect([map.filter, map.minFilter]).toEqual(["nearest", "nearest-mipmap-nearest"]);
  const scene = new Scene3D();
  scene.world3D.add(instance);
  const packet = JSON.parse(new Native3DEncoder().encode(scene.collectFrame3D()));
  expect(packet.textures[0].wrap).toBe("clamp");
  expect(packet.textures[0].wrapT).toBe("mirror");
  expect(packet.textures[0].minFilter).toBe("nearest-mipmap-nearest");
  instance.dispose();
  asset.dispose();
});

test("3D physics follows pause overlays and 100 scene replacements release worlds", async () => {
  const app = await createTestApp();
  for (let i = 0; i < 100; i++) {
    const scene = new Scene3D();
    app.scenes.change(scene);
    const physics = await scene.enablePhysics3D();
    const body = physics.createBody({
      position: { x: 0, y: 3, z: 0 },
      shape: { kind: "sphere", radius: 0.5 },
    });
    stepFrames(app, 2);
    const y = body.translation().y;
    app.scenes.push(new Scene(), { overlay: true });
    stepFrames(app, 3);
    expect(body.translation().y).toBe(y);
    app.scenes.pop();
    scene.timeScale = 0;
    stepFrames(app, 2);
    expect(body.translation().y).toBe(y);
    scene.timeScale = 1;
    stepFrames(app, 2);
    expect(body.translation().y).toBeLessThan(y);
    physics.removeBody(body);
    expect(physics.stats.bodies).toBe(0);
    app.scenes.pop();
    expect(physics.stats.bodies).toBe(0);
    expect(scene.physics3D).toBeNull();
  }
  app.destroy();
});
test("a throwing exit hook cannot skip resource cleanup or leave nodes attached", async () => {
  const scene = new Scene(),
    app = await createTestApp({ scene });
  let disposed = 0;
  scene.resources.defer(() => disposed++);
  class Broken extends Node {
    override exit() {
      throw new Error("broken cleanup");
    }
  }
  const broken = scene.world.add(new Broken()),
    sibling = scene.world.add(new Node());
  expect(() => app.scenes.pop()).toThrow();
  expect(disposed).toBe(1);
  expect(broken.scene).toBeNull();
  expect(sibling.scene).toBeNull();
  expect(scene.attachedApp).toBeNull();
  app.destroy();
});

test("disposed glTF instances release owned skin and animation references after exit failure", async () => {
  const { GltfInstance } = await import("../src/three/gltf.ts");
  const model = new GltfInstance();
  const target = model.add(new Transform3D());
  const clip = new AnimationClip3D("move", [
    {
      target,
      path: "translation",
      interpolation: "LINEAR",
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 1, 0, 0]),
    },
  ]);
  model.clips.push(clip);
  model.player.play(clip);
  model.destroy = () => {
    throw new Error("exit failed");
  };
  expect(() => model.dispose()).toThrow("glTF instance disposal failed");
  expect(model.children.length).toBe(0);
  expect(model.clips.length).toBe(0);
  expect(model.player.clip).toBeNull();
  expect(model.player.playing).toBe(false);
  expect(() => model.dispose()).not.toThrow();
});
