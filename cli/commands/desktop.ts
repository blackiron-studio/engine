import { stageExport } from "../export-transaction.ts";
import { exportDirectory, requireTarget, xmlText } from "../export-support.ts";
// Desktop exports through the generic host (host/): a macOS app bundle, or a folder with the
// executable and the game next to it on Windows and Linux. `run desktop` builds and launches.

import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Args } from "../args.ts";
import { pascal, renderIcon } from "../icon.ts";
import { encodePNG } from "../png.ts";
import { type Project, loadProject, slug } from "../project.ts";
import { buildNative } from "./build.ts";

export const HOST_DIR = resolve(import.meta.dir, "..", "..", "host");

export type DesktopPlatform = "macos" | "windows" | "linux";

const TARGETS: Record<DesktopPlatform, { triple: string; exe: string }> = {
  macos: {
    triple:
      process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
    exe: "kiln-host",
  },
  windows: { triple: "x86_64-pc-windows-msvc", exe: "kiln-host.exe" },
  linux: { triple: "x86_64-unknown-linux-gnu", exe: "kiln-host" },
};

export function currentPlatform(): DesktopPlatform {
  return process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : "linux";
}

export function sh(
  cmd: string[],
  cwd: string,
  env: Record<string, string> = {},
): void {
  const p = Bun.spawnSync(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
  if (p.exitCode !== 0)
    throw new Error(`${cmd.join(" ")} failed (exit ${p.exitCode})`);
}

/**
 * Build the host executable for a platform with cargo; cross builds need that target's
 * toolchain. Desktops get V8 (a prebuilt library downloaded on the first build) unless
 * KILN_NO_V8 is set; QuickJS is always compiled in as the fallback.
 */
export function buildHost(platform: DesktopPlatform): string {
  const t = TARGETS[platform];
  const cross = platform !== currentPlatform();
  const args = [
    "cargo",
    "build",
    "--locked",
    "--release",
    "--bin",
    "kiln-host",
  ];
  if (!process.env.KILN_NO_V8) args.push("--features", "v8");
  if (cross) args.push("--target", t.triple);
  console.log(
    `  building the host for ${platform}${cross ? ` (${t.triple})` : ""}`,
  );
  sh(args, HOST_DIR);
  const exe = join(HOST_DIR, "target", cross ? t.triple : "", "release", t.exe);
  if (!existsSync(exe)) throw new Error(`host binary not found at ${exe}`);
  return exe;
}

export interface DesktopExport {
  dir: string;
  launch: string;
}

export async function exportDesktop(
  project: Project,
  opts: { platform?: DesktopPlatform; out?: string } = {},
): Promise<DesktopExport> {
  requireTarget(project, opts.platform ?? currentPlatform());
  const dir = exportDirectory(
    project,
    opts.out ?? `dist/desktop/${opts.platform ?? currentPlatform()}`,
  );
  let staged = "";
  const result = await stageExport(project, dir, async (stage) => {
    staged = stage;
    return buildDesktopExport(project, { ...opts, out: stage });
  });
  console.log(`  export ready: ${dir}`);
  return { ...result, dir, launch: result.launch.replace(staged, dir) };
}

async function buildDesktopExport(
  project: Project,
  opts: { platform?: DesktopPlatform; out?: string } = {},
): Promise<DesktopExport> {
  const platform = opts.platform ?? currentPlatform();
  requireTarget(project, platform);
  const name = pascal(project.config.name) || "Game";
  const dir = exportDirectory(project, opts.out ?? `dist/desktop/${platform}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const native = await buildNative(project, { out: join(dir, ".bundle") });
  const exe = buildHost(platform);
  if (platform === "macos") {
    const app = join(dir, `${name}.app`);
    const contents = join(app, "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(join(contents, "Resources"), { recursive: true });
    await cp(exe, join(contents, "MacOS", name));
    await cp(native.dir, join(contents, "Resources", "Kiln"), {
      recursive: true,
    });
    const bundleId =
      project.config.ios?.bundleId ??
      `com.kiln.${slug(project.config.name).replace(/-/g, "")}`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${xmlText(project.config.name)}</string>
  <key>CFBundleDisplayName</key><string>${xmlText(project.config.name)}</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${project.config.version ?? "1.0.0"}</string>
  <key>CFBundleVersion</key><string>${project.config.buildNumber ?? 1}</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
`;
    await Bun.write(join(contents, "Info.plist"), plist);
    const iconset = join(dir, "icon.iconset");
    await mkdir(iconset, { recursive: true });
    for (const [size, file] of [
      [512, "icon_512x512.png"],
      [1024, "icon_512x512@2x.png"],
      [256, "icon_256x256.png"],
      [128, "icon_128x128.png"],
    ] as const) {
      const { rgba } = await renderIcon(project, native.dir, size);
      await Bun.write(join(iconset, file), encodePNG(size, size, rgba));
    }
    const icns = Bun.spawnSync(
      [
        "iconutil",
        "-c",
        "icns",
        iconset,
        "-o",
        join(contents, "Resources", "icon.icns"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (icns.exitCode !== 0)
      console.warn("  iconutil failed; the app will have no icon");
    await rm(iconset, { recursive: true, force: true });
    await rm(native.dir, { recursive: true, force: true });
    return { dir, launch: join(contents, "MacOS", name) };
  }
  const exeName = platform === "windows" ? `${name}.exe` : name;
  await cp(exe, join(dir, exeName));
  await cp(native.dir, join(dir, "Kiln"), { recursive: true });
  await rm(native.dir, { recursive: true, force: true });
  const { rgba } = await renderIcon(project, join(dir, "Kiln"), 256);
  await Bun.write(join(dir, "icon.png"), encodePNG(256, 256, rgba));
  return { dir, launch: join(dir, exeName) };
}

export async function exportDesktopCommand(args: Args): Promise<void> {
  const project = await loadProject();
  const platform = args.str("platform", currentPlatform()) as DesktopPlatform;
  if (!TARGETS[platform])
    throw new Error(
      `Unknown platform "${platform}". Platforms: macos, windows, linux.`,
    );
  await exportDesktop(project, {
    platform,
    out: args.str("out", "") || undefined,
  });
}

/** Build the game and the host, then run it in a window. */
export async function runDesktop(args: Args): Promise<void> {
  const project = await loadProject();
  requireTarget(project, currentPlatform());
  const native = await buildNative(project);
  const exe = buildHost(currentPlatform());
  const cmd = [exe, native.dir];
  if (args.bool("fullscreen")) cmd.push("--fullscreen");
  const size = args.str("size", "");
  if (size) cmd.push("--size", size);
  const snapshot = args.str("snapshot", "");
  if (snapshot)
    cmd.push(
      "--snapshot",
      resolve(snapshot),
      "--snapshot-frame",
      args.str("snapshot-frame", "60"),
      "--exit",
    );
  const js = args.str("js", "");
  if (js) cmd.push("--js", js);
  console.log(`  running ${project.config.name} on ${currentPlatform()}`);
  const p = Bun.spawn(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await p.exited;
  if (code !== 0) throw new Error(`host exited with ${code}`);
}
