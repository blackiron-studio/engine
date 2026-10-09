import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const engine = resolve(import.meta.dir, ".."),
  output = resolve(engine, ".kiln/verification/lowline"),
  temp = await mkdtemp(join(tmpdir(), "kiln-lowline-"));
await mkdir(output, { recursive: true });
const build = await Bun.build({
  entrypoints: [resolve(engine, "tests/browser/lowline-smoke.ts")],
  target: "browser",
  outdir: temp,
  naming: "smoke.js",
});
if (!build.success) throw new Error(build.logs.join("\n"));
let done!: (value: any) => void;
const resultPromise = new Promise<any>((r) => (done = r));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/capture") {
      const name = u.searchParams.get("name")!;
      if (!/^[a-z]+$/.test(name)) return new Response("bad", { status: 400 });
      await Bun.write(
        join(output, name + ".png"),
        Buffer.from((await req.text()).split(",")[1], "base64"),
      );
      return new Response("ok");
    }
    if (req.method === "POST" && u.pathname === "/result") {
      done(await req.json());
      return new Response("ok");
    }
    if (u.pathname === "/smoke.js")
      return new Response(Bun.file(join(temp, "smoke.js")));
    return new Response(
      '<!doctype html><html><body style="margin:0;background:#142b34"><canvas id="kiln" style="width:1280px;height:720px"></canvas><script type="module" src="/smoke.js"></script></body></html>',
      { headers: { "content-type": "text/html" } },
    );
  },
});
const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];
let chrome = "";
for (const c of candidates)
  if (await Bun.file(c).exists()) {
    chrome = c;
    break;
  }
if (!chrome) throw new Error("Chrome required; set CHROME_PATH");
const proc = Bun.spawn(
  [
    chrome,
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--user-data-dir=${join(temp, "profile")}`,
    "--window-size=1280,850",
    `http://127.0.0.1:${server.port}/`,
  ],
  { stdout: "ignore", stderr: "ignore" },
);
let timeout: ReturnType<typeof setTimeout>;
try {
  const result = await Promise.race([
    resultPromise,
    new Promise<never>(
      (_, reject) =>
        (timeout = setTimeout(
          () => reject(new Error("Lowline browser check timed out")),
          60000,
        )),
    ),
  ]);
  await Bun.write(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (result.status !== "PASS") process.exitCode = 1;
} finally {
  clearTimeout(timeout!);
  proc.kill();
  await proc.exited;
  server.stop(true);
  await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
