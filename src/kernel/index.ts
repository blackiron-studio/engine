// Kernels: the compiled Rust kernel (WebAssembly on the web, a static library in native
// hosts) and the reference TypeScript one, behind one interface. See protocol.ts.

export { BATCH_STRIDE, BATCH3_STRIDE, BLEND, CFG, DEFAULT_MAX_QUADS, DEFAULT_STREAM_WORDS, FRAME_WORDS, KERNEL_VERSION, MATERIAL, SLOT, drawFlags, NODE, NODE_BOUNDS, NODE_FLAG, NODE_FLOOR, NODE_WORDS, OP, OP_WORDS, STAT, type Kernel, type KernelKind, type KernelOptions, type ProjectionMatrix } from "./protocol.ts";
export { TsKernel } from "./ts.ts";
export { WasmKernel, loadWasmKernel } from "./wasm.ts";
export { StreamWriter } from "./stream.ts";

import type { Kernel, KernelKind, KernelOptions } from "./protocol.ts";
import { TsKernel } from "./ts.ts";
import { loadWasmKernel } from "./wasm.ts";

export type KernelChoice = KernelKind | "auto";

/**
 * Pick a kernel for the web or a headless run: the compiled one when it loads, otherwise
 * the reference. Native hosts install theirs on the host object instead.
 */
export async function createKernel(choice: KernelChoice = "auto", opts: KernelOptions = {}): Promise<Kernel> {
  if (choice === "ts") return new TsKernel(opts);
  if (choice === "wasm" || choice === "auto") {
    try {
      const k = await loadWasmKernel(opts);
      if (k) return k;
    } catch (err) {
      console.warn("[blackiron] compiled kernel failed to load, using the reference kernel:", err);
    }
  }
  return new TsKernel(opts);
}
