import { createPhysics3D, type ScenePhysics3D } from "./physics.ts";
import { Scene } from "../scene/scene.ts";
import type { DrawContext } from "../scene/draw.ts";
import { Node } from "../scene/node.ts";
import { Camera3D } from "./camera.ts";
import { Geometry3D } from "./geometry.ts";
import { Material3D } from "./material.ts";
import { Node3D } from "./node.ts";
import { Vec3, type Mat4 } from "./math.ts";
export class Mesh3D extends Node3D {
  /** WebGL2 first-person geometry drawn after the world in a reserved near depth band. */
  renderLayer: "world" | "viewmodel" = "world";
  /** Per-instance 0xRRGGBB base-color multiplier. Sharing a material still batches different tints. */
  tint = 0xffffff;
  castShadow = true;
  receiveShadow = true;
  /** Disable bounding-sphere frustum rejection for special procedural geometry. */
  frustumCulled = true;
  constructor(
    public geometry: Geometry3D,
    public material = new Material3D(),
  ) {
    super();
  }
}
export class PointLight3D extends Node3D {
  constructor(
    public color = 0xffffff,
    public intensity = 4,
    public range = 8,
  ) {
    super();
  }
}
export interface Environment3D {
  ambient: number;
  ambientIntensity: number;
  groundColor: number;
  /** Direction from the world toward the sun. */
  sunDirection: Vec3;
  sunColor: number;
  sunIntensity: number;
  fogColor: number;
  /** Exponential distance fog; 0 disables it. */
  fogDensity: number;
  exposure: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Half-width of the directional shadow volume in world units. */
  shadowExtent: number;
  shadowTarget: Vec3;
  shadowBias: number;
}
export const defaultEnvironment3D = (): Environment3D => ({
  ambient: 0xb9d5e3,
  ambientIntensity: 0.65,
  groundColor: 0x444150,
  sunDirection: new Vec3(-0.6, 1, 0.4),
  sunColor: 0xffe6bd,
  sunIntensity: 2.6,
  fogColor: 0x728795,
  fogDensity: 0.012,
  exposure: 1,
  shadows: true,
  shadowMapSize: 1024,
  shadowExtent: 28,
  shadowTarget: new Vec3(),
  shadowBias: 0.0015,
});
export interface RenderFrame3D {
  camera: Camera3D;
  meshes: readonly Mesh3D[];
  lights: readonly PointLight3D[];
  environment: Environment3D;
}
export interface RenderStats3D {
  meshes: number;
  culled: number;
  triangles: number;
  drawCalls: number;
  shadowDrawCalls: number;
}
/**
 * One integrated 3D world with Kiln's regular 2D HUD, input, saves, lifecycle, and post effects.
 * The renderer draws 3D before this scene's 2D world and overlay. Native/Canvas backends must
 * explicitly advertise support; unsupported backends report an error instead of a blank game.
 */
export class Scene3D extends Scene {
  physics3D: ScenePhysics3D | null = null;
  private physicsEpoch = 0;
  private physicsPending: Promise<ScenePhysics3D> | null = null;
  enablePhysics3D(gravity = { x: 0, y: -9.81, z: 0 }): Promise<ScenePhysics3D> {
    if (this.physics3D) return Promise.resolve(this.physics3D);
    if (this.physicsPending) return this.physicsPending;
    const epoch = ++this.physicsEpoch;
    const pending = createPhysics3D(gravity).then(physics => {
      if (epoch !== this.physicsEpoch) { physics.dispose(); throw new Error("Scene detached while initializing 3D physics"); }
      this.physics3D = physics; return physics;
    }).finally(() => { if (this.physicsPending === pending) this.physicsPending = null; });
    this.physicsPending = pending; return pending;
  }
  override updateTree(dt: number): void {
    const attached = this.attachedApp;
    super.updateTree(dt);
    if (attached === this.attachedApp && this.worldStep > 0 && !this.world3D.paused) this.physics3D?.step(this.worldStep);
  }
  override detach(): void {
    this.physicsEpoch++; this.physicsPending = null; this.physics3D?.dispose(); this.physics3D = null;
    super.detach();
  }
  readonly world3D = new Node3D();
  readonly camera3D = new Camera3D();
  environment = defaultEnvironment3D();
  private readonly meshList: Mesh3D[] = [];
  private readonly lightList: PointLight3D[] = [];
  constructor(width = 960, height = 540) {
    super(width, height);
    this.world3D.name = "world3D";
    this.add(this.world3D);
  }
  collectFrame3D(): RenderFrame3D {
    const prepare = (node: Node): void => { if (node instanceof Node3D) node.prepareRender3D(); for (const c of node.children) prepare(c); };
    prepare(this.world3D);
    this.world3D.updateWorldTree();
    this.camera3D.updateMatrices(this.width / this.height);
    this.meshList.length = 0;
    this.lightList.length = 0;
    const visit = (node: Node): void => {
      if (!node.visible) return;
      if (
        node instanceof Mesh3D &&
        !node.geometry.disposed &&
        node.material.opacity > 0
      )
        this.meshList.push(node);
      if (node instanceof PointLight3D && node.intensity > 0 && node.range > 0)
        this.lightList.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this.world3D);
    return {
      camera: this.camera3D,
      meshes: this.meshList,
      lights: this.lightList,
      environment: this.environment,
    };
  }
  override drawTree(ctx: DrawContext): void {
    if (!this.visible) return;
    if (!ctx.renderer.features.mesh3D || !ctx.renderer.render3D)
      throw new Error(
        `Scene3D requires a renderer with mesh3D support; ${ctx.renderer.kind} does not support it`,
      );
    ctx.renderer.render3D(this.collectFrame3D());
    super.drawTree(ctx);
  }
}
/** Six normalized view-frustum planes; reusable outside the rendering backend. */
export function frustumPlanes(matrix: Mat4): Float32Array {
  const out = new Float32Array(24);
  for (let axis = 0; axis < 3; axis++)
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1,
        offset = (axis * 2 + side) * 4;
      for (let c = 0; c < 4; c++)
        out[offset + c] = matrix[c * 4 + 3] + sign * matrix[c * 4 + axis];
      const len = Math.hypot(out[offset], out[offset + 1], out[offset + 2]);
      for (let c = 0; c < 4; c++) out[offset + c] /= len;
    }
  return out;
}
export function sphereInFrustum(
  planes: ArrayLike<number>,
  center: Readonly<Vec3>,
  radius: number,
): boolean {
  for (let p = 0; p < 24; p += 4)
    if (
      planes[p] * center.x +
        planes[p + 1] * center.y +
        planes[p + 2] * center.z +
        planes[p + 3] <
      -radius
    )
      return false;
  return true;
}
