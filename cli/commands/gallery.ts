import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Args } from "../args.ts";
import { loadProject, slug } from "../project.ts";
import { type ServeEntry, serve } from "../serve.ts";

const ENGINE_ROOT = resolve(import.meta.dir, "..", "..");

/** Every project under examples/ and templates/, plus any extra directories given. */
async function discover(extra: string[]): Promise<ServeEntry[]> {
  const dirs: string[] = [];
  for (const group of ["examples", "templates"]) {
    const base = join(ENGINE_ROOT, group);
    if (!existsSync(base)) continue;
    for (const e of await readdir(base, { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(base, e.name));
  }
  for (const d of extra) dirs.push(resolve(process.cwd(), d));
  const entries: ServeEntry[] = [];
  const used = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(join(dir, "kiln.json"))) continue;
    const project = await loadProject(dir);
    let prefix = `/${slug(dir.split("/").pop() ?? project.config.name)}`;
    while (used.has(prefix)) prefix += "-";
    used.add(prefix);
    let description = "";
    try {
      const readme = await readFile(join(dir, "README.md"), "utf8");
      description = readme.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
    } catch {
      /* no readme */
    }
    entries.push({ prefix, project, description: description.replace(/`/g, "") });
  }
  // The demo first, then the starters in their usual order.
  const order = ["demo", "isometric", "lumen", "breach", "lowline", "blank", "topdown", "platformer", "tactics"];
  entries.sort((a, b) => {
    const ia = order.indexOf(a.prefix.slice(1));
    const ib = order.indexOf(b.prefix.slice(1));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.prefix.localeCompare(b.prefix);
  });
  return entries;
}

/** Serve the demo and every starter behind one menu page. Extra project dirs may be passed. */
export async function gallery(args: Args): Promise<void> {
  const entries = await discover(args._);
  if (entries.length === 0) throw new Error("No projects found under examples/ or templates/");
  await serve(entries, { port: args.num("port", 4200), open: args.bool("open"), title: "Kiln gallery" });
}
