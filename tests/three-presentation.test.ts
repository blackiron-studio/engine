import { describe, expect, test } from "bun:test";
import { Camera3D, CameraShake3D, Particles3D, Mesh3D, Node3D, Vec3 } from "../src/three/index.ts";

describe("orthographic 2.5D presentation", () => {
  test("equal-axis camera matches the reference basis and keeps arena visible at narrow aspects", () => {
    const camera = new Camera3D().setIsometric();
    const center = camera.project(new Vec3(), 1280, 720);
    const x = camera.project(new Vec3(1, 0, 0), 1280, 720);
    const z = camera.project(new Vec3(0, 0, 1), 1280, 720);
    expect(center.x).toBeCloseTo(640, 3);
    expect(center.y).toBeCloseTo(360, 3);
    expect(x.x - center.x).toBeCloseTo(center.x - z.x, 3);
    expect(x.y).toBeCloseTo(z.y, 3);
    expect(x.y - center.y).toBeGreaterThan(0);
    for (const [w, h] of [[1280, 720], [720, 1280]]) {
      const left = camera.project(new Vec3(-12, 0, 12), w, h);
      const right = camera.project(new Vec3(12, 0, -12), w, h);
      expect(left.x).toBeGreaterThan(0);
      expect(right.x).toBeLessThan(w);
    }
  });
  test("weapon-height aiming round trips in both projections after orbit and parent transforms", () => {
    const parent = new Node3D(); parent.rotation.y = 0.4; parent.position.set(2, 1, -3);
    const camera = parent.add(new Camera3D().setIsometric());
    for (const projection of ["orthographic", "perspective"] as const) {
      camera.projection = projection;
      for (const point of [new Vec3(2, 0.84, -3), new Vec3(-4, 0.84, 5)]) {
        const screen = camera.project(point, 1280, 720);
        const world = camera.screenToGround(screen.x, screen.y, 1280, 720, 0.84)!;
        expect(world.x).toBeCloseTo(point.x, 3);
        expect(world.z).toBeCloseTo(point.z, 3);
      }
    }
  });
  test("movement preserves joystick magnitude and normalizes diagonal keys across camera orbit", () => {
    const camera = new Camera3D().setIsometric();
    const right = camera.groundDirection(1, 0);
    expect(right.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(right.z).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(camera.groundDirection(1, 1).length).toBeCloseTo(1, 5);
    expect(camera.groundDirection(0.3, 0.4).length).toBeCloseTo(0.5, 5);
    camera.position.set(-20, 20, 20);
    expect(camera.groundDirection(1, 0).z).toBeGreaterThan(0);
    expect(camera.groundDirection(NaN, 1).length).toBe(0);
    expect(() => camera.setIsometric(0)).toThrow();
  });
});

describe("retained 3D feedback", () => {
  test("bursts are capacity bounded, reuse geometry/materials and recycle expired slots", () => {
    const pool = new Particles3D(16, 123);
    expect(pool.burst({ x: 0, y: 1, z: 0, count: 24, color: 0xabcdef })).toBe(16);
    expect(pool.burst({ x: 0, y: 1, z: 0 })).toBe(0);
    const meshes = pool.children as Mesh3D[];
    expect(new Set(meshes.map(m => m.geometry)).size).toBe(1);
    expect(new Set(meshes.map(m => m.material)).size).toBe(1);
    expect(meshes.every(m => m.tint === 0xabcdef)).toBeTrue();
    pool.update(1);
    expect(pool.activeCount).toBe(0);
    expect(meshes.every(m => !m.visible)).toBeTrue();
    expect(pool.burst({ x: 1, y: 2, z: 3, count: 5 })).toBe(5);
    expect(pool.children.length).toBe(16);
    pool.reset();
    expect(pool.activeCount).toBe(0);
  });
  test("effects are deterministic, pausable and independent of the global random stream", () => {
    const a = new Particles3D(8, "same"), b = new Particles3D(8, "same");
    a.burst({ x: 0, y: 1, z: 0, count: 8 });
    for (let i = 0; i < 30; i++) Math.random();
    b.burst({ x: 0, y: 1, z: 0, count: 8 });
    for (let i = 0; i < 12; i++) a.update(1 / 120);
    for (let i = 0; i < 6; i++) b.update(1 / 60);
    const positions = (pool: Particles3D) => (pool.children as Mesh3D[]).map(m => [m.x, m.y, m.z]);
    for (let i = 0; i < 8; i++) for (let axis = 0; axis < 3; axis++)
      expect(positions(a)[i][axis]).toBeCloseTo(positions(b)[i][axis], 5);
    const before = positions(a);
    a.paused = true; a.updateTree(0.1); a.update(0);
    expect(positions(a)).toEqual(before);
    a.update(1e10);
    expect(a.activeCount).toBe(0);
  });
  test("camera shake freezes at zero time and settles exactly without changing the target", () => {
    const shake = new CameraShake3D(3);
    shake.kick(0.3, 0.25);
    const offset = shake.update(0.05).clone();
    expect(offset.length).toBeGreaterThan(0);
    expect(shake.update(0)).toEqual(offset);
    shake.update(0.2);
    expect(shake.offset.length).toBe(0);
    expect(() => shake.kick(Infinity)).toThrow();
    expect(() => new Particles3D(0)).toThrow();
    expect(() => new Particles3D(2).burst({ x: NaN, y: 0, z: 0 })).toThrow();
  });
});
