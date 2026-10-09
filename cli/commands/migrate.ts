import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Args } from "../args.ts";
import { slug } from "../project.ts";

const excluded = new Set([".git", ".kiln", ".blackiron", "node_modules", "dist", "target", "atlas", "screenshots"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".css", ".toml", ".yaml", ".yml", ".sh"]);
export interface MigrationChange { from: string; to: string; before: string; after: string }
export interface MigrationPlan { root: string; engine: string; changes: MigrationChange[]; archiveCache: boolean }

function rewrite(text: string, root: string, file: string, engine: string): string {
  // Game save keys are identifiers, not engine branding.
  const keys: string[] = [];
  text = text.replace(/(?:\bkey|["\']key["\'])\s*:\s*(["'])([^"'\n]*)\1/g, (match) => {
    keys.push(match);
    return `__PRESERVED_GAME_KEY_${keys.length - 1}__`;
  });
  text = text.replace(/(?:\.\.\/)+engine(?=\/|["'`)\s])/g, (old) => {
    const legacyRoot = resolve(root, "../engine");
    const base = resolve(dirname(file), old) === legacyRoot ? dirname(file) : root;
    return relative(base, engine).split("\\").join("/");
  });
  text = text.replaceAll("@kiln/engine", "@blackiron-studio/engine")
    .replaceAll("KILN", "BLACKIRON").replaceAll("Kiln", "Blackiron").replaceAll("kiln", "blackiron");
  return text.replace(/__PRESERVED_GAME_KEY_(\d+)__/g, (_, i) => keys[Number(i)]);
}

/** Preview a source migration. Never follows symlinks or touches generated files. */
export async function planMigration(directory: string, engineDirectory = resolve(import.meta.dir, "../..")): Promise<MigrationPlan> {
  const root = await realpath(directory), engine = await realpath(engineDirectory);
  if (existsSync(join(root, ".blackiron")) && (await lstat(join(root, ".blackiron"))).isSymbolicLink()) throw Error("Migration backup directory must not be a symlink.");
  const legacy = join(root, "kiln.json"), current = join(root, "blackiron.json");
  if (existsSync(legacy) && existsSync(current)) throw Error("Both kiln.json and blackiron.json exist; resolve the conflict before migrating.");
  if (!existsSync(legacy) && !existsSync(current)) throw Error("No engine project configuration found.");
  if ((await Bun.file(join(engine, "package.json")).json()).name !== "@blackiron-studio/engine") throw Error("--engine must point to the Blackiron Engine source checkout.");
  const changes: MigrationChange[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || entry.name.startsWith(".env")) continue;
      const from = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Migration does not follow symlinks: ${relative(root, from)}`);
      if (entry.isDirectory()) { await visit(from); continue; }
      if (!entry.isFile() || (!textExtensions.has(extname(entry.name)) && ![".gitignore", "bun.lock"].includes(entry.name))) continue;
      const before = await readFile(from, "utf8");
      let after = rewrite(before, root, from, engine);
      const to = join(dir, entry.name.replace(/kiln(?=\.json$)/, "blackiron"));
      if (from === legacy || from === current) {
        const original = JSON.parse(before), migrated = JSON.parse(after);
        for (const field of ["name", "version", "buildNumber"]) if (field in original) migrated[field] = original[field];
        for (const [target, field] of [["ios", "bundleId"], ["android", "applicationId"], ["desktop", "bundleId"]]) {
          if (original[target]?.[field] !== undefined) migrated[target][field] = original[target][field];
        }
        // Make old implicit store identities explicit before the engine default changes.
        if (from === legacy) {
          const bundleId = original.ios?.bundleId ?? `com.kiln.${slug(original.name ?? "game").replace(/-/g, "")}`;
          migrated.ios = { ...migrated.ios, bundleId };
          migrated.android = { ...migrated.android, applicationId: original.android?.applicationId ?? bundleId };
        }
        after = JSON.stringify(migrated, null, 2) + "\n";
      }
      if (from !== to || before !== after) {
        if (from !== to && existsSync(to)) throw Error(`Migration would overwrite ${relative(root, to)}`);
        changes.push({ from, to, before, after });
      }
    }
  }
  await visit(root);
  return { root, engine, changes, archiveCache: existsSync(join(root, ".kiln")) };
}

/** Back up every original before modifying anything; roll back on an incomplete write. */
export async function applyMigration(plan: MigrationPlan): Promise<string | null> {
  if (!plan.changes.length && !plan.archiveCache) return null;
  if (existsSync(join(plan.root, ".blackiron")) && (await lstat(join(plan.root, ".blackiron"))).isSymbolicLink()) throw Error("Migration backup directory must not be a symlink.");
  for (const change of plan.changes) {
    if ((await lstat(change.from)).isSymbolicLink() || await readFile(change.from, "utf8") !== change.before) throw Error("Source changed since migration preview; generate a new plan.");
    if (change.from !== change.to && existsSync(change.to)) throw Error("Migration destination appeared since preview.");
  }
  const backup = join(plan.root, ".blackiron/migrations", randomUUID());
  await mkdir(backup, { recursive: true });
  for (const change of plan.changes) {
    const saved = join(backup, "files", relative(plan.root, change.from));
    await mkdir(dirname(saved), { recursive: true });
    await copyFile(change.from, saved);
  }
  await writeFile(join(backup, "manifest.json"), JSON.stringify({ schema: "blackiron.migration/v1", engine: plan.engine,
    files: plan.changes.map(({ from, to }) => ({ from: relative(plan.root, from), to: relative(plan.root, to) })),
    archivedCache: plan.archiveCache }, null, 2) + "\n");
  const applied: MigrationChange[] = [];
  try {
    for (const change of plan.changes) {
      const temp = change.from + ".blackiron-migration-" + randomUUID();
      try {
        await writeFile(temp, change.after, { flag: "wx", mode: (await lstat(change.from)).mode });
        await rename(temp, change.from);
        applied.push(change);
        if (change.from !== change.to) await rename(change.from, change.to);
      } finally { await rm(temp, { force: true }); }
    }
    if (plan.archiveCache) await rename(join(plan.root, ".kiln"), join(backup, "legacy-cache"));
  } catch (error) {
    for (const change of applied.reverse()) {
      if (change.from !== change.to) await rm(change.to, { force: true });
      await copyFile(join(backup, "files", relative(plan.root, change.from)), change.from);
    }
    throw error;
  }
  return backup;
}

export async function migrate(args: Args): Promise<void> {
  if (args.bool("apply") && args.bool("dry-run")) throw Error("Choose --apply or --dry-run.");
  const plan = await planMigration(resolve(args._[0] ?? "."), resolve(args.str("engine", resolve(import.meta.dir, "../.."))));
  for (const change of plan.changes) console.log(`  ${relative(plan.root, change.from)}${change.from !== change.to ? " -> " + relative(plan.root, change.to) : " (update)"}`);
  if (plan.archiveCache) console.log("  archive legacy generated cache with the migration backup");
  console.log(`  ${plan.changes.length} source files to migrate`);
  if (!args.bool("apply")) { console.log("  Preview only. Add --apply to back up and migrate this project."); return; }
  const backup = await applyMigration(plan);
  console.log(backup ? `  Migrated. Original files and cache: ${backup}` : "  Project already uses Blackiron.");
}
