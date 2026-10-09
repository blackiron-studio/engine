/** Real-browser startup, input/pause/resume and GPU smoke checks for the three flagship games.
 * bun scripts/check-showcases.ts [optional project directory]
 * Uses an isolated Chrome profile; writes screenshots and evidence under .kiln/verification/showcases.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
const engine = resolve(import.meta.dir, "..");
const targets = process.argv[2]
  ? [process.argv[2]]
  : ["examples/demo", "templates/isometric", "examples/lumen"];
const chrome =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!(await Bun.file(chrome).exists()))
  throw new Error("Set CHROME_PATH to a Chrome/Chromium executable");
for (const target of targets) {
  const root = resolve(engine, target),
    config = await Bun.file(join(root, "kiln.json")).json();
  const slug = root.split("/").at(-1)!;
  const output = resolve(engine, ".kiln/verification/showcases", slug);
  await mkdir(output, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), "kiln-showcase-"));
  const entry = join(root, ".kiln", "showcase-check.ts");
  await mkdir(join(root, ".kiln"), { recursive: true });
  await writeFile(
    entry,
    `
import main from ${JSON.stringify(join(root, config.entry))};
import { App } from ${JSON.stringify(join(engine, "src/app/app.ts"))};
const report = document.querySelector('pre');
const check=(condition,message)=>{if(!condition)throw new Error(message);};
try {
 const app=await App.create({canvas:'#kiln',config:{...${JSON.stringify(config)},seed:7,fps:false}});
 await main(app); app.audio.setMuted(true);
 const frame=(n=1)=>{for(let i=0;i<n;i++)app.frame(1/60);};
 const press=(action)=>{app.input.press(action);frame();app.input.release(action);frame();};
 const key=(code)=>{window.dispatchEvent(new KeyboardEvent('keydown',{code,key:code,bubbles:true}));frame();window.dispatchEvent(new KeyboardEvent('keyup',{code,key:code,bubbles:true}));frame();};
 frame(3);key('Enter');frame(45);
 const playing=app.scenes.current;
 check(!!playing,'Missing play scene');
 if(${JSON.stringify(slug)}!=='lumen') check(playing.name==='play','Enter did not start gameplay');
 const before=JSON.stringify(playing.state ?? {x:playing.gx,y:playing.gy,z:playing.gz});
 key('Escape');frame(8);
 const paused=JSON.stringify(playing.state ?? {x:playing.gx,y:playing.gy,z:playing.gz});
 check(before===paused,'Pause mutated simulation');
 key('Escape');frame(3);
 check(app.scenes.current===playing,'Resume did not restore game');
 let orthographicPng=null;
 if(${JSON.stringify(slug)}==='lumen'){
   press('view');check(playing.camera3D.projection==='orthographic','Orthographic view switch failed');
   orthographicPng=app.canvas.toDataURL('image/png');
   press('view');check(playing.camera3D.projection==='perspective','Perspective view switch failed');
   press('dash');check(playing.state.dashCooldown>0,'Dash did not start');
 }
 app.input.press('right');frame(12);app.input.release('right');press('jump');frame(4);
 const gl=app.canvas.getContext('webgl2');
 check(!!gl,'WebGL2 unavailable');
 const error=gl.getError();check(error===gl.NO_ERROR,'WebGL error '+error);
 const times=[];for(let i=0;i<60;i++){const t=performance.now();frame();times.push(performance.now()-t);}times.sort((a,b)=>a-b);
 const stats={...app.renderer.stats},three=app.renderer.stats3D?{...app.renderer.stats3D}:null;
 check(stats.drawCalls>0,'Empty frame');
 const png=app.canvas.toDataURL('image/png');
 const result={name:${JSON.stringify(config.name)},status:'PASS',pauseStable:true,resumed:true,glError:error,scene:playing.name||playing.constructor.name,frameCpuMs:{median:times[30],p95:times[57]},stats,three};
 await fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({result,png,orthographicPng})});
 report.textContent=JSON.stringify(result);document.body.dataset.status='PASS';
} catch(error){const result={status:'FAIL',error:String(error?.stack??error)};report.textContent=result.error;document.body.dataset.status='FAIL';await fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({result})});}
`,
  );
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    outdir: temp,
    naming: "smoke.js",
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  let result: any;
  let finish: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/result" && req.method === "POST") {
        const body = await req.json();
        result = body.result;
        if (body.png)
          await writeFile(
            join(output, "play.png"),
            Buffer.from(body.png.split(",")[1], "base64"),
          );
        if (body.orthographicPng)
          await writeFile(join(output, "orthographic.png"), Buffer.from(body.orthographicPng.split(",")[1], "base64"));
        await writeFile(
          join(output, "result.json"),
          JSON.stringify(result, null, 2),
        );
        finish!();
        return new Response("ok");
      }
      if (url.pathname === "/")
        return new Response(
          '<!doctype html><html><body style="margin:0"><canvas id="kiln" style="width:1280px;height:720px"></canvas><pre></pre><script type="module" src="/smoke.js"></script></body></html>',
          { headers: { "content-type": "text/html" } },
        );
      const path =
        url.pathname === "/smoke.js"
          ? join(temp, "smoke.js")
          : resolve(root, `.${url.pathname}`);
      if (path !== join(temp, "smoke.js") && !path.startsWith(root + "/"))
        return new Response("Forbidden", { status: 403 });
      const file = Bun.file(path);
      return (await file.exists())
        ? new Response(file)
        : new Response("Missing", { status: 404 });
    },
  });
  const proc = Bun.spawn(
    [
      chrome,
      "--headless",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--user-data-dir=${join(temp, "profile")}`,
      "--window-size=1280,850",
      "--dump-dom",
      "--virtual-time-budget=12000",
      `http://127.0.0.1:${server.port}/`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Chrome can keep stdout open after dumping a page containing audio/timers.
    // The page's completed assertion report is the authoritative completion signal.
    const stdout = new Response(proc.stdout).text();
    await Promise.race([
      finished,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${config.name} browser smoke timed out`)),
          45000,
        );
      }),
    ]);
    if (result?.status !== "PASS")
      throw new Error(`${config.name}: ${result?.error ?? "No test output"}`);
    console.log(JSON.stringify(result));
  } finally {
    clearTimeout(timer);
    proc.kill("SIGKILL");
    await proc.exited;
    server.stop(true);
    await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(entry, { force: true });
  }
}
