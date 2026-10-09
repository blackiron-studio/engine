import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { atlasManifest, bakeAtlas } from "../../src/art/atlas.ts";
import { resolveAssets } from "../../src/art/images.ts";
import { HeadlessPlatform } from "../../src/platform/headless.ts";
import type { Args } from "../args.ts";
import { encodePNG } from "../png.ts";
import { loadProject } from "../project.ts";

/**
 * Bake the project's sprites without a browser. Requires `"art"` in kiln.json to name a
 * module that only defines sprites (importing the game entry would try to start it).
 */
export async function atlas(args: Args): Promise<void> {
  const project = await loadProject();
  if (!project.artPath) throw new Error(`kiln.json needs an "art" module path for "kiln atlas"`);
  await import(project.artPath);
  const t0 = performance.now();
  const images = await resolveAssets(new HeadlessPlatform({ root: project.root }));
  const atlas = bakeAtlas({ images });
  const outDir = resolve(project.root, args.str("out", "atlas"));
  await mkdir(outDir, { recursive: true });
  await Bun.write(resolve(outDir, "atlas.png"), encodePNG(atlas.width, atlas.height, atlas.data));
  await Bun.write(resolve(outDir, "atlas.json"), JSON.stringify(atlasManifest(atlas), null, 2));
  let count = 0;
  if (args.bool("split")) {
    const dir = resolve(outDir, "sprites");
    await mkdir(dir, { recursive: true });
    for (const r of atlas.all()) {
      if (r.name.startsWith("__")) continue;
      const p = atlas.extract(r.name);
      await Bun.write(resolve(dir, `${r.name.replace(/[^a-z0-9_.-]/gi, "_")}.png`), encodePNG(p.width, p.height, p.data));
      count++;
    }
  }
  const sprites = atlas.all().filter((r) => !r.name.startsWith("__")).length;
  console.log(`  baked ${sprites} sprites into ${atlas.width}x${atlas.height} in ${(performance.now() - t0).toFixed(0)} ms`);
  console.log(`  wrote ${outDir.replace(project.root + "/", "")}/atlas.png and atlas.json${count ? ` and ${count} sprite PNGs` : ""}`);
}
