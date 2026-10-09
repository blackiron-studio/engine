import type { Texture3D } from "./texture.ts";
let nextMaterial = 1;
export type Shading3D = "standard" | "lambert" | "unlit";

export interface Material3DOptions {
  color?: number;
  map?: Texture3D | null;
  normalMap?: Texture3D | null;
  metallicRoughnessMap?: Texture3D | null;
  emissiveMap?: Texture3D | null;
  alphaMode?: "OPAQUE" | "MASK" | "BLEND";
  alphaCutoff?: number;
  roughness?: number;
  metallic?: number;
  emissive?: number;
  emissiveIntensity?: number;
  opacity?: number;
  doubleSided?: boolean;
  /** Standard uses the metallic/roughness BRDF; Lambert shades a display-space palette. */
  shading?: Shading3D;
  /** Apply environment exposure and ACES tone mapping. False preserves authored unlit colors. */
  toneMapped?: boolean;
  /** Constant palette multiplier in Lambert mode, independent of environment ambient. */
  lambertAmbient?: number;
  /** Directional and point-light multiplier in Lambert mode. */
  lambertDiffuse?: number;
  /** Legacy alias for shading: "unlit". An explicit shading option takes precedence. */
  unlit?: boolean;
}
/** Lit material; base and emissive maps are sRGB, normal and metallic/roughness maps are linear. */
export class Material3D {
  readonly id = nextMaterial++;
  color = 0xffffff;
  map: Texture3D | null = null;
  normalMap: Texture3D | null = null;
  metallicRoughnessMap: Texture3D | null = null;
  emissiveMap: Texture3D | null = null;
  alphaMode: "OPAQUE" | "MASK" | "BLEND" = "OPAQUE";
  alphaCutoff = 0.5;
  roughness = 0.65;
  metallic = 0;
  emissive = 0x000000;
  emissiveIntensity = 0;
  opacity = 1;
  doubleSided = false;
  shading: Shading3D = "standard";
  toneMapped = true;
  lambertAmbient = 0.48;
  lambertDiffuse = 0.52;

  get unlit(): boolean {
    return this.shading === "unlit";
  }
  set unlit(value: boolean) {
    if (value) this.shading = "unlit";
    else if (this.shading === "unlit") this.shading = "standard";
  }

  constructor(options: Material3DOptions = {}) {
    const { shading, unlit, ...properties } = options;
    Object.assign(this, properties);
    if (unlit !== undefined) this.unlit = unlit;
    if (shading !== undefined) this.shading = shading;
  }
}
