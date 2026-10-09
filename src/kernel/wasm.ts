// The compiled kernel on the web: kernel/src/lib.rs built to WebAssembly and embedded as
// base64 by kernel/build.ts. Views over its memory are refreshed whenever it grows.

import { KERNEL_WASM_BASE64 } from "./kernel.wasm.ts";
import { BATCH_STRIDE, BATCH3_STRIDE, FLOATS_PER_VERT, KERNEL_VERSION, OP_WORDS, type Kernel, type KernelOptions, DEFAULT_MAX_QUADS, DEFAULT_STREAM_WORDS, NODE_WORDS, STAT } from "./protocol.ts";

interface Exports {
  memory: WebAssembly.Memory;
  kiln_version(): number;
  kiln_floats_per_vertex(): number;
  kiln_op_words(op: number): number;
  kiln_new(maxQuads: number, streamWords: number): number;
  kiln_free(k: number): void;
  kiln_stream(k: number): number;
  kiln_stream_words(k: number): number;
  kiln_scratch(k: number): number;
  kiln_scratch_words(k: number): number;
  kiln_vertices(k: number): number;
  kiln_vertex_cap(k: number): number;
  kiln_commands(k: number): number;
  kiln_command_cap(k: number): number;
  kiln_stats(k: number): number;
  kiln_set_white(k: number, u: number, v: number): void;
  kiln_run(k: number, len: number): void;
  kiln_batch_create(k: number, cap: number): number;
  kiln_batch_data(k: number, id: number): number;
  kiln_batch_set_count(k: number, id: number, n: number): void;
  kiln_batch_destroy(k: number, id: number): void;
  kiln_emitter_create(k: number, words: number): number;
  kiln_emitter_burst(k: number, id: number, n: number, x: number, y: number): void;
  kiln_emitter_count(k: number, id: number): number;
  kiln_emitter_clear(k: number, id: number): void;
  kiln_emitter_destroy(k: number, id: number): void;
  kiln_nodes_create(k: number, capacity: number): number;
  kiln_nodes_data(k: number, id: number): number;
  kiln_nodes_capacity(k: number, id: number): number;
  kiln_nodes_alloc(k: number, id: number): number;
  kiln_nodes_free(k: number, id: number, index: number): void;
  kiln_nodes_clear(k: number, id: number): void;
  kiln_nodes_count(k: number, id: number): number;
  kiln_nodes_high(k: number, id: number): number;
  kiln_nodes_step(k: number, id: number, dt: number): void;
  kiln_nodes_configure(k: number, id: number, gx: number, gy: number, damping: number, mode: number, bx: number, by: number, bw: number, bh: number, gz: number, floor: number): void;
  kiln_batch3_create(k: number, cap: number): number;
  kiln_batch3_data(k: number, id: number): number;
  kiln_batch3_set_count(k: number, id: number, n: number): void;
  kiln_batch3_destroy(k: number, id: number): void;
  kiln_set_shadow(k: number, w: number, h: number, ox: number, oy: number, u0: number, v0: number, u1: number, v1: number): void;
  kiln_nodes_set_frames(k: number, id: number, words: number): void;
  kiln_nodes_apply_transforms(k: number, id: number, words: number): number;
  kiln_nodes_destroy(k: number, id: number): void;
}

export function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

function compile(): Promise<WebAssembly.Module> {
  if (!modulePromise) modulePromise = WebAssembly.compile(decodeBase64(KERNEL_WASM_BASE64) as BufferSource);
  return modulePromise;
}

/** Instantiate the compiled kernel; null where WebAssembly is unavailable. */
export async function loadWasmKernel(opts: KernelOptions = {}): Promise<WasmKernel | null> {
  if (typeof WebAssembly === "undefined" || KERNEL_WASM_BASE64.length === 0) return null;
  const instance = await WebAssembly.instantiate(await compile(), {});
  return new WasmKernel(instance.exports as unknown as Exports, opts);
}

export class WasmKernel implements Kernel {
  readonly kind = "wasm" as const;
  readonly maxQuads: number;
  readonly version: number;
  private readonly k: number;
  private buffer: ArrayBufferLike | null = null;
  private _stream!: Float32Array;
  private _scratch!: Float32Array;
  private _vertices!: Float32Array;
  private _commands!: Uint32Array;
  private _stats!: Uint32Array;
  private readonly batchCaps = new Map<number, number>();
  private readonly batch3Caps = new Map<number, number>();

  constructor(
    private readonly x: Exports,
    opts: KernelOptions = {},
  ) {
    if (x.kiln_version() !== KERNEL_VERSION || x.kiln_floats_per_vertex?.() !== FLOATS_PER_VERT ||
        Object.entries(OP_WORDS).some(([op, words]) => x.kiln_op_words?.(Number(op)) !== words)) {
      throw new Error("Kiln kernel ABI mismatch: rebuild the shipped Wasm with bun kernel/build.ts --web-only");
    }
    this.maxQuads = Math.max(64, opts.maxQuads ?? DEFAULT_MAX_QUADS);
    this.k = x.kiln_new(this.maxQuads, Math.max(1024, opts.streamWords ?? DEFAULT_STREAM_WORDS));
    this.version = x.kiln_version();
    this.refresh();
  }

