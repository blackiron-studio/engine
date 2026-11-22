import { describe, expect, test } from "bun:test";
import { Spring } from "../src/core/index.ts";
import {
  Camera3D,
  Debris3D,
  EffectAtlas3D,
  Effects3D,
  FirstPersonLook,
  Geometry3D,
  LightPool3D,
  Material3D,
  Mesh3D,
  Node3D,
  Scene3D,
  ShapeBuilder3D,
  Vec3,
  arcPoints,
  eulerFromBasis,
  mat4Compose,
  mirrorOutline,
  standardEffectCells,
} from "../src/three/index.ts";
import { Native3DEncoder } from "../src/three/native.ts";

const sprites = (fx: Effects3D) => (fx.children as Mesh3D[]).filter((m) => m.visible);
const column = (m: Mesh3D, c: number) => new Vec3(m.worldMatrix[c * 4], m.worldMatrix[c * 4 + 1], m.worldMatrix[c * 4 + 2]);

describe("Spring", () => {
  test("settles on its target and keeps the same motion at any frame rate", () => {
    const run = (fps: number) => {
      const s = new Spring(200, 18);
      s.kick(3);
      const samples: number[] = [];
      for (let i = 0; i < fps; i++) {
        s.step(1 / fps, 0.5);
        if ((i + 1) % (fps / 10) === 0) samples.push(s.value);
      }
      return { samples, s };
    };
    const a = run(30),
      b = run(150);
    for (let i = 0; i < a.samples.length; i++) expect(Math.abs(a.samples[i] - b.samples[i])).toBeLessThan(0.01);
    expect(a.s.value).toBeCloseTo(0.5, 3);
    expect(a.s.settled(1e-3)).toBe(true);
  });
  test("critical damping never overshoots; kicks, resets and bad input", () => {
    const s = new Spring(100, Spring.critical(100), 1);
    let min = Infinity;
    for (let i = 0; i < 120; i++) min = Math.min(min, s.step(1 / 60, 0));
    expect(min).toBeGreaterThanOrEqual(-1e-6);
    s.reset(2);
    expect([s.value, s.velocity, s.target]).toEqual([2, 0, 2]);
    expect(s.step(0)).toBe(2);
    expect(() => new Spring(-1, 0)).toThrow(RangeError);
    expect(() => s.kick(NaN)).toThrow(RangeError);
    expect(() => s.step(1 / 60, Infinity)).toThrow(RangeError);
  });
});

describe("EffectAtlas3D", () => {
  test("the standard cells pack without overlap and keep their variants", () => {
    const atlas = EffectAtlas3D.standard();
    expect(EffectAtlas3D.standard()).toBe(atlas);
    expect(atlas.variants("smoke")).toBe(3);
    expect(atlas.variants("fire")).toBe(2);
    expect(atlas.variants("star")).toBe(2);
    expect(atlas.variants("missing")).toBe(0);
    const rects = atlas.names().flatMap((n) => Array.from({ length: atlas.variants(n) }, (_, i) => atlas.rect(n, i)));
    expect(rects.length).toBe(Object.values(standardEffectCells()).flat().length);
    for (const [u, v, w, h] of rects) {
      expect(u).toBeGreaterThan(0);
      expect(v).toBeGreaterThan(0);
      expect(u + w).toBeLessThan(1);
      expect(v + h).toBeLessThan(1);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i],
          b = rects[j];
        const apart = a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];
        expect(apart).toBe(true);
      }
    // Variants wrap; glow is bright in the middle of its cell and clear at its corner.
    expect(atlas.rect("smoke", 3)).toEqual(atlas.rect("smoke", 0));
    const [u, v, w, h] = atlas.rect("glow"),
      S = atlas.size,
      alpha = (x: number, y: number) => atlas.texture.data[(Math.floor(y * S) * S + Math.floor(x * S)) * 4 + 3];
    expect(alpha(u + w / 2, v + h / 2)).toBeGreaterThan(200);
    expect(alpha(u + 0.5 / S, v + 0.5 / S)).toBe(0);
    const mesh = new Mesh3D(Geometry3D.plane());
    atlas.apply(mesh, "ring");
    expect(mesh.uvRect).toEqual([...atlas.rect("ring")]);
  });
  test("custom cells and cells that do not fit", () => {
    const atlas = new EffectAtlas3D({ blob: { width: 8, height: 8, paint: () => [0.5, 1] } }, 32);
    const [u, v] = atlas.rect("blob");
    const i = (Math.round(v * 32) * 32 + Math.round(u * 32)) * 4;
    expect([...atlas.texture.data.slice(i, i + 4)]).toEqual([128, 128, 128, 255]);
    expect(() => new EffectAtlas3D({ big: { width: 64, height: 64, paint: () => [1, 1] } }, 32)).toThrow("do not fit");
    expect(() => atlas.rect("nope")).toThrow(RangeError);
  });
});

