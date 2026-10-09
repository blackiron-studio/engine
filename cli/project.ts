import { EXPORT_TARGETS, type ExportTarget } from "./export-support.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BlackironConfig } from "../src/app/app.ts";
import { defaultConfig } from "../src/app/app.ts";
import type { Args } from "./args.ts";

export interface Project {
  root: string;
  config: BlackironConfig & { entry: string; targets?: ExportTarget[] };
  entryPath: string;
  artPath: string | null;
}

export interface ExportOverrides {
  version?: string;
  buildNumber?: number;
}

function validateReleaseMetadata(config: ExportOverrides): void {
  if (
    config.version !== undefined &&
    (typeof config.version !== "string" || !/^\d+\.\d+\.\d+$/.test(config.version))
  )
    throw Error("version must be major.minor.patch");
  if (
    config.buildNumber !== undefined &&
    (!Number.isInteger(config.buildNumber) ||
      config.buildNumber < 1 ||
      config.buildNumber > 2100000000)
  )
    throw Error("buildNumber must be an integer from 1 to 2100000000");
}

/** A supplied flag must have a nonempty value; never silently use a fallback. */
export function optionalStringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw Error(`--${name} requires a value`);
  return value;
}

export function exportOverridesFromArgs(args: Args): ExportOverrides {
  const version = optionalStringFlag(args, "version");
  const build = optionalStringFlag(args, "build-number");
  if (build !== undefined && !/^\d+$/.test(build))
    throw Error("--build-number must be a positive integer");
  const overrides = {
    version,
    buildNumber: build === undefined ? undefined : Number(build),
  };
  validateReleaseMetadata(overrides);
  return overrides;
}

/** Resolve export metadata without editing the saved project or mutating the caller. */
export function resolveExportProject(
  project: Project,
  overrides: ExportOverrides = {},
): Project {
  const config = {
    ...project.config,
    version: overrides.version ?? project.config.version ?? "1.0.0",
    buildNumber: overrides.buildNumber ?? project.config.buildNumber ?? 1,
  };
  validateReleaseMetadata(config);
  return { ...project, config };
}

/** Load `blackiron.json` from the working directory. */
export async function loadProject(cwd = process.cwd()): Promise<Project> {
  if (existsSync(resolve(cwd, "blackiron-engine.lock.json")))
    await (await import("./engine-lock.ts")).verifyEngineLock(cwd);
  const file = resolve(cwd, "blackiron.json");
  if (!existsSync(file) && existsSync(resolve(cwd, "kiln.json")))
    throw new Error('Legacy kiln.json project. Run "blackiron migrate --apply" before using this engine.');
  if (!existsSync(file))
    throw new Error(
      `No blackiron.json in ${cwd}. Run "blackiron new <dir>" to start a project.`,
    );
  const raw = (await Bun.file(file).json()) as Partial<BlackironConfig> & {
    targets?: ExportTarget[];
  };
  if (
    raw.targets &&
    (!Array.isArray(raw.targets) ||
      !raw.targets.length ||
      raw.targets.some((t) => !EXPORT_TARGETS.includes(t)))
  )
    throw new Error(
      "targets must contain web, native, macos, windows, linux, ios and/or android",
    );
  validateReleaseMetadata(raw);
  const base = defaultConfig();
  const config = {
    ...base,
    ...raw,
    viewport: { ...base.viewport, ...raw.viewport },
    post: { ...raw.post },
    entry: raw.entry ?? "src/main.ts",
  };
  const entryPath = resolve(cwd, config.entry);
  if (!existsSync(entryPath))
    throw new Error(`Entry "${config.entry}" does not exist`);
  const artPath = config.art ? resolve(cwd, config.art) : null;
  return { root: cwd, config, entryPath, artPath };
}

/** The subset of config the runtime needs, injected into the page. */
export function runtimeConfig(p: Project): Partial<BlackironConfig> {
  const { entry: _entry, art: _art, ...rest } = p.config;
  return rest;
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "game"
  );
}
