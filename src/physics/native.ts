// Physics on a native host: the host owns the kernel world and exposes the same call
// surface as the Wasm build, with typed arrays over kernel memory.

import type { PhysicsBackend } from "./protocol.ts";

/** What a native host exposes per world through `__blackironHost.createPhysics(ppm)`. */
export interface NativePhysicsWorld {
  readonly scratch: Float32Array;
  call(op: number, words: number): number;
  transforms(): Float32Array;
  events(): Float32Array;
  destroy(): void;
}

export class NativePhysics implements PhysicsBackend {
  readonly kind = "native" as const;
  constructor(private readonly world: NativePhysicsWorld) {}
  get scratch(): Float32Array {
    return this.world.scratch;
  }
  call(op: number, words: number): number {
    return this.world.call(op, words);
  }
  transforms(): Float32Array {
    return this.world.transforms();
  }
  events(): Float32Array {
    return this.world.events();
  }
  destroy(): void {
    this.world.destroy();
  }
}
