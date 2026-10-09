import { stageExport } from "../export-transaction.ts";
import { exportDirectory, requireTarget } from "../export-support.ts";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { atlasManifest, bakeAtlas } from "../../src/art/atlas.ts";
import { resolveAssets } from "../../src/art/images.ts";
import { HeadlessPlatform } from "../../src/platform/headless.ts";
import type { Args } from "../args.ts";
import { bundle, gzipSize, kb } from "../bundle.ts";
import { writeEntry } from "../entry.ts";
import { pageHtml } from "../html.ts";
import { type Project, loadProject, runtimeConfig } from "../project.ts";

export interface BuildOutput {
  dist: string;
  js: string;
  html: string;
}

export async function buildProject(
  project: Project,
  opts: { report?: boolean } = {},
): Promise<BuildOutput> {
  requireTarget(project, "web");
  const dist = exportDirectory(project, "dist");
  return stageExport(
    project,
    dist,
    async (stage) => {
      const dist = stage;
      await mkdir(resolve(dist, "assets"), { recursive: true });
      await copyAssets(project, resolve(dist, "assets"));
      const entry = await writeEntry(project, "web", runtimeConfig(project));
      const r = await bundle(project, {
        minify: true,
        sourcemap: "linked",
        entry,
      });
      await Bun.write(resolve(dist, "assets", "game.js"), r.js);
      if (r.map) await Bun.write(resolve(dist, "assets", "game.js.map"), r.map);
      const html = pageHtml({
        title: project.config.name,
        config: runtimeConfig(project),
        scriptSrc: "./assets/game.js",
      });
      await Bun.write(resolve(dist, "index.html"), html);
      // The physics module is fetched next to the page only by games that enable physics.
      await cp(
        resolve(import.meta.dir, "..", "..", "src", "kernel", "physics.wasm"),
        resolve(dist, "physics.wasm"),
      );
      await cp(
        resolve(import.meta.dir, "..", "..", "src", "kernel", "audio.wasm"),
        resolve(dist, "audio.wasm"),
      );
      console.log(
        `  built ${project.config.name} to dist/ in ${r.ms.toFixed(0)} ms`,
      );
      if (opts.report) {
        console.log(
          `  game.js   ${kb(r.js.length)} raw, ${kb(gzipSize(r.js))} gzipped`,
        );
        console.log(
          `  index.html ${kb(html.length)} raw, ${kb(gzipSize(html))} gzipped`,
        );
      }
      return { dist: exportDirectory(project, "dist"), js: r.js, html };
    },
    ["assets", "physics.wasm", "audio.wasm", "index.html"],
  );
}

export interface NativeBuildOutput {
  dir: string;
  js: string;
}

/**
 * Bundle for a native host: one classic script that defines `__blackironBoot`, plus the
 * atlas prebaked to raw RGBA so the interpreter never paints at boot.
 */
export async function buildNative(
  project: Project,
  opts: { report?: boolean; out?: string } = {},
): Promise<NativeBuildOutput> {
  requireTarget(project, "native");
  const dir = exportDirectory(project, opts.out ?? "dist/native");
  return stageExport(project, dir, async (stage) => {
    const dir = stage;
    await mkdir(dir, { recursive: true });
    const config = runtimeConfig(project);
    const entry = await writeEntry(project, "native", config);
    const r = await bundle(project, {
      minify: true,
      sourcemap: "none",
      entry,
      format: "iife",
    });
    await Bun.write(resolve(dir, "game.js"), r.js);
    if (project.artPath) {
      await import(project.artPath);
      // Imported sheets under assets/ join the prebaked atlas, read from disk the way the page would fetch them.
      const images = await resolveAssets(
        new HeadlessPlatform({ root: project.root }),
      );
      const atlas = bakeAtlas({ images });
      await Bun.write(resolve(dir, "atlas.bin"), atlas.data);
      if (atlas.normals)
        await Bun.write(resolve(dir, "atlas_n.bin"), atlas.normals);
      await Bun.write(
        resolve(dir, "atlas.json"),
        JSON.stringify(atlasManifest(atlas)),
      );
      console.log(
        `  baked ${atlas.all().filter((x) => !x.name.startsWith("__")).length} sprites into ${atlas.width}x${atlas.height}`,
      );
    }
    await bundleFonts(project, dir);
    await copyAssets(project, resolve(dir, "assets"));
    await Bun.write(
      resolve(dir, "manifest.json"),
      JSON.stringify({ name: project.config.name, config }, null, 2),
    );
    console.log(
      `  bundled ${project.config.name} for native in ${r.ms.toFixed(0)} ms (${kb(r.js.length)})`,
    );
    return {
      dir: exportDirectory(project, opts.out ?? "dist/native"),
      js: r.js,
    };
  });
}

