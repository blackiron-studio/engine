import { afterEach, test, expect } from "bun:test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProject, resolveExportProject, type Project } from "../cli/project.ts";
import { parseArgs } from "../cli/args.ts";
import { writeExportManifest } from "../cli/export-manifest.ts";
import { exportDirectory, supportsTarget } from "../cli/export-support.ts";
import { buildNative, buildProject } from "../cli/commands/build.ts";
import { exportIos, iosExportOptionsFromArgs, iosProjectYAML, resolveIosExportProject } from "../cli/commands/ios.ts";
import { exportAndroid } from "../cli/commands/android.ts";
import { exportDesktop } from "../cli/commands/desktop.ts";
import { singleFileResources } from "../cli/single-file.ts";
import { fetchResource } from "../src/platform/resources.ts";
const roots: string[] = [];
async function project(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "kiln-export-"));
  roots.push(root);
  await Bun.write(
    join(root, "kiln.json"),
    JSON.stringify({ name: "Export fixture", entry: "src/main.ts" }),
  );
  await Bun.write(
    join(root, "src/main.ts"),
    "export default function main() {}",
  );
  return loadProject(root);
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("target declarations distinguish individual platforms and native wildcard", async () => {
  const p = await project();
  expect(supportsTarget(p, "android")).toBe(true);
  p.config.targets = ["macos", "web"];
  expect(supportsTarget(p, "native")).toBe(true);
  expect(supportsTarget(p, "ios")).toBe(false);
  p.config.targets = ["native"];
  expect(supportsTarget(p, "windows")).toBe(true);
  expect(supportsTarget(p, "web")).toBe(false);
});
test("unsupported exports reject before touching existing output or invoking SDKs", async () => {
  const p = await project();
  p.config.targets = ["web"];
  const out = join(p.root, "dist", "keep");
  const sentinel = join(out, "save.txt");
  await Bun.write(sentinel, "keep");
  for (const action of [
    () => buildNative(p, { out }),
    () => exportIos(p, { out }),
    () => exportAndroid(p, { out }),
    () => exportDesktop(p, { out, platform: "macos" }),
  ]) {
    await expect(action()).rejects.toThrow("export is not available");
    expect(await Bun.file(sentinel).text()).toBe("keep");
  }
});
test("export output rejects source ancestors, descendants and symlink aliases", async () => {
  const p = await project();
  for (const out of [".", "..", "src", "src/generated", "assets/cache", ".git"])
    expect(() => exportDirectory(p, out)).toThrow();
  await symlink(join(p.root, "src"), join(p.root, "alias"));
  expect(() => exportDirectory(p, "alias/generated")).toThrow();
  const external = await mkdtemp(join(tmpdir(), "kiln-source-"));
  roots.push(external);
  await symlink(external, join(p.root, "assets"));
  expect(() => exportDirectory(p, join(external, "cache"))).toThrow();
  expect(exportDirectory(p, "dist/new/macos")).toBe(
    join(realpathSync(p.root), "dist/new/macos"),
  );
});
test("web rebuild preserves sibling platform packages while refreshing assets", async () => {
  const p = await project();
  await Bun.write(join(p.root, "dist/desktop/app/keep"), "native");
  await Bun.write(join(p.root, "dist/assets/obsolete"), "old");
  await buildProject(p);
  expect(await Bun.file(join(p.root, "dist/desktop/app/keep")).text()).toBe(
    "native",
  );
  expect(await Bun.file(join(p.root, "dist/assets/obsolete")).exists()).toBe(
    false,
  );
});
test("single-file resource registry round-trips binary and JSON through platform fetch", async () => {
  const p = await project();
  const dist = join(p.root, "dist");
  await Bun.write(join(dist, "assets/data.json"), '{"value":42}');
  await Bun.write(join(dist, "assets/blob.bin"), new Uint8Array([0, 255, 17]));
  for (const f of ["physics.wasm", "audio.wasm"])
    await Bun.write(join(dist, f), new Uint8Array([0, 97, 115, 109]));
  await Bun.write(
    join(p.root, "fonts.css"),
    '@font-face {font-family:"Local";src:url("face.ttf")}',
  );
  await Bun.write(join(p.root, "face.ttf"), new Uint8Array([1, 2, 3]));
  p.config.fonts = ["fonts.css"];
  const embedded = await singleFileResources(p, dist);
  expect(embedded.styles).toContain("data:font/ttf;base64,AQID");
  const global = globalThis as typeof globalThis & {
    KILN_BUNDLED_ASSETS?: Record<string, string>;
  };
  const previous = global.KILN_BUNDLED_ASSETS;
  try {
    global.KILN_BUNDLED_ASSETS = JSON.parse(
      embedded.script.slice(embedded.script.indexOf("=") + 1).split(";\n")[0],
    );
    expect(await (await fetchResource("assets/data.json")).json()).toEqual({
      value: 42,
    });
    expect([
      ...new Uint8Array(
        await (await fetchResource("assets/blob.bin")).arrayBuffer(),
      ),
    ]).toEqual([0, 255, 17]);
  } finally {
    if (previous) global.KILN_BUNDLED_ASSETS = previous;
    else delete global.KILN_BUNDLED_ASSETS;
  }
});