describe("Effects3D", () => {
  test("sprites change colour, size and opacity over their life, then end", () => {
    const fx = new Effects3D({ capacity: 4, decals: 0, seed: 1 });
    fx.spawn({ texture: "glow", position: { x: 1, y: 2, z: 3 }, lifetime: 1, size: 1, endSize: 3, colors: [0xff0000, 0x0000ff], opacity: 0.8, fadeIn: 0.1, fadeOut: 0.5, glow: 1.5 });
    const [m] = sprites(fx);
    expect(m.opacity).toBe(0);
    expect(m.glow).toBe(1.5);
    expect(m.uvRect).toEqual([...fx.atlas.rect("glow")]);
    fx.update(0.25);
    expect(m.opacity).toBeCloseTo(0.8, 5);
    expect(m.tint).toBe(0xbf0040);
    fx.update(0.5);
    expect(m.opacity).toBeLessThan(0.8);
    expect(m.opacity).toBeGreaterThan(0);
    fx.update(0.3);
    expect(sprites(fx).length).toBe(0);
    expect(fx.activeCount).toBe(0);
  });
  test("move with gravity and drag; billboards face the camera and streaks lie along their motion", () => {
    const scene = new Scene3D(320, 180);
    scene.camera3D.position.set(0, 0, 10);
    const fx = scene.world3D.add(new Effects3D({ capacity: 4, decals: 0 }));
    const bill = fx.spawn({ texture: "dot", position: { x: 0, y: 0, z: 0 }, velocity: { x: 2, y: 0, z: 0 }, gravity: 10, lifetime: 2, size: 0.5 });
    fx.update(0.5);
    expect(bill.position.x).toBeCloseTo(1, 6);
    expect(bill.position.y).toBeCloseTo(-2.5, 6);
    const streak = fx.spawn({ texture: "streak", kind: "streak", position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 10, z: 0 }, lifetime: 1, size: 0.1, stretch: 0.05, maxLength: 0.3 });
    scene.collectFrame3D();
    const [bm, sm] = sprites(fx);
    // The billboard's face (+z) points at the eye.
    const toEye = new Vec3(0, 0, 10).sub(bill.position).normalize();
    expect(column(bm, 2).normalize().dot(toEye)).toBeCloseTo(1, 5);
    // The streak runs up its velocity, 0.3 m long (capped), with its head at the position.
    expect(column(sm, 1).length).toBeCloseTo(0.3, 5);
    expect(column(sm, 1).normalize().y).toBeCloseTo(1, 5);
    expect(sm.worldMatrix[13]).toBeCloseTo(-0.15, 5);
    expect(streak.alive).toBe(true);
  });
  test("handles: moveTo holds one step, opacity, free; follow; full pools keep driven sprites", () => {
    const fx = new Effects3D({ capacity: 2, decals: 0 });
    const held = fx.spawn({ texture: "glow", position: { x: 0, y: 0, z: 0 }, velocity: { x: 1, y: 0, z: 0 }, lifetime: Infinity, size: 1 });
    held.moveTo({ x: 5, y: 0, z: 0 });
    fx.update(0.1);
    expect(held.position.x).toBe(5);
    fx.update(0.1);
    expect(held.position.x).toBeCloseTo(5.1, 6);
    held.opacity = 0.3;
    fx.update(0.1);
    expect(sprites(fx)[0].opacity).toBeCloseTo(0.3, 6);
    // Pool full: the next sprite reuses the one that ends by itself, never the driven one.
    const short = fx.spawn({ texture: "dot", position: { x: 0, y: 0, z: 0 }, lifetime: 1, size: 1 });
    fx.spawn({ texture: "dot", position: { x: 0, y: 0, z: 0 }, lifetime: 1, size: 1 });
    expect(held.alive).toBe(true);
    expect(short.alive).toBe(false);
    held.free();
    expect(held.alive).toBe(false);
    // Following a node: rides along, ends with it.
    const node = new Node3D().setPosition(1, 1, 1);
    const parent = new Node3D();
    parent.add(node);
    const rider = fx.spawn({ texture: "glow", position: { x: 0, y: 1, z: 0 }, lifetime: 5, size: 1, follow: node });
    node.position.x = 4;
    fx.update(0.1);
    expect([rider.position.x, rider.position.y]).toEqual([4, 2]);
    node.destroy();
    fx.update(0.1);
    expect(rider.alive).toBe(false);
  });
  test("decals sit just off their surface in their own ring; seeds repeat", () => {
    const fx = new Effects3D({ capacity: 1, decals: 2, seed: 9 });
    const a = fx.decal({ texture: "scorch", position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 2 }, lifetime: 10, size: 1 });
    expect(a.position.z).toBeCloseTo(0.01, 6);
    fx.decal({ texture: "scorch", position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, lifetime: 10, size: 1 });
    fx.decal({ texture: "scorch", position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, lifetime: 10, size: 1 });
    expect(a.alive).toBe(false);
    fx.spawn({ texture: "dot", position: { x: 0, y: 0, z: 0 }, lifetime: 1, size: 1 });
    expect(fx.activeCount).toBe(3);
    const angles = (seed: number) => {
      const f = new Effects3D({ capacity: 3, decals: 0, seed });
      for (let i = 0; i < 3; i++) f.spawn({ texture: "smoke", position: { x: 0, y: 0, z: 0 }, lifetime: 1, size: 1 });
      return sprites(f).map((m) => [...m.uvRect]);
    };
    expect(angles(4)).toEqual(angles(4));
    expect(() => fx.spawn({ texture: "nope", position: { x: 0, y: 0, z: 0 }, lifetime: 1, size: 1 })).toThrow(RangeError);
    expect(() => fx.spawn({ texture: "dot", position: { x: NaN, y: 0, z: 0 }, lifetime: 1, size: 1 })).toThrow(RangeError);
    expect(() => fx.spawn({ texture: "dot", position: { x: 0, y: 0, z: 0 }, lifetime: 0, size: 1 })).toThrow(RangeError);
    expect(() => new Effects3D({ decals: 0 }).decal({ texture: "scorch", position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, lifetime: 1, size: 1 })).toThrow("no decal ring");
  });
  test("every sprite shares one geometry and material, so the renderer can batch them", () => {
    const scene = new Scene3D(320, 180);
    const fx = scene.world3D.add(new Effects3D({ capacity: 8, decals: 2 }));
    for (const texture of ["smoke", "fire", "glow", "streak"]) fx.spawn({ texture, position: { x: 0, y: 0, z: 0 }, lifetime: 1, size: 1, opacity: 0.5 });
    fx.decal({ texture: "scorch", position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, lifetime: 1, size: 1 });
    fx.update(0.01);
    const frame = scene.collectFrame3D();
    expect(frame.meshes.length).toBe(5);
    expect(new Set(frame.meshes.map((m) => m.geometry)).size).toBe(1);
    expect(new Set(frame.meshes.map((m) => m.material)).size).toBe(1);
  });
});

