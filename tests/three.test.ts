import { describe, expect, test } from "bun:test";
import { Node } from "../src/scene/node.ts";
import { DrawContext } from "../src/scene/draw.ts";
import { bakeAtlas } from "../src/art/atlas.ts";
import { FakeRenderer } from "../src/render/fake.ts";
import {
  Camera3D,
  Geometry3D,
  Material3D,
  Mesh3D,
  Node3D,
  PointLight3D,
  Ray3,
  Scene3D,
  Vec3,
  frustumPlanes,
  mat4Compose,
  mat4Identity,
  mat4Invert,
  mat4Multiply,
  mat4Point,
  sphereInFrustum,
} from "../src/three/index.ts";
import { createTestApp, stepFrames } from "../src/testkit/index.ts";

describe("real 3D transforms and cameras", () => {
  test("composes rotated/scaled ancestors across plain container nodes", () => {
    const root = new Node3D().setPosition(10, 2, -1).setScale(2);
    root.rotation.y = Math.PI / 2;
    const container = root.add(new Node());
    const child = container.add(new Node3D().setPosition(1, 0, 0));
    const grandchild = child.add(new Node3D().setPosition(0, 1, 0));
    const p = grandchild.getWorldPosition();
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(4);
    expect(p.z).toBeCloseTo(-3);
    root.updateWorldTree();
    expect(grandchild.worldMatrix[13]).toBeCloseTo(4);
    root.x = 20;
    expect(grandchild.getWorldPosition().x).toBeCloseTo(20);
  });
  test("matrix inverse round trips nonuniform scale, rotation, and translation", () => {
    const matrix = mat4Compose(
      mat4Identity(),
      new Vec3(4, 2, -8),
      new Vec3(0.3, -0.8, 0.6),
      new Vec3(2, 3, 0.5),
    );
    const inverse = mat4Identity();
    expect(mat4Invert(inverse, matrix)).toBe(true);
    const p = mat4Point(inverse, mat4Point(matrix, new Vec3(1, 2, 3)));
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(2);
    expect(p.z).toBeCloseTo(3);
    mat4Multiply(matrix, matrix, inverse);
    for (let i = 0; i < 16; i++)
      expect(matrix[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0);
    expect(mat4Invert(inverse, new Float32Array(16))).toBe(false);
  });
  test("perspective projection and screen rays agree on a ground intersection", () => {
    const camera = new Camera3D();
    camera.position.set(8, 7, 10);
    camera.lookAt(0, 0, 0);
    const world = new Vec3(2, 0, 1),
      screen = camera.project(world, 960, 540);
    const hit = camera
      .screenRay(screen.x, screen.y, 960, 540)
      .intersectGround();
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(world.x, 3);
    expect(hit!.z).toBeCloseTo(world.z, 3);
    expect(camera.project(new Vec3(0, 0, 0), 960, 540).x).toBeCloseTo(480);
  });
  test("orthographic rays are parallel, with constant projected size at different depth", () => {
    const camera = new Camera3D();
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.projection = "orthographic";
    camera.orthoHeight = 10;
    const a = camera.screenRay(200, 200, 800, 600),
      b = camera.screenRay(600, 200, 800, 600);
    expect(a.direction.x).toBeCloseTo(b.direction.x);
    expect(a.direction.z).toBeCloseTo(b.direction.z);
    expect(a.origin.x).not.toBe(b.origin.x);
    expect(camera.project(new Vec3(2, 0, 0), 800, 600).x).toBeCloseTo(
      camera.project(new Vec3(2, 0, -10), 800, 600).x,
    );
  });
  test("look-at remains finite straight overhead and handles parent transforms", () => {
    const parent = new Node3D().setPosition(8, 0, 0);
    const camera = parent.add(new Camera3D());
    camera.position.set(0, 10, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrices();
    expect(Array.from(camera.viewProjection).every(Number.isFinite)).toBe(true);
    const center = camera.project(new Vec3(8, 0, 0), 800, 600);
    expect(center.x).toBeCloseTo(400);
    expect(center.y).toBeCloseTo(300);
  });
  test("rejects invalid camera volumes instead of uploading NaN matrices", () => {
    const camera = new Camera3D();
    camera.near = -1;
    expect(() => camera.updateMatrices()).toThrow();
    camera.near = 1;
    camera.far = 0.5;
    expect(() => camera.updateMatrices()).toThrow();
  });
  test("frustum rejection excludes behind-camera and far-away spheres", () => {
    const camera = new Camera3D();
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.far = 30;
    camera.updateMatrices(1);
    const planes = frustumPlanes(camera.viewProjection);
    expect(sphereInFrustum(planes, new Vec3(), 1)).toBe(true);
    expect(sphereInFrustum(planes, new Vec3(0, 0, 10), 1)).toBe(false);
    expect(sphereInFrustum(planes, new Vec3(100, 0, 0), 1)).toBe(false);
    expect(sphereInFrustum(planes, new Vec3(0, 0, -100), 1)).toBe(false);
  });
  test("ground picking rejects parallel rays and intersections behind the camera", () => {
    expect(
      new Ray3(new Vec3(0, 1, 0), new Vec3(1, 0, 0)).intersectGround(),
    ).toBeNull();
    expect(
      new Ray3(new Vec3(0, 1, 0), new Vec3(0, 1, 0)).intersectGround(),
    ).toBeNull();
  });
});

describe("procedural 3D geometry", () => {
  for (const [name, geometry] of [
    ["box", Geometry3D.box()],
    ["plane", Geometry3D.plane()],
    ["sphere", Geometry3D.sphere()],
    ["cylinder", Geometry3D.cylinder()],
    ["cone", Geometry3D.cone()],
    ["torus", Geometry3D.torus()],
  ] as const) {
    test(`${name}: valid indexed triangles, outward winding, unit normals, and enclosing bounds`, () => {
      const p = geometry.positions,
        n = geometry.normals,
        idx = geometry.indices;
      for (let i = 0; i < p.length; i += 3) {
        expect(Math.hypot(n[i], n[i + 1], n[i + 2])).toBeCloseTo(1);
        expect(
          new Vec3(p[i], p[i + 1], p[i + 2]).distanceTo(geometry.center),
        ).toBeLessThanOrEqual(geometry.radius + 1e-6);
      }
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3,
          b = idx[i + 1] * 3,
          c = idx[i + 2] * 3;
        const cross = new Vec3(
          p[b] - p[a],
          p[b + 1] - p[a + 1],
          p[b + 2] - p[a + 2],
        ).cross(
          new Vec3(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]),
        );
        if (cross.length > 1e-9)
          expect(
            cross.dot(
              new Vec3(
                n[a] + n[b] + n[c],
                n[a + 1] + n[b + 1] + n[c + 1],
                n[a + 2] + n[b + 2] + n[c + 2],
              ),
            ),
          ).toBeGreaterThan(0);
      }
    });
  }
  test("invalid triangle buffers and primitive arguments fail early", () => {
    expect(() => new Geometry3D([0, 0, 0], [0, 1, 0], [0, 1, 2])).toThrow();
    expect(() => Geometry3D.sphere(-1)).toThrow();
    expect(() => Geometry3D.sphere(1, 2)).toThrow();
    expect(() => Geometry3D.box(NaN)).toThrow();
  });
});

