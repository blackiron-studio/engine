import type { Platform, DecodedImage } from "../platform/types.ts";
import { Geometry3D } from "./geometry.ts";
import { Material3D } from "./material.ts";
import { Texture3D } from "./texture.ts";
import { Mesh3D } from "./scene.ts";
import { Node3D } from "./node.ts";
import { mat4Identity } from "./math.ts";
import {
  AnimationClip3D,
  AnimationPlayer3D,
  Skin3D,
  Transform3D,
  normalizeQuaternion,
  type AnimationChannel3D,
} from "./animation.ts";

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}
interface TextureInfo {
  index: number;
  texCoord?: number;
  extensions?: unknown;
}
interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: unknown;
  extensions?: unknown;
}
interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface Gltf {
  asset: { version: string };
  extensionsRequired?: string[];
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }[];
  accessors?: Accessor[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  textures?: { source: number; sampler?: number }[];
  samplers?: {
    magFilter?: number;
    minFilter?: number;
    wrapS?: number;
    wrapT?: number;
  }[];
  materials?: {
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: TextureInfo;
      metallicFactor?: number;
      roughnessFactor?: number;
      metallicRoughnessTexture?: TextureInfo;
    };
    normalTexture?: TextureInfo;
    emissiveTexture?: TextureInfo;
    emissiveFactor?: number[];
    occlusionTexture?: TextureInfo;
    doubleSided?: boolean;
    alphaMode?: "OPAQUE" | "MASK" | "BLEND";
    alphaCutoff?: number;
    extensions?: { KHR_materials_unlit?: object };
  }[];
  meshes?: { primitives: Primitive[] }[];
  nodes?: GltfNode[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  animations?: {
    name?: string;
    samplers: {
      input: number;
      output: number;
      interpolation?: "LINEAR" | "STEP" | "CUBICSPLINE";
    }[];
    channels: {
      sampler: number;
      target: {
        node: number;
        path: "translation" | "rotation" | "scale" | "weights";
      };
    }[];
  }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
}
export interface GltfLoadOptions {
  /** Override embedded-image decoding for native hosts or custom codecs. */
  decodeImage?: (bytes: Uint8Array, mime: string) => Promise<DecodedImage>;
  maxBytes?: number;
}
const components: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};
const sizes: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
function index<T>(
  items: readonly T[] | undefined,
  i: number,
  label: string,
): T {
  if (!Number.isInteger(i) || i < 0 || !items || i >= items.length)
    throw new Error(`glTF invalid ${label} index: ${i}`);
  return items[i];
}
function integer(v: number, label: string): number {
  if (!Number.isSafeInteger(v) || v < 0)
    throw new Error(`glTF invalid ${label}`);
  return v;
}
function finite(values: number[], length: number, label: string): number[] {
  if (values.length !== length || values.some((v) => !Number.isFinite(v)))
    throw new Error(`glTF invalid ${label}`);
  return values;
}
function uri(base: string, value: string): string {
  if (/^(data:|https?:|\/)/.test(value)) return value;
  if (/^https?:/.test(base)) return new URL(value, base).href;
  return base.slice(0, base.lastIndexOf("/") + 1) + value;
}
function dataUri(value: string): Uint8Array {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(value);
  if (!match) throw new Error("glTF requires base64 data URIs");
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const encoded = match[1].replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    throw new Error("Invalid base64 buffer");
  const out: number[] = [];
  let bits = 0,
    accumulator = 0;
  for (const ch of encoded.replace(/=+$/, "")) {
    accumulator = (accumulator << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}
function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let encoded = "";
  for (const byte of bytes) encoded += "%" + byte.toString(16).padStart(2, "0");
  return decodeURIComponent(encoded);
}
function srgbColor(values: number[]): number {
  const encode = (v: number) =>
    Math.round(
      Math.max(
        0,
        Math.min(
          1,
          v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055,
        ),
      ) * 255,
    );
  return (
    (encode(values[0]) << 16) | (encode(values[1]) << 8) | encode(values[2])
  );
}
export class GltfInstance extends Node3D {
  readonly player = new AnimationPlayer3D();
  clips: AnimationClip3D[] = [];
  skins: Skin3D[] = [];
  disposed = false;
  constructor() {
    super();
    this.add(this.player);
  }
  /** Runs after animation updates and before either renderer collects meshes. */
  override prepareRender3D(): void {
    this.updateSkins();
  }
  updateSkins(): void {
    if (!this.disposed) for (const skin of this.skins) skin.update();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    try {
      this.destroy();
    } catch (error) {
      errors.push(error);
    }
    for (const skin of this.skins) {
      try {
        skin.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.player.playing = false;
    this.player.clip = null;
    this.player.onFinished = null;
    this.skins.length = 0;
    this.clips.length = 0;
    this.clear();
    if (errors.length)
      throw new AggregateError(errors, "glTF instance disposal failed");
  }
}
export interface GltfAsset {
  instantiate(): GltfInstance;
  dispose(): void;
  readonly bytes: number;
  readonly warnings: readonly string[];
}
/** glTF 2 / GLB triangles, indexed/interleaved/normalized/sparse accessors, PBR maps and skin clips. */
export async function loadGltf(
  platform: Platform,
  url: string,
  options: GltfLoadOptions = {},
): Promise<GltfAsset> {
  const limit = options.maxBytes ?? 128 * 1024 * 1024;
  let consumed = 0;
  const account = (n: number) => {
    consumed += n;
    if (consumed > limit) throw new Error("glTF exceeds resource byte budget");
  };
  const bytes = new Uint8Array(await platform.loadBytes(url));
  account(bytes.length);
  let json: Gltf, binary: Uint8Array | undefined;
  if (
    bytes.length >= 12 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    ) === 0x46546c67
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.length
    )
      throw new Error("Invalid GLB header");
    let offset = 12,
      source: string | undefined;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error("Truncated GLB chunk");
      const length = view.getUint32(offset, true),
        kind = view.getUint32(offset + 4, true);
      offset += 8;
      if (length % 4 || offset + length > bytes.length)
        throw new Error("Invalid GLB chunk bounds");
      const chunk = bytes.subarray(offset, offset + length);
      if (kind === 0x4e4f534a) {
        if (source !== undefined || offset !== 20)
          throw new Error("Invalid GLB JSON chunk");
        source = decodeUtf8(chunk);
      } else if (kind === 0x004e4942) {
        if (binary) throw new Error("Duplicate GLB binary chunk");
        binary = chunk;
      }
      offset += length;
    }
    if (!source) throw new Error("Missing GLB JSON");
    json = JSON.parse(source);
  } else json = JSON.parse(decodeUtf8(bytes));
  if (json.asset?.version !== "2.0")
    throw new Error("Only glTF 2.0 is supported");
  for (const extension of json.extensionsRequired ?? [])
    if (extension !== "KHR_materials_unlit")
      throw new Error(`Unsupported required glTF extension: ${extension}`);
  const buffers: Uint8Array[] = [];
  for (const [i, b] of (json.buffers ?? []).entries()) {
    integer(b.byteLength, "buffer length");
    const data = b.uri
      ? b.uri.startsWith("data:")
        ? dataUri(b.uri)
        : new Uint8Array(await platform.loadBytes(uri(url, b.uri)))
      : i === 0
        ? binary
        : undefined;
    if (!data || data.length < b.byteLength)
      throw new Error("Truncated glTF buffer");
    if (data !== binary) account(data.length);
    buffers.push(data.subarray(0, b.byteLength));
  }
  const bufferView = (i: number) => {
    const b = index(json.bufferViews, i, "bufferView"),
      data = index(buffers, b.buffer, "buffer");
    const offset = integer(b.byteOffset ?? 0, "buffer offset"),
      length = integer(b.byteLength, "view length");
    if (offset + length > data.length)
      throw new Error("glTF bufferView out of bounds");
    return data.subarray(offset, offset + length);
  };
  const read = (
    data: Uint8Array,
    component: number,
    offset: number,
  ): number => {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (component) {
      case 5120:
        return v.getInt8(offset);
      case 5121:
        return v.getUint8(offset);
      case 5122:
        return v.getInt16(offset, true);
      case 5123:
        return v.getUint16(offset, true);
      case 5125:
        return v.getUint32(offset, true);
      case 5126:
        return v.getFloat32(offset, true);
      default:
        throw new Error("Unsupported accessor component");
    }
  };
  const accessor = (i: number, expected?: string): Float32Array => {
    const a = index(json.accessors, i, "accessor"),
      n = components[a.type],
      size = sizes[a.componentType];
    if (!n || !size || (expected && a.type !== expected))
      throw new Error("Unsupported accessor layout");
    integer(a.count, "accessor count");
    if (a.count * n * 4 > limit)
      throw new Error("Accessor allocation exceeds budget");
    account(a.count * n * 4);
    const out = new Float32Array(a.count * n),
      offset = integer(a.byteOffset ?? 0, "accessor offset");
    if (a.bufferView !== undefined) {
      const data = bufferView(a.bufferView),
        view = index(json.bufferViews, a.bufferView, "bufferView"),
        stride = view.byteStride ?? n * size;
      if (
        !Number.isInteger(stride) ||
        stride < n * size ||
        stride % size ||
        offset % size ||
        offset + (a.count ? (a.count - 1) * stride + n * size : 0) > data.length
      )
        throw new Error("Accessor outside bufferView");
      for (let j = 0; j < a.count; j++)
        for (let k = 0; k < n; k++)
          out[j * n + k] = read(
            data,
            a.componentType,
            offset + j * stride + k * size,
          );
    } else if (offset !== 0) throw new Error("Accessor offset without buffer");
    if (a.sparse) {
      const s = a.sparse,
        count = integer(s.count, "sparse count"),
        is = sizes[s.indices.componentType];
      if (
        count > a.count ||
        ![5121, 5123, 5125].includes(s.indices.componentType)
      )
        throw new Error("Invalid sparse accessor");
      const ids = bufferView(s.indices.bufferView),
        values = bufferView(s.values.bufferView),
        io = integer(s.indices.byteOffset ?? 0, "sparse index offset"),
        vo = integer(s.values.byteOffset ?? 0, "sparse value offset");
      if (io + count * is > ids.length || vo + count * n * size > values.length)
        throw new Error("Sparse accessor outside buffer");
      let last = -1;
      for (let j = 0; j < count; j++) {
        const at = read(ids, s.indices.componentType, io + j * is);
        if (at <= last || at >= a.count)
          throw new Error("Invalid sparse index order");
        last = at;
        for (let k = 0; k < n; k++)
          out[at * n + k] = read(
            values,
            a.componentType,
            vo + (j * n + k) * size,
          );
      }
    }
    if (a.normalized) {
      const max =
        a.componentType === 5120
          ? 127
          : a.componentType === 5121
            ? 255
            : a.componentType === 5122
              ? 32767
              : a.componentType === 5123
                ? 65535
                : 0;
      if (!max) throw new Error("Invalid normalized accessor");
      for (let j = 0; j < out.length; j++) out[j] = Math.max(-1, out[j] / max);
    }
    if (out.some((v) => !Number.isFinite(v)))
      throw new Error("Non-finite accessor");
    return out;
  };
  const textures: Texture3D[] = [],
    geometries: Geometry3D[] = [],
    warnings: string[] = [];
  try {
    const images: DecodedImage[] = [];
    for (const image of json.images ?? []) {
      if (image.uri && !image.uri.startsWith("data:")) {
        images.push(await platform.loadImage(uri(url, image.uri)));
      } else {
        const data = image.uri
            ? dataUri(image.uri)
            : bufferView(image.bufferView!),
          mime =
            image.mimeType ??
            image.uri?.slice(5, image.uri.indexOf(";")) ??
            "image/png";
        if (options.decodeImage)
          images.push(await options.decodeImage(data, mime));
        else if (platform.decodeImage)
          images.push(await platform.decodeImage(data, mime));
        else {
          let raw = "";
          for (let i = 0; i < data.length; i += 8192)
            raw += String.fromCharCode(...data.subarray(i, i + 8192));
          images.push(
            await platform.loadImage(`data:${mime};base64,${btoa(raw)}`),
          );
        }
      }
      account(images[images.length - 1].data.byteLength);
    }
    for (const texture of json.textures ?? []) {
      const image = index(images, texture.source, "image"),
        sampler =
          texture.sampler === undefined
            ? {}
            : index(json.samplers, texture.sampler, "sampler");
      const wrap = (value: number | undefined): Texture3D["wrap"] => {
        switch (value ?? 10497) {
          case 10497: return "repeat";
          case 33071: return "clamp";
          case 33648: return "mirror";
          default: throw new Error("Unsupported glTF texture wrap mode");
        }
      };
      const magFilter = sampler.magFilter ?? 9729;
      if (magFilter !== 9728 && magFilter !== 9729) throw new Error("Unsupported glTF magnification filter");
      const minFilter = (value: number | undefined): Texture3D["minFilter"] => {
        switch (value ?? 9987) {
          case 9728: return "nearest";
          case 9729: return "linear";
          case 9984: return "nearest-mipmap-nearest";
          case 9985: return "linear-mipmap-nearest";
          case 9986: return "nearest-mipmap-linear";
          case 9987: return "linear-mipmap-linear";
          default: throw new Error("Unsupported glTF minification filter");
        }
      };
      textures.push(
        new Texture3D(
          image.width,
          image.height,
          image.data,
          magFilter === 9728 ? "nearest" : "linear",
          wrap(sampler.wrapS),
          wrap(sampler.wrapT),
          minFilter(sampler.minFilter),
        ),
      );
    }
    const map = (info?: TextureInfo) => {
      if (!info) return null;
      if ((info.texCoord ?? 0) !== 0 || info.extensions)
        throw new Error("Only untransformed TEXCOORD_0 is supported");
      return index(textures, info.index, "texture");
    };
    const materials = (json.materials ?? []).map((m) => {
      const p = m.pbrMetallicRoughness ?? {},
        base = finite(p.baseColorFactor ?? [1, 1, 1, 1], 4, "base color"),
        emissive = finite(m.emissiveFactor ?? [0, 0, 0], 3, "emissive");
      if (m.occlusionTexture)
        warnings.push("Occlusion texture is not currently applied");
      return new Material3D({
        color: srgbColor(base),
        opacity: base[3],
        roughness: p.roughnessFactor ?? 1,
        metallic: p.metallicFactor ?? 1,
        map: map(p.baseColorTexture),
        normalMap: map(m.normalTexture),
        metallicRoughnessMap: map(p.metallicRoughnessTexture),
        emissiveMap: map(m.emissiveTexture),
        emissive: srgbColor(emissive),
        emissiveIntensity: emissive.some((v) => v > 0) ? 1 : 0,
        doubleSided: m.doubleSided,
        alphaMode: m.alphaMode ?? "OPAQUE",
        alphaCutoff: m.alphaCutoff ?? 0.5,
        shading: m.extensions?.KHR_materials_unlit ? "unlit" : "standard",
      });
    });
    const meshes = (json.meshes ?? []).map((mesh) =>
      mesh.primitives.map((p) => {
        if ((p.mode ?? 4) !== 4 || p.targets || p.extensions)
          throw new Error(
            "Only uncompressed triangle primitives without morph targets are supported",
          );
        let positions = accessor(p.attributes.POSITION, "VEC3"),
          ids =
            p.indices === undefined
              ? Float32Array.from({ length: positions.length / 3 }, (_, i) => i)
              : accessor(p.indices, "SCALAR");
        if (
          p.indices !== undefined &&
          ![5121, 5123, 5125].includes(
            index(json.accessors, p.indices, "indices").componentType,
          )
        )
          throw new Error("Invalid index component type");
        if (
          ids.length % 3 ||
          ids.some(
            (i) => !Number.isInteger(i) || i < 0 || i >= positions.length / 3,
          )
        )
          throw new Error("Invalid triangle indices");
        let normals: Float32Array,
          remap: Float32Array | null = null;
        if (p.attributes.NORMAL !== undefined)
          normals = accessor(p.attributes.NORMAL, "VEC3");
        else {
          // glTF specifies flat normals when NORMAL is absent. Duplicate shared vertices per face.
          remap = ids;
          const flat = new Float32Array(ids.length * 3);
          normals = new Float32Array(flat.length);
          for (let i = 0; i < ids.length; i += 3) {
            const a = ids[i] * 3,
              b = ids[i + 1] * 3,
              c = ids[i + 2] * 3,
              ux = positions[b] - positions[a],
              uy = positions[b + 1] - positions[a + 1],
              uz = positions[b + 2] - positions[a + 2],
              vx = positions[c] - positions[a],
              vy = positions[c + 1] - positions[a + 1],
              vz = positions[c + 2] - positions[a + 2];
            const nx = uy * vz - uz * vy,
              ny = uz * vx - ux * vz,
              nz = ux * vy - uy * vx,
              l = Math.hypot(nx, ny, nz) || 1;
            for (let j = 0; j < 3; j++) {
              flat.set(
                positions.subarray(ids[i + j] * 3, ids[i + j] * 3 + 3),
                (i + j) * 3,
              );
              normals.set([nx / l, ny / l, nz / l], (i + j) * 3);
            }
          }
          positions = flat;
          ids = Float32Array.from({ length: ids.length }, (_, i) => i);
        }
        const attribute = (name: string, type: string) => {
          if (p.attributes[name] === undefined) return undefined;
          const data = accessor(p.attributes[name], type),
            size = components[type];
          if (!remap) return data;
          const expanded = new Float32Array(remap.length * size);
          for (let i = 0; i < remap.length; i++)
            expanded.set(
              data.subarray(remap[i] * size, remap[i] * size + size),
              i * size,
            );
          return expanded;
        };
        const g = new Geometry3D(
          positions,
          normals,
          ids,
          attribute("TEXCOORD_0", "VEC2"),
        );
        geometries.push(g);
        if (p.attributes.COLOR_0 !== undefined)
          warnings.push("Vertex colors are not currently applied");
        return {
          geometry: g,
          material:
            p.material === undefined
              ? new Material3D()
              : index(materials, p.material, "material"),
          joints: attribute("JOINTS_0", "VEC4"),
          weights: attribute("WEIGHTS_0", "VEC4"),
        };
      }),
    );
    const nodes = json.nodes ?? [],
      parents = new Set<number>();
    for (const n of nodes)
      for (const child of n.children ?? []) {
        index(nodes, child, "node");
        if (parents.has(child))
          throw new Error("glTF node has multiple parents");
        parents.add(child);
      }
    const visit = (i: number, path: Set<number>) => {
      if (path.has(i)) throw new Error("glTF node cycle");
      const next = new Set(path);
      next.add(i);
      for (const child of index(nodes, i, "node").children ?? [])
        visit(child, next);
    };
    for (let i = 0; i < nodes.length; i++) visit(i, new Set());
    const skins = (json.skins ?? []).map((s) => ({
      joints: s.joints.map((i) => {
        index(nodes, i, "joint");
        return i;
      }),
      bind:
        s.inverseBindMatrices === undefined
          ? null
          : accessor(s.inverseBindMatrices, "MAT4"),
    }));
    const animations = (json.animations ?? []).map((a, i) => ({
      name: a.name ?? `animation.${i}`,
      channels: a.channels.map((c) => {
        index(nodes, c.target.node, "animation target");
        if (c.target.path === "weights")
          throw new Error("Morph animation is not supported");
        if (nodes[c.target.node].matrix)
          throw new Error("Animated nodes must use TRS transforms");
        const s = index(a.samplers, c.sampler, "animation sampler"),
          interpolation = s.interpolation ?? "LINEAR";
        if (!["LINEAR", "STEP", "CUBICSPLINE"].includes(interpolation))
          throw new Error("Unsupported animation interpolation");
        return {
          target: c.target.node,
          path: c.target.path,
          times: accessor(s.input, "SCALAR"),
          values: accessor(
            s.output,
            c.target.path === "rotation" ? "VEC4" : "VEC3",
          ),
          interpolation,
        };
      }),
    }));
    let disposed = false;
    return {
      bytes: consumed,
      warnings,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const g of geometries) g.dispose();
        for (const t of textures) t.dispose();
      },
      instantiate() {
        if (disposed) throw new Error("glTF asset is disposed");
        const instance = new GltfInstance(),
          live = nodes.map((n) => {
            const node = new Transform3D();
            node.name = n.name ?? "";
            if (n.matrix) {
              if (n.translation || n.rotation || n.scale)
                throw new Error("glTF matrix and TRS are mutually exclusive");
              node.matrix = new Float32Array(finite(n.matrix, 16, "matrix"));
            }
            if (n.translation) {
              const v = finite(n.translation, 3, "translation");
              node.position.set(v[0], v[1], v[2]);
            }
            if (n.scale) {
              const v = finite(n.scale, 3, "scale");
              node.scale.set(v[0], v[1], v[2]);
            }
            if (n.rotation)
              node.quaternion = normalizeQuaternion(
                finite(n.rotation, 4, "rotation"),
              );
            return node;
          });
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i],
            node = live[i];
          for (const c of n.children ?? []) node.add(live[c]);
          if (n.mesh !== undefined)
            for (const p of index(meshes, n.mesh, "mesh")) {
              const mesh = node.add(new Mesh3D(p.geometry, p.material));
              if (n.skin !== undefined) {
                const s = index(skins, n.skin, "skin");
                if (!p.joints || !p.weights)
                  throw new Error("Skinned mesh missing joints/weights");
                if (s.bind && s.bind.length !== s.joints.length * 16)
                  throw new Error("Invalid inverse bind count");
                instance.skins.push(
                  new Skin3D(
                    mesh,
                    s.joints.map((j) => live[j]),
                    s.joints.map((_, j) =>
                      s.bind
                        ? s.bind.slice(j * 16, j * 16 + 16)
                        : mat4Identity(),
                    ),
                    p.joints,
                    p.weights,
                  ),
                );
              }
            }
        }
        const roots = json.scenes
          ? (index(json.scenes, json.scene ?? 0, "scene").nodes ?? [])
          : nodes.map((_, i) => i).filter((i) => !parents.has(i));
        for (const i of roots) {
          if (parents.has(i)) throw new Error("glTF scene root has a parent");
          instance.add(index(live, i, "root"));
        }
        instance.clips = animations.map(
          (a) =>
            new AnimationClip3D(
              a.name,
              a.channels.map(
                (c) => ({ ...c, target: live[c.target] }) as AnimationChannel3D,
              ),
            ),
        );
        instance.updateSkins();
        return instance;
      },
    };
  } catch (error) {
    for (const t of textures) t.dispose();
    for (const g of geometries) g.dispose();
    throw error;
  }
}
