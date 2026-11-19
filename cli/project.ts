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
    (typeof config.version !== "string" || !/^\d+(\.\d+){0,2}$/.test(config.version))
  )
    // Apple's marketing version is one to three period-separated integers ("1.0" is common).
    throw Error("version must be major, major.minor or major.minor.patch");
  if (
    config.buildNumber !== undefined &&
    (!Number.isInteger(config.buildNumber) ||
      config.buildNumber < 1 ||
      config.buildNumber > 2100000000)
  )
    throw Error("buildNumber must be an integer from 1 to 2100000000");
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[^/:]+\.localhost)$/;

/** Fail before any build when the player-services config cannot work on a device. */
export function validateServices(config: Pick<BlackironConfig, "services" | "cloud">): void {
  const s = config.services as Partial<NonNullable<BlackironConfig["services"]>> | undefined;
  if (config.cloud !== undefined && typeof config.cloud !== "boolean") throw Error("cloud must be true or false");
  if (s === undefined) {
    if (config.cloud) throw Error('cloud: true needs a "services" block naming the backend, e.g. { "provider": "http", "url": "https://…" }');
    return;
  }
  if (!s || typeof s !== "object" || typeof s.provider !== "string" || !s.provider)
    throw Error('services.provider is required: "mock", "http", "apteva" or a name registered with registerProvider()');
  if (s.provider === "mock") return;
  if (typeof s.url !== "string" || !s.url)
    throw Error(`services.url is missing: the "${s.provider}" provider needs the backend's base URL`);
  let url: URL;
  try {
    url = new URL(s.url);
  } catch {
    throw Error(`services.url is not a URL: ${s.url}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOST.test(url.hostname)))
    throw Error("services.url must be https (http is allowed for localhost only): phones refuse cleartext connections");
  if (s.provider === "apteva" && (typeof s.game !== "string" || !s.game))
    throw Error('services.game is missing: the "apteva" provider needs the game id on the Apteva server');
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
  if (config.services?.provider === "mock")
    console.warn('  warning: services.provider is "mock": this export signs players in to nothing and keeps no cloud saves');
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
  validateServices(raw);
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
