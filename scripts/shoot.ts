/**
 * Headless screenshots of any project, with no visible window.
 *
 *   bun scripts/shoot.ts <project dir> [--steps "frames:3;key:Enter;frames:60;shot:play"]
 *                        [--size 1280x720] [--dpr 2] [--out dir] [--seed 7]
 *
 * Steps run in order on a fixed 60 Hz clock:
 *   frames:N          advance N frames
 *   key:Code          press and release a key (KeyboardEvent code)
 *   hold:Code:N       hold a key for N frames
 *   press:action      press and release an input action
 *   tap:x,y           tap a point in viewport units
 *   shot:name         save <out>/<name>.png
 *   eval:js           run JavaScript with `app` and `scene` in scope (for test setup)
 *
 * Default steps: frames:3;shot:title;key:Enter;frames:90;shot:play. Uses Playwright's
 * chrome-headless-shell when installed, else Chrome in headless mode (CHROME_PATH overrides).
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const engine = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const target = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
if (!target) throw new Error("usage: bun scripts/shoot.ts <project dir> [--steps ...] [--size WxH] [--dpr N] [--out dir]");
const root = resolve(process.cwd(), target);
const config = await Bun.file(join(root, "blackiron.json")).json();
const [width, height] = flag("size", `${config.viewport?.width ?? 1280}x${config.viewport?.height ?? 720}`).split("x").map(Number);
const dpr = Number(flag("dpr", "2"));
const steps = flag("steps", "frames:3;shot:title;key:Enter;frames:90;shot:play");
const out = resolve(process.cwd(), flag("out", join(engine, ".blackiron/shots", root.split("/").at(-1)!)));
const seed = Number(flag("seed", "7"));

function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse()) {
      for (const sub of readdirSync(join(cache, dir))) {
        const exe = join(cache, dir, sub, "chrome-headless-shell");
        if (existsSync(exe)) return exe;
      }
    }
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  throw new Error("No headless Chrome found; set CHROME_PATH");
}

await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "blackiron-shoot-"));
const entry = join(root, ".blackiron", "shoot-entry.ts");
await mkdir(join(root, ".blackiron"), { recursive: true });
await writeFile(
  entry,
  `
import main from ${JSON.stringify(join(root, config.entry))};
import { App } from ${JSON.stringify(join(engine, "src/app/app.ts"))};
const post = (body) => fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  // Load the game's web fonts before the first frame, as a player's browser would.
  await Promise.race([document.fonts.ready.then(() => Promise.all([...document.fonts].map((f) => f.load().catch(() => null)))), new Promise((r) => setTimeout(r, 4000))]);
  const app = await App.create({ canvas: '#blackiron', config: { ...${JSON.stringify(config)}, seed: ${seed}, fps: false } });
  await main(app);
  app.audio.setMuted(true);
  globalThis.app = app;
  const frame = (n = 1) => { for (let i = 0; i < n; i++) app.frame(1 / 60); };
  const keyEvent = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  const shots = [];
  // Split only before a step name, so eval bodies may contain semicolons.
  for (const raw of ${JSON.stringify(steps)}.split(/;(?=\s*(?:frames|key|hold|press|tap|eval|shot):)/).map((s) => s.trim()).filter(Boolean)) {
    const at = raw.indexOf(':');
    const op = at < 0 ? raw : raw.slice(0, at);
    const arg = at < 0 ? '' : raw.slice(at + 1);
    if (op === 'frames') frame(Number(arg));
    else if (op === 'key') { keyEvent(arg, true); frame(); keyEvent(arg, false); frame(); }
    else if (op === 'hold') { const [code, n] = arg.split(':'); keyEvent(code, true); frame(Number(n)); keyEvent(code, false); frame(); }
    else if (op === 'press') { app.input.press(arg); frame(); app.input.release(arg); frame(); }
    else if (op === 'tap') { const [x, y] = arg.split(',').map(Number); const h = app.bindHost(); h.pointerLogical('down', 9, x, y); frame(); h.pointerLogical('up', 9, x, y); frame(); }
    else if (op === 'eval') { const scene = app.scenes.current; new Function('app', 'scene', arg)(app, scene); }
    else if (op === 'shot') shots.push({ name: arg, png: app.canvas.toDataURL('image/png') });
    else throw new Error('Unknown step ' + op);
  }
  const gl = app.canvas.getContext('webgl2');
  await post({ status: 'PASS', scene: app.scenes.current?.name ?? null, glError: gl ? gl.getError() : null, stats: { ...app.renderer.stats }, shots });
} catch (error) {
  await post({ status: 'FAIL', error: String(error?.stack ?? error) });
}
`,
);
const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: temp, naming: "shoot.js" });
if (!build.success) throw new Error(build.logs.join("\n"));

let done: (value: unknown) => void;
const finished = new Promise((r) => (done = r));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/result" && req.method === "POST") {
      const body = await req.json();
      for (const s of body.shots ?? []) await writeFile(join(out, `${s.name}.png`), Buffer.from(s.png.split(",")[1], "base64"));
      delete body.shots;
      done(body);
      return new Response("ok");
    }
    if (url.pathname === "/")
      return new Response(
        `<!doctype html><html><head>${(config.fonts ?? []).map((u: string) => `<link rel="stylesheet" href="${u}">`).join("")}</head><body style="margin:0;background:#000"><canvas id="blackiron" style="width:${width}px;height:${height}px;display:block"></canvas><script type="module" src="/shoot.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    const path = url.pathname === "/shoot.js" ? join(temp, "shoot.js") : resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (path !== join(temp, "shoot.js") && !path.startsWith(root + "/")) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response("Missing", { status: 404 });
  },
});
const proc = Bun.spawn(
  [
    findChrome(),
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--use-angle=metal",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    `--force-device-scale-factor=${dpr}`,
    `--user-data-dir=${join(temp, "profile")}`,
    `--window-size=${width},${height}`,
    "--virtual-time-budget=60000",
    "--dump-dom",
    `http://127.0.0.1:${server.port}/`,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  void new Response(proc.stdout).text();
  const result = (await Promise.race([
    finished,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${config.name}: headless run timed out`)), 120000))),
  ])) as { status: string; error?: string };
  if (result.status !== "PASS") throw new Error(`${config.name}: ${result.error}`);
  console.log(JSON.stringify({ name: config.name, out, ...result }));
} finally {
  clearTimeout(timer);
  proc.kill("SIGKILL");
  await proc.exited;
  server.stop(true);
  await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(entry, { force: true });
}