test("failed browser rebuild leaves the previous game and assets usable", async () => {
  const p = await project();
  await buildProject(p);
  const before = await Bun.file(join(p.root, "dist/assets/game.js")).text();
  await Bun.write(
    p.entryPath,
    "import './missing-file.ts'; export default function(){}",
  );
  await expect(buildProject(p)).rejects.toThrow();
  expect(await Bun.file(join(p.root, "dist/assets/game.js")).text()).toBe(
    before,
  );
  expect(await Bun.file(join(p.root, "dist/index.html")).exists()).toBe(true);
});
test("missing native fonts fail without replacing previous bundle", async () => {
  const p = await project();
  await Bun.write(join(p.root, "dist/native/manifest.json"), "original");
  p.config.fonts = ["missing.ttf"];
  await expect(buildNative(p)).rejects.toThrow("Font not found");
  expect(await Bun.file(join(p.root, "dist/native/manifest.json")).text()).toBe(
    "original",
  );
});
test("staged export rolls back partially published managed outputs", async () => {
  const { stageExport } = await import("../cli/export-transaction.ts");
  const p = await project();
  await Bun.write(join(p.root, "dist/a"), "before a");
  await Bun.write(join(p.root, "dist/b"), "before b");
  await expect(
    stageExport(
      p,
      "dist",
      async (stage) => {
        await Bun.write(join(stage, "a"), "after a");
      },
      ["a", "b"],
    ),
  ).rejects.toThrow();
  expect(await Bun.file(join(p.root, "dist/a")).text()).toBe("before a");
  expect(await Bun.file(join(p.root, "dist/b")).text()).toBe("before b");
});
test("project release metadata is validated", async () => {
  const p = await project();
  for (const config of [
    { version: "bad" },
    { buildNumber: 0 },
    { buildNumber: 1.5 },
  ]) {
    await Bun.write(
      join(p.root, "kiln.json"),
      JSON.stringify({ name: "fixture", entry: "src/main.ts", ...config }),
    );
    await expect(loadProject(p.root)).rejects.toThrow();
  }
});

test("iOS export CLI overrides config without modifying saved source or caller metadata", async () => {
  const p = await project();
  p.config.version = "2.3.4";
  p.config.buildNumber = 8;
  p.config.ios = { bundleId: "com.example.original", team: "ABCDE12345", signing: "automatic" };
  const before = JSON.stringify(p);
  const saved = await Bun.file(join(p.root, "kiln.json")).text();
  const args = parseArgs(["ios", "--version", "3.4.5", "--build-number=42", "--bundle-id", "com.example.release", "--team-id", "FGHIJ67890", "--signing", "external"]);
  const resolved = resolveIosExportProject(p, iosExportOptionsFromArgs(args));
  expect(resolved.config.version).toBe("3.4.5");
  expect(resolved.config.buildNumber).toBe(42);
  expect(resolved.config.ios).toEqual({ bundleId: "com.example.release", team: "FGHIJ67890", signing: "external" });
  expect(JSON.stringify(p)).toBe(before);
  expect(await Bun.file(join(p.root, "kiln.json")).text()).toBe(saved);
  const configured = resolveIosExportProject(p);
  expect(configured.config.version).toBe("2.3.4");
  expect(configured.config.buildNumber).toBe(8);
  expect(configured.config.ios?.signing).toBe("automatic");
});

test("export defaults leave signing available for an external builder", async () => {
  const p = await project();
  const resolved = resolveIosExportProject(p);
  expect(resolved.config.version).toBe("1.0.0");
  expect(resolved.config.buildNumber).toBe(1);
  expect(resolved.config.ios?.signing).toBe("external");
  const yaml = iosProjectYAML(resolved);
  expect(yaml).not.toContain("CODE_SIGNING_ALLOWED");
  expect(yaml).not.toContain("CODE_SIGN_IDENTITY");
  expect(yaml).not.toContain("CODE_SIGN_STYLE");
});

