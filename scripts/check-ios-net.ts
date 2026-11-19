/**
 * End to end on an iOS simulator: an exported app with `services`, `cloud` and Sign in with
 * Apple configured signs in as a guest, syncs a store and talks over a WebSocket to servers
 * in this process, through BlackironNet.swift. Uses a throwaway simulator and never opens
 * the Simulator window.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { createServiceHandler } from "../src/services/server.ts";

if (process.platform !== "darwin") throw Error("The iOS networking check requires macOS and Xcode");
const engine = resolve(import.meta.dir, "..");
const output = resolve(engine, ".blackiron/verification/ios-net");
await mkdir(output, { recursive: true });

async function sh(command: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw Error(`${command.slice(0, 3).join(" ")} failed (${code}): ${out.slice(-2000)}${err.slice(-2000)}`);
  return out;
}

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
    message(ws, raw) {
      if (typeof raw !== "string") return void ws.send(raw);
      const f = JSON.parse(raw) as { t: string; d: { a: number; b: number }; i?: number };
      if (f.t === "add" && f.i !== undefined) ws.send(JSON.stringify({ r: f.i, d: f.d.a + f.d.b }));
      if (f.t === "bye") ws.close(4002, "see you");
    },
  },
});
const base = `http://127.0.0.1:${server.port}`;
const root = await mkdtemp(join(tmpdir(), "blackiron-ios-net-"));
let udid = "";
try {
  await Bun.write(
    join(root, "blackiron.json"),
    JSON.stringify({ name: "Net check", version: "1.0", buildNumber: 1, entry: "main.ts", targets: ["ios"], services: { provider: "http", url: base }, cloud: true, ios: { bundleId: "com.blackiron.netcheck", signInWithApple: true } }),
  );
  await Bun.write(
    join(root, "main.ts"),
    `import { Channel, createStore } from ${JSON.stringify(resolve(engine, "src/index.ts"))};
export default async function main(app) {
  const net = app.platform.net;
  const report = (body) => net.request({ url: "${base}/result", json: body });
  try {
    const { identity, saves, provider } = app.services;
    const player = await identity.signIn();
    createStore({ key: "progress", version: 1, initial: () => ({ level: 1 }) }).save({ level: 7 });
    const sync = await saves.sync();
    const listed = await identity.authorized((s) => provider.listSaves(s));
    const missing = await net.request({ url: "${base}/nowhere" });
    let refused = "";
    try { await net.request({ url: "http://127.0.0.1:1/", timeoutMs: 3000 }); } catch (e) { refused = e.name + ":" + e.kind; }
    const channel = new Channel({ net, url: "ws://127.0.0.1:${server.port}/ws", heartbeatMs: 0, reconnect: false });
    const opened = new Promise((r) => channel.onStatus((s) => s === "open" && r(null)));
    channel.open();
    await opened;
    const sum = await channel.call("add", { a: 2, b: 40 });
    const socket = net.connect("ws://127.0.0.1:${server.port}/ws");
    const echoed = await new Promise((r) => { socket.onMessage((m) => r(Array.from(m))); socket.onOpen(() => socket.send(new Uint8Array([1, 2, 250]))); });
    const closed = new Promise((r) => socket.onClose((e) => r(e)));
    socket.send(JSON.stringify({ t: "bye" }));
    const end = await closed;
    channel.close();
    await report({ kind: app.platform.kind, player, pushed: sync.pushed, saved: listed.map((d) => [d.key, JSON.parse(d.data).data, d.rev]), missing: missing.status, refused, sum, echoed, end, sheets: identity.platformProviders(), hostSheets: app.platform.signIn ? app.platform.signIn.providers() : null });
  } catch (e) {
    await report({ error: String(e && e.stack ? e.stack : e) });
  }
}
`,
  );
  console.log("  exporting and building for the simulator");
  await sh([process.execPath, join(engine, "cli/blackiron.ts"), "export", "ios", "--out", "ios", "--signing", "unsigned"], root);
  const exported = join(root, "ios");
  const manifest = (await Bun.file(join(exported, "blackiron-export.json")).json()) as { projectPath: string; scheme: string };
  const plist = await Bun.file(join(exported, "Info.plist")).text();
  assert.match(plist, /BlackironSignInWithApple/);
  assert.match(plist, /NSAllowsLocalNetworking/);
  assert.match(await Bun.file(join(exported, "App.entitlements")).text(), /com\.apple\.developer\.applesignin/);
  const derived = join(output, "DerivedData");
  await sh(["xcodebuild", "-project", join(exported, manifest.projectPath), "-scheme", manifest.scheme, "-configuration", "Debug", "-derivedDataPath", derived, "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "CODE_SIGNING_ALLOWED=NO", "build"], exported);
  const app = join(derived, `Build/Products/Debug-iphonesimulator/${manifest.scheme}.app`);

  const types = JSON.parse(await sh(["xcrun", "simctl", "list", "devicetypes", "-j"])) as { devicetypes: { identifier: string; name: string }[] };
  const runtimes = JSON.parse(await sh(["xcrun", "simctl", "list", "runtimes", "-j"])) as { runtimes: { identifier: string; platform?: string; isAvailable: boolean }[] };
  const runtime = runtimes.runtimes.filter((r) => r.isAvailable && r.identifier.includes("iOS")).pop();
  // The newest plain iPhone: old device types are listed but cannot run a current runtime.
  const type = types.devicetypes.filter((t) => /^iPhone \d+$/.test(t.name)).sort((a, b) => Number(a.name.slice(7)) - Number(b.name.slice(7))).pop();
  if (!runtime || !type) throw Error("No iOS simulator runtime or iPhone device type is installed");
  udid = (await sh(["xcrun", "simctl", "create", "Blackiron net check", type.identifier, runtime.identifier])).trim();
  console.log(`  booting a throwaway ${type.name} (${udid})`);
  await sh(["xcrun", "simctl", "bootstatus", udid, "-b"]);
  await sh(["xcrun", "simctl", "install", udid, app]);
  await sh(["xcrun", "simctl", "launch", udid, "com.blackiron.netcheck"]);
  const got = await Promise.race([result, new Promise<Record<string, unknown>>((r) => setTimeout(() => r({ error: "no result within 60 seconds" }), 60000))]);
  await Bun.write(join(output, "result.json"), JSON.stringify(got, null, 2));
  assert.equal(got.error, undefined, String(got.error));
  assert.equal(got.kind, "native");
  assert.deepEqual(got.player, { id: "1", name: "Player 1", anonymous: true, providers: [] });
  assert.deepEqual(got.pushed, ["progress"]);
  assert.deepEqual(got.saved, [["progress", { level: 7 }, 1]]);
  assert.equal(got.missing, 404);
  assert.equal(got.refused, "NetError:offline");
  assert.equal(got.sum, 42);
  assert.deepEqual(got.echoed, [1, 2, 250]);
  assert.deepEqual(got.end, { code: 4002, reason: "see you", clean: true });
  // The build offers the Apple sheet; the reference backend can verify it.
  assert.deepEqual(got.hostSheets, ["apple"]);
  assert.deepEqual(got.sheets, ["apple"]);
  console.log("  iOS networking: App.services guest sign-in, cloud save of a store, HTTP statuses, WebSocket call, binary echo and server close all pass");
} finally {
  server.stop(true);
  if (udid) {
    await sh(["xcrun", "simctl", "shutdown", udid]).catch(() => {});
    await sh(["xcrun", "simctl", "delete", udid]).catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
}
