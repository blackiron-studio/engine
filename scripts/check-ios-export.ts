/** Export through the CLI, relocate away from source, and verify real Xcode overrides. */
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

if (process.platform !== "darwin") throw Error("iOS export acceptance requires macOS and Xcode");
const engine = resolve(import.meta.dir, "..");
const evidence = join(engine, ".kiln/verification/ios-export-contract");
await mkdir(evidence, { recursive: true });
const source = await mkdtemp(join(tmpdir(), "kiln-ios-source-"));
const relocated = await mkdtemp(join(tmpdir(), "kiln-ios-relocated-"));
let log = "";
async function run(command: string[], cwd: string): Promise<string> {
  console.log(`  checking ${command[0]} ${command[1] ?? ""}`);
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  log += `$ ${command.join(" ")}\n${out}${err}\n`;
  await Bun.write(join(evidence, "build.log"), log);
  if (code !== 0) throw Error(`Command failed (${code}): ${out.slice(-3000)}${err.slice(-3000)}`);
  return out;
}
try {
  const config = JSON.stringify({ name: "Export contract", version: "0.1.0", buildNumber: 1, entry: "main.ts", targets: ["ios"] });
  await Bun.write(join(source, "kiln.json"), config);
  await Bun.write(join(source, "main.ts"), "export default function main() {}\n");
  await run([process.execPath, join(engine, "cli/kiln.ts"), "export", "ios",
    "--out", "generated/ios", "--version", "1.2.3", "--build-number", "7",
    "--bundle-id", "com.example.exportcontract", "--signing", "external"], source);
  assert.equal(await Bun.file(join(source, "kiln.json")).text(), config);
  const exported = join(source, "generated/ios");
  const manifest = await Bun.file(join(exported, "kiln-export.json")).json();
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.buildNumber, 7);
  assert.equal(manifest.bundleId, "com.example.exportcontract");
  assert.equal(manifest.signing, "external");
  assert.equal(manifest.projectPath, "ExportContract.xcodeproj");
  const native = await Bun.file(join(exported, "Kiln/manifest.json")).json();
  assert.equal(native.config.version, "1.2.3");
  assert.equal(native.config.buildNumber, 7);
  await cp(exported, join(relocated, "export"), { recursive: true });
  await rm(source, { recursive: true, force: true });
  const root = join(relocated, "export");
  const project = join(root, manifest.projectPath);
  const settings = await run(["xcodebuild", "-project", project, "-scheme", manifest.scheme,
    "-configuration", "Release", "-sdk", "iphonesimulator", "-showBuildSettings"], root);
  assert.match(settings, /CODE_SIGNING_ALLOWED = YES/);
  assert.match(settings, /MARKETING_VERSION = 1\.2\.3/);
  assert.match(settings, /CURRENT_PROJECT_VERSION = 7/);
  const overrides = ["CODE_SIGNING_ALLOWED=NO", "MARKETING_VERSION=9.8.7",
    "CURRENT_PROJECT_VERSION=42", "PRODUCT_BUNDLE_IDENTIFIER=com.example.relocated"];
  const derived = join(evidence, "DerivedData");
  const base = ["xcodebuild", "-project", project, "-scheme", manifest.scheme,
    "-configuration", "Release", "-derivedDataPath", derived];
  await run([...base, "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", ...overrides, "build"], root);
  const simulatorApp = join(derived, "Build/Products/Release-iphonesimulator/ExportContract.app");
  const archive = join(evidence, "ExportContract.xcarchive");
  await run([...base, "-sdk", "iphoneos", "-destination", "generic/platform=iOS",
    "-archivePath", archive, ...overrides, "archive"], root);
  const archiveApp = join(archive, "Products/Applications/ExportContract.app");
  for (const app of [simulatorApp, archiveApp]) {
    const plist = JSON.parse(await run(["plutil", "-convert", "json", "-o", "-", join(app, "Info.plist")], root));
    assert.equal(plist.CFBundleShortVersionString, "9.8.7");
    assert.equal(plist.CFBundleVersion, "42");
    assert.equal(plist.CFBundleIdentifier, "com.example.relocated");
    assert.equal(await Bun.file(join(app, "Kiln/game.js")).exists(), true);
  }
  const report = {
    status: "PASS", export: manifest,
    checks: ["CLI overrides and unchanged configuration", "native bundle metadata", "self-contained relocated project",
      "external signing remains enabled", "simulator build", "unsigned device archive", "final plist version/build/identity overrides"],
    built: { version: "9.8.7", buildNumber: "42", bundleId: "com.example.relocated" },
    signingVerified: false,
  };
  await Bun.write(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(source, { recursive: true, force: true });
  await rm(relocated, { recursive: true, force: true });
}
