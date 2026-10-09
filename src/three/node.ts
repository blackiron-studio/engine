import { Node } from "../scene/node.ts";
import type { DrawContext } from "../scene/draw.ts";
import {
  type Mat4,
  Vec3,
  mat4Compose,
  mat4Identity,
  mat4Multiply,
  mat4Point,
} from "./math.ts";

/** A scene-tree node with a real hierarchical 3D transform, Y up. */
export class Node3D extends Node {
  readonly position = new Vec3();
  /** Euler XYZ in radians. */
  readonly rotation = new Vec3();
  readonly scale = new Vec3(1, 1, 1);
  readonly worldMatrix: Mat4 = mat4Identity();
  protected readonly localMatrix: Mat4 = mat4Identity();
  /** Refresh derived mesh data before collection. */
  prepareRender3D(): void {}
  setPosition(x: number, y: number, z: number): this {
    this.position.set(x, y, z);
    return this;
  }
  setScale(x: number, y = x, z = x): this {
    this.scale.set(x, y, z);
    return this;
  }
  get x(): number {
    return this.position.x;
  }
  set x(v: number) {
    this.position.x = v;
  }
  get y(): number {
    return this.position.y;
  }
  set y(v: number) {
    this.position.y = v;
  }
  get z(): number {
    return this.position.z;
  }
  set z(v: number) {
    this.position.z = v;
  }
  /** Recompute world transform, including ancestors, even before the first frame. */
  updateWorldMatrix(): Mat4 {
    this.composeLocal();
    let parent = this.parent;
    while (parent && !(parent instanceof Node3D)) parent = parent.parent;
    if (parent instanceof Node3D)
      mat4Multiply(
        this.worldMatrix,
        parent.updateWorldMatrix(),
        this.localMatrix,
      );
    else this.worldMatrix.set(this.localMatrix);
    return this.worldMatrix;
  }
  protected composeLocal(): void {
    mat4Compose(this.localMatrix, this.position, this.rotation, this.scale);
  }
  /** Linear traversal used by the renderer avoids recomputing shared ancestors. */
  updateWorldTree(parent?: Mat4): void {
    this.composeLocal();
    if (parent) mat4Multiply(this.worldMatrix, parent, this.localMatrix);
    else this.worldMatrix.set(this.localMatrix);
    const visit = (n: Node): void => {
      if (n instanceof Node3D) n.updateWorldTree(this.worldMatrix);
      else for (const c of n.children) visit(c);
    };
    for (const c of this.children) visit(c);
  }
  localToWorld(point: Readonly<Vec3>, out = new Vec3()): Vec3 {
    return mat4Point(this.updateWorldMatrix(), point, out);
  }
  getWorldPosition(out = new Vec3()): Vec3 {
    const m = this.updateWorldMatrix();
    return out.set(m[12], m[13], m[14]);
  }
  /** 3D drawing is collected by Scene3D; do not accidentally traverse it through the 2D pass. */
  override drawTree(_ctx: DrawContext): void {}
}
