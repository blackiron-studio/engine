import { Texture3D } from "../src/three/texture.ts";
import { Node } from "../src/scene/node.ts";
import { test, expect } from "bun:test";
import { ResourceCache, ResourceScope } from "../src/content/resources.ts";
import { pickSceneMesh, worldPointInParent } from "../src/content/editor-geometry.ts";
import { Camera3D } from "../src/three/camera.ts";
import { Geometry3D } from "../src/three/geometry.ts";
import { Vec3 } from "../src/three/math.ts";
import { Node3D } from "../src/three/node.ts";
import { Mesh3D } from "../src/three/scene.ts";
import {
  SceneEditor,
  createSceneRegistry,
  parseSceneDocument,
  type SceneDocument,
} from "../src/content/scene.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";
import {
  defineSheet,
  resolveAssets,
  resetImageRegistry,
  registerAssetLoader,
} from "../src/art/images.ts";
import { getAnimation } from "../src/art/sprites.ts";
import { AnimatedSprite } from "../src/scene/sprite.ts";
import { sceneStore } from "../cli/scene-store.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("resource leases share loads, survive one scope exiting and release on last owner", async () => {
  let loads = 0,
    disposed = 0;
  const cache = new ResourceCache({
    load: async () => {
      loads++;
      return { bytes: 64 };
    },
    dispose: () => disposed++,
    bytes: (r) => r.bytes,
  });
  const a = new ResourceScope(),
    b = new ResourceScope();
  const [first, second] = await Promise.all([
    a.acquire(cache, "x"),
    b.acquire(cache, "x"),
  ]);
  expect(first).toBe(second);
  expect(loads).toBe(1);
  expect(cache.stats.bytes).toBe(64);
  a.dispose();
  expect(disposed).toBe(0);
  b.dispose();
  b.dispose();
  expect(disposed).toBe(1);
  expect(cache.stats.entries).toBe(0);
});
test("late completion after scene exit disposes instead of resurrecting resource", async () => {
  let complete!: (v: number) => void,
    disposed = 0;
  const cache = new ResourceCache({
    load: () => new Promise<number>((r) => (complete = r)),
    dispose: () => disposed++,
  });
  const scope = new ResourceScope(),
    pending = scope.acquire(cache, "late");
  await Promise.resolve();
  scope.dispose();
  complete(7);
  await expect(pending).rejects.toThrow("released");
  expect(disposed).toBe(1);
  expect(cache.stats.entries).toBe(0);
});
test("failed resource loading is retryable", async () => {
  let calls = 0;
  const cache = new ResourceCache({
    load: async () => {
      if (calls++ === 0) throw new Error("network");
      return 4;
    },
    dispose: () => {},
  });
  const a = cache.acquire("x");
  await expect(a.value).rejects.toThrow("network");
  a.release();
  const b = cache.acquire("x");
  expect(await b.value).toBe(4);
  b.release();
});
test("asset registry preserves failed loader and does not repeat successful loaders", async () => {
  resetImageRegistry();
  let first = 0,
    second = 0;
  registerAssetLoader(async () => {
    first++;
    return [];
  });
  registerAssetLoader(async () => {
    if (second++ === 0) throw new Error("retry");
    return [];
  });
  await expect(resolveAssets(new HeadlessPlatform())).rejects.toThrow("retry");
  await resolveAssets(new HeadlessPlatform());
  expect(first).toBe(1);
  expect(second).toBe(2);
  resetImageRegistry();
});
test("Aseprite restores clockwise rotation, authored trim canvas and variable reverse/pingpong timing", async () => {
  resetImageRegistry();
  const platform = new HeadlessPlatform();
  // Authored 2x1 red/green strip, stored clockwise as 1x2, trimmed into x=1,y=1 on 4x3 canvas.
  platform.loadImage = async () => ({
    width: 1,
    height: 2,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
  });
  const frames = [100, 200, 300].map((duration, i) => ({
    filename: `f${i}.png`,
    duration,
    frame: { x: 0, y: 0, w: 1, h: 2 },
    rotated: true,
    trimmed: true,
    spriteSourceSize: { x: 1, y: 1, w: 2, h: 1 },
    sourceSize: { w: 4, h: 3 },
  }));
  platform.loadJson = async <T>() =>
    ({
      frames,
      meta: {
        image: "sheet.png",
        frameTags: [
          { name: "reverse", from: 0, to: 2, direction: "reverse" },
          { name: "ping", from: 0, to: 2, direction: "pingpong" },
        ],
      },
    }) as T;
  defineSheet("faithful", "sheet.json");
  const items = await resolveAssets(platform);
  expect(items[0].w).toBe(4);
  expect(items[0].h).toBe(3);
  expect(Array.from(items[0].data.slice(20, 28))).toEqual([
    255, 0, 0, 255, 0, 255, 0, 255,
  ]);
  expect(getAnimation("faithful.reverse")?.frames).toEqual([
    "faithful.f2",
    "faithful.f1",
    "faithful.f0",
  ]);
  expect(getAnimation("faithful.ping")?.durations).toEqual([
    0.1, 0.2, 0.3, 0.2,
  ]);
  const sprite = new AnimatedSprite("faithful.reverse");
  sprite.update(0.29);
  expect(sprite.frame).toBe(0);
  sprite.update(0.02);
  expect(sprite.frame).toBe(1);
  sprite.update(0.2);
  expect(sprite.frame).toBe(2);
  resetImageRegistry();
});
const document: SceneDocument = {
  format: "blackiron.scene",
  version: 1,
  prefabs: { crate: { id: "body", type: "Mesh3D", props: { color: 123 } } },
  root: {
    id: "root",
    type: "Node3D",
    children: [
      { id: "a", prefab: "crate", overrides: { body: { color: 456 } } },
      { id: "b", prefab: "crate" },
    ],
  },
};
test("prefabs instantiate independently, overrides resolve and resources dispose", () => {
  const registry = createSceneRegistry(),
    one = registry.instantiate(document),
    two = registry.instantiate(document);
  expect(one.nodes.get("a")).not.toBe(two.nodes.get("a"));
  expect((one.nodes.get("a") as any).material.color).toBe(456);
  expect((one.nodes.get("b") as any).material.color).toBe(123);
  const geometry = (one.nodes.get("a") as any).geometry;
  one.dispose();
  expect(geometry.disposed).toBe(true);
  expect(one.nodes.size).toBe(0);
  two.dispose();
});
test("scene validation rejects cycles, duplicate ids, unknown codecs and dangerous property keys", () => {
  expect(() =>
    parseSceneDocument(
      '{"format":"blackiron.scene","version":1,"root":{"id":"x","type":"Node","props":{"__proto__":{}}}}',
    ),
  ).toThrow("Unsafe");
  const registry = createSceneRegistry();
  expect(() =>
    registry.instantiate({
      ...document,
      prefabs: { crate: { id: "body", prefab: "crate" } },
    }),
  ).toThrow("cycle");
  expect(() =>
    registry.instantiate({ ...document, root: { id: "root", type: "Typo" } }),
  ).toThrow("Unknown");
});
test("editor undo, redo and serialization preserve prefab overrides", () => {
  const editor = new SceneEditor(document);
  editor.edit((d) => {
    d.root.name = "Changed";
  });
  expect(editor.document.root.name).toBe("Changed");
  editor.undo();
  expect(editor.document.root.name).toBeUndefined();
  editor.redo();
  expect(parseSceneDocument(editor.serialize()).root.name).toBe("Changed");
});
test("visual editor picks the nearest visible triangle and moves through parent transforms", () => {
  const camera = new Camera3D();
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  const parent = new Node3D();
  const geometry = Geometry3D.box();
  const far = parent.add(new Mesh3D(geometry));
  far.z = -2;
  const near = parent.add(new Mesh3D(geometry));
  const nodes = new Map([["far", far], ["near", near]]);
  expect(pickSceneMesh(nodes, camera, 400, 300, 800, 600)?.id).toBe("near");
  near.visible = false;
  expect(pickSceneMesh(nodes, camera, 400, 300, 800, 600)?.id).toBe("far");
  expect(pickSceneMesh(nodes, camera, 0, 0, 800, 600)).toBeNull();
  parent.position.set(1, 2, 3);
  parent.rotation.y = 0.7;
  parent.scale.set(2, 1, 0.5);
  const world = new Vec3(3, 2, -4);
  near.position.copy(worldPointInParent(near, world));
  const actual = near.getWorldPosition();
  expect(actual.x).toBeCloseTo(world.x, 4);
  expect(actual.y).toBeCloseTo(world.y, 4);
  expect(actual.z).toBeCloseTo(world.z, 4);
  parent.scale.z = 0;
  expect(() => worldPointInParent(near, world)).toThrow("singular");
  geometry.dispose();
});
test("persistent scene saves survive reload and reject stale writes / cross-origin edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "blackiron-scene-test-"));
  try {
    const url = "http://localhost:4285/dev/scene?name=main";
    const put = (revision: string, origin = "http://localhost:4285") =>
      sceneStore(
        root,
        new Request(url, {
          method: "PUT",
          headers: { origin, "if-match": revision },
          body: JSON.stringify(document),
        }),
      );
    expect((await put("new")).status).toBe(200);
    expect((await put("new")).status).toBe(409);
    expect((await put("new", "https://example.com")).status).toBe(403);
    const response = await sceneStore(root, new Request(url)),
      saved = await response.json();
    expect(saved.document).toEqual(document);
    expect(saved.revision).not.toBe("new");
    expect(
      JSON.parse(
        await readFile(join(root, "assets/scenes/main.blackiron.json"), "utf8"),
      ),
    ).toEqual(document);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scene instance releases resources even when its root teardown fails", () => {
  let releases = 0;
  const registry = createSceneRegistry().register("Failing", {
    create(_props, scope) {
      scope.defer(() => releases++);
      const node = new Node();
      node.destroy = () => {
        throw new Error("exit failed");
      };
      return node;
    },
  });
  const instance = registry.instantiate({
    format: "blackiron.scene",
    version: 1,
    root: { id: "root", type: "Failing" },
  });
  expect(() => instance.dispose()).toThrow("Scene disposal failed");
  expect(releases).toBe(1);
  expect(instance.nodes.size).toBe(0);
  expect(() => instance.dispose()).not.toThrow();
});

test("native text textures respect negative glyph bearings and alpha coverage", () => {
  const texture = Texture3D.fromText(
    "A",
    {
      width: 8,
      height: 8,
      size: 4,
      padding: 1,
      color: 0xffffff,
      background: 0,
    },
    () => ({
      w: 2,
      h: 2,
      left: 0,
      top: -2,
      advance: 2,
      ascent: 2,
      descent: 0,
      data: new Uint8Array([255, 128, 0, 255]),
    }),
  );
  const pixel = (x: number, y: number) => texture.data[(y * 8 + x) * 4];
  expect(pixel(3, 3)).toBe(255);
  expect(pixel(4, 3)).toBe(128);
  expect(pixel(3, 4)).toBe(0);
  expect(pixel(4, 4)).toBe(255);
  expect(() =>
    Texture3D.fromText("A", { width: 0, height: 8, size: 4 }),
  ).toThrow();
  texture.dispose();
});
