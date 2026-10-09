import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadProject } from "../cli/project.ts";
import { buildNative } from "../cli/commands/build.ts";
import { decodePNG, encodePNG } from "../cli/png.ts";
import { compareImages } from "../cli/commands/verify.ts";
const engine = resolve(import.meta.dir, ".."),
  root = resolve(engine, "tests/fixtures/native3d"),
  output = resolve(engine, ".kiln/verification/native-content");
await mkdir(output, { recursive: true });
const native = await buildNative(await loadProject(root));
const build = Bun.spawn(
  [
    "cargo",
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    resolve(engine, "host/Cargo.toml"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await build.exited) !== 0) throw new Error("Native build failed");
const host = resolve(
  engine,
  `host/target/release/kiln-host${process.platform === "win32" ? ".exe" : ""}`,
);
const capture = Bun.spawn(
  [
    host,
    native.dir,
    "--size",
    "800x600",
    "--snapshot",
    join(output, "native.png"),
    "--snapshot-frame",
    "100",
    "--exit",
    "--fixed-dt",
    "16.666666666666668",
    "--js",
    "quickjs",
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const [stdout, stderr, code] = await Promise.all([
  new Response(capture.stdout).text(),
  new Response(capture.stderr).text(),
  capture.exited,
]);
await Bun.write(join(output, "native.log"), stdout + stderr);
if (code !== 0) throw new Error("Native content check failed: " + stderr);
const temp = await mkdtemp(join(tmpdir(), "kiln-native-content-"));
const entry = join(root, ".kiln/browser-check.ts");
await mkdir(resolve(root, ".kiln"), { recursive: true });
await Bun.write(
  entry,
  `import main from '../main.ts';import {App} from '${resolve(engine, "src/app/app.ts")}';try{const app=await App.create({canvas:'canvas',config:{seed:1,viewport:{width:800,height:600},render:{scale:1,snap:'none'}}});await main(app);app.renderer.resize(800,600,1);for(let i=0;i<100;i++)app.frame(1/60);const gl=app.canvas.getContext('webgl2');if(gl.getError())throw Error('GL error');await fetch('/result',{method:'POST',body:JSON.stringify({png:app.canvas.toDataURL('image/png'),physics:app.scene.physics3D.stats})});}catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({error:String(error.stack??error)})});}`,
);
const bundled = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  outdir: temp,
  naming: "main.js",
});
if (!bundled.success) throw new Error(bundled.logs.join("\n"));
let done!: (result: any) => void;
const finished = new Promise<any>((r) => (done = r));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/result") {
      done(await req.json());
      return new Response("ok");
    }
    if (path === "/")
      return new Response(
        '<!doctype html><html><body><canvas style="width:800px;height:600px"></canvas><script type="module" src="/main.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    const file =
      path === "/main.js" ? join(temp, "main.js") : resolve(root, "." + path);
    if (file !== join(temp, "main.js") && !file.startsWith(root + "/"))
      return new Response("Forbidden", { status: 403 });
    return (await Bun.file(file).exists())
      ? new Response(Bun.file(file))
      : new Response("Not found", { status: 404 });
  },
});
const chrome =
  process.env.CHROME_PATH ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome");
const browser = Bun.spawn(
  [
    chrome,
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${join(temp, "profile")}`,
    "--window-size=800,700",
    `http://127.0.0.1:${server.port}/`,
  ],
  { stdout: "ignore", stderr: "ignore" },
);
let timeout: ReturnType<typeof setTimeout>;
try {
  const result = await Promise.race([
    finished,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(Error("Browser content check timed out")),
        30000,
      );
    }),
  ]);
  if (result.error) throw new Error(result.error);
  await Bun.write(
    join(output, "web.png"),
    Buffer.from(result.png.split(",")[1], "base64"),
  );
  const web = decodePNG(
      new Uint8Array(await Bun.file(join(output, "web.png")).arrayBuffer()),
    ),
    nativeImage = decodePNG(
      new Uint8Array(await Bun.file(join(output, "native.png")).arrayBuffer()),
    );
  const normalize = (image: typeof web) => {
    const width = 800,
      height = 600,
      rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = Math.min(
            image.width - 1,
            Math.floor(((x + 0.5) * image.width) / width),
          ),
          sy = Math.min(
            image.height - 1,
            Math.floor(((y + 0.5) * image.height) / height),
          );
        rgba.set(
          image.rgba.subarray(
            (sy * image.width + sx) * 4,
            (sy * image.width + sx) * 4 + 4,
          ),
          (y * width + x) * 4,
        );
      }
    return { width, height, rgba };
  };
  const comparison = compareImages(normalize(web), normalize(nativeImage));
  await Bun.write(
    join(output, "difference.png"),
    encodePNG(comparison.width, comparison.height, comparison.diff),
  );
  // Check content exists as well as agreement; two blank frames must never pass.
  const colorful = (image: typeof web) => {
    let count = 0;
    for (let i = 0; i < image.rgba.length; i += 4) {
      const r = image.rgba[i],
        g = image.rgba[i + 1],
        b = image.rgba[i + 2];
      if ((r > 150 && r > g * 1.4) || (g > 150 && g > r * 1.4)) count++;
    }
    return count;
  };
  const fraction = comparison.differing / comparison.total,
    report = {
      status:
        fraction <= 0.02 &&
        !comparison.sizeMismatch &&
        colorful(web) > 500 &&
        colorful(nativeImage) > 500
          ? "PASS"
          : "FAIL",
      differingFraction: fraction,
      tolerance: 0.02,
      webColoredPixels: colorful(web),
      nativeColoredPixels: colorful(nativeImage),
      physics: result.physics,
      normalizedResolution: [800, 600],
      captureResolution: {
        web: [web.width, web.height],
        native: [nativeImage.width, nativeImage.height],
      },
      scope:
        "Embedded GLB PNG, texture UVs, CPU skin pose, Rapier gravity/contact, native depth and browser/native interior pixels",
    };
  await Bun.write(join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(report);
  if (report.status !== "PASS")
    throw new Error("Native/browser content mismatch");
} finally {
  clearTimeout(timeout!);
  browser.kill();
  await browser.exited;
  server.stop(true);
  await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  await rm(entry, { force: true });
}
