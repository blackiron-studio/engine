import { stageExport } from "../export-transaction.ts";
import { exportDirectory, requireTarget } from "../export-support.ts";
// `kiln export ios` writes an Xcode project around the native host; `kiln run ios` builds
// it for the simulator and launches it.

import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hexRgb, pascal, renderIcon } from "../icon.ts";
import { encodePNG } from "../png.ts";
import type { Args } from "../args.ts";
import {
  type ExportOverrides,
  type Project,
  exportOverridesFromArgs,
  loadProject,
  optionalStringFlag,
  resolveExportProject,
  slug,
} from "../project.ts";
import { writeExportManifest } from "../export-manifest.ts";
import { buildNative } from "./build.ts";

const HOST_DIR = resolve(import.meta.dir, "..", "..", "native", "ios");

const KERNEL_DIR = resolve(HOST_DIR, "..", "..", "kernel");

/** The compiled kernel for Apple targets, built with `bun kernel/build.ts` when missing. */
async function kernelFramework(): Promise<string> {
  const out = join(KERNEL_DIR, "dist", "KilnKernel.xcframework");
  // Cargo checks source and dependency freshness on every export.
  console.log("  building the kernel for iOS (cargo)");
  const p = Bun.spawnSync(
    [process.execPath, join(KERNEL_DIR, "build.ts"), "--ios-only"],
    { cwd: KERNEL_DIR, stdout: "inherit", stderr: "inherit" },
  );
  if (p.exitCode !== 0 || !existsSync(out))
    throw new Error(
      "kernel build failed; install Rust (rustup) with the aarch64-apple-ios and aarch64-apple-ios-sim targets, then run: bun kernel/build.ts",
    );
  return out;
}

/** App icon from a sprite over the background colour, plus a launch-screen colour. */
async function writeAssets(
  project: Project,
  dir: string,
  nativeDir: string,
): Promise<void> {
  const bg = hexRgb(
    project.config.background as string | number | undefined,
    [16, 16, 24],
  );
  const size = 1024;
  const { rgba: icon, sprite } = await renderIcon(project, nativeDir, size);
  if (sprite) console.log(`  app icon from sprite "${sprite}"`);
  const assets = join(dir, "Assets.xcassets");
  await mkdir(join(assets, "AppIcon.appiconset"), { recursive: true });
  await mkdir(join(assets, "LaunchBackground.colorset"), { recursive: true });
  await Bun.write(
    join(assets, "Contents.json"),
    JSON.stringify({ info: { author: "xcode", version: 1 } }),
  );
  await Bun.write(
    join(assets, "AppIcon.appiconset", "icon.png"),
    encodePNG(size, size, icon),
  );
  await Bun.write(
    join(assets, "AppIcon.appiconset", "Contents.json"),
    JSON.stringify({
      images: [
        {
          filename: "icon.png",
          idiom: "universal",
          platform: "ios",
          size: "1024x1024",
        },
      ],
      info: { author: "xcode", version: 1 },
    }),
  );
  const color = {
    "color-space": "srgb",
    components: {
      red: (bg[0] / 255).toFixed(3),
      green: (bg[1] / 255).toFixed(3),
      blue: (bg[2] / 255).toFixed(3),
      alpha: "1.000",
    },
  };
  await Bun.write(
    join(assets, "LaunchBackground.colorset", "Contents.json"),
    JSON.stringify({
      colors: [{ idiom: "universal", color }],
      info: { author: "xcode", version: 1 },
    }),
  );
}

export type IosSigningMode = "external" | "automatic" | "unsigned";

export interface IosExportOptions extends ExportOverrides {
  out?: string;
  bundleId?: string;
  teamId?: string;
  signing?: IosSigningMode;
}

export function iosExportOptionsFromArgs(args: Args): IosExportOptions {
  return {
    ...exportOverridesFromArgs(args),
    out: optionalStringFlag(args, "out"),
    bundleId: optionalStringFlag(args, "bundle-id"),
    teamId: optionalStringFlag(args, "team-id"),
    signing: optionalStringFlag(args, "signing") as IosSigningMode | undefined,
  };
}

export function resolveIosExportProject(
  project: Project,
  opts: IosExportOptions = {},
): Project {
  const resolved = resolveExportProject(project, opts);
  const ios = { ...resolved.config.ios };
  ios.bundleId = opts.bundleId ?? ios.bundleId ??
    `com.kiln.${slug(resolved.config.name).replace(/-/g, "")}`;
  ios.team = opts.teamId ?? ios.team;
  ios.signing = opts.signing ?? ios.signing ?? (ios.team ? "automatic" : "external");
  if (
    typeof ios.bundleId !== "string" || ios.bundleId.length > 255 ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(ios.bundleId)
  )
    throw Error("iOS bundle ID must contain dot-separated letters, digits or hyphens, without wildcards");
  if (
    ios.team !== undefined &&
    (typeof ios.team !== "string" || !/^[A-Z0-9]{10}$/.test(ios.team))
  )
    throw Error("iOS team ID must contain exactly 10 uppercase letters or digits");
  if (!["external", "automatic", "unsigned"].includes(ios.signing))
    throw Error("iOS signing must be external, automatic or unsigned");
  resolved.config.ios = ios;
  return resolved;
}

