/**
 * End to end on the real desktop host: a game script signs in, syncs a cloud save and talks
 * over a WebSocket to servers running in this process, through the Rust host's networking.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { buildNative } from "../cli/commands/build.ts";
import { loadProject } from "../cli/project.ts";
import { createServiceHandler } from "../src/services/server.ts";

const engine = resolve(import.meta.dir, "..");
const output = resolve(engine, ".blackiron/verification/native-net");
await mkdir(output, { recursive: true });

let finish: (value: Record<string, unknown>) => void = () => {};
const result = new Promise<Record<string, unknown>>((r) => (finish = r));
const services = createServiceHandler();
const server = Bun.serve({
  port: 0,
  async fetch(req, srv) {
    const path = new URL(req.url).pathname;
    if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    if (path === "/result") {
      finish((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    return services(req);
  },
  websocket: {
    // The Channel wire format: {t, d, i} is a call, {r, d} its answer.
    message(ws, raw) {
      if (typeof raw !== "string") return void ws.send(raw);
      const f = JSON.parse(raw) as { t: string; d: { a: number; b: number }; i?: number };
      if (f.t === "add" && f.i !== undefined) ws.send(JSON.stringify({ r: f.i, d: f.d.a + f.d.b }));
      if (f.t === "bye") ws.close(4002, "see you");
    },
  },
});
const base = `http://127.0.0.1:${server.port}`;

const root = await mkdtemp(join(tmpdir(), "blackiron-native-net-"));
try {
  await Bun.write(join(root, "blackiron.json"), JSON.stringify({ name: "Native net", entry: "main.ts", network: true, viewport: { width: 320, height: 180 } }));
  await Bun.write(
    join(root, "main.ts"),
    `import { Channel, createServices, memoryBackend } from ${JSON.stringify(resolve(engine, "src/index.ts"))};
export default async function main(app) {
  const net = app.platform.net;
  const report = (body) => net.request({ url: "${base}/result", json: body });
  try {
    const services = createServices({ config: { provider: "http", url: "${base}" }, net, storage: memoryBackend(), cloud: true });
    const player = await services.identity.signIn();
    services.saves.backend.set("slot", "native save \\u00fc");
    const sync = await services.saves.sync();
    const listed = await services.identity.authorized((s) => services.provider.listSaves(s));
    const missing = await net.request({ url: "${base}/nowhere" });
    let refused = "";
    try { await net.request({ url: "http://127.0.0.1:1/", timeoutMs: 3000 }); } catch (e) { refused = e.name + ":" + e.kind; }
    const channel = new Channel({ net, url: "ws://127.0.0.1:${server.port}/ws", heartbeatMs: 0, reconnect: false });
    const opened = new Promise((r) => channel.onStatus((s) => s === "open" && r(null)));
    channel.open();
    await opened;
    const sum = await channel.call("add", { a: 2, b: 40 });
    // A raw socket: binary out and back, then a close the server starts.
    const socket = net.connect("ws://127.0.0.1:${server.port}/ws");
    const echoed = await new Promise((r) => { socket.onMessage((m) => r(Array.from(m))); socket.onOpen(() => socket.send(new Uint8Array([1, 2, 250]))); });
    const closed = new Promise((r) => socket.onClose((e) => r(e)));
    socket.send(JSON.stringify({ t: "bye" }));
    const end = await closed;
    channel.close();
    await report({ kind: app.platform.kind, player, pushed: sync.pushed, listed: listed.map((d) => [d.key, d.data, d.rev]), missing: missing.status, refused, sum, echoed, end });
  } catch (e) {
    await report({ error: String(e && e.stack ? e.stack : e) });
  }
}
`,
  );
  const native = await buildNative(await loadProject(root));
  const build = Bun.spawn(["cargo", "build", "--locked", "--release", "--manifest-path", resolve(engine, "host/Cargo.toml")], { stdout: "inherit", stderr: "inherit" });
  if ((await build.exited) !== 0) throw new Error("Native build failed");
  const host = resolve(engine, `host/target/release/blackiron-host${process.platform === "win32" ? ".exe" : ""}`);
  for (const js of process.argv.includes("--v8") ? ["quickjs", "v8"] : ["quickjs"]) {
    const run = Bun.spawn([host, native.dir, "--size", "320x180", "--snapshot", join(output, "frame.png"), "--snapshot-frame", "100000", "--exit", "--js", js], { stdout: "pipe", stderr: "pipe" });
    const timeout = new Promise<Record<string, unknown>>((r) => setTimeout(() => r({ error: "no result within 30 seconds" }), 30000));
    const exited = run.exited.then(() => ({ error: "the host exited before reporting" }) as Record<string, unknown>);
    const got = await Promise.race([result, timeout, exited]);
    run.kill();
    await Bun.write(join(output, `${js}.log`), (await new Response(run.stdout).text()) + (await new Response(run.stderr).text()));
    await Bun.write(join(output, `${js}.json`), JSON.stringify(got, null, 2));
    assert.equal(got.error, undefined, String(got.error));
    assert.equal(got.kind, "native");
    assert.deepEqual(got.player, { id: "1", name: "Player 1", anonymous: true, providers: [] });
    assert.deepEqual(got.pushed, ["slot"]);
    assert.deepEqual(got.listed, [["slot", "native save ü", 1]]);
    assert.equal(got.missing, 404);
    assert.equal(got.refused, "NetError:offline");
    assert.equal(got.sum, 42);
    assert.deepEqual(got.echoed, [1, 2, 250]);
    assert.deepEqual(got.end, { code: 4002, reason: "see you", clean: true });
    console.log(`  native networking on ${js}: sign-in, cloud save, HTTP statuses, WebSocket call, binary echo and server close all pass`);
  }
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
