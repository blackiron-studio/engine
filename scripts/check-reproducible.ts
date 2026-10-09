import { resolve, relative, join } from "node:path";
import { readdir, mkdir } from "node:fs/promises";
const engine = resolve(import.meta.dir, ".."),
  projects = [
    "examples/demo",
    "templates/isometric",
    "examples/lumen",
    "examples/breach",
    "examples/lowline",
  ];
async function manifest(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function visit(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile())
        out[relative(dir, file)] = new Bun.CryptoHasher("sha256")
          .update(await Bun.file(file).arrayBuffer())
          .digest("hex");
    }
  }
  await visit(join(dir, "assets"));
  for (const name of ["index.html", "physics.wasm", "audio.wasm"])
    out[name] = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(join(dir, name)).arrayBuffer())
      .digest("hex");
  return out;
}
const reports = [];
for (const project of projects) {
  const cwd = resolve(engine, project),
    build = async () => {
      const proc = Bun.spawn(
        [process.execPath, resolve(engine, "cli/kiln.ts"), "build"],
        { cwd, stdout: "inherit", stderr: "inherit" },
      );
      if ((await proc.exited) !== 0)
        throw new Error(`Build failed: ${project}`);
      return manifest(resolve(cwd, "dist"));
    };
  const first = await build(),
    second = await build();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error(`Non-reproducible output: ${project}`);
  reports.push({ project, files: second, status: "PASS" });
}
await mkdir(resolve(engine, ".kiln/verification/reproducible"), {
  recursive: true,
});
await Bun.write(
  resolve(engine, ".kiln/verification/reproducible/result.json"),
  JSON.stringify(
    {
      bun: Bun.version,
      checkedAt: new Date().toISOString(),
      scope:
        "Two clean web builds on this host, SHA-256 of managed web outputs (HTML, assets, physics/audio Wasm), excluding sibling platform exports. Does not certify cross-host native binary reproducibility or remote font stability.",
      reports,
    },
    null,
    2,
  ),
);
console.log("Reproducibility: all five web builds are byte-identical.");