describe("per-instance opacity, glow and texture window", () => {
  test("the native packet carries them and blends meshes made see-through", () => {
    const scene = new Scene3D(),
      g = Geometry3D.box(),
      material = new Material3D();
    const solid = scene.world3D.add(new Mesh3D(g, material));
    const faded = scene.world3D.add(new Mesh3D(g, material));
    const hidden = scene.world3D.add(new Mesh3D(g, material));
    faded.opacity = 0.25;
    faded.glow = 2;
    faded.uvRect.splice(0, 4, 0.5, 0.25, 0.5, 0.5);
    hidden.opacity = 0;
    expect(scene.collectFrame3D().meshes).toEqual([solid, faded]);
    void solid;
    const packet = JSON.parse(new Native3DEncoder().encode(scene.collectFrame3D()));
    const [a, b] = packet.meshes;
    expect([a.blend, b.blend]).toEqual([false, true]);
    expect([a.uniforms[67], b.uniforms[67]]).toEqual([1, 0.25]);
    expect(b.uniforms.slice(172, 177)).toEqual([0.5, 0.25, 0.5, 0.5, 2]);
    expect(a.uniforms.slice(172, 177)).toEqual([0, 0, 1, 1, 0]);
  });
});

describe("LightPool3D", () => {
  test("flashes fade, the most finished light gives way, followers ride along", () => {
    const pool = new LightPool3D(2);
    const a = pool.flash({ x: 0, y: 1, z: 0 }, { intensity: 10, range: 4, lifetime: 1, color: 0xff0000 });
    pool.update(0.5);
    expect(a.intensity).toBeCloseTo(2.5, 6);
    const b = pool.flash({ x: 0, y: 0, z: 0 }, { intensity: 8, range: 4, lifetime: 1 });
    expect(b).not.toBe(a);
    const c = pool.flash({ x: 2, y: 0, z: 0 }, { intensity: 8, range: 4, lifetime: 1 });
    expect(c).toBe(a);
    const node = new Node3D().setPosition(3, 0, 0);
    new Node3D().add(node);
    const d = pool.flash({ x: 0, y: 1, z: 0 }, { intensity: 8, range: 4, lifetime: 2 }, node);
    node.x = 5;
    pool.update(0.1);
    expect([d.position.x, d.position.y]).toEqual([5, 1]);
    pool.update(3);
    expect(pool.activeCount).toBe(0);
    expect(() => pool.flash({ x: 0, y: 0, z: 0 }, { intensity: 1, range: 0, lifetime: 1 })).toThrow(RangeError);
  });
});

