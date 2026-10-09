import { resolve, relative, isAbsolute, basename } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import type { Project } from "./project.ts";
export const EXPORT_TARGETS = [
  "web",
  "native",
  "macos",
  "windows",
  "linux",
  "ios",
  "android",
] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];
export function supportsTarget(
  project: Project,
  target: ExportTarget,
): boolean {
  const targets = project.config.targets;
  if (!targets) return true;
  if (target === "native") return targets.some((t) => t !== "web");
  return (
    targets.includes(target) || (target !== "web" && targets.includes("native"))
  );
}
export function requireTarget(project: Project, target: ExportTarget): void {
  if (!supportsTarget(project, target))
    throw new Error(
      `${project.config.name} declares targets ${project.config.targets!.join(", ")}; ${target} export is not available`,
    );
}
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = resolve(path, "..");
  return parent === path ? path : resolve(canonical(parent), basename(path));
}
/** Export commands replace their output: never allow a source tree or ancestor as output. */
export function exportDirectory(project: Project, path: string): string {
  const out = canonical(resolve(project.root, path)),
    root = canonical(project.root);
  const contains = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return (
      rel === "" ||
      (rel !== ".." &&
        !rel.startsWith("../") &&
        !rel.startsWith("..\\") &&
        !isAbsolute(rel))
    );
  };
  if (
    contains(out, root) ||
    ["src", "assets", ".git"].some(
      (d) =>
        contains(canonical(resolve(root, d)), out) ||
        contains(out, canonical(resolve(root, d))),
    )
  )
    throw new Error(`Unsafe export output: ${path}`);
  if (
    contains(out, canonical(project.entryPath)) ||
    (project.artPath && contains(out, canonical(project.artPath)))
  )
    throw new Error(`Export output contains project sources: ${path}`);
  return out;
}
export function xmlText(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
}
