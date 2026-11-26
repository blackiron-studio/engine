// Headless screenshots of a project in Chrome, with no visible window. Used by `blackiron screens`
// (every phone, tablet and desktop size, with a size audit at each shot) and scripts/shoot.ts.
//
// Steps run in order on a fixed 60 Hz clock:
//   frames:N          advance N frames
//   key:Code          press and release a key (KeyboardEvent code)
//   hold:Code:N       hold a key for N frames
//   press:action      press and release an input action
//   tap:x,y           tap a point in viewport units
//   shot:name         save <out>/<name>.png (and, with `audit`, measure it)
//   eval:js           run JavaScript with `app` and `scene` in scope (for test setup)

import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DevicePreset, ScreenAudit } from "../src/app/screen.ts";

const engine = resolve(import.meta.dir, "..");

export const DEFAULT_STEPS = "frames:3;shot:title;key:Enter;frames:90;shot:play";

/** Playwright's chrome-headless-shell when installed, else Chrome (CHROME_PATH overrides). */
export function findChrome(): string {
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

export interface ShootOptions {
  /** Project folder (with blackiron.json). */
  root: string;
  // biome-ignore lint: the project's raw config
  config: Record<string, any>;
  out: string;
  steps?: string;
  seed?: number;
  /** Window size in CSS pixels and device pixel ratio, when no device is given. */
  width?: number;
  height?: number;
  dpr?: number;
  /** Show the game as on this device (size, notch, touch). */
  device?: DevicePreset;
  /** Measure every shot with `app.auditScreen()` and the layout audit. */
  audit?: boolean;
}

/** A control that runs off the screen in a shot. */
export interface OffscreenControl {
  name: string;
}

export interface ShotResult {
  name: string;
  file: string;
  audit?: ScreenAudit;
  offscreen?: OffscreenControl[];
}

export interface ShootResult {
  status: "PASS";
  scene: string | null;
  glError: number | null;
  stats: Record<string, number>;
  shots: ShotResult[];
}

export async function shoot(o: ShootOptions): Promise<ShootResult> {
  const { root, config, out } = o;
  const device = o.device ?? null;
  const width = device ? device.width : (o.width ?? config.viewport?.width ?? 1280);
  const height = device ? device.height : (o.height ?? config.viewport?.height ?? 720);
  const dpr = device ? device.pixelRatio : (o.dpr ?? 2);
  const steps = o.steps ?? DEFAULT_STEPS;
  const seed = o.seed ?? 7;
  await mkdir(out, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), "blackiron-shoot-"));
  const entry = join(root, ".blackiron", `shoot-entry-${process.pid}-${Date.now()}.ts`);
  await mkdir(join(root, ".blackiron"), { recursive: true });
  await writeFile(
    entry,
    `
import main from ${JSON.stringify(join(root, config.entry))};
import { App } from ${JSON.stringify(join(engine, "src/app/app.ts"))};
import { auditUILayout } from ${JSON.stringify(join(engine, "src/testkit/ui-layout.ts"))};
const post = (body) => fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const audit = ${o.audit ? "true" : "false"};
const controlName = (c) => c.name || (typeof c.text === 'string' && c.text ? c.constructor.name + ' "' + c.text + '"' : c.constructor.name);
try {
  // Load the game's web fonts before the first frame, as a player's browser would.
  await Promise.race([document.fonts.ready.then(() => Promise.all([...document.fonts].map((f) => f.load().catch(() => null)))), new Promise((r) => setTimeout(r, 4000))]);
  const app = await App.create({ canvas: '#blackiron', config: { ...${JSON.stringify(config)}, seed: ${seed}, fps: false, debug: false }, device: ${JSON.stringify(device)} ?? undefined });
  await main(app);
  app.audio.setMuted(true);
  globalThis.app = app;
  const frame = (n = 1) => { for (let i = 0; i < n; i++) app.frame(1 / 60); };
  const keyEvent = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  const shots = [];
  // Split only before a step name, so eval bodies may contain semicolons.
  for (const raw of ${JSON.stringify(steps)}.split(/;(?=\\s*(?:frames|key|hold|press|tap|eval|shot):)/).map((s) => s.trim()).filter(Boolean)) {
    const at = raw.indexOf(':');
    const op = at < 0 ? raw : raw.slice(0, at);
    const arg = at < 0 ? '' : raw.slice(at + 1);
    if (op === 'frames') frame(Number(arg));
    else if (op === 'key') { keyEvent(arg, true); frame(); keyEvent(arg, false); frame(); }
    else if (op === 'hold') { const [code, n] = arg.split(':'); keyEvent(code, true); frame(Number(n)); keyEvent(code, false); frame(); }
    else if (op === 'press') { app.input.press(arg); frame(); app.input.release(arg); frame(); }
    else if (op === 'tap') { const [x, y] = arg.split(',').map(Number); const h = app.bindHost(); h.pointerLogical('down', 9, x, y); frame(); h.pointerLogical('up', 9, x, y); frame(); }
    else if (op === 'eval') { const scene = app.scenes.current; new Function('app', 'scene', arg)(app, scene); }
    else if (op === 'shot') {
      const shot = { name: arg, png: app.canvas.toDataURL('image/png') };
      if (audit) {
        shot.audit = app.auditScreen();
        const scene = app.scenes.current;
        shot.offscreen = scene ? auditUILayout(scene).filter((i) => i.kind === 'outside').map((i) => ({ name: i.controls.map(controlName).join(', ') })) : [];
      }
      shots.push(shot);
    }
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
  if (!build.success) {
    await rm(entry, { force: true });
    throw new Error(build.logs.join("\n"));
  }

  let done: (value: unknown) => void;
  const finished = new Promise((r) => (done = r));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/result" && req.method === "POST") {
        const body = await req.json();
        const shots: ShotResult[] = [];
        for (const s of body.shots ?? []) {
          const file = join(out, `${s.name}.png`);
          await writeFile(file, Buffer.from(s.png.split(",")[1], "base64"));
          shots.push({ name: s.name, file, audit: s.audit, offscreen: s.offscreen });
        }
        body.shots = shots;
        done(body);
        return new Response("ok");
      }
      if (url.pathname === "/") {
        // The same stage as a real build: a full-window box that centres the canvas.
        const stage = `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center"><canvas id="blackiron" style="display:block"></canvas></div>`;
        return new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${(config.fonts ?? []).map((u: string) => `<link rel="stylesheet" href="${u}">`).join("")}</head><body style="margin:0;background:#000;overflow:hidden">${stage}<script type="module" src="/shoot.js"></script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
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
      // Keep the browser alive until the page posts /result; frames already advance on a fixed clock.
      // No --virtual-time-budget: under chrome-headless-shell it stalls createImageBitmap, hanging every
      // project that loads PNG assets.
      "--remote-debugging-port=0",
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
    ])) as ShootResult | { status: "FAIL"; error: string };
    if (result.status !== "PASS") throw new Error(`${config.name}: ${(result as { error: string }).error}`);
    return result;
  } finally {
    clearTimeout(timer);
    proc.kill("SIGKILL");
    await proc.exited;
    server.stop(true);
    await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(entry, { force: true });
  }
}