export interface IosExport {
  dir: string;
  target: string;
  bundleId: string;
  projectPath: string;
  manifestPath: string;
}

export async function exportIos(
  project: Project,
  opts: IosExportOptions = {},
): Promise<IosExport> {
  requireTarget(project, "ios");
  project = resolveIosExportProject(project, opts);
  const dir = exportDirectory(
    project,
    opts.out ?? `dist/ios/${pascal(project.config.name) || "Game"}`,
  );
  let staged = "";
  const result = await stageExport(project, dir, async (stage) => {
    staged = stage;
    return buildIosExport(project, { ...opts, out: stage });
  });
  console.log(`  export ready: ${dir}`);
  return {
    ...result,
    dir,
    projectPath: result.projectPath.replace(staged, dir),
    manifestPath: result.manifestPath.replace(staged, dir),
  };
}

async function buildIosExport(
  project: Project,
  opts: { out?: string } = {},
): Promise<IosExport> {
  requireTarget(project, "ios");
  const ios = project.config.ios ?? {};
  const target = pascal(project.config.name) || "Game";
  const bundleId =
    ios.bundleId ?? `com.kiln.${slug(project.config.name).replace(/-/g, "")}`;
  const dir = exportDirectory(project, opts.out ?? `dist/ios/${target}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const native = await buildNative(project, { out: join(dir, "Kiln") });
  await cp(join(HOST_DIR, "Sources"), join(dir, "Sources"), {
    recursive: true,
  });
  await cp(
    await kernelFramework(),
    join(dir, "Kernel", "KilnKernel.xcframework"),
    { recursive: true },
  );
  await writeAssets(project, dir, native.dir);

  const yml = iosProjectYAML(project);
  await Bun.write(join(dir, "project.yml"), yml);
  const projectPath = join(dir, `${target}.xcodeproj`);
  const gen = Bun.spawnSync(["xcodegen", "generate"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (gen.exitCode !== 0) {
    const msg =
      new TextDecoder().decode(gen.stderr) ||
      new TextDecoder().decode(gen.stdout);
    throw new Error(
      `xcodegen failed (is it installed? brew install xcodegen):\n${msg}`,
    );
  }
  const manifestPath = await writeExportManifest(dir, {
    target: "ios",
    projectPath: `${target}.xcodeproj`,
    scheme: target,
    bundleId,
    version: project.config.version!,
    buildNumber: project.config.buildNumber!,
    signing: ios.signing!,
    ...(ios.team ? { teamId: ios.team } : {}),
  });
  return { dir, target, bundleId, projectPath, manifestPath };
}

/** Pure project generation, shared by the exporter and contract tests. */
export function iosProjectYAML(input: Project): string {
  const project = resolveIosExportProject(input);
  const ios = project.config.ios!;
  const target = pascal(project.config.name) || "Game";
  const bundleId = ios.bundleId!;
  const signingSettings: string[] = [];
  if (ios.team) signingSettings.push(`DEVELOPMENT_TEAM: ${ios.team}`);
  if (ios.signing === "automatic") signingSettings.push("CODE_SIGN_STYLE: Automatic");
  else if (ios.signing === "unsigned")
    signingSettings.push('CODE_SIGN_IDENTITY: ""', 'CODE_SIGNING_REQUIRED: "NO"', 'CODE_SIGNING_ALLOWED: "NO"');

  const orientation =
    ios.orientation ??
    (project.config.viewport.width >= project.config.viewport.height
      ? "landscape"
      : "portrait");
  const orientations =
    orientation === "landscape"
      ? [
          "UIInterfaceOrientationLandscapeLeft",
          "UIInterfaceOrientationLandscapeRight",
        ]
      : orientation === "portrait"
        ? ["UIInterfaceOrientationPortrait"]
        : [
            "UIInterfaceOrientationPortrait",
            "UIInterfaceOrientationLandscapeLeft",
            "UIInterfaceOrientationLandscapeRight",
          ];
  return `name: ${target}
options:
  bundleIdPrefix: ${bundleId.split(".").slice(0, -1).join(".") || "com.kiln"}
  deploymentTarget:
    iOS: "${ios.minVersion ?? "16.0"}"
  createIntermediateGroups: true
targets:
  ${target}:
    type: application
    platform: iOS
    sources:
      - path: Sources
      - path: Assets.xcassets
      - path: Kiln
        type: folder
        buildPhase: resources
    dependencies:
      - framework: Kernel/KilnKernel.xcframework
        embed: false
      - sdk: Metal.framework
      - sdk: QuartzCore.framework
      - sdk: CoreGraphics.framework
    info:
      path: Info.plist
      properties:
        CFBundleDisplayName: ${JSON.stringify(project.config.name)}
        CFBundleShortVersionString: "$(MARKETING_VERSION)"
        CFBundleVersion: "$(CURRENT_PROJECT_VERSION)"
        UILaunchScreen:
          UIColorName: LaunchBackground
        UIRequiresFullScreen: true
        UIStatusBarHidden: true
        UIViewControllerBasedStatusBarAppearance: true
        UISupportedInterfaceOrientations: [${orientations.join(", ")}]
        UISupportedInterfaceOrientations~ipad: [${orientations.join(", ")}]
        UIApplicationSceneManifest:
          UIApplicationSupportsMultipleScenes: false
          UISceneConfigurations:
            UIWindowSceneSessionRoleApplication:
              - UISceneConfigurationName: Default
                UISceneDelegateClassName: $(PRODUCT_MODULE_NAME).SceneDelegate
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}
        TARGETED_DEVICE_FAMILY: "1,2"
        ARCHS: arm64
        SWIFT_VERSION: "5.10"
        GENERATE_INFOPLIST_FILE: false
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        MARKETING_VERSION: "${project.config.version}"
        CURRENT_PROJECT_VERSION: "${project.config.buildNumber}"
${signingSettings.map((setting) => `        ${setting}`).join("\n")}
`;
}

export async function exportIosCommand(args: Args): Promise<void> {
  const project = await loadProject();
  const out = await exportIos(project, iosExportOptionsFromArgs(args));
  console.log(
    `\n  open ${out.projectPath.replace(project.root + "/", "")}   # or: kiln run ios\n`,
  );
}

