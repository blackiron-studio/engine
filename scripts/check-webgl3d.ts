/** Run the actual WebGL2 pipeline in Chrome and check pixels, not just recorded calls.
 * bun scripts/check-webgl3d.ts [path-to-Chrome]
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const candidates = [
  process.argv[2],
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => !!p);
let chrome: string | undefined;
for (const candidate of candidates)
  if (await Bun.file(candidate).exists()) {
    chrome = candidate;
    break;
  }
if (!chrome)
  throw new Error(
    "Chrome/Chromium is required. Set CHROME_PATH or pass the executable path.",
  );
const output = resolve(import.meta.dir, "../.kiln/verification/three");
await mkdir(output, { recursive: true });
await rm(join(output, "frame.png"), { force: true });
const profile = await mkdtemp(join(tmpdir(), "kiln-webgl3d-"));
const bundle = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../tests/browser/three-smoke.ts")],
  target: "browser",
  outdir: output,
  naming: "smoke.js",
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
await writeFile(
  join(output, "index.html"),
  '<!doctype html><html><body style="margin:0;background:#10171d;color:white"><canvas></canvas><pre></pre><script src="smoke.js"></script></body></html>',
);
const proc = Bun.spawn(
  [
    chrome,
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--user-data-dir=${profile}`,
    "--window-size=1000,1050",
    `--screenshot=${join(output, "frame.png")}`,
    "--dump-dom",
    "--virtual-time-budget=2000",
    pathToFileURL(join(output, "index.html")).href,
  ],
  { stdout: "pipe", stderr: "ignore" },
);
let html = "";
try {
  const reader = proc.stdout.getReader();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error("Chrome WebGL check timed out after 25 seconds")),
      25000,
    );
  });
  try {
    while (!html.includes("</html>")) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      html += new TextDecoder().decode(value);
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  await writeFile(join(output, "result.html"), html);
  const content = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
  if (!content || !html.includes('data-status="PASS"'))
    throw new Error(`WebGL3D smoke failed: ${content ?? html}`);
  const result = JSON.parse(
    content.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
  );
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  // Chrome writes its screenshot immediately after the DOM result.
  for (
    let i = 0;
    i < 30 && !(await Bun.file(join(output, "frame.png")).exists());
    i++
  )
    await Bun.sleep(100);
  console.log(JSON.stringify(result, null, 2));
  console.log(`WebGL3D evidence: ${output}`);
} finally {
  proc.kill();
  await proc.exited;
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
