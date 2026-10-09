import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, relative } from "node:path";
import type { Project } from "./project.ts";
/** Embed managed local resources and font stylesheets; fail if a declared font cannot be packaged. */
export async function singleFileResources(
  project: Project,
  dist: string,
): Promise<{ script: string; styles: string }> {
  const assets: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const key = relative(dist, path).split("\\").join("/");
        if (key === "assets/game.js" || key === "assets/game.js.map") continue;
        const file = Bun.file(path);
        assets[key] =
          `data:${file.type || "application/octet-stream"};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
      }
    }
  }
  await walk(join(dist, "assets"));
  for (const name of ["physics.wasm", "audio.wasm"])
    assets[name] =
      `data:application/wasm;base64,${Buffer.from(await Bun.file(join(dist, name)).arrayBuffer()).toString("base64")}`;
  let styles = "";
  const fontLoads = new Set<string>();
  for (const entry of project.config.fonts ?? []) {
    const remote = /^https?:/.test(entry),
      base = remote
        ? entry
        : new URL(entry, pathToFileURL(project.root + "/")).href;
    const response = remote ? await fetch(entry) : null;
    if (response && !response.ok)
      throw Error(`Font stylesheet failed: ${entry} (${response.status})`);
    let css = response
      ? await response.text()
      : await Bun.file(new URL(base)).text();
    if (/@import\b/i.test(css))
      throw Error(`Nested font @import cannot be packaged: ${entry}`);
    for (const match of [
      ...css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g),
    ]) {
      if (match[1].startsWith("data:")) continue;
      const url = new URL(match[1], base);
      const res = url.protocol === "file:" ? null : await fetch(url);
      if (res && !res.ok)
        throw Error(`Font resource failed: ${url} (${res.status})`);
      const bytes = res
        ? await res.arrayBuffer()
        : await Bun.file(url).arrayBuffer();
      const mime =
        (res ? res.headers.get("content-type") : Bun.file(url).type) ||
        "application/octet-stream";
      css = css.replace(
        match[0],
        `url("data:${mime};base64,${Buffer.from(bytes).toString("base64")}")`,
      );
    }
    for (const block of css.split("@font-face").slice(1)) {
      const family = /font-family:\s*([^;\n}]+)/
        .exec(block)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, "");
      const weight = /font-weight:\s*(\d+)/.exec(block)?.[1] ?? "400";
      if (family) fontLoads.add(`${weight} 16px ${JSON.stringify(family)}`);
    }
    styles += css + "\n";
  }
  const script = `globalThis.BLACKIRON_BUNDLED_ASSETS=${JSON.stringify(assets)};\nif(document.fonts)await Promise.all(${JSON.stringify([...fontLoads])}.map(f=>document.fonts.load(f)));\n`;
  return { script, styles };
}
