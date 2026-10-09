import { sceneStore } from "./scene-store.ts";
// The development server. Serves one project at "/" for `blackiron dev`, or several projects
// under prefixes with an index page for `blackiron gallery`. Bundles on request, caches until a
// file changes, and tells open pages to reload over server-sent events.

import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { bakeAtlas } from "../src/art/atlas.ts";
import { bundle } from "./bundle.ts";
import { writeEntry } from "./entry.ts";
import { escapeHtml, pageHtml } from "./html.ts";
import { encodePNG } from "./png.ts";
import { type Project, loadProject, runtimeConfig } from "./project.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServeEntry {
  /** URL prefix without a trailing slash; "" for the root. */
  prefix: string;
  project: Project;
  /** Shown on the gallery index. */
  description?: string;
}

export interface ServeOptions {
  port: number;
  open?: boolean;
  /** Title of the index page when several entries are served. */
  title?: string;
}

interface Live {
  entry: ServeEntry;
  cached: Promise<{ js: string }> | null;
}

export async function serve(entries: ServeEntry[], opts: ServeOptions): Promise<void> {
  const engineSrc = resolve(import.meta.dir, "..", "src");
  const lives: Live[] = entries.map((entry) => ({ entry, cached: null }));
  const byPrefix = [...lives].sort((a, b) => b.entry.prefix.length - a.entry.prefix.length);

  const build = (live: Live) => {
    if (!live.cached) {
      const name = live.entry.project.config.name;
      live.cached = writeEntry(live.entry.project, "web", runtimeConfig(live.entry.project))
        .then((entry) => bundle(live.entry.project, { sourcemap: "inline", entry }))
        .then(
        (r) => {
          console.log(`  built ${name} in ${r.ms.toFixed(0)} ms`);
          return r;
        },
        (err: Error) => {
          console.error(err.message);
          return { js: `console.error(${JSON.stringify(err.message)}); document.body.style.background='#300';` };
        },
      );
    }
    return live.cached;
  };

  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const notify = () => {
    const msg = new TextEncoder().encode("data: reload\n\n");
    for (const c of clients) {
      try {
        c.enqueue(msg);
      } catch {
        clients.delete(c);
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const invalidate = (targets: Live[]) => (_: unknown, filename: string | Buffer | null) => {
    const name = String(filename ?? "");
    if (/(^|\/)(node_modules|dist|atlas|screenshots|\.blackiron)(\/|$)/.test(name)) return;
    for (const l of targets) l.cached = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      for (const l of targets) void build(l);
      notify();
    }, 60);
  };
  try {
    for (const live of lives) watch(live.entry.project.root, { recursive: true }, invalidate([live]));
    watch(engineSrc, { recursive: true }, invalidate(lives));
  } catch (err) {
    console.warn("File watching unavailable:", (err as Error).message);
  }

  const multi = entries.length > 1 || entries[0]?.prefix !== "";
  const indexHtml = multi ? galleryHtml(entries, opts.title ?? "Blackiron gallery") : null;

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);

      if (path === "/dev/events") {
        let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            clients.add(c);
            c.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
          cancel() {
            if (ctrl) clients.delete(ctrl);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      if (indexHtml && (path === "/" || path === "/index.html")) {
        return new Response(indexHtml, { headers: { "content-type": MIME[".html"], "cache-control": "no-cache" } });
      }

      const live = byPrefix.find((l) => l.entry.prefix === "" || path === l.entry.prefix || path.startsWith(`${l.entry.prefix}/`));
      if (!live) return new Response("Not found", { status: 404 });
      const { prefix, project } = live.entry;
      if (prefix && path === prefix) return Response.redirect(`${prefix}/`, 302);
      const sub = prefix ? path.slice(prefix.length) : path;

      if (sub === "/dev/scene") return sceneStore(project.root, req);
      if (sub === "/dev/editor") return new Response('<!doctype html><html><head><meta charset="utf-8"><title>Blackiron scene editor</title></head><body><script type="module" src="editor.js"></script></body></html>', { headers: { "content-type": MIME[".html"] } });
      if (sub === "/dev/editor.js") {
        const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, "editor.ts")], target: "browser" });
        if (!result.success) return new Response(result.logs.join("\n"), { status: 500 });
        return new Response(await result.outputs[0].text(), { headers: { "content-type": MIME[".js"] } });
      }
      if (sub === "/" || sub === "/index.html") {
        // Re-read blackiron.json so viewport and post changes apply on reload without a restart.
        const fresh = await loadProject(project.root).catch(() => project);
        live.entry.project = fresh;
        const html = pageHtml({ title: fresh.config.name, config: runtimeConfig(fresh), scriptSrc: "game.js", dev: true });
        return new Response(html, { headers: { "content-type": MIME[".html"], "cache-control": "no-cache" } });
      }
      if (sub === "/physics.wasm") {
        return new Response(Bun.file(resolve(import.meta.dir, "..", "src", "kernel", "physics.wasm")), { headers: { "Content-Type": "application/wasm", "Cache-Control": "no-cache" } });
      }
      if (sub === "/audio.wasm") {
        return new Response(Bun.file(resolve(import.meta.dir, "..", "src", "kernel", "audio.wasm")), { headers: { "Content-Type": "application/wasm", "Cache-Control": "no-cache" } });
      }
      if (sub === "/game.js") {
        const { js } = await build(live);
        return new Response(js, { headers: { "content-type": MIME[".js"], "cache-control": "no-cache" } });
      }
      if (sub === "/dev/atlas.png") {
        if (project.artPath) await import(project.artPath);
        const atlas = bakeAtlas();
        return new Response(encodePNG(atlas.width, atlas.height, atlas.data), { headers: { "content-type": MIME[".png"] } });
      }
      if (req.method === "POST" && sub === "/dev/screenshot") {
        const name = (url.searchParams.get("name") ?? "shot").replace(/[^a-z0-9_-]/gi, "");
        const dataUrl = await req.text();
        const base64 = dataUrl.split(",")[1] ?? dataUrl;
        await mkdir(resolve(project.root, "screenshots"), { recursive: true });
        await Bun.write(resolve(project.root, "screenshots", `${name}.png`), Buffer.from(base64, "base64"));
        return new Response("ok");
      }
      const filePath = resolve(join(project.root, `.${sub}`));
      if (filePath !== project.root && !filePath.startsWith(`${project.root}${sep}`)) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(filePath);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, { headers: { "content-type": MIME[extname(filePath)] ?? "application/octet-stream", "cache-control": "no-cache" } });
    },
  });

  const base = `http://localhost:${server.port}`;
  if (multi) {
    console.log(`\n  ${opts.title ?? "Blackiron gallery"} is running at ${base}\n`);
    for (const e of entries) console.log(`    ${e.project.config.name.padEnd(14)} ${base}${e.prefix}/`);
    console.log();
  } else console.log(`\n  ${entries[0].project.config.name} is running at ${base}\n`);
  for (const live of lives) void build(live);
  if (opts.open) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([opener, base]);
  }
}