describe("Scene3D integration", () => {
  test("collects live visible meshes and lights; preserves the regular UI and fixed-step lifecycle", async () => {
    class Actor extends Mesh3D {
      override update(dt: number): void {
        this.x += dt;
      }
    }
    const scene = new Scene3D();
    const mesh = scene.world3D.add(
      new Actor(Geometry3D.box(), new Material3D()),
    );
    mesh.name = "actor";
    const hidden = scene.world3D.add(new Node3D());
    hidden.visible = false;
    hidden.add(new Mesh3D(Geometry3D.box()));
    scene.world3D.add(new PointLight3D());
    const app = await createTestApp({ scene });
    stepFrames(app, 2);
    const renderer = app.renderer as FakeRenderer,
      world = renderer.ops.find((op) => op.op === "world3d");
    expect(world?.op).toBe("world3d");
    if (world?.op === "world3d") {
      expect(world.meshes.length).toBe(1);
      expect(world.lights).toBe(1);
      expect(world.meshes[0].matrix[12]).toBeGreaterThan(0);
    }
    expect(
      renderer.ops.some((op) => op.op === "pass" && op.pass === "overlay"),
    ).toBe(true);
    mesh.geometry.dispose();
    expect(scene.collectFrame3D().meshes.length).toBe(0);
  });
  test("unsupported backends fail explicitly", () => {
    const renderer = new FakeRenderer(960, 540);
    renderer.features.mesh3D = false;
    expect(() =>
      new Scene3D().drawTree(new DrawContext(renderer, bakeAtlas())),
    ).toThrow("mesh3D support");
  });
  test("headless recordings snapshot transforms instead of retaining mutable mesh state", () => {
    const scene = new Scene3D(),
      mesh = scene.world3D.add(new Mesh3D(Geometry3D.box()));
    mesh.x = 2;
    const renderer = new FakeRenderer(960, 540);
    renderer.begin(0);
    renderer.render3D(scene.collectFrame3D());
    mesh.x = 100;
    scene.collectFrame3D();
    const record = renderer.ops.find((op) => op.op === "world3d");
    if (record?.op === "world3d") expect(record.meshes[0].matrix[12]).toBe(2);
    else throw new Error("Missing 3D recording");
  });
});
