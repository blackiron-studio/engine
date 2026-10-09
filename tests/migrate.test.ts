import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { applyMigration, planMigration } from "../cli/commands/migrate.ts";
import { loadProject } from "../cli/project.ts";

const roots: string[] = [];
const engine = resolve(import.meta.dir, "..");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "blackiron-migration-"));
  roots.push(root);
  await Bun.write(join(root, "kiln.json"), JSON.stringify({ name: "Kiln Quest", version: "1.2.3", buildNumber: 4,
    entry: "src/main.ts", ios: { bundleId: "com.kiln.quest" }, android: { applicationId: "com.kiln.quest" } }));
  await Bun.write(join(root, "src/main.ts"), 'import { App } from "@kiln/engine/app";\nconst save = { key: "kiln.quest" };\n');
  await Bun.write(join(root, "src/test.ts"), 'import "../../engine/src/index.ts";\n');
  await Bun.write(join(root, "package.json"), '{"scripts":{"dev":"bun ../engine/cli/kiln.ts dev"}}');
  await Bun.write(join(root, "tsconfig.json"), '{"compilerOptions":{"paths":{"@kiln/engine":["../engine/src/index.ts"]}}}');
  await Bun.write(join(root, "assets/main.kiln.json"), '{"schema":"kiln.scene","key":"kiln.identity"}');
  await Bun.write(join(root, ".kiln/evidence.json"), '{"old":true}');
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("migration previews, backs up, preserves identity and archives generated evidence", async () => {
  const root = await fixture();
  const original = await readFile(join(root, "kiln.json"), "utf8");
  const plan = await planMigration(root, engine);
  expect(await Bun.file(join(root, "blackiron.json")).exists()).toBe(false);
  expect(await readFile(join(root, "kiln.json"), "utf8")).toBe(original);
  await expect(loadProject(root)).rejects.toThrow("migrate --apply");
  const backup = (await applyMigration(plan))!;
  expect(await readFile(join(backup, "files/kiln.json"), "utf8")).toBe(original);
  expect(await Bun.file(join(backup, "legacy-cache/evidence.json")).json()).toEqual({ old: true });
  expect(await Bun.file(join(root, "kiln.json")).exists()).toBe(false);
  const config = await Bun.file(join(root, "blackiron.json")).json();
  expect(config.name).toBe("Kiln Quest");
  expect(config.version).toBe("1.2.3");
  expect(config.buildNumber).toBe(4);
  expect(config.ios.bundleId).toBe("com.kiln.quest");
  expect(config.android.applicationId).toBe("com.kiln.quest");
  expect(await readFile(join(root, "src/main.ts"), "utf8")).toContain('@blackiron-studio/engine/app');
  expect(await readFile(join(root, "src/main.ts"), "utf8")).toContain('key: "kiln.quest"');
  expect(await Bun.file(join(root, "assets/main.blackiron.json")).json()).toEqual({ schema: "blackiron.scene", key: "kiln.identity" });
  expect(await readFile(join(root, "src/test.ts"), "utf8")).toContain(relative(join(root, "src"), engine) + "/src/index.ts");
  expect(await readFile(join(root, "package.json"), "utf8")).toContain(relative(root, engine) + "/cli/blackiron.ts");
  expect(await applyMigration(await planMigration(root, engine))).toBeNull();
});

test("migration rejects stale previews before changing source", async () => {
  const root = await fixture(), plan = await planMigration(root, engine);
  await Bun.write(join(root, "src/main.ts"), "edited after preview");
  await expect(applyMigration(plan)).rejects.toThrow("Source changed");
  expect(await Bun.file(join(root, "kiln.json")).exists()).toBe(true);
  expect(await Bun.file(join(root, "src/main.ts")).text()).toBe("edited after preview");
});

test("migration preserves implicit legacy bundle/application identities", async () => {
  const root = await fixture();
  await Bun.write(join(root, "kiln.json"), '{"name":"Wyrmdeck","entry":"src/main.ts"}');
  await applyMigration(await planMigration(root, engine));
  const config = await Bun.file(join(root, "blackiron.json")).json();
  expect(config.ios.bundleId).toBe("com.kiln.wyrmdeck");
  expect(config.android.applicationId).toBe("com.kiln.wyrmdeck");
});

test("migration rejects conflicting configs and scene destinations", async () => {
  const root = await fixture();
  await Bun.write(join(root, "blackiron.json"), "{}");
  await expect(planMigration(root, engine)).rejects.toThrow("Both");
  await rm(join(root, "blackiron.json"));
  await Bun.write(join(root, "assets/main.blackiron.json"), "{}");
  await expect(planMigration(root, engine)).rejects.toThrow("overwrite");
});

test("migration never traverses source or backup symlinks", async () => {
  const root = await fixture();
  await symlink(engine, join(root, "external"));
  await expect(planMigration(root, engine)).rejects.toThrow("symlinks");
  await rm(join(root, "external"));
  await mkdir(join(root, "backups"));
  await symlink(join(root, "backups"), join(root, ".blackiron"));
  await expect(planMigration(root, engine)).rejects.toThrow("backup directory");
});

test("migration rolls back changed source if cache archival fails", async () => {
  const root = await fixture(), plan = await planMigration(root, engine);
  const original = await Bun.file(join(root, "kiln.json")).text();
  await rm(join(root, ".kiln"), { recursive: true });
  await expect(applyMigration(plan)).rejects.toThrow();
  expect(await Bun.file(join(root, "kiln.json")).text()).toBe(original);
  expect(await Bun.file(join(root, "blackiron.json")).exists()).toBe(false);
  expect(await Bun.file(join(root, "src/main.ts")).text()).toContain("@kiln/engine");
});