  private refresh(): void {
    const mem = this.x.memory.buffer;
    if (mem === this.buffer) return;
    this.buffer = mem;
    const x = this.x;
    this._stream = new Float32Array(mem, x.kiln_stream(this.k), x.kiln_stream_words(this.k));
    this._scratch = new Float32Array(mem, x.kiln_scratch(this.k), x.kiln_scratch_words(this.k));
    this._vertices = new Float32Array(mem, x.kiln_vertices(this.k), x.kiln_vertex_cap(this.k) * FLOATS_PER_VERT);
    this._commands = new Uint32Array(mem, x.kiln_commands(this.k), x.kiln_command_cap(this.k));
    this._stats = new Uint32Array(mem, x.kiln_stats(this.k), STAT.COUNT);
  }

  get stream(): Float32Array {
    this.refresh();
    return this._stream;
  }

  get scratch(): Float32Array {
    this.refresh();
    return this._scratch;
  }

  get vertices(): Float32Array {
    this.refresh();
    return this._vertices;
  }

  get commands(): Uint32Array {
    this.refresh();
    return this._commands;
  }

  get stats(): Uint32Array {
    this.refresh();
    return this._stats;
  }

  setWhite(u: number, v: number): void {
    this.x.kiln_set_white(this.k, u, v);
  }

  run(streamLength: number): void {
    this.x.kiln_run(this.k, streamLength);
  }

  createBatch(capacity: number): number {
    const id = this.x.kiln_batch_create(this.k, Math.max(1, capacity));
    this.batchCaps.set(id, Math.max(1, capacity));
    this.refresh();
    return id;
  }

  batchData(id: number): Float32Array {
    this.refresh();
    const cap = this.batchCaps.get(id) ?? 0;
    const ptr = this.x.kiln_batch_data(this.k, id);
    return ptr && cap ? new Float32Array(this.x.memory.buffer, ptr, cap * BATCH_STRIDE) : new Float32Array(0);
  }

  setBatchCount(id: number, count: number): void {
    this.x.kiln_batch_set_count(this.k, id, count);
  }

  destroyBatch(id: number): void {
    this.x.kiln_batch_destroy(this.k, id);
    this.batchCaps.delete(id);
  }

  createEmitter(words: number): number {
    const id = this.x.kiln_emitter_create(this.k, words);
    this.refresh();
    return id;
  }

  burst(id: number, n: number, x: number, y: number): void {
    this.x.kiln_emitter_burst(this.k, id, n, x, y);
    this.refresh();
  }

  emitterCount(id: number): number {
    return this.x.kiln_emitter_count(this.k, id);
  }

  clearEmitter(id: number): void {
    this.x.kiln_emitter_clear(this.k, id);
  }

  destroyEmitter(id: number): void {
    this.x.kiln_emitter_destroy(this.k, id);
  }

  createNodes(capacity: number): number {
    const id = this.x.kiln_nodes_create(this.k, Math.max(1, capacity));
    this.refresh();
    return id;
  }

  nodesData(id: number): Float32Array {
    this.refresh();
    const cap = this.x.kiln_nodes_capacity(this.k, id);
    const ptr = this.x.kiln_nodes_data(this.k, id);
    return ptr && cap ? new Float32Array(this.x.memory.buffer, ptr, cap * NODE_WORDS) : new Float32Array(0);
  }

  allocNode(id: number): number {
    return this.x.kiln_nodes_alloc(this.k, id);
  }

  freeNode(id: number, index: number): void {
    this.x.kiln_nodes_free(this.k, id, index);
  }

  clearNodes(id: number): void {
    this.x.kiln_nodes_clear(this.k, id);
  }

  nodeCount(id: number): number {
    return this.x.kiln_nodes_count(this.k, id);
  }

  nodesHigh(id: number): number {
    return this.x.kiln_nodes_high(this.k, id);
  }

  stepNodes(id: number, dt: number): void {
    this.x.kiln_nodes_step(this.k, id, dt);
  }

  configureNodes(id: number, gx: number, gy: number, damping: number, boundsMode: number, bx: number, by: number, bw: number, bh: number, gz = 0, floor = 0): void {
    this.x.kiln_nodes_configure(this.k, id, gx, gy, damping, boundsMode, bx, by, bw, bh, gz, floor);
  }

  createBatch3(capacity: number): number {
    const id = this.x.kiln_batch3_create(this.k, Math.max(1, capacity));
    this.batch3Caps.set(id, Math.max(1, capacity));
    this.refresh();
    return id;
  }

  batch3Data(id: number): Float32Array {
    this.refresh();
    const cap = this.batch3Caps.get(id) ?? 0;
    const ptr = this.x.kiln_batch3_data(this.k, id);
    return ptr && cap ? new Float32Array(this.x.memory.buffer, ptr, cap * BATCH3_STRIDE) : new Float32Array(0);
  }

  setBatch3Count(id: number, count: number): void {
    this.x.kiln_batch3_set_count(this.k, id, count);
  }

  destroyBatch3(id: number): void {
    this.x.kiln_batch3_destroy(this.k, id);
    this.batch3Caps.delete(id);
  }

  setShadow(w: number, h: number, ox: number, oy: number, u0: number, v0: number, u1: number, v1: number): void {
    this.x.kiln_set_shadow(this.k, w, h, ox, oy, u0, v0, u1, v1);
  }

  setNodeFrames(id: number, words: number): void {
    this.x.kiln_nodes_set_frames(this.k, id, words);
    this.refresh();
  }

  applyNodeTransforms(id: number, words: number): number {
    return this.x.kiln_nodes_apply_transforms(this.k, id, words);
  }

  destroyNodes(id: number): void {
    this.x.kiln_nodes_destroy(this.k, id);
  }

  destroy(): void {
    this.x.kiln_free(this.k);
  }
}
