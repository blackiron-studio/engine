/** Visual acceptance through Blackiron's public mesh APIs, not a Neon gameplay port.
 * bun scripts/check-neon-reference.ts [--chrome /path/to/chrome] [--serve] [--port 4213]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const output = resolve(import.meta.dir, "../.blackiron/verification/neon");
await mkdir(output, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../tests/browser/neon-reference.ts")],
  target: "browser",
  outdir: output,
  naming: "neon.js",
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
await writeFile(
  join(output, "index.html"),
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blackiron · Neon renderer reference</title><style>
*{box-sizing:border-box}body{margin:0;overflow:hidden;background:#0a121a;color:#d9eeee;font-family:Arial,Helvetica,sans-serif}canvas{display:block;width:100vw;height:100vh}header{position:fixed;left:36px;top:30px;pointer-events:none}header small{display:block;color:#7eadad;letter-spacing:3px;font:10px monospace;margin-bottom:9px}h1{font-size:21px;font-weight:500;letter-spacing:2px;margin:0}footer{position:fixed;left:36px;right:36px;bottom:26px;display:flex;justify-content:space-between;gap:20px;color:#8ba6af;font:10px monospace;pointer-events:none}a{color:#8debd9;pointer-events:auto;text-decoration:none}pre{display:none}
</style></head><body><canvas></canvas><header><small>BLACKIRON / RENDERER ACCEPTANCE</small><h1>NEON BASTION REFERENCE</h1></header><footer><span id="summary">Procedural geometry · no texture or model assets</span><a href="?animate=1">Animate the figure study ↗</a></footer><pre></pre><textarea hidden></textarea><script src="neon.js"></script></body></html>`,
);
const candidates = [
  option("--chrome"),
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((path): path is string => !!path);
let chrome: string | undefined;
for (const path of candidates)
  if (await Bun.file(path).exists()) {
    chrome = path;
    break;
  }
if (!chrome)
  throw new Error(
    "Chrome/Chromium is required; set CHROME_PATH or pass --chrome /path/to/browser",
  );
await rm(join(output, "frame.png"), { force: true });
const profile = await mkdtemp(join(tmpdir(), "blackiron-neon-reference-"));
const proc = Bun.spawn(
  [
    chrome,
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "--dump-dom",
    pathToFileURL(join(output, "index.html")).href + "?capture=1",
  ],
  { stdout: "pipe", stderr: "ignore" },
);
let html = "";
try {
  const reader = proc.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Neon renderer check timed out after 30 seconds")),
      30000,
    );
  });
  try {
    while (!html.includes("</html>")) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      html += new TextDecoder().decode(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  await writeFile(join(output, "result.html"), html);
  const text = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
  if (!text)
    throw new Error(
      `Renderer fixture did not return diagnostics: ${html.slice(-2000)}`,
    );
  const result = JSON.parse(
    text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
  );
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  if (result.status !== "PASS")
    throw new Error(
      `Neon renderer acceptance failed: ${JSON.stringify(result)}`,
    );
  const snapshot = html.match(
    /<textarea hidden="">(data:image\/png;base64,[A-Za-z0-9+/=]+)<\/textarea>/,
  )?.[1];
  if (!snapshot)
    throw new Error("Renderer fixture did not return a PNG snapshot");
  await writeFile(
    join(output, "frame.png"),
    Buffer.from(snapshot.split(",")[1], "base64"),
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(`Neon renderer evidence: ${output}`);
} finally {
  // Headless Chrome can leave SIGTERM pending on macOS display-link teardown.
  proc.kill("SIGKILL");
  await Promise.race([proc.exited, Bun.sleep(1000)]);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
if (args.includes("--serve")) {
  const port = Number(option("--port") ?? 4213);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new RangeError("--port must be an integer from 1 to 65535");
  const mime: Record<string, string> = {
    "index.html": "text/html; charset=utf-8",
    "neon.js": "text/javascript; charset=utf-8",
    "frame.png": "image/png",
    "result.json": "application/json; charset=utf-8",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const pathname = new URL(request.url).pathname,
        name = pathname === "/" ? "index.html" : pathname.slice(1);
      if (!mime[name]) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(join(output, name)), {
        headers: { "content-type": mime[name], "cache-control": "no-store" },
      });
    },
  });
  console.log(
    `Reference viewer: http://127.0.0.1:${server.port}/ (append ?animate=1 for moving figures)`,
  );
}
