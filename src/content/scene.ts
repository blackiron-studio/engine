import { Node, Node2D } from "../scene/node.ts";
import { Sprite } from "../scene/sprite.ts";
import { Node3D } from "../three/node.ts";
import { Mesh3D, PointLight3D } from "../three/scene.ts";
import { Geometry3D } from "../three/geometry.ts";
import { Material3D } from "../three/material.ts";
import { ResourceScope } from "./resources.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface SceneNodeData {
  id: string;
  type?: string;
  name?: string;
  props?: Record<string, JsonValue>;
  children?: SceneNodeData[];
  prefab?: string;
  overrides?: Record<string, Record<string, JsonValue>>;
}
export interface SceneDocument {
  format: "blackiron.scene";
  version: 1;
  root: SceneNodeData;
  prefabs?: Record<string, SceneNodeData>;
}
export interface SceneInstance {
  root: Node;
  nodes: ReadonlyMap<string, Node>;
  dispose(): void;
}
export interface NodeCodec {
  create(props: Record<string, JsonValue>, scope: ResourceScope): Node;
  apply?(
    node: Node,
    props: Record<string, JsonValue>,
    resolve: (id: string) => Node,
  ): void;
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function safe(value: unknown, depth = 0): void {
  if (depth > 128) throw new Error("Scene document nesting limit exceeded");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Non-finite scene value");
  if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (forbidden.has(k)) throw new Error(`Unsafe scene key: ${k}`);
      safe(v, depth + 1);
    }
  else if (
    value !== null &&
    !["string", "number", "boolean", "undefined"].includes(typeof value)
  )
    throw new Error("Non-JSON scene value");
}
export function parseSceneDocument(value: unknown): SceneDocument {
  if (typeof value === "string") value = JSON.parse(value);
  safe(value);
  const d = value as SceneDocument;
  if (!d || d.format !== "blackiron.scene" || d.version !== 1 || !d.root)
    throw new Error("Expected blackiron.scene version 1");
  let count = 0;
  const validate = (n: SceneNodeData, ids: Set<string>) => {
    if (
      !n ||
      typeof n.id !== "string" ||
      !/^[a-zA-Z0-9_.-]+$/.test(n.id) ||
      ids.has(n.id)
    )
      throw new Error("Scene node IDs must be unique safe names");
    ids.add(n.id);
    if (++count > 10000) throw new Error("Scene document node limit exceeded");
    if (!!n.type === !!n.prefab)
      throw new Error(`Node ${n.id} needs exactly one type or prefab`);
    if (n.props && (Array.isArray(n.props) || typeof n.props !== "object"))
      throw new Error("Invalid node properties");
    if (n.children && !Array.isArray(n.children))
      throw new Error("Invalid node children");
    for (const child of n.children ?? []) validate(child, ids);
  };
  validate(d.root, new Set());
  for (const p of Object.values(d.prefabs ?? {})) validate(p, new Set());
  return JSON.parse(JSON.stringify(d));
}
export class SceneRegistry {
  private codecs = new Map<string, NodeCodec>();
  register(type: string, codec: NodeCodec): this {
    if (this.codecs.has(type)) throw new Error(`Duplicate scene type: ${type}`);
    this.codecs.set(type, codec);
    return this;
  }
  instantiate(input: SceneDocument): SceneInstance {
    const doc = parseSceneDocument(input),
      nodes = new Map<string, Node>(),
      scope = new ResourceScope(),
      links: (() => void)[] = [];
    let count = 0;
    const build = (
      data: SceneNodeData,
      prefix = "",
      chain: string[] = [],
      overrides: SceneNodeData["overrides"] = {},
    ): Node => {
      if (++count > 10000 || chain.length > 32)
        throw new Error("Expanded prefab limit exceeded");
      const id = prefix + data.id;
      if (nodes.has(id)) throw new Error(`Duplicate expanded ID: ${id}`);
      if (data.prefab) {
        if (chain.includes(data.prefab))
          throw new Error(`Prefab cycle: ${data.prefab}`);
        const template = doc.prefabs?.[data.prefab];
        if (!template) throw new Error(`Unknown prefab: ${data.prefab}`);
        const root = build(
          template,
          id + "/",
          [...chain, data.prefab],
          data.overrides,
        );
        nodes.set(id, root);
        if (data.name) root.name = data.name;
        for (const child of data.children ?? [])
          root.add(build(child, id + "/", chain));
        return root;
      }
      const codec = this.codecs.get(data.type!);
      if (!codec) throw new Error(`Unknown scene node type: ${data.type}`);
      const props = { ...data.props, ...overrides?.[data.id] },
        node = codec.create(props, scope);
      nodes.set(id, node);
      node.name = data.name ?? data.id;
      if (codec.apply)
        links.push(() =>
          codec.apply!(node, props, (ref) => {
            const found = nodes.get(prefix + ref) ?? nodes.get(ref);
            if (!found) throw new Error(`Unresolved scene reference: ${ref}`);
            return found;
          }),
        );
      for (const child of data.children ?? [])
        node.add(build(child, prefix, chain, overrides));
      return node;
    };
    let root: Node | undefined;
    try {
      root = build(doc.root);
      for (const link of links) link();
    } catch (error) {
      const errors: unknown[] = [error];
      for (const node of nodes.values()) {
        try {
          node.destroy();
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      try {
        scope.dispose();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      nodes.clear();
      if (errors.length > 1)
        throw new AggregateError(
          errors,
          "Scene construction and cleanup failed",
        );
      throw error;
    }
    let disposed = false;
    return {
      root,
      nodes,
      dispose() {
        if (disposed) return;
        disposed = true;
        const errors: unknown[] = [];
        try {
          root!.destroy();
        } catch (error) {
          errors.push(error);
        }
        try {
          scope.dispose();
        } catch (error) {
          errors.push(error);
        }
        root!.clear();
        nodes.clear();
        if (errors.length)
          throw new AggregateError(errors, "Scene disposal failed");
      },
    };
  }
}
function number(
  p: Record<string, JsonValue>,
  key: string,
  fallback: number,
): number {
  const v = p[key] ?? fallback;
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`Expected numeric ${key}`);
  return v;
}
function vector(
  p: Record<string, JsonValue>,
  key: string,
  fallback: number[],
): number[] {
  const v = p[key] ?? fallback;
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    v.some((x) => typeof x !== "number" || !Number.isFinite(x))
  )
    throw new Error(`Expected 3D ${key}`);
  return v as number[];
}
function transform3(node: Node3D, p: Record<string, JsonValue>): void {
  const a = vector(p, "position", [0, 0, 0]),
    b = vector(p, "rotation", [0, 0, 0]),
    c = vector(p, "scale", [1, 1, 1]);
  node.position.set(a[0], a[1], a[2]);
  node.rotation.set(b[0], b[1], b[2]);
  node.scale.set(c[0], c[1], c[2]);
  node.visible = p.visible !== false;
}
/** Built-in, explicitly typed codecs. Custom gameplay types register their own property contracts. */
export function createSceneRegistry(): SceneRegistry {
  const registry = new SceneRegistry();
  registry.register("Node", {
    create: (p) => {
      const n = new Node();
      n.visible = p.visible !== false;
      return n;
    },
  });
  registry.register("Node2D", {
    create: (p) => {
      const n = new Node2D(number(p, "x", 0), number(p, "y", 0));
      n.rotation = number(p, "rotation", 0);
      n.scaleX = number(p, "scaleX", 1);
      n.scaleY = number(p, "scaleY", 1);
      return n;
    },
  });
  registry.register("Sprite", {
    create: (p) => {
      if (typeof p.sprite !== "string") throw new Error("Sprite name required");
      const n = new Sprite(p.sprite, number(p, "x", 0), number(p, "y", 0));
      n.tint = number(p, "tint", 0xffffff);
      return n;
    },
  });
  registry.register("Node3D", {
    create: (p) => {
      const n = new Node3D();
      transform3(n, p);
      return n;
    },
  });
  registry.register("PointLight3D", {
    create: (p) => {
      const n = new PointLight3D(
        number(p, "color", 0xffffff),
        number(p, "intensity", 4),
        number(p, "range", 8),
      );
      transform3(n, p);
      return n;
    },
  });
  const geometryPools = new WeakMap<ResourceScope, Map<string, Geometry3D>>();
  const materialPools = new WeakMap<ResourceScope, Map<string, Material3D>>();
  registry.register("Mesh3D", {
    create: (p, scope) => {
      const primitive = String(p.primitive ?? "box");
      let pool = geometryPools.get(scope);
      if (!pool) {
        pool = new Map();
        geometryPools.set(scope, pool);
      }
      let g = pool.get(primitive);
      if (!g) {
        g =
          primitive === "box"
            ? Geometry3D.box()
            : primitive === "sphere"
              ? Geometry3D.sphere()
              : primitive === "plane"
                ? Geometry3D.plane()
                : primitive === "cylinder"
                  ? Geometry3D.cylinder()
                  : undefined;
        if (!g) throw new Error(`Unknown primitive: ${primitive}`);
        scope.own(g);
        pool.set(primitive, g);
      }
      const shading = p.shading ?? "standard";
      if (!["standard", "lambert", "unlit"].includes(String(shading)))
        throw new Error("Invalid material shading");
      const options = {
        color: number(p, "color", 0xffffff),
        roughness: number(p, "roughness", 0.65),
        metallic: number(p, "metallic", 0),
        shading: shading as "standard" | "lambert" | "unlit",
        toneMapped: p.toneMapped !== false,
      };
      let materials = materialPools.get(scope);
      if (!materials) {
        materials = new Map();
        materialPools.set(scope, materials);
      }
      const key = JSON.stringify(options);
      let material = materials.get(key);
      if (!material) {
        material = new Material3D(options);
        materials.set(key, material);
      }
      const n = new Mesh3D(g, material);
      transform3(n, p);
      return n;
    },
  });
  return registry;
}

/** Bounded undo/redo over validated authoring data, never arbitrary live object snapshots. */
export class SceneEditor {
  private past: string[] = [];
  private future: string[] = [];
  private current: SceneDocument;
  constructor(
    document: SceneDocument,
    readonly historyLimit = 100,
  ) {
    this.current = parseSceneDocument(document);
  }
  get document(): SceneDocument {
    return parseSceneDocument(this.current);
  }
  edit(change: (draft: SceneDocument) => void): void {
    const draft = this.document;
    change(draft);
    const next = parseSceneDocument(draft);
    this.past.push(JSON.stringify(this.current));
    if (this.past.length > this.historyLimit) this.past.shift();
    this.future = [];
    this.current = next;
  }
  undo(): boolean {
    const old = this.past.pop();
    if (!old) return false;
    this.future.push(JSON.stringify(this.current));
    this.current = JSON.parse(old);
    return true;
  }
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(JSON.stringify(this.current));
    this.current = JSON.parse(next);
    return true;
  }
  serialize(): string {
    return JSON.stringify(this.current, null, 2) + "\n";
  }
}
