/** Exercise an exported standalone HTML in Chrome. Only the HTML and test result endpoint are served. */
import { mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { bundleFonts } from "../cli/commands/build.ts";
import { loadProject } from "../cli/project.ts";
const engine = resolve(import.meta.dir, ".."),
  output = join(engine, ".kiln/verification/exports");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "kiln-export-browser-"));
const chrome =
  process.env.CHROME_PATH ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome");
let proc: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const fixture = join(engine, "tests/fixtures/native3d");
  await cp(join(fixture, "assets"), join(root, "assets"), { recursive: true });
  // Use a real local font already used by the showcase. An explicit dependency failure is preferable to silently skipping font decode.
  const fontNames = await bundleFonts(
    await loadProject(join(engine, "examples/lumen")),
    root,
  );
  if (!fontNames.length)
    throw Error(
      "Could not package a real font for the browser acceptance check",
    );
  const font = join(root, "fonts", fontNames[0]);
  await cp(font, join(root, "assets/font.ttf"));
  await Bun.write(
    join(root, "font.css"),
    '@font-face {font-family:"Export Audit";font-weight:500;src:url("assets/font.ttf")}',
  );
  const config = await Bun.file(join(fixture, "kiln.json")).json();
  await Bun.write(
    join(root, "kiln.json"),
    JSON.stringify({
      ...config,
      name: "Offline export acceptance",
      fonts: ["font.css"],
    }),
  );
  await Bun.write(
    join(root, "main.ts"),
    `
 import main from ${JSON.stringify(join(fixture, "main.ts"))};
 import {loadGltf} from ${JSON.stringify(join(engine, "src/three/index.ts"))};
 export default async function(app) {
  try {
   const image=await app.platform.loadImage("assets/checker.png");
   const gltf=await loadGltf(app.platform,"./assets/model.gltf");
   const instance=gltf.instantiate(); if(!instance.children.length)throw Error("glTF empty"); instance.dispose(); gltf.dispose();
   for(const name of ["physics.wasm","audio.wasm"]) await WebAssembly.compile(await app.platform.loadBytes(name));
   await main(app);
   const font=document.fonts.check('500 16px "Export Audit"');
   let frames=0;
   const check=()=> {if(++frames<30){requestAnimationFrame(check);return;}
     try {
      app.frame(1/60);
      const gl=document.querySelector("canvas").getContext("webgl2");
      const ext=gl.getExtension("WEBGL_debug_renderer_info");
      const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const colors=new Set();for(let i=0;i<pixels.length;i+=4)colors.add(pixels[i]+","+pixels[i+1]+","+pixels[i+2]);
      if(colors.size<8||!font||image.width<1)throw Error("Export rendered no useful pixels or font missing: "+colors.size);
      fetch("/result",{method:"POST",body:JSON.stringify({status:"PASS",colors:colors.size,font,image:[image.width,image.height],renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),checks:["external glTF + bin + PNG","embedded GLB + skeletal sample","Rapier 3D scene","physics/audio Wasm compilation","local font decode","WebGL2 rendered pixels"]})});
     }catch(e){fetch("/result",{method:"POST",body:JSON.stringify({status:"FAIL",error:String(e)})});}
   };requestAnimationFrame(check);
  }catch(e){fetch("/result",{method:"POST",body:JSON.stringify({status:"FAIL",error:String(e)})});throw e;}
 }`,
  );
  const build = Bun.spawn(
    [
      process.execPath,
      join(engine, "cli/kiln.ts"),
      "export",
      "web",
      "--single-file",
      "--out",
      "standalone.html",
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if ((await build.exited) !== 0) throw Error("Export failed");
  const html = await Bun.file(join(root, "standalone.html")).text();
  const blocked: string[] = [];
  let finish: (value: any) => void = () => {};
  const result = new Promise<any>((r) => (finish = r));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/")
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      if (path === "/result" && req.method === "POST") {
        finish(await req.json());
        return new Response("ok");
      }
      if (path !== "/favicon.ico") blocked.push(path);
      return new Response("External asset blocked", { status: 404 });
    },
  });
  proc = Bun.spawn(
    [
      chrome,
      "--headless",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--user-data-dir=${join(root, "chrome")}`,
      `http://127.0.0.1:${server.port}/`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let timeout: ReturnType<typeof setTimeout>;
  const report = await Promise.race([
    result,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(Error("Offline browser export timed out")),
        30000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  report.blockedAssetRequests = blocked;
  await Bun.write(
    join(output, "single-file.json"),
    JSON.stringify(report, null, 2),
  );
  if (report.status !== "PASS" || blocked.length)
    throw Error(JSON.stringify(report));
  console.log(JSON.stringify(report, null, 2));
} finally {
  proc?.kill();
  if (proc) await proc.exited;
  server?.stop(true);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
