import type { RenderFrame3D } from "./scene.ts";
import type { Geometry3D } from "./geometry.ts";
import type { Texture3D } from "./texture.ts";
import {
  mat4Identity,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Orthographic,
} from "./math.ts";
/** Versioned retained-resource protocol consumed by Blackiron's wgpu stage, independent of the 2D vertex ABI. */
export class Native3DEncoder {
  private geometryVersions = new Map<Geometry3D, number>();
  private textureVersions = new Map<Texture3D, number>();
  encode(frame: RenderFrame3D | null): string {
    if (!frame) {
      this.geometryVersions.clear();
      this.textureVersions.clear();
      return JSON.stringify({
        version: 1,
        geometries: [],
        textures: [],
        meshes: [],
      });
    }
    const geometries: unknown[] = [],
      textures: unknown[] = [],
      usedGeometry = new Set<Geometry3D>(),
      usedTexture = new Set<Texture3D>();
    const e = frame.environment,
      sun = e.sunDirection.clone().normalize(),
      eye = frame.camera.getWorldPosition();
    if (!sun.length) sun.set(0, 1, 0);
    const extent = Math.max(1, e.shadowExtent),
      lightEye = sun
        .clone()
        .multiplyScalar(extent * 2)
        .add(e.shadowTarget),
      lightView = mat4Identity(),
      lightMatrix = mat4Identity();
    mat4Invert(lightView, mat4LookAt(mat4Identity(), lightEye, e.shadowTarget));
    mat4Multiply(
      lightMatrix,
      mat4Orthographic(mat4Identity(), extent * 2, 1, 0.1, extent * 4),
      lightView,
    );
    const rgb = (c: number, s = 1) => [
      (((c >> 16) & 255) / 255) * s,
      (((c >> 8) & 255) / 255) * s,
      ((c & 255) / 255) * s,
    ];
    const lights = [...frame.lights]
      .sort((a, b) => {
        const score = (l: typeof a) =>
          l.intensity /
          (1 +
            (l.worldMatrix[12] - eye.x) ** 2 +
            (l.worldMatrix[13] - eye.y) ** 2 +
            (l.worldMatrix[14] - eye.z) ** 2);
        return score(b) - score(a);
      })
      .slice(0, 8);
    const meshes = [];
    for (const mesh of frame.meshes) {
      const viewmodel = mesh.renderLayer === "viewmodel";
      const g = mesh.geometry,
        m = mesh.material;
      if (g.disposed || m.opacity <= 0) continue;
      const inverse = mat4Identity();
      if (!mat4Invert(inverse, mesh.worldMatrix)) continue;
      usedGeometry.add(g);
      if (this.geometryVersions.get(g) !== g.version) {
        geometries.push({
          id: g.id,
          positions: Array.from(g.positions),
          normals: Array.from(g.normals),
          uvs: Array.from(g.uvs),
          indices: Array.from(g.indices),
        });
        this.geometryVersions.set(g, g.version);
      }
      const maps = [
        m.map,
        m.normalMap,
        m.metallicRoughnessMap,
        m.emissiveMap,
      ].map((t) => {
        if (!t || t.disposed) return 0;
        usedTexture.add(t);
        if (this.textureVersions.get(t) !== t.version) {
          textures.push({
            id: t.id,
            width: t.width,
            height: t.height,
            data: Array.from(t.data),
            filter: t.filter,
            minFilter: t.minFilter,
            wrap: t.wrap,
            wrapT: t.wrapT,
          });
          this.textureVersions.set(t, t.version);
        }
        return t.id;
      });
      // Uniform vectors: viewProjection, model, normal matrix, light matrix, then 16-byte fields.
      const u = new Float32Array(160);
      u.set(frame.camera.viewProjection, 0);
      u.set(mesh.worldMatrix, 16);
      for (let col = 0; col < 4; col++)
        for (let row = 0; row < 4; row++)
          u[32 + col * 4 + row] = inverse[row * 4 + col];
      u.set(lightMatrix, 48);
      const tint = rgb(mesh.tint),
        color = rgb(m.color);
      u.set(
        color.map((v, i) => v * tint[i]),
        64,
      );
      u[67] = m.opacity;
      u.set(
        [
          m.roughness,
          m.metallic,
          m.shading === "unlit" ? 2 : m.shading === "lambert" ? 1 : 0,
          m.toneMapped ? 1 : 0,
        ],
        68,
      );
      u.set(rgb(m.emissive, m.emissiveIntensity), 72);
      u[75] = m.alphaMode === "MASK" ? m.alphaCutoff : -1;
      u.set([eye.x, eye.y, eye.z, e.exposure], 76);
      u.set(rgb(e.ambient, e.ambientIntensity), 80);
      u[83] = m.lambertAmbient;
      u.set(rgb(e.groundColor, e.ambientIntensity), 84);
      u[87] = m.lambertDiffuse;
      u.set([sun.x, sun.y, sun.z, e.shadowBias], 88);
      u.set(rgb(e.sunColor, e.sunIntensity), 92);
      u[95] = e.shadows && mesh.receiveShadow && !viewmodel ? 1 : 0;
      u.set(rgb(e.fogColor), 96);
      u[99] = e.fogDensity;
      u.set(
        maps.map((id) => (id ? 1 : 0)),
        100,
      );
      const mm = mesh.worldMatrix,
        det =
          mm[0] * (mm[5] * mm[10] - mm[9] * mm[6]) -
          mm[4] * (mm[1] * mm[10] - mm[9] * mm[2]) +
          mm[8] * (mm[1] * mm[6] - mm[5] * mm[2]);
      const blend = m.opacity < 1 || m.alphaMode === "BLEND";
      u.set(
        [lights.length, blend ? 1 : 0, m.doubleSided ? 1 : 0, det < 0 ? 1 : 0],
        104,
      );
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        u.set(
          [l.worldMatrix[12], l.worldMatrix[13], l.worldMatrix[14], l.range],
          108 + i * 4,
        );
      }
      // Point colors have a separate vector array in the packet (the uniform is extended below).
      const uniforms = new Float32Array(172);
      uniforms.set(u.subarray(0, 140));
      for (let i = 0; i < lights.length; i++)
        uniforms.set(rgb(lights[i].color, lights[i].intensity), 140 + i * 4);
      meshes.push({
        geometry: g.id,
        maps,
        uniforms: Array.from(uniforms),
        blend,
        shadow: mesh.castShadow && !blend && !viewmodel,
        viewmodel,
        depth: Math.hypot(mm[12] - eye.x, mm[13] - eye.y, mm[14] - eye.z),
      });
    }
    for (const g of this.geometryVersions.keys())
      if (!usedGeometry.has(g)) this.geometryVersions.delete(g);
    for (const t of this.textureVersions.keys())
      if (!usedTexture.has(t)) this.textureVersions.delete(t);
    meshes.sort(
      (a, b) =>
        Number(a.viewmodel) - Number(b.viewmodel) || Number(a.blend) - Number(b.blend) || (a.blend ? b.depth - a.depth : 0),
    );
    return JSON.stringify({
      version: 1,
      geometries,
      textures,
      meshes,
      shadows: e.shadows,
      shadowSize: Math.min(4096, Math.max(128, Math.round(e.shadowMapSize))),
    });
  }
}
