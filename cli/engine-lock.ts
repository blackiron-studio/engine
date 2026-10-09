import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { Args } from "./args.ts";

export const engineRoot = resolve(import.meta.dir, "..");
export interface EngineLock {
  schema: "blackiron.engine-lock/v1";
  repository: string;
  version: string;
  revision: string;
  sourceHash: string;
  files: string[];
}
async function git(engine: string, ...args: string[]): Promise<string> {
  const result = Bun.spawn(["git", "-C", engine, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
  if (status) throw Error(`Cannot pin engine source: ${err.trim()}`);
  return out.trim();
}
export async function sourceHash(engine: string, files: string[]): Promise<string> {
  if (!files.length || files.some((p) => p.startsWith("/") || p.includes("\\") || p.split("/").some((part) => part === ".." || !part)))
    throw Error("Invalid engine lock source paths.");
  const hash = createHash("sha256");
  for (const path of [...files].sort()) {
    const bytes = await readFile(join(engine, path));
    hash.update(path + "\0" + bytes.length + "\0").update(bytes);
  }
  return hash.digest("hex");
}
export async function verifyEngineLock(root: string, engine = engineRoot): Promise<EngineLock> {
  const lock = await Bun.file(join(root, "blackiron-engine.lock.json")).json() as EngineLock;
  if (lock.schema !== "blackiron.engine-lock/v1" || !/^[a-f0-9]{40}$/.test(lock.revision) ||
      !/^[a-f0-9]{64}$/.test(lock.sourceHash) || !Array.isArray(lock.files) || lock.files.some((p) => typeof p !== "string"))
    throw Error("Invalid Blackiron engine lock.");
  const pkg = await Bun.file(join(engine, "package.json")).json();
  if (pkg.name !== "@blackiron-studio/engine" || pkg.version !== lock.version || await sourceHash(engine, lock.files) !== lock.sourceHash)
    throw Error("Engine source does not match the project lock. Restore the pinned snapshot or explicitly update the lock.");
  return lock;
}
export async function updateEngineLock(root: string, engine = engineRoot): Promise<EngineLock> {
  if (await git(engine, "status", "--porcelain")) throw Error("Commit engine source before pinning it.");
  const pkg = await Bun.file(join(engine, "package.json")).json();
  if (pkg.name !== "@blackiron-studio/engine") throw Error("Expected Blackiron engine source.");
  const files = (await git(engine, "ls-files", "-z")).split("\0").filter(Boolean).sort();
  const lock: EngineLock = { schema: "blackiron.engine-lock/v1", repository: pkg.repository.url,
    version: pkg.version, revision: await git(engine, "rev-parse", "HEAD"), sourceHash: await sourceHash(engine, files), files };
  await Bun.write(join(root, "blackiron-engine.lock.json"), JSON.stringify(lock, null, 2) + "\n");
  return lock;
}
export async function engineLock(args: Args): Promise<void> {
  const root = resolve(args._[0] ?? ".");
  const lock = args.bool("update") ? await updateEngineLock(root) : await verifyEngineLock(root);
  console.log(`  Blackiron ${lock.version} / ${lock.revision} / source SHA-256 ${lock.sourceHash}`);
}
