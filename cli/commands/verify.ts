import { supportsTarget } from "../export-support.ts";
// The visual test harness: render each project's snapshot scenarios on a host with a fixed
// clock and scripted taps, then compare the pixels with the golden images kept in the
// project. `--update` accepts the current renders as the new goldens.
//
//   blackiron verify                       every project (or the current one), desktop host
//   blackiron verify --host ios            the iOS Simulator (device: --device)
//   blackiron verify --host android        the connected Android device or emulator
//   blackiron verify --host all            all three
//   blackiron verify --js quickjs          desktop renders with QuickJS instead of the build's default (V8)
//
// Goldens live in <project>/snapshots/<host>/<name>.png. A failing comparison writes
// <name>.actual.png and <name>.diff.png next to the golden.

import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SnapshotSpec } from "../../src/app/app.ts";
import { resetSpriteRegistry } from "../../src/art/index.ts";
import type { Args } from "../args.ts";
import { decodePNG, encodePNG } from "../png.ts";
import { type Project, loadProject } from "../project.ts";
import { adbFor, buildAndroidApk, launchAndroidApp } from "./android.ts";
import { buildNative } from "./build.ts";
import { buildHost, currentPlatform } from "./desktop.ts";
import { buildIosApp, installIosApp, launchIosApp } from "./ios.ts";

export type VerifyHost = "desktop" | "ios" | "android";

const ENGINE_ROOT = resolve(import.meta.dir, "..", "..");
/** 60 frames per second of synthetic time. */
const FIXED_DT = 1000 / 60;

interface Outcome {
  project: string;
  host: VerifyHost;
  name: string;
  status: "pass" | "fail" | "new" | "updated" | "error";
  detail?: string;
}

function scenarios(project: Project): SnapshotSpec[] {
  const list = project.config.snapshots;
  return list && list.length ? list : [{ name: "title", frame: 40 }];
}

/** Projects to verify: the current directory when it holds a blackiron.json, else the demo, bench and starters. */
async function projects(args: Args): Promise<Project[]> {
  const explicit = args._.filter((a) => a !== "verify");
  if (explicit.length) return Promise.all(explicit.map((d) => loadProject(resolve(d))));
  if (existsSync(resolve(process.cwd(), "blackiron.json"))) return [await loadProject()];
  const dirs: string[] = [];
  for (const group of ["examples", "templates"]) {
    const base = join(ENGINE_ROOT, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) if (existsSync(join(base, d, "blackiron.json"))) dirs.push(join(base, d));
  }
  return Promise.all(dirs.map((d) => loadProject(d)));
}

interface Comparison {
  differing: number;
  total: number;
  diff: Uint8Array;
  width: number;
  height: number;
  sizeMismatch?: string;
}

/** Pixels whose largest channel difference exceeds 32 count as differing. */
export function compareImages(a: { width: number; height: number; rgba: Uint8Array }, b: { width: number; height: number; rgba: Uint8Array }): Comparison {
  if (a.width !== b.width || a.height !== b.height) {
    return { differing: a.width * a.height, total: a.width * a.height, diff: new Uint8Array(0), width: a.width, height: a.height, sizeMismatch: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  const total = a.width * a.height;
  const diff = new Uint8Array(total * 4);
  let differing = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(a.rgba[o] - b.rgba[o]), Math.abs(a.rgba[o + 1] - b.rgba[o + 1]), Math.abs(a.rgba[o + 2] - b.rgba[o + 2]));
    const grey = Math.round((a.rgba[o] + a.rgba[o + 1] + a.rgba[o + 2]) / 3) >> 2;
    if (d > 32) {
      differing++;
      diff[o] = 255;
      diff[o + 1] = 40;
      diff[o + 2] = 40;
    } else {
      diff[o] = grey;
      diff[o + 1] = grey;
      diff[o + 2] = grey;
    }
    diff[o + 3] = 255;
  }
  return { differing, total, diff, width: a.width, height: a.height };
}

/** Native bundles by project root: built once per run, since a project's art module only loads once per process. */
const bundles = new Map<string, string>();

async function bundleFor(project: Project): Promise<string> {
  let dir = bundles.get(project.root);
  if (!dir) {
    // Every project defines its own sprites; the registry is global to this process.
    resetSpriteRegistry();
    dir = (await buildNative(project, { out: join(project.root, ".blackiron", "verify-bundle") })).dir;
    bundles.set(project.root, dir);
  }
  return dir;
}

