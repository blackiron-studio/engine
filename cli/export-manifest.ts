import { join } from "node:path";

/** Export defaults and relative paths. Final binaries may use build-system overrides. */
export interface ExportManifest {
  schema: "blackiron.export/v1";
  engine: { name: string; version: string };
  target: string;
  projectPath: string;
  scheme: string;
  bundleId: string;
  version: string;
  buildNumber: number;
  signing: "external" | "automatic" | "unsigned";
  teamId?: string;
}

export async function writeExportManifest(
  dir: string,
  metadata: Omit<ExportManifest, "schema" | "engine">,
): Promise<string> {
  const engine = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
  const manifest: ExportManifest = {
    schema: "blackiron.export/v1",
    engine: { name: engine.name, version: engine.version },
    ...metadata,
  };
  const path = join(dir, "blackiron-export.json");
  await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
  return path;
}
