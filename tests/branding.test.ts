import { expect, test } from "bun:test";
import { join } from "node:path";
import { KERNEL_WASM_BASE64 } from "../src/kernel/kernel.wasm.ts";

test("all shipped Wasm builds use the canonical Blackiron ABI", async () => {
  const modules = [Buffer.from(KERNEL_WASM_BASE64, "base64"),
    await Bun.file(join(import.meta.dir, "../src/kernel/physics.wasm")).bytes(),
    await Bun.file(join(import.meta.dir, "../src/kernel/audio.wasm")).bytes()];
  for (const bytes of modules) {
    const exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((entry) => entry.name);
    expect(exports).toContain("blackiron_audio_new");
    expect(exports.some((name) => name.startsWith("kiln_"))).toBe(false);
  }
  const physics = WebAssembly.Module.exports(new WebAssembly.Module(modules[1])).map((entry) => entry.name);
  expect(physics).toContain("blackiron_physics_new");
});