async function renderDesktop(project: Project, spec: SnapshotSpec, out: string, js: string): Promise<void> {
  const bundle = await bundleFor(project);
  const exe = buildHost(currentPlatform());
  const vp = project.config.viewport;
  const cmd = [exe, bundle, "--size", `${vp.width}x${vp.height}`, "--snapshot", out, "--snapshot-frame", String(spec.frame ?? 40), "--exit", "--fixed-dt", String(FIXED_DT)];
  if (js) cmd.push("--js", js);
  for (const t of spec.taps ?? []) cmd.push("--tap", t);
  // A frame the game never reaches (an exception every frame, say) would otherwise hang the run.
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, RUST_LOG: "warn" }, timeout: 120_000, killSignal: "SIGKILL" });
  if (p.exitCode !== 0 || !existsSync(out)) throw new Error(`host failed (exit ${p.exitCode}): ${new TextDecoder().decode(p.stderr).slice(-800)}`);
}

let iosBuilt: Awaited<ReturnType<typeof buildIosApp>> | null = null;
let iosBuiltFor = "";

async function renderIos(project: Project, spec: SnapshotSpec, out: string, device: string): Promise<void> {
  if (!iosBuilt || iosBuiltFor !== project.root) {
    resetSpriteRegistry();
    iosBuilt = await buildIosApp(project, device);
    iosBuiltFor = project.root;
    // Install before asking for the data container: a reinstall moves it.
    installIosApp(device, iosBuilt);
  }
  const container = Bun.spawnSync(["xcrun", "simctl", "get_app_container", device, iosBuilt.bundleId, "data"], { stdout: "pipe", stderr: "pipe" });
  const dataDir = new TextDecoder().decode(container.stdout).trim();
  if (!dataDir) throw new Error("could not find the app's data container");
  const file = join(dataDir, "Documents", `${spec.name}.png`);
  await rm(file, { force: true });
  if (process.env.BLACKIRON_VERBOSE) console.log(`    container ${dataDir}\n    waiting for ${file}`);
  launchIosApp(device, iosBuilt, { BLACKIRON_SNAPSHOT: file, BLACKIRON_SNAPSHOT_FRAME: String(spec.frame ?? 40), BLACKIRON_FIXED_DT: String(FIXED_DT), BLACKIRON_TAPS: (spec.taps ?? []).join(";") });
  const deadline = Date.now() + 90_000;
  while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(250);
  await Bun.sleep(300);
  Bun.spawnSync(["xcrun", "simctl", "terminate", device, iosBuilt.bundleId]);
  if (!existsSync(file)) throw new Error("the app wrote no snapshot within 90 s");
  await Bun.write(out, Bun.file(file));
}

let androidBuilt: Awaited<ReturnType<typeof buildAndroidApk>> | null = null;
let androidBuiltFor = "";

async function renderAndroid(project: Project, spec: SnapshotSpec, out: string, serial: string): Promise<void> {
  if (!androidBuilt || androidBuiltFor !== project.root) {
    resetSpriteRegistry();
    androidBuilt = await buildAndroidApk(project);
    androidBuiltFor = project.root;
  }
  const adb = adbFor(serial);
  const file = `${spec.name}.png`;
  Bun.spawnSync([...adb, "shell", "run-as", androidBuilt.applicationId, "rm", "-f", `files/${file}`]);
  launchAndroidApp(androidBuilt, serial, { BLACKIRON_SNAPSHOT: file, BLACKIRON_SNAPSHOT_FRAME: String(spec.frame ?? 40), BLACKIRON_FIXED_DT: String(FIXED_DT), BLACKIRON_TAPS: (spec.taps ?? []).join(";"), BLACKIRON_SNAPSHOT_EXIT: "1" });
  const deadline = Date.now() + 90_000;
  let bytes: Uint8Array | null = null;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    const p = Bun.spawnSync([...adb, "exec-out", "run-as", androidBuilt.applicationId, "cat", `files/${file}`], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode === 0 && p.stdout.length > 100) {
      bytes = new Uint8Array(p.stdout);
      break;
    }
  }
  Bun.spawnSync([...adb, "shell", "am", "force-stop", androidBuilt.applicationId]);
  if (!bytes) throw new Error("the app wrote no snapshot within 90 s");
  await Bun.write(out, bytes);
}

