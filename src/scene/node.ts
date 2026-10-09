// Scene tree. `Node` is the plain container with lifecycle; `Node2D` adds a transform.
// Override `ready`, `update`, `render` and `exit` in subclasses.

import { activeProfiler } from "../app/profiler.ts";
import type { App } from "../app/app.ts";
import { type Mat, matCompose, matIdentity, matInvert, matMul } from "../render/types.ts";
import type { DrawContext } from "./draw.ts";
import type { Scene } from "./scene.ts";

export class Node {
  name = "";
  parent: Node | null = null;
  readonly children: Node[] = [];
  /** Hidden nodes are not drawn; their children are not drawn either. */
  visible = true;
  /** Paused nodes and their subtree skip `update`. */
  paused = false;
  scene: Scene | null = null;
  private readied = false;
  private sorted: Node[] | null = null;
  private sortDirty = false;
  private traversal: Node[] | null = null;
  private exiting = false;

  // --- Lifecycle hooks -------------------------------------------------------

  /** Called once when the node is part of a running scene. Add children here. */
  ready(): void {}
  /** Called every fixed step with the step in seconds. */
  update(_dt: number): void {}
  /** Called every frame with the node's transform already applied. */
  render(_ctx: DrawContext): void {}
  /** Called when the node leaves the scene tree. */
  exit(): void {}

  // --- Tree ------------------------------------------------------------------

  add<T extends Node>(child: T): T {
    for (let ancestor: Node | null = this; ancestor; ancestor = ancestor.parent) {
      if (ancestor === child) throw new Error("A node cannot be added under itself or its descendant");
    }
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
    this.traversal = null;
    this.sortDirty = true;
    this.scene?.uiChanged();
    if (this.scene) child.enterTree(this.scene);
    return child;
  }

  remove(child: Node): void {
    const i = this.children.indexOf(child);
    if (i < 0) return;
    this.children.splice(i, 1);
    this.traversal = null;
    this.sortDirty = true;
    this.scene?.uiChanged();
    child.parent = null;
    if (child.scene) child.exitTree();
  }

  /** Remove this node from its parent and tear down its subtree. */
  destroy(): void {
    if (this.parent) this.parent.remove(this);
    else if (this.scene) this.exitTree();
  }

  clear(): void {
    for (const c of [...this.children]) this.remove(c);
  }

  /** @internal */
  enterTree(scene: Scene): void {
    this.scene = scene;
    for (const c of this.childSnapshot()) if (c.parent === this) c.enterTree(scene);
    if (scene.isStarted && !this.readied) {
      this.readied = true;
      this.ready();
    }
  }

  /** @internal */
  exitTree(): void {
    if (this.exiting) return;
    this.exiting = true;
    const errors: unknown[] = [];
    for (const c of this.childSnapshot()) if (c.parent === this) {
      try { c.exitTree(); } catch (error) { errors.push(error); }
    }
    const wasReady = this.readied;
    this.readied = false;
    try { if (wasReady) this.exit(); } catch (error) { errors.push(error); }
    this.scene = null;
    this.exiting = false;
    if (errors.length) throw new AggregateError(errors, "Node exit failed");
  }

  /** @internal Ready every node in the subtree that has not been readied, parents first. */
  readyTree(): void {
    if (!this.readied) {
      this.readied = true;
      this.ready();
    }
    for (const c of this.childSnapshot()) if (c.parent === this) c.readyTree();
  }

  updateTree(dt: number): void {
    if (this.paused) return;
    const kids = this.childSnapshot();
    const attached = this.scene;
    if (activeProfiler) {
      const t = activeProfiler.now();
      this.update(dt);
      activeProfiler.nodeUpdate(this, activeProfiler.now() - t);
    } else this.update(dt);
    if (attached && this.scene !== attached) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.parent === this) c.updateTree(dt);
      if (attached && this.scene !== attached) return;
    }
  }

  drawTree(ctx: DrawContext): void {
    if (!this.visible) return;
    this.profiledRender(ctx);
    const kids = this.orderedChildren();
    for (let i = 0; i < kids.length; i++) if (kids[i].parent === this) kids[i].drawTree(ctx);
  }

  /** @internal Render, timed when a profiler is active. */
  protected profiledRender(ctx: DrawContext): void {
    if (activeProfiler) {
      const t = activeProfiler.now();
      this.render(ctx);
      activeProfiler.nodeRender(this, activeProfiler.now() - t);
    } else this.render(ctx);
  }

  /** @internal */
  markSortDirty(): void {
    this.sortDirty = true;
    this.scene?.uiChanged();
  }

  /** Stable during traversal; rebuilding only on structural changes avoids per-step allocations. */
  protected childSnapshot(): readonly Node[] {
    return this.traversal ??= [...this.children];
  }

  protected orderedChildren(): Node[] {
    if (!this.sortDirty && this.sorted) return this.sorted;
    let needsSort = false;
    for (const c of this.children) {
      if (c instanceof Node2D && c.zIndex !== 0) {
        needsSort = true;
        break;
      }
    }
    this.sorted = [...this.children];
    if (needsSort) this.sorted.sort((a, b) => zOf(a) - zOf(b));
    this.sortDirty = false;
    return this.sorted;
  }

  /** Depth-first search by name. */
  find(name: string): Node | null {
    for (const c of this.children) {
      if (c.name === name) return c;
      const hit = c.find(name);
      if (hit) return hit;
    }
    return null;
  }

  /** Every descendant that is an instance of `type`. */
  findAll<T extends Node>(type: abstract new (...args: never[]) => T, out: T[] = []): T[] {
    for (const c of this.children) {
      if (c instanceof type) out.push(c);
      c.findAll(type, out);
    }
    return out;
  }

  /** Descendants in the same painter order used by drawTree, including hidden nodes. */
  findAllInDrawOrder<T extends Node>(type: abstract new (...args: never[]) => T, out: T[] = []): T[] {
    for (const c of this.orderedChildren()) {
      if (c.parent !== this) continue;
      if (c instanceof type) out.push(c);
      c.findAllInDrawOrder(type, out);
    }
    return out;
  }

  get app(): App {
    const s = this.scene;
    if (!s) throw new Error(`Node "${this.name || this.constructor.name}" is not in a scene`);
    return s.app;
  }

  get isReady(): boolean {
    return this.readied;
  }
}

