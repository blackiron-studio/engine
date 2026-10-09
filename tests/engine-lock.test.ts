import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceHash, verifyEngineLock } from "../cli/engine-lock.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
test("engine pins verify extracted snapshots and reject modified source", async () => {
  const root = await mkdtemp(join(tmpdir(), "blackiron-lock-")); roots.push(root);
  const engine = join(root, "engine");
  await Bun.write(join(engine, "package.json"), '{"name":"@blackiron-studio/engine","version":"0.17.0"}');
  await Bun.write(join(engine, "src/index.ts"), "export const value = 1;");
  const files = ["package.json", "src/index.ts"];
  await Bun.write(join(root, "blackiron-engine.lock.json"), JSON.stringify({ schema: "blackiron.engine-lock/v1",
    repository: "https://github.com/blackiron-studio/engine.git", revision: "a".repeat(40), version: "0.17.0",
    sourceHash: await sourceHash(engine, files), files }));
  expect((await verifyEngineLock(root, engine)).version).toBe("0.17.0");
  await Bun.write(join(engine, "src/index.ts"), "export const value = 2;");
  await expect(verifyEngineLock(root, engine)).rejects.toThrow("does not match");
});
test("engine pins reject source traversal", async () => {
  await expect(sourceHash(".", ["../outside"])).rejects.toThrow("Invalid");
});
