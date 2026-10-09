// Entry wrappers. A game exports a `main(app)` function; the wrapper creates the App for
// the target (a canvas on the web, the host object natively) and calls it. Old-style
// entries that start themselves at top level still work on the web.

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { BlackironConfig } from "../src/app/app.ts";
import type { Project } from "./project.ts";

const ENGINE = resolve(import.meta.dir, "..", "src", "index.ts");

export async function writeEntry(project: Project, target: "web" | "native", config: Partial<BlackironConfig>): Promise<string> {
  const dir = resolve(project.root, ".blackiron");
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, `entry.${target}.ts`);
  const entry = JSON.stringify(project.entryPath);
  const engine = JSON.stringify(ENGINE);
  const cfg = JSON.stringify(config);
  const source =
    target === "web"
      ? `import * as game from ${entry};
import { App } from ${engine};
if (typeof game.default === "function") {
  const app = await App.create({ canvas: "#blackiron" });
  await game.default(app);
  app.start();
}
`
      : `import * as game from ${entry};
import { App, Atlas, NativePlatform } from ${engine};
globalThis.BLACKIRON_CONFIG = ${cfg};
globalThis.__blackironBoot = async () => {
  const platform = new NativePlatform();
  let atlas;
  try {
    const manifest = await platform.loadJson("atlas.json");
    const bytes = await platform.loadBytes("atlas.bin");
    const normals = manifest.normals ? new Uint8ClampedArray(await platform.loadBytes("atlas_n.bin")) : null;
    atlas = Atlas.fromManifest(manifest, new Uint8ClampedArray(bytes), normals);
  } catch (err) {
    console.warn("[blackiron] no prebaked atlas, painting at boot:", String(err));
  }
  const app = await App.create({ platform, atlas });
  app.bindHost();
  if (typeof game.default === "function") await game.default(app);
  app.start();
  globalThis.__blackironReady = true;
  return app;
};
`;
  await Bun.write(file, source);
  return file;
}
