import { GpuProfiler } from "./gpu-profiler.ts";
// WebGL2 backend: one sprite batch over three textures (atlas nearest, atlas linear,
// glyphs), a scene target at native or scaled resolution, a light target multiplied in,
// an untouched overlay target for UI, a two-level bloom chain, LUT grading, grain and
// scanlines, all composed in one final pass.

import { WebGL3DStage } from "../three/webgl.ts";
import type { RenderFrame3D, RenderStats3D } from "../three/scene.ts";
import type { Atlas } from "../art/atlas.ts";
import type { Rect } from "../core/math.ts";
import { FLOATS_PER_VERT, type Kernel, type ProjectionMatrix, STAT } from "../kernel/protocol.ts";
import { StreamWriter } from "../kernel/stream.ts";
import { CMD, TsKernel } from "../kernel/ts.ts";
import { GlyphCache } from "./glyphs.ts";
import { resolveLut } from "./lut.ts";
import { BLUR_FRAG, BRIGHT_FRAG, COMPOSITE_FRAG, COPY_FRAG, QUAD_VERT, SPRITE_FRAG, SPRITE_VERT } from "./shaders.ts";
import {
  type FontSpec,
  type LightDraw,
  type Mat,
  type Pass,
  type PostSettings,
  type Renderer,
  type RendererFeatures,
  type RendererOptions,
  type RenderStats,
  type SpriteDraw,
  type TextDraw,
  type TextSize,
} from "./types.ts";

const FLOATS_PER_QUAD = FLOATS_PER_VERT * 4;

interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export class WebGL2Renderer implements Renderer {
  readonly kind = "webgl2" as const;
  readonly stats: RenderStats = { drawCalls: 0, sprites: 0, frameMs: 0, targetWidth: 0, targetHeight: 0 };
  readonly features: RendererFeatures = { lighting: true, lut: true, smooth: true, text: true, normals: true, shadows: true, mesh3D: true };
  width: number;
  height: number;

  readonly stats3D: RenderStats3D = { meshes: 0, culled: 0, triangles: 0, drawCalls: 0, shadowDrawCalls: 0 };
  private gpuProfiler: GpuProfiler | null = null;
  profiling = false;
  get diagnostics() {
    const mesh = this.stage3D?.resources ?? { geometries: 0, textures: 0, geometryBytes: 0, textureBytes: 0, instanceBytes: 0, targetBytes: 0 };
    const targets = [this.scene, this.overlay, this.light, this.scratch, this.bloomA, this.bloomB, this.bloomC, this.bloomD];
    const targetBytes = targets.reduce((sum, t) => sum + (t ? t.w * t.h * 4 : 0), 0);
    const atlasBytes = this.atlas ? this.atlas.width * this.atlas.height * 4 * (this.hasNormals ? 2 : 1) : 0;
    return { gpu: this.gpuProfiler?.report ?? { supported: false, samples: 0, pending: 0, medianMs: null, p95Ms: null }, mesh,
      estimatedGpuBytes: mesh.geometryBytes + mesh.textureBytes + mesh.instanceBytes + mesh.targetBytes + targetBytes + atlasBytes + this.glyphLayers * 1024 * 1024 * 4,
      stats: { ...this.stats }, stats3D: { ...this.stats3D } };
  }
  collectGarbage(): void { this.stage3D?.collectGarbage(); }
  private stage3D: WebGL3DStage | null = null;
  private frame3D: RenderFrame3D | null = null;
  private gl: WebGL2RenderingContext;
  private readonly scaleMode: "native" | number;
  private backingW = 0;
  private backingH = 0;
  private fbW = 0;
  private fbH = 0;

  private spriteProg!: Program;
  private brightProg!: Program;
  private blurProg!: Program;
  private copyProg!: Program;
  private compositeProg!: Program;
  private vao!: WebGLVertexArrayObject;
  private vbo!: WebGLBuffer;
  private quadVao!: WebGLVertexArrayObject;
  private samplerNearest!: WebGLSampler;
  private samplerLinear!: WebGLSampler;
  private scene: Target | null = null;
  private overlay: Target | null = null;
  private light: Target | null = null;
  /** Light-sized target one shadowed light draws into before it is added to the light target. */
  private scratch: Target | null = null;
  /** Second attachment of the scene target: the normals of what was drawn, for lit shading. */
  private sceneNormal: WebGLTexture | null = null;
  private normalsTex: WebGLTexture | null = null;
  private blankTex: WebGLTexture | null = null;
  private hasNormals = false;
  private bloomA: Target | null = null;
  private bloomB: Target | null = null;
  private bloomC: Target | null = null;
  private bloomD: Target | null = null;
  private atlasTex: WebGLTexture | null = null;
  private atlas: Atlas | null = null;
  private glyphTex: WebGLTexture | null = null;
  private glyphLayers = 0;
  private glyphs: GlyphCache | null = null;
  private lutTex: WebGLTexture | null = null;
  private lutKey: string | Uint8Array | null = null;

  /** The kernel that expands this renderer's stream: the compiled one when it loaded, else the reference. */
  readonly kernel: Kernel;
  private readonly writer: StreamWriter;
  private lightUsed = false;
  private frameStart = 0;
  private lost = false;
  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };
  private onRestored = () => {
    this.stage3D = null;
    this.gpuProfiler = null;
    this.init();
    if (this.atlas) this.uploadAtlas(this.atlas);
    this.lost = false;
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    width: number,
    height: number,
    opts: RendererOptions = {},
    kernel?: Kernel,
  ) {
    this.width = width;
    this.height = height;
    this.kernel = kernel ?? new TsKernel();
    this.writer = new StreamWriter(this.kernel);
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.scaleMode = opts.scale ?? (opts.renderScale ? Math.max(1, Math.floor(opts.renderScale)) : "native");
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.init();
  }

  // --- Setup ------------------------------------------------------------------

  private init(): void {
    const gl = this.gl;
    this.spriteProg = this.program(SPRITE_VERT, SPRITE_FRAG, ["uViewport", "uTex", "uTexLinear", "uGlyphs", "uNormals", "uNormalBuf", "uScratch", "uTargetSize", "uHasNormals"]);
    this.brightProg = this.program(QUAD_VERT, BRIGHT_FRAG, ["uTex", "uThreshold"]);
    this.blurProg = this.program(QUAD_VERT, BLUR_FRAG, ["uTex", "uDir"]);
    this.copyProg = this.program(QUAD_VERT, COPY_FRAG, ["uTex"]);
    this.compositeProg = this.program(QUAD_VERT, COMPOSITE_FRAG, [
      "uScene", "uBloomA", "uBloomB", "uLight", "uOverlay", "uLut",
      "uBloomStrength", "uLighting", "uUseLut", "uVignette", "uTint", "uTintAmount",
      "uSaturation", "uContrast", "uBrightness", "uGrain", "uScanlines", "uScanPeriod", "uTime", "uOffset",
    ]);

    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer() as WebGLBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.kernel.maxQuads * FLOATS_PER_QUAD * 4, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 32);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 40);
    const indices = new Uint32Array(this.kernel.maxQuads * 6);
    for (let i = 0; i < this.kernel.maxQuads; i++) {
      const v = i * 4;
      const o = i * 6;
      indices[o] = v;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v;
      indices[o + 4] = v + 2;
      indices[o + 5] = v + 3;
    }
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.quadVao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(this.quadVao);
    const qbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.samplerNearest = this.sampler(gl.NEAREST);
    this.samplerLinear = this.sampler(gl.LINEAR);

    this.glyphTex = gl.createTexture();
    this.glyphLayers = 0;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.glyphTex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    // A transparent texel stands in for the normal buffer and scratch where they must not be sampled.
    this.blankTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blankTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this.normalsTex = null;
    this.hasNormals = false;
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.lutKey = null;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.atlasTex = null;
    this.fbW = 0;
    this.fbH = 0;
    this.glyphs?.markUploaded();
    if (this.glyphs) this.glyphs.version++;
  }

  private sampler(filter: number): WebGLSampler {
    const gl = this.gl;
    const s = gl.createSampler() as WebGLSampler;
    gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, filter);
    gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, filter);
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return s;
  }

  private program(vs: string, fs: string, uniforms: string[]): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type) as WebGLShader;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const prog = gl.createProgram() as WebGLProgram;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
    return { prog, u };
  }

  private colorTexture(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private target(w: number, h: number, old?: Target | null): Target {
    const gl = this.gl;
    if (old) {
      gl.deleteTexture(old.tex);
      gl.deleteFramebuffer(old.fbo);
    }
    const tex = this.colorTexture(w, h);
    const fbo = gl.createFramebuffer() as WebGLFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fbo, tex, w, h };
  }

  /** Size the offscreen targets to the current scale mode; recreate when they change. */
  private ensureTargets(): void {
    const w = this.scaleMode === "native" ? this.backingW : Math.round(this.width * this.scaleMode);
    const h = this.scaleMode === "native" ? this.backingH : Math.round(this.height * this.scaleMode);
    if (w <= 0 || h <= 0 || (w === this.fbW && h === this.fbH && this.scene)) return;
    this.fbW = w;
    this.fbH = h;
    this.scene = this.target(w, h, this.scene);
    this.overlay = this.target(w, h, this.overlay);
    const lw = Math.max(1, Math.round(w / 2));
    const lh = Math.max(1, Math.round(h / 2));
    this.light = this.target(lw, lh, this.light);
    this.scratch = this.target(lw, lh, this.scratch);
    // The scene target carries a second attachment for normals; draws select it per pass.
    const gl = this.gl;
    if (this.sceneNormal) gl.deleteTexture(this.sceneNormal);
    this.sceneNormal = this.colorTexture(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.sceneNormal, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));
    this.bloomA = this.target(qw, qh, this.bloomA);
    this.bloomB = this.target(qw, qh, this.bloomB);
    this.bloomC = this.target(Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(h / 8)), this.bloomC);
    this.bloomD = this.target(Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(h / 8)), this.bloomD);
    this.stats.targetWidth = w;
    this.stats.targetHeight = h;
    this.glyphs?.setPixelRatio(w / this.width);
  }

  // --- Renderer contract ---------------------------------------------------------

  setLogicalSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.fbW = 0;
    this.ensureTargets();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (w === this.backingW && h === this.backingH && this.scene) return;
    this.backingW = w;
    this.backingH = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ensureTargets();
  }

  uploadAtlas(atlas: Atlas): void {
    const limit = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
    if (atlas.width > limit || atlas.height > limit) throw new RangeError(`Atlas ${atlas.width}×${atlas.height} exceeds this GPU's maximum texture size ${limit}`);
    this.kernel.setWhite(atlas.whiteU, atlas.whiteV);
    // A sprite named "shadow" is what the kernel draws under nodes that ask for one.
    if (atlas.has("shadow")) {
      const sh = atlas.region("shadow");
      this.kernel.setShadow(sh.w, sh.h, sh.ox, sh.oy, sh.u0, sh.v0, sh.u1, sh.v1);
    }
    const gl = this.gl;
    this.atlas = atlas;
    if (this.atlasTex) gl.deleteTexture(this.atlasTex);
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlas.width, atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(atlas.data.buffer, atlas.data.byteOffset, atlas.data.byteLength));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.atlasTex = tex;
    if (this.normalsTex) gl.deleteTexture(this.normalsTex);
    this.normalsTex = null;
    this.hasNormals = false;
    if (atlas.normals) {
      const nt = gl.createTexture() as WebGLTexture;
      gl.bindTexture(gl.TEXTURE_2D, nt);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlas.width, atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(atlas.normals.buffer, atlas.normals.byteOffset, atlas.normals.byteLength));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.normalsTex = nt;
      this.hasNormals = true;
    }
  }

  private uploadGlyphs(): void {
    const g = this.glyphs;
    if (!g || !g.dirty) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.glyphTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const resized = this.glyphLayers !== g.pages.length;
    if (resized) {
      this.glyphLayers = g.pages.length;
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, g.size, g.size, this.glyphLayers, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    const pages = resized || g.dirtyPages.size === 0 ? g.pages.keys() : g.dirtyPages.values();
    for (const page of pages) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, page, g.size, g.size, 1, gl.RGBA, gl.UNSIGNED_BYTE, g.pages[page]);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    g.markUploaded();
    gl.activeTexture(gl.TEXTURE0);
  }

  private bindBatchTextures(): void {
    const gl = this.gl;
    gl.useProgram(this.spriteProg.prog);
    gl.uniform2f(this.spriteProg.u.uViewport, this.width, this.height);
    gl.uniform1i(this.spriteProg.u.uTex, 0);
    gl.uniform1i(this.spriteProg.u.uTexLinear, 1);
    gl.uniform1i(this.spriteProg.u.uGlyphs, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.bindSampler(0, this.samplerNearest);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.bindSampler(1, this.samplerLinear);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.glyphTex);
    gl.bindSampler(2, this.samplerLinear);
    gl.uniform1i(this.spriteProg.u.uNormals, 3);
    gl.uniform1i(this.spriteProg.u.uNormalBuf, 4);
    gl.uniform1i(this.spriteProg.u.uScratch, 5);
    gl.uniform1f(this.spriteProg.u.uHasNormals, this.hasNormals ? 1 : 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.normalsTex ?? this.blankTex);
    gl.bindSampler(3, this.samplerNearest);
    this.bindPassTextures(0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
  }

  /** The normal buffer and scratch are readable only where they are not being drawn: blank them elsewhere. */
  private bindPassTextures(target: number): void {
    const gl = this.gl;
    const normalBuf = (target === 1 || target === 3) && this.hasNormals ? this.sceneNormal : this.blankTex;
    const scratch = target === 1 ? (this.scratch?.tex ?? this.blankTex) : this.blankTex;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, normalBuf);
    gl.bindSampler(4, this.samplerLinear);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, scratch);
    gl.bindSampler(5, this.samplerLinear);
    gl.activeTexture(gl.TEXTURE0);
  }

  begin(clearColor: number): void {
    if (this.lost) return;
    this.ensureTargets();
    this.frameStart = performance.now();
    this.stats.drawCalls = 0;
    this.stats.sprites = 0;
    this.lightUsed = false;
    this.frame3D = null;
    Object.assign(this.stats3D, { meshes: 0, culled: 0, triangles: 0, drawCalls: 0, shadowDrawCalls: 0 });
    this.writer.begin(clearColor, this.width, this.height);
  }

  render3D(frame: RenderFrame3D): void {
    if (this.lost) return;
    if (this.frame3D) throw new Error("One Scene3D world may be rendered per frame; use ordinary Scene overlays for menus");
    this.frame3D = frame;
  }

  setPass(pass: Pass, clear = 0): void {
    if (this.lost) return;
    if (pass === "light") this.lightUsed = true;
    this.writer.pass(pass === "world" ? 0 : pass === "light" ? 1 : pass === "scratch" ? 3 : 2, clear);
  }

  drawLight(d: LightDraw): void {
    if (this.lost) return;
    this.writer.light(d.x, d.y, d.radius, d.color, d.intensity, d.falloff, d.height);
  }

  drawQuad(points: ArrayLike<number>, color: number, alpha: number, erase = false): void {
    if (this.lost) return;
    this.writer.quad(points, color, alpha, erase);
  }

  drawMesh(verts: ArrayLike<number>, count: number, tint: number, alpha: number, additive = false, smooth = false): void {
    if (this.lost) return;
    this.writer.mesh(verts, count, tint, alpha, additive, smooth);
  }

  blitScratch(): void {
    if (this.lost) return;
    this.writer.blitScratch(this.width, this.height);
  }

  setTransform(m: Readonly<Mat>): void {
    this.writer.transform(m);
  }

  sprite(d: SpriteDraw): void {
    if (this.lost) return;
    this.writer.sprite(d);
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1, additive = false): void {
    if (this.lost || !this.atlas) return;
    this.writer.rect(x, y, w, h, color, alpha, additive);
  }

  drawBatch(id: number, alpha: number, tint: number, cull: Rect | null, additive: boolean, smooth: boolean): void {
    if (this.lost) return;
    this.writer.batch(id, alpha, tint, cull, additive, smooth);
  }

  drawParticles(id: number, dt: number, emitting: boolean, ex: number, ey: number, alpha: number, snap: boolean): void {
    if (this.lost) return;
    this.writer.particles(id, dt, emitting, ex, ey, alpha, snap);
  }

  drawNodes(id: number, alpha: number, tint: number, additive: boolean, smooth: boolean): void {
    this.writer.nodes(id, alpha, tint, additive, smooth);
  }

  setProjection(p: ProjectionMatrix, cam: Readonly<Mat>, sorted: boolean): void {
    this.writer.projection(p, cam, sorted);
  }

  endProjection(): void {
    this.writer.projectionEnd();
  }

  setTransform3(a: number, b: number, c: number, d: number, gx: number, gy: number, gz: number, depthBias: number, shadow: boolean, shadowAlpha: number): void {
    this.writer.transform3(a, b, c, d, gx, gy, gz, depthBias, shadow, shadowAlpha);
  }

  drawBatch3(id: number, alpha: number, tint: number, additive: boolean, smooth: boolean): void {
    this.writer.batch3(id, alpha, tint, additive, smooth);
  }

  clip(x: number, y: number, w: number, h: number): void {
    if (this.lost) return;
    this.writer.clip(x, y, w, h);
  }

  unclip(): void {
    if (this.lost) return;
    this.writer.clipEnd();
  }

  private glyphCache(): GlyphCache {
    if (!this.glyphs) this.glyphs = new GlyphCache(this.fbW > 0 ? this.fbW / this.width : 1);
    return this.glyphs;
  }

  measureText(text: string, font: FontSpec): TextSize {
    return this.glyphCache().measure(text, font);
  }

  text(d: TextDraw): void {
    if (this.lost) return;
    const cache = this.glyphCache();
    const ratio = cache.pixelRatio;
    const { ascent, lineHeight } = cache.metrics(d.font);
    const lines = d.text.split("\n");
    const draw = (line: string, x0: number, y0: number, color: number) => {
      let pen = x0;
      for (const ch of line) {
        const gl = cache.glyph(ch, d.font);
        if (ch !== " ") this.writer.glyph(pen + gl.left / ratio, y0 + ascent + gl.top / ratio, gl.w / ratio, gl.h / ratio, gl.u0, gl.v0, gl.u1, gl.v1, color, d.alpha, d.additive ?? false, gl.page);
        pen += gl.advance / ratio;
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const w = cache.measure(line, d.font).width;
      const x = d.align === "center" ? d.x - w / 2 : d.align === "right" ? d.x - w : d.x;
      const y = d.y + i * lineHeight;
      if (d.shadow !== undefined && d.shadow !== null) draw(line, x + 1, y + 1, d.shadow);
      draw(line, x, y, d.color);
    }
  }

  /** Replay the kernel's command list into the GL targets: one vertex upload, one draw per DRAW. */
  private playback(): void {
    if (!this.scene || !this.overlay || !this.light) return;
    const gl = this.gl;
    const k = this.kernel;
    const st = k.stats;
    const vertexCount = st[STAT.VERTICES];
    this.uploadGlyphs();
    this.bindBatchTextures();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (vertexCount > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, k.vertices, 0, vertexCount * FLOATS_PER_VERT);
    const cmds = k.commands;
    const n = st[STAT.COMMANDS];
    let lightCleared = false;
    let target: { w: number; h: number } = this.scene;
    gl.disable(gl.SCISSOR_TEST);
    for (let i = 0; i < n; ) {
      switch (cmds[i]) {
        case CMD.SCISSOR: {
          const [x, y, w, h] = [cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4]];
          if (w === 0 || h === 0) gl.disable(gl.SCISSOR_TEST);
          else {
            const sx = target.w / this.width;
            const sy = target.h / this.height;
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(Math.floor(x * sx), Math.floor(target.h - (y + h) * sy), Math.ceil(w * sx), Math.ceil(h * sy));
          }
          i += 5;
          break;
        }
        case CMD.BEGIN: {
          const c = cmds[i + 1];
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.overlay.fbo);
          gl.viewport(0, 0, this.overlay.w, this.overlay.h);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
          gl.viewport(0, 0, this.scene.w, this.scene.h);
          if (this.hasNormals && this.sceneNormal) {
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
            gl.clearBufferfv(gl.COLOR, 0, [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, 1]);
            gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
          } else {
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.clearColor(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
          if (this.frame3D) {
            this.stage3D ??= new WebGL3DStage(gl);
            Object.assign(this.stats3D, this.stage3D.render(this.frame3D, this.scene.fbo, this.scene.w, this.scene.h, c));
            this.stats.drawCalls += this.stats3D.drawCalls + this.stats3D.shadowDrawCalls;
            this.bindBatchTextures();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
            gl.viewport(0, 0, this.scene.w, this.scene.h);
            gl.drawBuffers(this.hasNormals ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
          }
          gl.uniform2f(this.spriteProg.u.uTargetSize, this.scene.w, this.scene.h);
          this.bindPassTextures(0);
          i += 2;
          break;
        }
        case CMD.PASS: {
          const id = cmds[i + 1];
          const clear = cmds[i + 2];
          const t = id === 0 ? this.scene : id === 1 ? this.light : id === 3 ? (this.scratch ?? this.light) : this.overlay;
          target = t;
          gl.disable(gl.SCISSOR_TEST);
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
          gl.viewport(0, 0, t.w, t.h);
          if (id === 0) gl.drawBuffers(this.hasNormals ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
          if (id === 1 && !lightCleared) {
            gl.clearColor(((clear >> 16) & 255) / 255, ((clear >> 8) & 255) / 255, (clear & 255) / 255, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            lightCleared = true;
          }
          if (id === 3) {
            // Each shadowed light starts from an empty scratch.
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
          gl.uniform2f(this.spriteProg.u.uTargetSize, t.w, t.h);
          this.bindPassTextures(id);
          i += 3;
          break;
        }
        case CMD.DRAW: {
          const first = cmds[i + 1];
          const count = cmds[i + 2];
          gl.drawElements(gl.TRIANGLES, (count / 4) * 6, gl.UNSIGNED_INT, (first / 4) * 6 * 4);
          this.stats.drawCalls++;
          i += 3;
          break;
        }
        case CMD.END:
          i += 1;
          break;
        default:
          i = n;
      }
    }
    this.stats.sprites = st[STAT.SPRITES];
    gl.disable(gl.SCISSOR_TEST);
  }

  private uploadLut(lut: string | Uint8Array | null): boolean {
    const data = resolveLut(lut);
    if (!data) return false;
    if (this.lutKey !== lut) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.activeTexture(gl.TEXTURE0);
      this.lutKey = lut;
    }
    return true;
  }

  private fullscreen(prog: Program, into: Target | null, tex: WebGLTexture, sampler: WebGLSampler): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
    gl.viewport(0, 0, into ? into.w : this.backingW, into ? into.h : this.backingH);
    gl.useProgram(prog.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindSampler(0, sampler);
    gl.uniform1i(prog.u.uTex, 0);
  }

  end(post: PostSettings, offsetX = 0, offsetY = 0): void {
    if (this.lost || !this.scene || !this.overlay || !this.light || !this.bloomA || !this.bloomB || !this.bloomC || !this.bloomD) return;
    const gl = this.gl;
    this.collectGarbage();
    if (this.profiling) { this.gpuProfiler ??= new GpuProfiler(gl); this.gpuProfiler.begin(); }
    this.writer.end();
    this.kernel.run(this.writer.length);
    this.playback();
    gl.bindVertexArray(this.quadVao);
    gl.disable(gl.BLEND);

    if (post.bloom > 0) {
      this.fullscreen(this.brightProg, this.bloomA, this.scene.tex, this.samplerLinear);
      gl.uniform1f(this.brightProg.u.uThreshold, post.bloomThreshold);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const passes = Math.max(1, Math.round(post.bloomPasses));
      for (let i = 0; i < passes; i++) {
        this.fullscreen(this.blurProg, this.bloomB, this.bloomA.tex, this.samplerLinear);
        gl.uniform2f(this.blurProg.u.uDir, 1 / this.bloomA.w, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.fullscreen(this.blurProg, this.bloomA, this.bloomB.tex, this.samplerLinear);
        gl.uniform2f(this.blurProg.u.uDir, 0, 1 / this.bloomA.h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      // Second, wider level at an eighth of the target.
      this.fullscreen(this.copyProg, this.bloomC, this.bloomA.tex, this.samplerLinear);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      for (let i = 0; i < 2; i++) {
        this.fullscreen(this.blurProg, this.bloomD, this.bloomC.tex, this.samplerLinear);
        gl.uniform2f(this.blurProg.u.uDir, 1 / this.bloomC.w, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.fullscreen(this.blurProg, this.bloomC, this.bloomD.tex, this.samplerLinear);
        gl.uniform2f(this.blurProg.u.uDir, 0, 1 / this.bloomC.h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      this.stats.drawCalls += 2 + passes * 2 + 4;
    } else {
      // Keep the bloom textures black so the composite can sample them unconditionally.
      for (const t of [this.bloomA, this.bloomC]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }

    const useLut = this.uploadLut(post.lut);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.backingW, this.backingH);
    gl.useProgram(this.compositeProg.prog);
    const exact = this.backingW === this.scene.w && this.backingH === this.scene.h;
    const integer = this.backingW % this.scene.w === 0 && this.backingH % this.scene.h === 0;
    const bind = (unit: number, tex: WebGLTexture | null, sampler: WebGLSampler) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindSampler(unit, sampler);
    };
    bind(0, this.scene.tex, exact || integer ? this.samplerNearest : this.samplerLinear);
    bind(1, this.bloomA.tex, this.samplerLinear);
    bind(2, this.bloomC.tex, this.samplerLinear);
    bind(3, this.light.tex, this.samplerLinear);
    bind(4, this.overlay.tex, exact || integer ? this.samplerNearest : this.samplerLinear);
    bind(5, this.lutTex, this.samplerLinear);
    const c = this.compositeProg.u;
    gl.uniform1i(c.uScene, 0);
    gl.uniform1i(c.uBloomA, 1);
    gl.uniform1i(c.uBloomB, 2);
    gl.uniform1i(c.uLight, 3);
    gl.uniform1i(c.uOverlay, 4);
    gl.uniform1i(c.uLut, 5);
    gl.uniform1f(c.uBloomStrength, post.bloom);
    gl.uniform1f(c.uLighting, this.lightUsed ? 1 : 0);
    gl.uniform1f(c.uUseLut, useLut ? 1 : 0);
    gl.uniform1f(c.uVignette, post.vignette);
    gl.uniform3f(c.uTint, ((post.tint >> 16) & 255) / 255, ((post.tint >> 8) & 255) / 255, (post.tint & 255) / 255);
    gl.uniform1f(c.uTintAmount, post.tintAmount);
    gl.uniform1f(c.uSaturation, post.saturation);
    gl.uniform1f(c.uContrast, post.contrast);
    gl.uniform1f(c.uBrightness, post.brightness);
    gl.uniform1f(c.uGrain, post.grain);
    gl.uniform1f(c.uScanlines, post.scanlines);
    gl.uniform1f(c.uScanPeriod, Math.max(2, this.backingH / this.height));
    gl.uniform1f(c.uTime, (performance.now() % 100000) / 1000);
    gl.uniform2f(c.uOffset, offsetX / this.width, -offsetY / this.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stats.drawCalls++;

    gl.enable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    this.gpuProfiler?.end();
    this.stats.frameMs = performance.now() - this.frameStart;
  }

  snapshot(): string | null {
    try {
      return this.canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.gpuProfiler?.destroy(); this.gpuProfiler = null;
    this.stage3D?.destroy();
    this.stage3D = null;
    this.frame3D = null;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}
