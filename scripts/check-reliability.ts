import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem, platform, release } from "node:os";
import { resolve, join } from "node:path";
const engine = resolve(import.meta.dir, ".."),
  seconds = Number(process.env.BLACKIRON_SOAK_SECONDS ?? 1800);
if (!Number.isFinite(seconds) || seconds < 1)
  throw new Error("Invalid soak duration");
const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];
let chrome: string | undefined;
for (const p of candidates)
  if (await Bun.file(p).exists()) {
    chrome = p;
    break;
  }
if (!chrome) throw new Error("Chrome required");
const temp = await mkdtemp(join(tmpdir(), "blackiron-soak-")),
  output = resolve(engine, ".blackiron/verification/reliability");
await mkdir(output, { recursive: true });
const build = await Bun.build({
  entrypoints: [resolve(engine, "tests/browser/reliability-soak.ts")],
  target: "browser",
  outdir: temp,
  naming: "soak.js",
});
if (!build.success) throw new Error(build.logs.join("\n"));
const bundleHash = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(join(temp, "soak.js")).arrayBuffer())
  .digest("hex");
let done!: (value: unknown) => void;
const finished = new Promise<any>((r) => (done = r));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/progress") {
      const progress = await req.json();
      await Bun.write(join(output, "progress.json"), JSON.stringify(progress));
      console.log(JSON.stringify(progress));
      return new Response("ok");
    }
    if (req.method === "POST" && url.pathname === "/result") {
      done(await req.json());
      return new Response("ok");
    }
    if (url.pathname === "/soak.js")
      return new Response(Bun.file(join(temp, "soak.js")));
    return new Response(
      '<!doctype html><html><body><canvas style="width:1280px;height:720px"></canvas><pre></pre><script type="module" src="/soak.js"></script></body></html>',
      { headers: { "content-type": "text/html" } },
    );
  },
});
const proc = Bun.spawn(
  [
    chrome,
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    `--user-data-dir=${join(temp, "profile")}`,
    "--window-size=1280,850",
    `http://127.0.0.1:${server.port}/?seconds=${seconds}`,
  ],
  { stdout: "ignore", stderr: "ignore" },
);
let timeout: ReturnType<typeof setTimeout>;
try {
  const result = await Promise.race([
    finished,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Hardware soak timed out")),
        (seconds + 90) * 1000,
      );
    }),
  ]);
  const budgets = await Bun.file(
    resolve(engine, "performance-budgets.json"),
  ).json();
  const checks = {
    frame2D:
      result.mode2D.frameP95Ms !== null &&
      result.mode2D.frameP95Ms <= 1000 / budgets.targetFps + 0.5,
    frame3D:
      result.mode3D.frameP95Ms !== null &&
      result.mode3D.frameP95Ms <= 1000 / budgets.targetFps + 0.5,
    cpu2D:
      result.mode2D.cpuP95Ms !== null &&
      result.mode2D.cpuP95Ms <= budgets.cpuP95Ms,
    cpu3D:
      result.mode3D.cpuP95Ms !== null &&
      result.mode3D.cpuP95Ms <= budgets.cpuP95Ms,
    gpu:
      result.gpu.p95Ms === null
        ? "unavailable"
        : result.gpu.p95Ms <= budgets.gpuP95Ms,
    memory: result.estimatedGpuBytes.max <= budgets.estimatedGpuBytes,
    stableAllocation:
      result.estimatedGpuBytes.max - result.estimatedGpuBytes.steadyMin <=
      65536,
    gpuWorkloads: Object.values(
      result.gpuWindows as Record<
        string,
        { samples: number; maxP95Ms: number }
      >,
    ).every((v) => v.samples > 0 && v.maxP95Ms <= budgets.gpuP95Ms),
    restarts: result.restarts >= budgets.minimumRestarts,
    realGPU: !/(SwiftShader|llvmpipe|Software)/i.test(result.device),
  };
  const report = {
    ...result,
    checks,
    budgets,
    bundleHash,
    host: {
      cpu: cpus()[0].model,
      ramBytes: totalmem(),
      os: platform(),
      release: release(),
    },
    requestedSeconds: seconds,
    measuredAt: new Date().toISOString(),
  };
  await Bun.write(join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (
    result.status !== "PASS" ||
    Object.values(checks).some((v) => v === false)
  )
    process.exitCode = 1;
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
