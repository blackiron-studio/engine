/** Real trusted input in an isolated headless Chrome, using Chrome's test/debug protocol.
 * Does not attach to or inspect the user's browser. Includes a paced rendering sample.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const forceFallback = process.env.BLACKIRON_TEST_MOUSE_FALLBACK === "1";
const engine = resolve(import.meta.dir, ".."),
  temp = await mkdtemp(join(tmpdir(), "blackiron-fps-input-")),
  output = resolve(
    engine,
    forceFallback
      ? ".blackiron/verification/breach-mouse-fallback"
      : ".blackiron/verification/breach-input",
  );
await mkdir(output, { recursive: true });
const entry = join(engine, "examples/breach/.blackiron/input-test.ts");
await mkdir(resolve(entry, ".."), { recursive: true });
await Bun.write(
  entry,
  `import main from "../src/main.ts";import {App} from "../../../src/app/app.ts";import config from "../blackiron.json";
const app=await App.create({canvas:'#blackiron',config:config as any});await main(app);app.audio.setMuted(true);
const times:number[]=[];const base=app.frame.bind(app);app.frame=(dt:number)=>{const start=performance.now();base(dt);times.push(performance.now()-start);if(times.length>4000)times.shift();};
(globalThis as any).__fpsTimes=times;(globalThis as any).__fpsReady=true;app.start();`,
);
const build = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  outdir: temp,
  naming: "game.js",
});
if (!build.success) throw new Error(build.logs.join("\n"));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/game.js")
      return new Response(Bun.file(join(temp, "game.js")));
    return new Response(
      '<html><body style="margin:0;background:#142b34"><canvas id="blackiron" style="width:1280px;height:720px"></canvas><script type="module" src="/game.js"></script></body></html>',
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
if (!chrome) throw new Error("Chrome required");
const profile = join(temp, "profile");
const proc = Bun.spawn(
  [
    chrome,
    ...(process.env.BLACKIRON_HEADED === "1" ? [] : ["--headless"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--window-size=1280,850",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let socket: WebSocket | undefined;
try {
  let port = "";
  for (let i = 0; i < 100; i++) {
    const f = Bun.file(join(profile, "DevToolsActivePort"));
    if (await f.exists()) {
      port = (await f.text()).split("\n")[0];
      break;
    }
    await sleep(100);
  }
  if (!port) throw new Error("Chrome debugging endpoint unavailable");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find(
    (p: any) => p.type === "page" && p.url === "about:blank",
  );
  if (!page) throw new Error("Missing isolated test page");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((r, j) => {
    socket!.onopen = () => r();
    socket!.onerror = () => j(new Error("Debug socket failed"));
  });
  let id = 0;
  const waiting = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  socket.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiting.get(m.id);
    if (w) {
      waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.error) w.reject(new Error(m.error.message));
      else w.resolve(m.result);
    }
  };
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const n = ++id,
        timer = setTimeout(() => {
          waiting.delete(n);
          reject(new Error(`Timeout: ${method}`));
        }, 15000);
      waiting.set(n, { resolve, reject, timer });
      socket!.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression: string) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.text + JSON.stringify(r.exceptionDetails.exception),
      );
    return r.result.value;
  };
  const until = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(
      `Timed out waiting for ${expression}: ${JSON.stringify(await evaluate("({phase:blackiron.scene.state.phase,message:blackiron.scene.message,rawError:globalThis.__lockError,locked:!!document.pointerLockElement,focus:document.hasFocus(),activation:navigator.userActivation.isActive,canvas:blackiron.canvas.getBoundingClientRect().toJSON()})"))}`,
    );
  };
  const check = (v: unknown, m: string) => {
    if (!v) throw new Error(m);
  };
  await send("Page.enable");
  if (forceFallback)
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        "Object.defineProperty(HTMLElement.prototype, 'requestPointerLock', {value:undefined, configurable:true});",
    });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  await until("globalThis.__fpsReady===true");
  await evaluate(
    "(()=>{const handler=blackiron.scene.lock.onError;blackiron.scene.lock.onError=m=>{(globalThis.__lockError??=[]).push(m);handler?.(m);};})()",
  );
  const click = async (x: number, y: number) => {
    const r = await evaluate(
      "(()=>{const r=blackiron.canvas.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()",
    );
    const p = {
      x: r.x + (x / 1280) * r.w,
      y: r.y + (y / 720) * r.h,
      button: "left",
      clickCount: 1,
    };
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...p });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...p });
    await sleep(100); // Canvas UI actions are routed on the next animation frame.
  };
  const key = async (
    code: string,
    key: string,
    windowsVirtualKeyCode: number,
  ) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      code,
      key,
      windowsVirtualKeyCode,
    });
    await sleep(70);
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      code,
      key,
      windowsVirtualKeyCode,
    });
    await sleep(100);
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.bringToFront");
  await until("__fpsTimes.length>=5");
  await sleep(500); // Wait for the newly navigated root document to commit and receive focus.

  await click(220, 519);
  await until("blackiron.scene.state.phase==='playing'");
  await sleep(500);
  const captured = await evaluate("document.pointerLockElement===blackiron.canvas");
  const captureError = await evaluate("globalThis.__lockError??[]");
  if (
    !captured &&
    !forceFallback &&
    !(
      process.env.BLACKIRON_ALLOW_UNAVAILABLE_POINTER_LOCK === "1" &&
      captureError.some((m: string) => m.includes("WrongDocumentError"))
    )
  )
    throw new Error(
      "Mouse capture not verified: " + JSON.stringify(captureError),
    );
  const yaw = await evaluate("blackiron.scene.look.yaw");
  if (captured) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 600,
      y: 350,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 680,
      y: 360,
    });
    await sleep(160);
  } else {
    check(
      await evaluate("blackiron.scene.lock.dragFallback"),
      "Drag fallback was not enabled",
    );
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 600,
      y: 350,
      button: "right",
      buttons: 2,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 680,
      y: 370,
      button: "right",
      buttons: 2,
    });
    const beforeChord = await evaluate("blackiron.scene.weapons[0].ammo");
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 680,
      y: 370,
      button: "left",
      buttons: 3,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 680,
      y: 370,
      button: "left",
      buttons: 2,
      clickCount: 1,
    });
    await sleep(160);
    check(
      (await evaluate("blackiron.scene.weapons[0].ammo")) < beforeChord,
      "Click while right-dragging did not fire",
    );
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 680,
      y: 370,
      button: "right",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(160);
  }
  check(
    (await evaluate("blackiron.scene.look.yaw")) !== yaw,
    "Look input did not turn camera",
  );
  const ammo = await evaluate("blackiron.scene.weapons[0].ammo");
  {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 640,
      y: 360,
      button: "left",
      clickCount: 1,
    });
    await sleep(220);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 640,
      y: 360,
      button: "left",
      clickCount: 1,
    });
  }
  check(
    (await evaluate("blackiron.scene.weapons[0].ammo")) < ammo,
    "Fire input failed",
  );
  await key("Escape", "Escape", 27);
  await until(
    "document.pointerLockElement===null && blackiron.scene.state.phase==='paused'",
  );
  const paused = await evaluate("JSON.stringify(blackiron.scene.diagnostics)");
  await sleep(200);
  check(
    paused === (await evaluate("JSON.stringify(blackiron.scene.diagnostics)")),
    "Pause changed gameplay",
  );
  if (captured) {
    await click(640, 424);
    await until(
      "document.pointerLockElement===blackiron.canvas && blackiron.scene.state.phase==='playing'",
    );
  } else {
    await click(640, 424);
    await until(
      "blackiron.scene.state.phase==='playing' && blackiron.scene.lock.dragFallback",
    );
  }
  const after = await evaluate("blackiron.scene.weapons[0].ammo");
  await sleep(250);
  check(
    after === (await evaluate("blackiron.scene.weapons[0].ammo")),
    "Fire stuck after resume",
  );
  await key("F1", "F1", 112);
  await until("blackiron.scene.settingsOpen && document.pointerLockElement===null");
  const sensitivity = await evaluate("blackiron.scene.look.sensitivity");
  await click(760, 245);
  check(
    (await evaluate("blackiron.scene.look.sensitivity")) > sensitivity,
    "Sensitivity control failed",
  );
  await click(750, 410);
  await key("KeyK", "k", 75);
  check(
    (await evaluate("blackiron.input.bindingsOf('jump')[0]")) === "KeyK",
    "Rebind failed",
  );
  await send("Page.reload", {});
  await until(
    "globalThis.__fpsReady===true && blackiron.scene.state.phase==='title'",
  );
  check(
    (await evaluate("blackiron.input.bindingsOf('jump')[0]")) === "KeyK",
    "Binding did not persist across reload",
  );
  check(
    (await evaluate("blackiron.scene.look.sensitivity")) > sensitivity,
    "Sensitivity did not persist",
  );
  await click(220, 519);
  await until(
    captured
      ? "document.pointerLockElement===blackiron.canvas"
      : "blackiron.scene.state.phase==='playing'",
  );
  // Performance sample runs on actual rAF pacing, after startup warm-up.
  await sleep(1000);
  await evaluate(
    `globalThis.__fpsStrafe=0;globalThis.__fpsBot=setInterval(()=>{blackiron.input.keyUp("KeyA");blackiron.input.keyUp("KeyD");blackiron.input.keyDown((__fpsStrafe++%2)?"KeyA":"KeyD");blackiron.input.keyDown("KeyJ");},900);__fpsTimes.length=0; globalThis.__fpsFrameTimes=[]; globalThis.__fpsLast=performance.now(); globalThis.__fpsSampling=true; (function sample(now){if(!globalThis.__fpsSampling)return; __fpsFrameTimes.push(now-__fpsLast);__fpsLast=now;requestAnimationFrame(sample);})(performance.now());`,
  );
  await sleep(20000);
  const result = await evaluate(
    `(()=>{globalThis.__fpsSampling=false;clearInterval(globalThis.__fpsBot);blackiron.input.reset();const percentile=(a,p)=>{a.sort((x,y)=>x-y);return a[Math.ceil(a.length*p)-1]??null};const gl=blackiron.canvas.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return {status:'PASS',trustedInput:{escapePause:true,noStuckFire:true,settings:true,rebind:true,persistence:true},performance:{seconds:20,frames:__fpsTimes.length,cpuP95Ms:percentile(__fpsTimes,0.95),frameP95Ms:percentile(__fpsFrameTimes.slice(1),0.95),gpu:blackiron.renderer.diagnostics.gpu,estimatedGpuBytes:blackiron.renderer.diagnostics.estimatedGpuBytes,device:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)},diagnostics:blackiron.scene.diagnostics,glError:gl.getError()};})()`,
  );
  Object.assign(result.trustedInput, {
    capture: captured ? "PASS" : "UNAVAILABLE",
    mouseLook: captured ? "PASS" : "PASS (right-drag fallback)",
    mouseFire: "PASS",
    fireWhileDragging: captured ? "not applicable" : "PASS",
    fallbackSimulated: forceFallback,
    recapture: captured ? "PASS" : "UNAVAILABLE",
  });
  result.captureError = captureError;
  result.scope =
    "Isolated Chrome input and 20-second rAF-paced gameplay; unavailable capture is explicitly reported and is not a passing capture test.";
  result.performance.checks = {
    cpu: result.performance.cpuP95Ms <= 8.3,
    framePacing: result.performance.frameP95Ms <= 17.2,
    gpu:
      result.performance.gpu.p95Ms !== null &&
      result.performance.gpu.p95Ms <= 8.3,
    memory: result.performance.estimatedGpuBytes <= 268435456,
    realGPU: !/(SwiftShader|llvmpipe|Software)/i.test(
      result.performance.device,
    ),
  };
  if (
    result.glError !== 0 ||
    Object.values(result.performance.checks).some((v) => !v)
  )
    result.status = "FAIL";
  await Bun.write(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  const png = await evaluate("blackiron.canvas.toDataURL('image/png')");
  await Bun.write(
    join(output, "live.png"),
    Buffer.from(png.split(",")[1], "base64"),
  );
  if (result.status !== "PASS") process.exitCode = 1;
} catch (error) {
  const result = {
    status: "FAIL",
    error: String((error as Error).stack ?? error),
  };
  await Bun.write(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  socket?.close();
  proc.kill();
  await proc.exited;
  server.stop(true);
  await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  await rm(entry, { force: true });
}