test("iOS plist uses overridable Xcode settings with resolved export defaults", async () => {
  const p = resolveIosExportProject(await project(), { version: "4.5.6", buildNumber: 123 });
  const yaml = Bun.YAML.parse(iosProjectYAML(p)) as any;
  const target = yaml.targets.ExportFixture;
  expect(target.info.properties.CFBundleShortVersionString).toBe("$(MARKETING_VERSION)");
  expect(target.info.properties.CFBundleVersion).toBe("$(CURRENT_PROJECT_VERSION)");
  expect(target.settings.base.MARKETING_VERSION).toBe("4.5.6");
  expect(target.settings.base.CURRENT_PROJECT_VERSION).toBe("123");
  expect(target.settings.base.TARGETED_DEVICE_FAMILY).toBe("1,2");
});

test("iOS signing modes produce independent Xcode policies", async () => {
  const p = await project();
  p.config.ios = { team: "ABCDE12345" };
  const settings = (signing?: "external" | "automatic" | "unsigned") => {
    const resolved = resolveIosExportProject(p, { signing });
    return (Bun.YAML.parse(iosProjectYAML(resolved)) as any).targets.ExportFixture.settings.base;
  };
  expect(settings().CODE_SIGN_STYLE).toBe("Automatic");
  expect(settings().DEVELOPMENT_TEAM).toBe("ABCDE12345");
  expect(settings("external").CODE_SIGN_STYLE).toBeUndefined();
  expect(settings("external").CODE_SIGNING_ALLOWED).toBeUndefined();
  expect(settings("unsigned").CODE_SIGNING_ALLOWED).toBe("NO");
  expect(settings("unsigned").CODE_SIGNING_REQUIRED).toBe("NO");
  expect(settings("unsigned").CODE_SIGN_IDENTITY).toBe("");
  p.config.ios = { signing: "automatic" };
  expect(settings().DEVELOPMENT_TEAM).toBeUndefined();
  expect(settings().CODE_SIGN_STYLE).toBe("Automatic");
});

test("invalid iOS export metadata fails before replacing output or invoking toolchains", async () => {
  const p = await project();
  const out = join(p.root, "dist/ios/keep");
  const sentinel = join(out, "keep.txt");
  await Bun.write(sentinel, "previous export");
  for (const opts of [
    { version: "invalid" }, { buildNumber: 0 }, { buildNumber: 1.2 },
    { bundleId: "com.example.*" }, { bundleId: "com.example\nsettings:" },
    { teamId: "bad" }, { signing: "invalid" as any },
  ]) {
    await expect(exportIos(p, { ...opts, out })).rejects.toThrow();
    expect(await Bun.file(sentinel).text()).toBe("previous export");
  }
});

test("iOS CLI rejects missing values and malformed build numbers", () => {
  for (const flags of [
    ["--version"], ["--build-number"], ["--bundle-id"], ["--team-id"], ["--signing"],
    ["--version="], ["--build-number=1e2"], ["--build-number=1.5"], ["--build-number=0"],
  ]) expect(() => iosExportOptionsFromArgs(parseArgs(flags))).toThrow();
});

test("generic export metadata validates configured values and supplies CLI defaults", async () => {
  const p = await project();
  expect(resolveExportProject(p).config.version).toBe("1.0.0");
  expect(resolveExportProject(p, { version: "7.8.9", buildNumber: 9 }).config.buildNumber).toBe(9);
  p.config.buildNumber = 0;
  expect(() => resolveExportProject(p)).toThrow();
});

test("export manifest contains portable paths and identifies engine and export defaults", async () => {
  const p = await project();
  const path = await writeExportManifest(join(p.root, "dist/ios"), {
    target: "ios", projectPath: "ExportFixture.xcodeproj", scheme: "ExportFixture",
    bundleId: "com.example.fixture", version: "1.2.3", buildNumber: 7, signing: "external",
  });
  const manifest = await Bun.file(path).json();
  expect(manifest.schema).toBe("kiln.export/v1");
  expect(manifest.engine).toEqual({ name: "@blackiron-studio/engine", version: (await Bun.file(join(import.meta.dir, "../package.json")).json()).version });
  expect(manifest.projectPath).toBe("ExportFixture.xcodeproj");
  expect(manifest.buildNumber).toBe(7);
  expect(JSON.stringify(manifest)).not.toContain(p.root);
});