const zOf = (n: Node): number => (n instanceof Node2D ? n.zIndex : 0);

export class Node2D extends Node {
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  alpha = 1;
  /** Sort children by their y so lower ones draw in front; for top-down scenes. */
  ySort = false;
  private zOrder = 0;
  /** Height above the ground in world units; used by projected layers (see Camera2D.projection). */
  z = 0;
  /** Height including the parents', as of the last draw. */
  worldZ = 0;
  /** Draw a blob shadow on the ground under this node in projected layers. */
  castShadow = false;
  shadowAlpha = 0.5;
  /** Added to the depth key in projected layers, for the rare draw-order exception. */
  depthBias = 0;
  /** Local-to-screen transform as of the last draw. */
  readonly world: Mat = matIdentity();
  /** Ground-space transform as of the last draw in a projected layer. */
  readonly ground: Mat = matIdentity();
  /** Alpha multiplied down the tree as of the last draw. */
  worldAlpha = 1;
  private readonly local: Mat = matIdentity();

  constructor(x = 0, y = 0) {
    super();
    this.x = x;
    this.y = y;
  }

  get zIndex(): number {
    return this.zOrder;
  }

  set zIndex(v: number) {
    if (v === this.zOrder) return;
    this.zOrder = v;
    this.parent?.markSortDirty();
  }

  get scale(): number {
    return this.scaleX;
  }

  set scale(v: number) {
    this.scaleX = v;
    this.scaleY = v;
  }

  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  override drawTree(ctx: DrawContext): void {
    if (!this.visible) return;
    const parentA = ctx.alpha;
    matCompose(this.local, this.x, this.y, this.scaleX, this.scaleY, this.rotation);
    this.worldAlpha = parentA * this.alpha;
    if (ctx.projection) {
      // Projected layer: compose in ground space; the context projects to the screen.
      const pg = ctx.ground;
      const g0 = pg[0], g1 = pg[1], g2 = pg[2], g3 = pg[3], g4 = pg[4], g5 = pg[5];
      const parentZ = ctx.groundZ;
      const parentBias = ctx.depthBias;
      matMul(this.ground, pg, this.local);
      this.worldZ = parentZ + this.z;
      ctx.setTransform3(this.ground, this.worldZ, this.worldAlpha, parentBias + this.depthBias, this.castShadow, this.shadowAlpha);
      for (let i = 0; i < 6; i++) this.world[i] = ctx.transform[i];
      this.profiledRender(ctx);
      const kids = this.orderedChildren();
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].parent === this) kids[i].drawTree(ctx);
        ctx.setTransform3(this.ground, this.worldZ, this.worldAlpha, parentBias + this.depthBias);
      }
      ctx.setTransform3([g0, g1, g2, g3, g4, g5], parentZ, parentA, parentBias);
      return;
    }
    const parentT = ctx.transform;
    const p0 = parentT[0], p1 = parentT[1], p2 = parentT[2], p3 = parentT[3], p4 = parentT[4], p5 = parentT[5];
    matMul(this.world, parentT, this.local);
    ctx.setTransform(this.world, this.worldAlpha);
    this.profiledRender(ctx);
    const kids = this.orderedChildren();
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].parent === this) kids[i].drawTree(ctx);
      ctx.setTransform(this.world, this.worldAlpha);
    }
    ctx.setTransform([p0, p1, p2, p3, p4, p5], parentA);
  }

  protected override orderedChildren(): Node[] {
    if (!this.ySort) return super.orderedChildren();
    return [...this.children].sort((a, b) => {
      const dz = zOf(a) - zOf(b);
      if (dz !== 0) return dz;
      return (a instanceof Node2D ? a.y : 0) - (b instanceof Node2D ? b.y : 0);
    });
  }

  /** Local point to the current layer's screen space, using the last drawn transform. */
  toScreen(lx = 0, ly = 0): [number, number] {
    const m = this.world;
    return [m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5]];
  }

  /** Screen point into this node's local space, using the last drawn transform. */
  toLocal(sx: number, sy: number): [number, number] {
    const inv = matInvert(this.world);
    return [inv[0] * sx + inv[2] * sy + inv[4], inv[1] * sx + inv[3] * sy + inv[5]];
  }

  /** Position in the parent's space of `ancestor`, walking up through Node2D parents. */
  positionIn(ancestor: Node): [number, number] {
    let x = this.x;
    let y = this.y;
    let n: Node | null = this.parent;
    while (n && n !== ancestor) {
      if (n instanceof Node2D) {
        const c = Math.cos(n.rotation);
        const s = Math.sin(n.rotation);
        const px = x * n.scaleX;
        const py = y * n.scaleY;
        x = n.x + px * c - py * s;
        y = n.y + px * s + py * c;
      }
      n = n.parent;
    }
    return [x, y];
  }
}