describe("Debris3D", () => {
  test("keeps the piece where it was, bounces on the floor, comes to rest, smokes and sinks away", () => {
    const model = new Node3D().setPosition(0, 2, 0).setScale(2);
    model.rotation.y = Math.PI / 2;
    const part = model.add(new Node3D().setPosition(1, 0, 0));
    const debris = new Debris3D();
    const puffs: number[] = [];
    const bounces: number[] = [];
    debris.launch(part, {
      velocity: { x: 0, y: 3, z: 0 },
      spin: { x: 0, y: 0, z: 6 },
      radius: 0.1,
      lifetime: 4,
      sink: 1,
      emit: [{ every: 0.2, spawn: (_, age) => puffs.push(age) }],
      onBounce: (_p, _n, speed) => bounces.push(speed),
    });
    expect(part.parent).toBe(debris);
    expect(part.x).toBeCloseTo(0, 5);
    expect(part.y).toBeCloseTo(2, 5);
    expect(part.z).toBeCloseTo(-2, 5);
    expect(part.scale.x).toBeCloseTo(2, 5);
    let top = 0;
    for (let i = 0; i < 150; i++) {
      debris.update(1 / 60);
      top = Math.max(top, part.y);
      expect(part.y).toBeGreaterThanOrEqual(0.1 - 1e-6);
    }
    expect(top).toBeGreaterThan(2.3);
    expect(bounces.length).toBeGreaterThan(0);
    const restY = part.y;
    expect(restY).toBeCloseTo(0.1, 5);
    expect(puffs.length).toBeGreaterThan(5);
    for (let i = 0; i < 70; i++) debris.update(1 / 60);
    expect(part.y).toBeLessThan(restY);
    for (let i = 0; i < 30; i++) debris.update(1 / 60);
    expect(debris.count).toBe(0);
    expect(part.parent).toBeNull();
  });
  test("bounces off walls through the ray cast; capacity removes the oldest", () => {
    const debris = new Debris3D(2);
    debris.floor = null;
    // A wall at x = 1 facing -x.
    debris.cast = (o, d, len) => {
      if (d.x <= 0) return null;
      const t = (1 - o.x) / d.x;
      return t >= 0 && t <= len ? { point: new Vec3().copy(d).multiplyScalar(t).add(o), normal: new Vec3(-1, 0, 0) } : null;
    };
    const piece = debris.launch(new Node3D(), { velocity: { x: 5, y: 0, z: 0 }, gravity: 0, radius: 0.1, bounce: 0.5 });
    for (let i = 0; i < 30; i++) debris.update(1 / 60);
    expect(piece.x).toBeLessThan(0.9);
    debris.launch(new Node3D(), { velocity: { x: 0, y: 0, z: 0 } });
    debris.launch(new Node3D(), { velocity: { x: 0, y: 0, z: 0 } });
    expect(debris.count).toBe(2);
    expect(piece.parent).toBeNull();
    expect(() => debris.launch(new Node3D(), { velocity: { x: 0, y: 0, z: 0 }, radius: 0 })).toThrow(RangeError);
  });
  test("eulerFromBasis inverts mat4Compose's rotation", () => {
    const m = new Float32Array(16);
    const r = new Vec3(0.4, -1.1, 2.3);
    mat4Compose(m, new Vec3(), r, new Vec3(1, 1, 1));
    const back = eulerFromBasis([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
    const m2 = new Float32Array(16);
    mat4Compose(m2, new Vec3(), back, new Vec3(1, 1, 1));
    for (let i = 0; i < 16; i++) expect(m2[i]).toBeCloseTo(m[i], 5);
  });
});

describe("FirstPersonLook punch and dip", () => {
  test("kicks the camera, not the aim, and settles back", () => {
    const look = new FirstPersonLook(),
      camera = new Camera3D(),
      eye = new Vec3(0, 1.6, 0);
    look.punch(2, -1);
    look.update(1 / 30);
    look.apply(camera, eye);
    expect([look.yaw, look.pitch]).toEqual([0, 0]);
    const dir = new Vec3().copy(camera.target).sub(camera.position);
    expect(dir.y).toBeGreaterThan(0.01);
    expect(dir.x).toBeLessThan(-0.005);
    look.land(6);
    look.update(1 / 30);
    look.apply(camera, eye);
    expect(camera.position.y).toBeLessThan(1.6);
    for (let i = 0; i < 120; i++) look.update(1 / 60);
    look.apply(camera, eye);
    expect(camera.position.y).toBeCloseTo(1.6, 4);
    expect(camera.target.y - camera.position.y).toBeCloseTo(0, 4);
    expect(() => look.land(NaN)).toThrow(RangeError);
  });
});

describe("ShapeBuilder3D", () => {
  const outward = (g: Geometry3D) => {
    // Every triangle's winding agrees with its vertex normals.
    const P = g.positions,
      N = g.normals,
      I = g.indices;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
      const u = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]],
        v = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const d = [a, b, c].reduce((s, k) => s + n[0] * N[k * 3] + n[1] * N[k * 3 + 1] + n[2] * N[k * 3 + 2], 0);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  };
  test("chamfered boxes and extrusions split into body and edges, facing out", () => {
    const shape = new ShapeBuilder3D().box(0.4, 0.2, 0.3, { bevel: 0.02 });
    const { body, edge } = shape.build();
    expect(body && edge).toBeTruthy();
    outward(body!);
    outward(edge!);
    const xs = Array.from(body!.positions).filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo(0.2, 5);
    const one = shape.buildOne()!;
    expect(one.indices.length).toBe(body!.indices.length + edge!.indices.length);
    // A clockwise outline is turned round; the side-view axis extrudes along x.
    const tri = new ShapeBuilder3D().extrude([[0, 0], [0, 1], [1, 0]], 0.1, { axis: "x", bevel: 0 }).build().body!;
    outward(tri);
    const px = Array.from(tri.positions).filter((_, i) => i % 3 === 0);
    expect(Math.max(...px)).toBeCloseTo(0.05, 6);
  });
  test("lathes, arcs and mirrored outlines; bad input throws", () => {
    const profile = arcPoints(0, 0, 0.5, Math.PI / 2, -Math.PI / 2, 8).map(([x, y]) => [Math.abs(x), y] as [number, number]);
    const ball = new ShapeBuilder3D().lathe(profile, { segments: 16, uv: "unit" }).build().body!;
    outward(ball);
    for (let i = 0; i < ball.positions.length; i += 3) expect(Math.hypot(ball.positions[i], ball.positions[i + 1], ball.positions[i + 2])).toBeCloseTo(0.5, 4);
    expect(mirrorOutline([[0, 0], [1, 0], [1, 1]])).toEqual([[-1, 1], [-1, 0], [-0, 0]]);
    expect(() => new ShapeBuilder3D().extrude([[0, 0], [1, 0]], 1)).toThrow(RangeError);
    expect(() => new ShapeBuilder3D().box(1, 1, 0)).toThrow(RangeError);
    expect(() => new ShapeBuilder3D().lathe([[0, 1], [-1, 0]])).toThrow(RangeError);
    expect(() => new ShapeBuilder3D().lathe([[0, 1], [1, 0]], { segments: 2 })).toThrow(RangeError);
  });
});
