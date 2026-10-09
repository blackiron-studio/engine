import { Texture3D } from "./texture.ts";
import { Geometry3D } from "./geometry.ts";
import { Material3D } from "./material.ts";
import {
  type Mat4,
  Vec3,
  mat4Identity,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Orthographic,
  mat4Point,
} from "./math.ts";
import {
  Mesh3D,
  type RenderFrame3D,
  type RenderStats3D,
  frustumPlanes,
  sphereInFrustum,
} from "./scene.ts";
import {
  DEPTH3D_FRAG,
  DEPTH3D_VERT,
  MESH3D_FRAG,
  MESH3D_VERT,
} from "./shaders.ts";
/** Four matrix columns plus RGB tint, all per instance. */
const INSTANCE_FLOATS = 19;
const INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}
interface GeometryGpu {
  vao: WebGLVertexArrayObject;
  position: WebGLBuffer;
  normal: WebGLBuffer;
  indices: WebGLBuffer;
  uv: WebGLBuffer;
  version: number;
  lastFrame: number;
}
interface Group {
  geometry: Geometry3D;
  material: Material3D;
  meshes: Mesh3D[];
  receiveShadow: boolean;
  mirrored: boolean;
  depth: number;
}
/** Internal WebGL stage. Writes directly into Kiln's existing scene target before its 2D HUD. */
export class WebGL3DStage {
  private readonly mesh: Program;
  private readonly depth: Program;
  private readonly instanceBuffer: WebGLBuffer;
  private instanceCapacity = 0;
  private instanceData = new Float32Array(0);
  private readonly geometries = new Map<Geometry3D, GeometryGpu>();
  private readonly textures = new Map<Texture3D, { handle: WebGLTexture; version: number; lastFrame: number }>();
  private depthBuffer: WebGLRenderbuffer | null = null;
  private colorBuffer: WebGLRenderbuffer | null = null;
  private sceneFramebuffer: WebGLFramebuffer | null = null;
  private depthWidth = 0;
  private depthHeight = 0;
  private shadowTexture: WebGLTexture | null = null;
  private shadowFramebuffer: WebGLFramebuffer | null = null;
  private shadowSize = 0;
  private frame = 0;
  private readonly lightMatrix = mat4Identity();
  constructor(private readonly gl: WebGL2RenderingContext) {
    this.mesh = this.program(MESH3D_VERT, MESH3D_FRAG, [
      "uViewProjection",
      "uLightMatrix",
      "uColor", "uMap", "uNormalMap", "uMetallicRoughnessMap", "uEmissiveMap", "uMaps", "uAlphaCutoff", "uBlendAlpha",
      "uRoughness",
      "uMetallic",
      "uEmissive",
      "uOpacity",
      "uShading",
      "uToneMapped",
      "uLambertAmbient",
      "uLambertDiffuse",
      "uEye",
      "uAmbient",
      "uGround",
      "uSunDirection",
      "uSunColor",
      "uFogColor",
      "uFogDensity",
      "uExposure",
      "uPointCount",
      "uPointPositionRange[0]",
      "uPointColor[0]",
      "uShadow",
      "uShadowEnabled",
      "uShadowTexel",
      "uShadowBias",
      "uReceiveShadow",
    ]);
    this.depth = this.program(DEPTH3D_VERT, DEPTH3D_FRAG, ["uViewProjection", "uMap", "uHasMap", "uAlphaCutoff", "uOpacity"]);
    this.instanceBuffer = gl.createBuffer()!;
  }
  private program(vs: string, fs: string, names: string[]): Program {
    const gl = this.gl,
      program = gl.createProgram()!;
    const shaders: WebGLShader[] = [];
    try {
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, vs],
        [gl.FRAGMENT_SHADER, fs],
      ] as const) {
        const shader = gl.createShader(kind)!;
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(`Kiln3D shader: ${gl.getShaderInfoLog(shader)}`);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(`Kiln3D link: ${gl.getProgramInfoLog(program)}`);
    } catch (e) {
      gl.deleteProgram(program);
      throw e;
    } finally {
      for (const s of shaders) gl.deleteShader(s);
    }
    return {
      program,
      uniforms: Object.fromEntries(
        names.map((name) => [name, gl.getUniformLocation(program, name)]),
      ),
    };
  }
  private geometry(geometry: Geometry3D): GeometryGpu {
    let cached = this.geometries.get(geometry);
    if (cached) {
      if (cached.version !== geometry.version) {
        const gl = this.gl;
        for (const [buffer, data] of [[cached.position, geometry.positions], [cached.normal, geometry.normals], [cached.uv, geometry.uvs]] as const) {
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        }
        cached.version = geometry.version;
      }
      cached.lastFrame = this.frame;
      return cached;
    }
    const gl = this.gl,
      vao = gl.createVertexArray()!,
      position = gl.createBuffer()!,
      normal = gl.createBuffer()!,
      indices = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normal);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(2 + i);
      gl.vertexAttribPointer(
        2 + i,
        4,
        gl.FLOAT,
        false,
        INSTANCE_STRIDE,
        i * 16,
      );
      gl.vertexAttribDivisor(2 + i, 1);
    }
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 3, gl.FLOAT, false, INSTANCE_STRIDE, 64);
    gl.vertexAttribDivisor(6, 1);
    const uv = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uv);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 2, gl.FLOAT, false, 0, 0);
    cached = { vao, position, normal, indices, uv, version: geometry.version, lastFrame: this.frame };
    this.geometries.set(geometry, cached);
    return cached;
  }
  private releaseGeometry(g: GeometryGpu): void {
    const gl = this.gl;
    gl.deleteVertexArray(g.vao);
    gl.deleteBuffer(g.position);
    gl.deleteBuffer(g.normal);
    gl.deleteBuffer(g.indices);
    gl.deleteBuffer(g.uv);
  }
  private targetDepth(width: number, height: number): void {
    const gl = this.gl;
    if (
      width !== this.depthWidth ||
      height !== this.depthHeight ||
      !this.depthBuffer
    ) {
      gl.deleteRenderbuffer(this.depthBuffer);
      gl.deleteRenderbuffer(this.colorBuffer);
      gl.deleteFramebuffer(this.sceneFramebuffer);
      this.depthBuffer = gl.createRenderbuffer();
      this.colorBuffer = gl.createRenderbuffer();
      this.sceneFramebuffer = gl.createFramebuffer();
      this.depthWidth = width;
      this.depthHeight = height;
      const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        samples,
        gl.DEPTH_COMPONENT24,
        width,
        height,
      );
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorBuffer);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        samples,
        gl.RGBA8,
        width,
        height,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        this.depthBuffer,
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.RENDERBUFFER,
        this.colorBuffer,
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Kiln3D multisample framebuffer incomplete");
  }
  private shadowTarget(requested: number): void {
    const gl = this.gl,
      max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      size = Math.max(128, Math.min(max, 4096, Math.round(requested)));
    if (this.shadowSize === size) return;
    if (this.shadowTexture) gl.deleteTexture(this.shadowTexture);
    if (this.shadowFramebuffer) gl.deleteFramebuffer(this.shadowFramebuffer);
    this.shadowSize = size;
    this.shadowTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.bindSampler(6, null);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.DEPTH_COMPONENT24,
      size,
      size,
      0,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      this.shadowTexture,
      0,
    );
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Kiln3D shadow framebuffer incomplete");
  }
  private groups(
    meshes: readonly Mesh3D[],
    planes: Float32Array | null,
    shadow: boolean,
    eye: Readonly<Vec3>,
    stats: RenderStats3D,
  ): Group[] {
    const map = new Map<string, Group>(),
      transparent: Group[] = [];
    const center = new Vec3();
    for (const mesh of meshes) {
      if (
        mesh.geometry.disposed ||
        mesh.material.opacity <= 0 ||
        (shadow && (mesh.renderLayer === "viewmodel" || !mesh.castShadow || mesh.material.alphaMode === "BLEND" || mesh.material.opacity < 1))
      )
        continue;
      const m = mesh.worldMatrix;
      const determinant =
        m[0] * (m[5] * m[10] - m[9] * m[6]) -
        m[4] * (m[1] * m[10] - m[9] * m[2]) +
        m[8] * (m[1] * m[6] - m[5] * m[2]);
      if (Math.abs(determinant) < 1e-10) continue;
      mat4Point(m, mesh.geometry.center, center);
      // Frobenius norm remains conservative for nonuniform scales and hierarchical shear.
      const radius =
        mesh.geometry.radius *
        Math.hypot(m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]);
      if (
        planes &&
        mesh.frustumCulled &&
        !sphereInFrustum(planes, center, radius)
      ) {
        if (!shadow) stats.culled++;
        continue;
      }
      const mirrored = determinant < 0,
        key = `${mesh.geometry.id}:${mesh.material.id}:${mesh.receiveShadow}:${mirrored}:${mesh.material.doubleSided}`;
      if (!shadow) {
        stats.meshes++;
        stats.triangles += mesh.geometry.indices.length / 3;
      }
      if (!shadow && (mesh.material.opacity < 1 || mesh.material.alphaMode === "BLEND")) {
        transparent.push({
          geometry: mesh.geometry,
          material: mesh.material,
          meshes: [mesh],
          receiveShadow: mesh.receiveShadow,
          mirrored,
          depth: center.distanceTo(eye),
        });
        continue;
      }
      let group = map.get(key);
      if (!group) {
        group = {
          geometry: mesh.geometry,
          material: mesh.material,
          meshes: [],
          receiveShadow: mesh.receiveShadow,
          mirrored,
          depth: 0,
        };
        map.set(key, group);
      }
      group.meshes.push(mesh);
    }
    transparent.sort((a, b) => b.depth - a.depth);
    return [...map.values(), ...transparent];
  }
  private draw(group: Group): void {
    const gl = this.gl,
      count = group.meshes.length;
    if (this.instanceCapacity < count) {
      this.instanceCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
      this.instanceData = new Float32Array(
        this.instanceCapacity * INSTANCE_FLOATS,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.instanceData.byteLength,
        gl.DYNAMIC_DRAW,
      );
    }
    for (let i = 0; i < count; i++) {
      const mesh = group.meshes[i],
        offset = i * INSTANCE_FLOATS;
      this.instanceData.set(mesh.worldMatrix, offset);
      this.instanceData[offset + 16] = ((mesh.tint >> 16) & 255) / 255;
      this.instanceData[offset + 17] = ((mesh.tint >> 8) & 255) / 255;
      this.instanceData[offset + 18] = (mesh.tint & 255) / 255;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceData,
      0,
      count * INSTANCE_FLOATS,
    );
    gl.bindVertexArray(this.geometry(group.geometry).vao);
    gl.frontFace(group.mirrored ? gl.CW : gl.CCW);
    if (group.material.doubleSided) gl.disable(gl.CULL_FACE);
    else gl.enable(gl.CULL_FACE);
    gl.drawElementsInstanced(
      gl.TRIANGLES,
      group.geometry.indices.length,
      gl.UNSIGNED_INT,
      0,
      count,
    );
  }
  render(
    frame: RenderFrame3D,
    fbo: WebGLFramebuffer,
    width: number,
    height: number,
    clearColor = 0,
  ): RenderStats3D {
    const gl = this.gl,
      environment = frame.environment,
      camera = frame.camera,
      stats: RenderStats3D = {
        meshes: 0,
        culled: 0,
        triangles: 0,
        drawCalls: 0,
        shadowDrawCalls: 0,
      };
    this.frame++;
    this.collectGarbage();
    for (const [geometry, cached] of this.geometries)
      if (geometry.disposed || this.frame - cached.lastFrame > 120) {
        this.releaseGeometry(cached);
        this.geometries.delete(geometry);
      }
    const eye = camera.getWorldPosition(),
      sun = environment.sunDirection.clone().normalize();
    if (sun.length === 0) sun.set(0, 1, 0);
    const extent = Math.max(1, environment.shadowExtent),
      lightEye = sun
        .clone()
        .multiplyScalar(extent * 2)
        .add(environment.shadowTarget),
      lightWorld = mat4LookAt(
        mat4Identity(),
        lightEye,
        environment.shadowTarget,
      ),
      lightView = mat4Identity(),
      lightProjection = mat4Orthographic(
        mat4Identity(),
        extent * 2,
        1,
        0.1,
        extent * 4,
      );
    mat4Invert(lightView, lightWorld);
    mat4Multiply(this.lightMatrix, lightProjection, lightView);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.cullFace(gl.BACK);
    this.shadowTarget(environment.shadows ? environment.shadowMapSize : 128);
    if (environment.shadows) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFramebuffer);
      gl.viewport(0, 0, this.shadowSize, this.shadowSize);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.depth.program);
      gl.uniformMatrix4fv(
        this.depth.uniforms.uViewProjection,
        false,
        this.lightMatrix,
      );
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 2);
      for (const group of this.groups(
        frame.meshes,
        frustumPlanes(this.lightMatrix),
        true,
        eye,
        stats,
      )) {
        const m = group.material, u = this.depth.uniforms;
        this.bindTexture(m.map, 0);
        gl.uniform1i(u.uMap, 0); gl.uniform1f(u.uHasMap, m.map && !m.map.disposed ? 1 : 0);
        gl.uniform1f(u.uAlphaCutoff, m.alphaMode === "MASK" ? m.alphaCutoff : -1);
        gl.uniform1f(u.uOpacity, m.opacity);
        this.draw(group);
        stats.shadowDrawCalls++;
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    this.targetDepth(width, height);
    gl.viewport(0, 0, width, height);
    gl.clearDepth(1);
    gl.clearColor(
      ((clearColor >> 16) & 255) / 255,
      ((clearColor >> 8) & 255) / 255,
      (clearColor & 255) / 255,
      1,
    );
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.mesh.program);
    const u = this.mesh.uniforms;
    const color = (
      loc: WebGLUniformLocation | null,
      value: number,
      intensity = 1,
    ) =>
      gl.uniform3f(
        loc,
        (((value >> 16) & 255) / 255) * intensity,
        (((value >> 8) & 255) / 255) * intensity,
        ((value & 255) / 255) * intensity,
      );
    gl.uniformMatrix4fv(u.uViewProjection, false, camera.viewProjection);
    gl.uniformMatrix4fv(u.uLightMatrix, false, this.lightMatrix);
    gl.uniform3f(u.uEye, eye.x, eye.y, eye.z);
    color(
      u.uAmbient,
      environment.ambient,
      Math.max(0, environment.ambientIntensity),
    );
    color(
      u.uGround,
      environment.groundColor,
      Math.max(0, environment.ambientIntensity),
    );
    color(
      u.uSunColor,
      environment.sunColor,
      Math.max(0, environment.sunIntensity),
    );
    gl.uniform3f(u.uSunDirection, sun.x, sun.y, sun.z);
    color(u.uFogColor, environment.fogColor);
    gl.uniform1f(u.uFogDensity, Math.max(0, environment.fogDensity));
    gl.uniform1f(u.uExposure, Math.max(0.01, environment.exposure));
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.bindSampler(6, null);
    gl.uniform1i(u.uShadow, 6);
    gl.uniform1f(u.uShadowEnabled, environment.shadows ? 1 : 0);
    gl.uniform1f(u.uShadowTexel, 1 / this.shadowSize);
    gl.uniform1f(u.uShadowBias, Math.max(0, environment.shadowBias));
    const lights = [...frame.lights]
        .sort((a, b) => lightScore(b, eye) - lightScore(a, eye))
        .slice(0, 8),
      pointPosition = new Float32Array(32),
      pointColor = new Float32Array(24);
    let li = 0;
    for (const light of lights) {
      const m = light.worldMatrix;
      pointPosition.set([m[12], m[13], m[14], light.range], li * 4);
      pointColor.set(
        [
          (((light.color >> 16) & 255) / 255) * light.intensity,
          (((light.color >> 8) & 255) / 255) * light.intensity,
          ((light.color & 255) / 255) * light.intensity,
        ],
        li * 3,
      );
      li++;
    }
    gl.uniform1i(u.uPointCount, li);
    gl.uniform4fv(u["uPointPositionRange[0]"], pointPosition);
    gl.uniform3fv(u["uPointColor[0]"], pointColor);
    const layers = [
      frame.meshes.filter(m => m.renderLayer !== "viewmodel"),
      frame.meshes.filter(m => m.renderLayer === "viewmodel"),
    ];
    for (let layer = 0; layer < layers.length; layer++) {
      // Reserve the nearest depth band for viewmodels. This preserves their own
      // occlusion without clearing a multisampled depth target mid-pass (costly on tile GPUs).
      gl.depthRange(layer === 0 ? 0.02 : 0, layer === 0 ? 1 : 0.02);
      for (const group of this.groups(
        layers[layer],
        frustumPlanes(camera.viewProjection),
        false,
        eye,
        stats,
      )) {
        const material = group.material;
        const maps = [material.map, material.normalMap, material.metallicRoughnessMap, material.emissiveMap];
        maps.forEach((map, slot) => this.bindTexture(map, slot));
        ["uMap", "uNormalMap", "uMetallicRoughnessMap", "uEmissiveMap"].forEach((name, slot) => gl.uniform1i(u[name], slot));
        gl.uniform4fv(u.uMaps, maps.map(map => map && !map.disposed ? 1 : 0));
        gl.uniform1f(u.uAlphaCutoff, material.alphaMode === "MASK" ? material.alphaCutoff : -1);
        gl.uniform1f(u.uBlendAlpha, material.alphaMode === "BLEND" || material.opacity < 1 ? 1 : 0);
        color(u.uColor, material.color);
        gl.uniform1f(
          u.uRoughness,
          Math.max(0.04, Math.min(1, material.roughness)),
        );
        gl.uniform1f(u.uMetallic, Math.max(0, Math.min(1, material.metallic)));
        color(
          u.uEmissive,
          material.emissive,
          Math.max(0, material.emissiveIntensity),
        );
        gl.uniform1f(u.uOpacity, Math.max(0, Math.min(1, material.opacity)));
        gl.uniform1i(
          u.uShading,
          material.shading === "unlit"
            ? 2
            : material.shading === "lambert"
              ? 1
              : 0,
        );
        gl.uniform1f(u.uToneMapped, material.toneMapped ? 1 : 0);
        gl.uniform1f(u.uLambertAmbient, Math.max(0, material.lambertAmbient));
        gl.uniform1f(u.uLambertDiffuse, Math.max(0, material.lambertDiffuse));
        gl.uniform1f(u.uReceiveShadow, group.receiveShadow ? 1 : 0);
        if (material.opacity < 1 || material.alphaMode === "BLEND") {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        }
        this.draw(group);
        stats.drawCalls++;
      }
    }
    gl.depthRange(0, 1);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.blitFramebuffer(
      0,
      0,
      width,
      height,
      0,
      0,
      width,
      height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    return stats;
  }
  private bindTexture(texture: Texture3D | null, slot: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + slot); gl.bindSampler(slot, null);
    if (!texture || texture.disposed) { gl.bindTexture(gl.TEXTURE_2D, null); return; }
    let gpu = this.textures.get(texture);
    if (!gpu) { gpu = { handle: gl.createTexture()!, version: 0, lastFrame: this.frame }; this.textures.set(texture, gpu); }
    gl.bindTexture(gl.TEXTURE_2D, gpu.handle);
    if (gpu.version !== texture.version) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, texture.width, texture.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, texture.data);
      const filter = texture.filter === "nearest" ? gl.NEAREST : gl.LINEAR;
      const minFilters: Record<Texture3D["minFilter"], number> = {
        nearest: gl.NEAREST, linear: gl.LINEAR,
        "nearest-mipmap-nearest": gl.NEAREST_MIPMAP_NEAREST,
        "linear-mipmap-nearest": gl.LINEAR_MIPMAP_NEAREST,
        "nearest-mipmap-linear": gl.NEAREST_MIPMAP_LINEAR,
        "linear-mipmap-linear": gl.LINEAR_MIPMAP_LINEAR,
      };
      const wrap = (mode: Texture3D["wrap"]) => mode === "clamp" ? gl.CLAMP_TO_EDGE : mode === "mirror" ? gl.MIRRORED_REPEAT : gl.REPEAT;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilters[texture.minFilter]); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(texture.wrap)); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(texture.wrapT));
      if (texture.minFilter.includes("mipmap")) gl.generateMipmap(gl.TEXTURE_2D);
      gpu.version = texture.version;
    }
    gpu.lastFrame = this.frame;
  }
  collectGarbage(): void {
    for (const [texture, gpu] of this.textures) if (texture.disposed || this.frame - gpu.lastFrame > 120) {
      this.gl.deleteTexture(gpu.handle); this.textures.delete(texture);
    }
    for (const [geometry, gpu] of this.geometries) if (geometry.disposed || this.frame - gpu.lastFrame > 120) {
      this.releaseGeometry(gpu); this.geometries.delete(geometry);
    }
  }
  get resources() {
    let geometryBytes = 0, textureBytes = 0;
    for (const g of this.geometries.keys()) geometryBytes += g.positions.byteLength + g.normals.byteLength + g.indices.byteLength + g.uvs.byteLength;
    for (const t of this.textures.keys()) {
      let width = t.width, height = t.height;
      while (true) {
        textureBytes += width * height * 4;
        if (!t.minFilter.includes("mipmap") || (width === 1 && height === 1)) break;
        width = Math.max(1, width >> 1); height = Math.max(1, height >> 1);
      }
    }
    return { geometries: this.geometries.size, textures: this.textures.size, geometryBytes, textureBytes,
      instanceBytes: this.instanceData.byteLength, targetBytes: this.depthWidth * this.depthHeight * 8 * Math.min(4, this.gl.getParameter(this.gl.MAX_SAMPLES)) + this.shadowSize ** 2 * 4 };
  }
  destroy(): void {
    const gl = this.gl;
    for (const cached of this.geometries.values()) this.releaseGeometry(cached);
    this.geometries.clear();
    for (const gpu of this.textures.values()) gl.deleteTexture(gpu.handle);
    this.textures.clear();
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteProgram(this.mesh.program);
    gl.deleteProgram(this.depth.program);
    gl.deleteRenderbuffer(this.depthBuffer);
    gl.deleteRenderbuffer(this.colorBuffer);
    gl.deleteFramebuffer(this.sceneFramebuffer);
    gl.deleteTexture(this.shadowTexture);
    gl.deleteFramebuffer(this.shadowFramebuffer);
  }
}
function lightScore(
  light: RenderFrame3D["lights"][number],
  eye: Readonly<Vec3>,
): number {
  const m = light.worldMatrix;
  return (
    light.intensity /
    (1 + (m[12] - eye.x) ** 2 + (m[13] - eye.y) ** 2 + (m[14] - eye.z) ** 2)
  );
}
