// The physics kernel as WebAssembly, loaded only by games that enable physics. The bytes
// come from `physics.wasm`, served next to the game on the web and read from disk in tests.

import { type PhysicsBackend, EVENT_STRIDE, TRANSFORM_STRIDE } from "./protocol.ts";

interface Exports {
  memory: WebAssembly.Memory;
  blackiron_physics_new(ppm: number): number;
  blackiron_physics_free(p: number): void;
  blackiron_physics_scratch(p: number): number;
  blackiron_physics_scratch_words(p: number): number;
  blackiron_physics_call(p: number, op: number, words: number): number;
  blackiron_physics_transforms(p: number): number;
  blackiron_physics_transform_count(p: number): number;
  blackiron_physics_events(p: number): number;
  blackiron_physics_event_count(p: number): number;
}

let modules = new Map<BufferSource, Promise<WebAssembly.Module>>();

/** Instantiate the physics module from its bytes. */
export async function loadWasmPhysics(bytes: BufferSource, pixelsPerMeter: number): Promise<WasmPhysics> {
  let compiled = modules.get(bytes);
  if (!compiled) {
    compiled = WebAssembly.compile(bytes);
    modules = new Map([[bytes, compiled]]);
  }
  const instance = await WebAssembly.instantiate(await compiled, {});
  return new WasmPhysics(instance.exports as unknown as Exports, pixelsPerMeter);
}

export class WasmPhysics implements PhysicsBackend {
  readonly kind = "wasm" as const;
  private readonly p: number;
  private buffer: ArrayBufferLike | null = null;
  private _scratch!: Float32Array;

  constructor(
    private readonly x: Exports,
    pixelsPerMeter: number,
  ) {
    this.p = x.blackiron_physics_new(pixelsPerMeter);
    this.refresh();
  }

  private refresh(): void {
    const mem = this.x.memory.buffer;
    if (mem === this.buffer) return;
    this.buffer = mem;
    this._scratch = new Float32Array(mem, this.x.blackiron_physics_scratch(this.p), this.x.blackiron_physics_scratch_words(this.p));
  }

  get scratch(): Float32Array {
    this.refresh();
    return this._scratch;
  }

  call(op: number, words: number): number {
    const r = this.x.blackiron_physics_call(this.p, op, words);
    this.refresh();
    return r;
  }

  transforms(): Float32Array {
    this.refresh();
    return new Float32Array(this.x.memory.buffer, this.x.blackiron_physics_transforms(this.p), this.x.blackiron_physics_transform_count(this.p) * TRANSFORM_STRIDE);
  }

  events(): Float32Array {
    this.refresh();
    return new Float32Array(this.x.memory.buffer, this.x.blackiron_physics_events(this.p), this.x.blackiron_physics_event_count(this.p) * EVENT_STRIDE);
  }

  destroy(): void {
    this.x.blackiron_physics_free(this.p);
  }

  /** Allocate an isolated world using this already compiled module (no fetch or recompilation). */
  fork(pixelsPerMeter: number): WasmPhysics {
    return new WasmPhysics(this.x, pixelsPerMeter);
  }
}
