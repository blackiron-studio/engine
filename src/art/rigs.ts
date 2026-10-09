// Rig manifests: a template (which bones, in what order) plus the sprites for its parts.
// Templates ship here; `defineRig` loads a parts sheet cut by `blackiron art parts` and registers
// the manifest so a scene can build a `Rig2D` from its name.

import { type ImageItem, type ImageSpriteSpec, registerAssetLoader } from "./images.ts";
import type { SpriteSetManifest } from "./spritesets.ts";

export interface BoneDef {
  name: string;
  parent: string | null;
  /** Pivot offset from the parent's pivot, in rig units (pixels at the template's height). */
  x: number;
  y: number;
  /** Where the part's own pivot sits on it, as a fraction of its size. */
  anchor: [number, number];
  /** Draw order, back to front. */
  order: number;
}

export interface RigTemplate {
  name: string;
  /** Height of the rest pose in rig units; parts scale by height / this. */
  height: number;
  bones: BoneDef[];
  /** Bones a clip on the "upper" layer poses. */
  upper: string[];
}

export interface RigManifest {
  /** Name the parts sheet registered under, when loaded from a manifest. */
  name?: string;
  template: string | RigTemplate;
  /** Bone name to sprite name; bones without a part are joints. */
  parts: Record<string, string>;
  /** Height of this character in pixels; scales the template's default pivots and pose offsets. */
  height?: number;
  /** Scale applied to the part sprites, 1 when the parts were cut at game scale. */
  scale?: number;
  /** Pivot overrides per bone, in rig units. */
  pivots?: Record<string, [number, number]>;
  /** Anchor overrides per bone. */
  anchors?: Record<string, [number, number]>;
}

// ---------------------------------------------------------------- templates

const bone = (name: string, parent: string | null, x: number, y: number, anchor: [number, number], order: number): BoneDef => ({ name, parent, x, y, anchor, order });

/** A standing figure 64 units tall, feet at the origin, facing right. */
export const HUMANOID: RigTemplate = {
  name: "humanoid",
  height: 64,
  bones: [
    bone("hips", null, 0, -24, [0.5, 0.5], 0),
    bone("torso", "hips", 0, 0, [0.5, 1], 3),
    bone("head", "torso", 0, -22, [0.5, 1], 5),
    bone("arm.far", "torso", -6, -20, [0.5, 0.1], 1),
    bone("arm.near", "torso", 6, -20, [0.5, 0.1], 6),
    bone("shield", "arm.far", 0, 14, [0.5, 0.5], 2),
    bone("weapon", "arm.near", 0, 16, [0.5, 0.85], 7),
    bone("leg.far", "hips", -4, 0, [0.5, 0.05], 1),
    bone("leg.near", "hips", 4, 0, [0.5, 0.05], 4),
  ],
  upper: ["torso", "head", "arm.far", "arm.near", "shield", "weapon"],
};

/** Four legs and a head forward, 40 units tall. */
export const QUADRUPED: RigTemplate = {
  name: "quadruped",
  height: 40,
  bones: [
    bone("body", null, 0, -20, [0.5, 0.5], 3),
    bone("head", "body", 16, -6, [0.2, 0.7], 5),
    bone("tail", "body", -18, -4, [0.9, 0.5], 1),
    bone("leg.frontFar", "body", 10, 6, [0.5, 0.05], 2),
    bone("leg.backFar", "body", -10, 6, [0.5, 0.05], 2),
    bone("leg.frontNear", "body", 12, 6, [0.5, 0.05], 4),
    bone("leg.backNear", "body", -8, 6, [0.5, 0.05], 4),
  ],
  upper: ["head", "tail"],
};

/** A body with two wings, 32 units tall, hovering. */
export const FLYER: RigTemplate = {
  name: "flyer",
  height: 32,
  bones: [
    bone("body", null, 0, -16, [0.5, 0.5], 2),
    bone("wing.far", "body", -4, -4, [0.9, 0.9], 1),
    bone("wing.near", "body", 4, -4, [0.1, 0.9], 3),
    bone("head", "body", 8, -4, [0.3, 0.8], 4),
  ],
  upper: ["head"],
};

/** One squashy body, 24 units tall. */
export const BLOB: RigTemplate = {
  name: "blob",
  height: 24,
  bones: [bone("body", null, 0, 0, [0.5, 1], 1), bone("face", "body", 0, -14, [0.5, 0.5], 2)],
  upper: ["face"],
};

export const TEMPLATES: Record<string, RigTemplate> = { humanoid: HUMANOID, quadruped: QUADRUPED, flyer: FLYER, blob: BLOB };


/** Rig details a parts sheet carries in `meta.rig`. */
export interface RigMeta {
  template: string;
  height?: number;
  pivots?: Record<string, [number, number]>;
  anchors?: Record<string, [number, number]>;
}

const rigs = new Map<string, RigManifest>();

export function defineRigManifest(name: string, manifest: RigManifest): RigManifest {
  const m = { ...manifest, name };
  rigs.set(name, m);
  return m;
}

export const getRigManifest = (name: string): RigManifest | undefined => rigs.get(name);

export function resetRigs(): void {
  rigs.clear();
}

/**
 * Register a parts sheet as a rig. Parts become sprites `${prefix}.${part}`; the manifest's
 * `meta.rig` names the template, the character height and the pivots the cut worked out.
 */
export function defineRig(prefix: string, jsonUrl: string, spec: ImageSpriteSpec = {}): void {
  registerAssetLoader(async (platform) => {
    const json = await platform.loadJson<SpriteSetManifest & { meta: { rig?: RigMeta } }>(jsonUrl);
    const base = jsonUrl.slice(0, jsonUrl.lastIndexOf("/") + 1);
    const imageUrl = json.meta.image.startsWith("http") || json.meta.image.startsWith("/") ? json.meta.image : base + json.meta.image;
    const img = await platform.loadImage(imageUrl);
    const parts: Record<string, string> = {};
    const items: ImageItem[] = json.frames.map((f, i) => {
      const part = (f.filename ?? String(i)).replace(/\.(png|jpe?g|gif|webp|ase|aseprite)$/i, "");
      const name = `${prefix}.${part}`;
      parts[part] = name;
      const data = new Uint8ClampedArray(f.frame.w * f.frame.h * 4);
      for (let row = 0; row < f.frame.h; row++) {
        const src = ((f.frame.y + row) * img.width + f.frame.x) * 4;
        data.set(img.data.subarray(src, src + f.frame.w * 4), row * f.frame.w * 4);
      }
      return { name, w: f.frame.w, h: f.frame.h, data, origin: [0.5, 0.5], style: spec.style, normal: spec.normal === "bevel" ? "bevel" : undefined };
    });
    const meta = json.meta.rig ?? { template: "humanoid" };
    defineRigManifest(prefix, { template: meta.template, parts, height: meta.height, pivots: meta.pivots, anchors: meta.anchors });
    return items;
  });
}