export async function verify(args: Args): Promise<void> {
  const hostArg = args.str("host", "desktop");
  const hosts: VerifyHost[] = hostArg === "all" ? ["desktop", "ios", "android"] : [hostArg as VerifyHost];
  for (const h of hosts) if (!["desktop", "ios", "android"].includes(h)) throw new Error(`Unknown host "${h}". Hosts: desktop, ios, android, all.`);
  const update = args.bool("update");
  const only = args.str("only", "");
  const tolerance = Number(args.str("tolerance", "0.005"));
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw new Error("tolerance must be between 0 and 1");
  const device = args.str("device", "iPhone 17 Pro");
  const serial = args.str("serial", "");
  const js = args.str("js", "");
  const list = await projects(args);
  const outcomes: Outcome[] = [];
  let skipped = 0;
  for (const project of list) {
    for (const host of hosts) {
      if (!supportsTarget(project, host === "desktop" ? currentPlatform() : host)) {
        console.log(`  SKIP ${project.config.name} / ${host}: declared targets ${project.config.targets?.join(", ")}`);
        skipped++;
        continue;
      }
      const goldenDir = join(project.root, "snapshots", host);
      await mkdir(goldenDir, { recursive: true });
      for (const spec of scenarios(project)) {
        if (only && spec.name !== only) continue;
        const golden = join(goldenDir, `${spec.name}.png`);
        const actual = join(goldenDir, `${spec.name}.actual.png`);
        const diffPath = join(goldenDir, `${spec.name}.diff.png`);
        const label = `${project.config.name} / ${host} / ${spec.name}`;
        try {
          console.log(`  rendering ${label}`);
          if (host === "desktop") await renderDesktop(project, spec, actual, js);
          else if (host === "ios") await renderIos(project, spec, actual, device);
          else await renderAndroid(project, spec, actual, serial);
          if (!update && !existsSync(golden)) {
            outcomes.push({ project: project.config.name, host, name: spec.name, status: "fail", detail: "Missing golden; inspect .actual.png, then run --update to accept it" });
            continue;
          }
          if (update) {
            const existed = existsSync(golden);
            await Bun.write(golden, Bun.file(actual));
            await rm(actual, { force: true });
            await rm(diffPath, { force: true });
            outcomes.push({ project: project.config.name, host, name: spec.name, status: existed ? "updated" : "new" });
            continue;
          }
          const a = decodePNG(new Uint8Array(await Bun.file(actual).arrayBuffer()));
          const g = decodePNG(new Uint8Array(await Bun.file(golden).arrayBuffer()));
          const cmp = compareImages(a, g);
          const ratio = cmp.total ? cmp.differing / cmp.total : 1;
          if (cmp.sizeMismatch || ratio > tolerance) {
            if (cmp.diff.length) await Bun.write(diffPath, encodePNG(cmp.width, cmp.height, cmp.diff));
            outcomes.push({ project: project.config.name, host, name: spec.name, status: "fail", detail: cmp.sizeMismatch ?? `${(ratio * 100).toFixed(2)}% of pixels differ (tolerance ${(tolerance * 100).toFixed(2)}%)` });
          } else {
            await rm(actual, { force: true });
            await rm(diffPath, { force: true });
            outcomes.push({ project: project.config.name, host, name: spec.name, status: "pass", detail: `${(ratio * 100).toFixed(2)}% differ` });
          }
        } catch (err) {
          outcomes.push({ project: project.config.name, host, name: spec.name, status: "error", detail: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  console.log("");
  let failed = 0;
  for (const o of outcomes) {
    const mark = o.status === "pass" ? "ok  " : o.status === "fail" || o.status === "error" ? "FAIL" : o.status === "new" ? "new " : "upd ";
    if (o.status === "fail" || o.status === "error") failed++;
    console.log(`  ${mark} ${o.project} / ${o.host} / ${o.name}${o.detail ? `   ${o.detail}` : ""}`);
  }
  console.log(`\n  ${outcomes.filter(o => o.status === "pass").length} passed, ${outcomes.filter(o => o.status === "updated" || o.status === "new").length} baselines written, ${failed} failed, ${skipped} unsupported targets skipped`);
  if (failed) process.exit(1);
}