function sh(cmd: string[], cwd?: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out =
    new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
  return { ok: p.exitCode === 0, out };
}

export interface IosBuild {
  app: string;
  bundleId: string;
  target: string;
}

/** Export and build for the iOS Simulator; the app path is ready for `simctl install`. */
export async function buildIosApp(
  project: Project,
  device: string,
): Promise<IosBuild> {
  const exp = await exportIos(project, { signing: "unsigned" });
  console.log(
    `  building ${exp.target} for ${device} (this takes a minute the first time)`,
  );
  // Build products live outside the export folder, so re-exporting keeps the build incremental.
  const derived = join(project.root, ".kiln", "ios-build");
  const build = sh(
    [
      "xcodebuild",
      "-project",
      exp.projectPath,
      "-scheme",
      exp.target,
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "-destination",
      `platform=iOS Simulator,name=${device}`,
      "-derivedDataPath",
      derived,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    exp.dir,
  );
  if (!build.ok) {
    const errors = build.out
      .split("\n")
      .filter((l) => /error:/.test(l))
      .slice(0, 20)
      .join("\n");
    throw new Error(`xcodebuild failed:\n${errors || build.out.slice(-3000)}`);
  }
  const app = join(
    derived,
    "Build",
    "Products",
    "Debug-iphonesimulator",
    `${exp.target}.app`,
  );
  if (!existsSync(app)) throw new Error(`Built app not found at ${app}`);
  return { app, bundleId: exp.bundleId, target: exp.target };
}

/** Boot the simulator and install the app. A reinstall gives the app a fresh data container. */
export function installIosApp(device: string, built: IosBuild): void {
  sh(["xcrun", "simctl", "boot", device]);
  sh(["open", "-a", "Simulator"]);
  sh(["xcrun", "simctl", "terminate", device, built.bundleId]);
  const install = sh(["xcrun", "simctl", "install", device, built.app]);
  if (!install.ok) throw new Error(`simctl install failed:\n${install.out}`);
}

/** Launch the installed app; `env` reaches the process as-is. */
export function launchIosApp(
  device: string,
  built: IosBuild,
  env: Record<string, string> = {},
): void {
  sh(["xcrun", "simctl", "terminate", device, built.bundleId]);
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) childEnv[`SIMCTL_CHILD_${k}`] = v;
  const p = Bun.spawnSync(
    ["xcrun", "simctl", "launch", device, built.bundleId],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...childEnv } },
  );
  if (p.exitCode !== 0)
    throw new Error(
      `simctl launch failed:\n${new TextDecoder().decode(p.stderr)}`,
    );
}

/** Build for the iOS Simulator and launch on the chosen device. */
export async function runIos(args: Args): Promise<void> {
  const project = await loadProject();
  const device = args.str("device", "iPhone 17 Pro");
  const built = await buildIosApp(project, device);
  installIosApp(device, built);
  launchIosApp(device, built);
  console.log(`  launched ${built.bundleId} on ${device}`);
}