/** The menu page listing every served project. */
export function galleryHtml(entries: ServeEntry[], title: string): string {
  const cards = entries
    .map(
      (e) => `
      <a class="card" href="${e.prefix}/">
        <span class="dimension">${e.prefix === "/demo" ? "01 / 2D" : e.prefix === "/isometric" ? "02 / 2.5D" : e.prefix === "/lumen" ? "03 / 3D" : e.prefix === "/breach" ? "04 / 3D FPS" : e.prefix === "/lowline" ? "05 / 2D OPEN CITY" : "STARTER / LAB"}</span>
        ${["/breach", "/lowline"].includes(e.prefix) ? `<img class="preview" src="${e.prefix}/assets/preview.png" alt="${escapeHtml(e.project.config.name)} gameplay" loading="lazy">` : ""}
        ${["/demo", "/isometric", "/lumen"].includes(e.prefix) ? `<img class="preview" src="${e.prefix}/screenshots/showcase.png" alt="${escapeHtml(e.project.config.name)} gameplay" loading="lazy">` : ""}
        <span class="name">${escapeHtml(e.project.config.name)}</span>
        <span class="desc">${escapeHtml(e.description ?? "")}</span>
        <span class="meta">${e.project.config.viewport.width}×${e.project.config.viewport.height} · ${escapeHtml(e.prefix.replace(/^\//, ""))}</span>
      </a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; background: #112d36; color: #e5e9df; font: 15px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  .wrap { max-width: 76rem; margin: 0 auto; padding: 5rem 2rem 3rem; }
  h1 { margin: 0 0 0.3rem; font-size: clamp(2.5rem,6vw,5rem); letter-spacing: -0.04em; color: #f1dfb9; }
  p.lead { margin: 0 0 1.6rem; color: #adcbc5; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 0.9rem; }
  .card { display: grid; gap: 0.3rem; align-content: start; padding: 1.7rem; background: #1c3d45; border: 1px solid #3a5960; border-radius: 14px; color: inherit; text-decoration: none; transition: border-color 0.12s, transform 0.12s; }
  .preview { display: block; width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 8px; margin: 0 0 1rem; }
  .dimension { color: #e6bb76; font-size: .75rem; letter-spacing: .14em; margin-bottom: .6rem; }
  .card:nth-child(-n+5) { min-height: 220px; border-top: 4px solid #adc5a0; }
  .card:hover { border-color: #ffd067; transform: translateY(-1px); }
  .name { font-weight: 600; font-size: 1.65rem; }
  .desc { color: #adcbc5; font-size: 0.9rem; }
  .meta { color: #86aaa8; font-size: 0.75rem; font-family: ui-monospace, Menlo, monospace; margin-top: 0.3rem; }
  footer { margin-top: 2rem; color: #86aaa8; font-size: 0.8rem; font-family: ui-monospace, Menlo, monospace; }
  kbd { background: #1a1729; border: 1px solid #2c2942; border-radius: 3px; padding: 0 0.35em; font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(title)}</h1>
  <p class="lead">Three dimensions. One engine. Explore Wisp Hollow, Highground, Lumen Salvage, Signal Breach and Lowline, then build with the focused starters below. Press <kbd>\`</kbd> in any game for the debug overlay.</p>
  <div class="grid">${cards}
  </div>
  <footer>blackiron gallery · ${entries.length} projects</footer>
</div>
</body>
</html>
`;
}