export async function build(args: Args): Promise<void> {
  const project = await loadProject();
  if (!["web", "native"].includes(args.str("target", "web")))
    throw new Error("Build target must be web or native");
  if (args.str("target", "web") === "native")
    await buildNative(project, { report: args.bool("report") });
  else await buildProject(project, { report: args.bool("report") });
}

/** Imported art and other files under the project's assets/ ride along as assets/ in every build. */
async function copyAssets(project: Project, to: string): Promise<void> {
  const from = resolve(project.root, "assets");
  if (!existsSync(from)) return;
  await mkdir(to, { recursive: true });
  await cp(from, to, {
    recursive: true,
    filter: (f) => !f.endsWith(".preview.png"),
  });
}

/** Copy local font files and download Google Fonts faces (as TrueType) into the bundle's fonts/. */
export async function bundleFonts(
  project: Project,
  nativeDir: string,
): Promise<string[]> {
  const fonts = project.config.fonts ?? [];
  const names: string[] = [];
  if (fonts.length === 0) return names;
  const fontsDir = join(nativeDir, "fonts");
  await mkdir(fontsDir, { recursive: true });
  const cache = join(project.root, ".blackiron", "fonts");
  await mkdir(cache, { recursive: true });
  for (const entry of fonts) {
    try {
      const direct = !/^https?:/.test(entry) && /\.(ttf|otf)$/i.test(entry);
      const files = direct
        ? [resolve(project.root, entry)]
        : await googleFontFiles(
            /^https?:/.test(entry)
              ? entry
              : pathToFileURL(resolve(project.root, entry)).href,
            cache,
          );
      for (const file of files) {
        if (!existsSync(file)) {
          throw new Error(`Font not found: ${entry}`);
        }
        const destination = join(fontsDir, basename(file));
        if (
          existsSync(destination) &&
          !Buffer.from(await Bun.file(file).arrayBuffer()).equals(
            Buffer.from(await Bun.file(destination).arrayBuffer()),
          )
        )
          throw Error(`Conflicting font filename: ${basename(file)}`);
        await cp(file, destination);
        names.push(basename(file));
      }
    } catch (err) {
      throw new Error(
        `Could not bundle font ${entry}: ${(err as Error).message}`,
      );
    }
  }
  if (names.length)
    console.log(
      `  bundled ${names.length} font file${names.length === 1 ? "" : "s"}`,
    );
  return names;
}

/** Resolve a Google Fonts CSS URL to TrueType files, cached under .blackiron/fonts. */
async function googleFontFiles(
  cssUrl: string,
  cache: string,
): Promise<string[]> {
  // A user agent without WOFF2 support is served TrueType sources, which CoreText can register.
  const local = cssUrl.startsWith("file:");
  const res = local
    ? null
    : await fetch(cssUrl, { headers: { "User-Agent": "Blackiron font bundler" } });
  if (res && !res.ok) throw new Error(`${res.status} fetching ${cssUrl}`);
  const css = res ? await res.text() : await Bun.file(new URL(cssUrl)).text();
  if (/@import\b/i.test(css))
    throw Error(
      "Nested font @import is unsupported; declare each stylesheet explicitly",
    );
  const out: string[] = [];
  for (const block of css.split("@font-face").slice(1)) {
    const family = /font-family:\s*([^;\n}]+)/
      .exec(block)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, "");
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? "normal";
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1] ?? "400";
    const source = /url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/.exec(block)?.[1];
    if (!family || !source) continue;
    const url = new URL(source, cssUrl).href;
    if (url.startsWith("file:")) {
      const path = fileURLToPath(url);
      if (!/\.(ttf|otf)$/i.test(path))
        throw Error(`Native font format unsupported: ${path}`);
      out.push(path);
      continue;
    }
    const ext = (url.split("?")[0].split(".").pop() ?? "ttf").toLowerCase();
    if (ext !== "ttf" && ext !== "otf") continue;
    const file = join(
      cache,
      `${family.replace(/\s+/g, "")}-${weight}${style === "italic" ? "-italic" : ""}.${ext}`,
    );
    if (!existsSync(file)) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
      await Bun.write(file, await r.arrayBuffer());
    }
    out.push(file);
  }
  if (!out.length)
    throw new Error(
      `No supported TTF/OTF faces in ${cssUrl}; supply a local TTF/OTF font or compatible stylesheet`,
    );
  return out;
}
