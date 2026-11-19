import { describe, expect, test } from "bun:test";
import { Channel, ChannelError, ClockSync, HostNet, InputBuffer, LoopbackNet, NetError, Peer, SnapshotBuffer, WebNet, fromBase64, toBase64 } from "../src/net/index.ts";
import type { BlackironHostApi } from "../src/render/native.ts";

const URL_ = "wss://game.test/play";

describe("loopback sockets", () => {
  test("connects, echoes text and bytes, and closes cleanly on both ends", async () => {
    const net = new LoopbackNet({ manual: true, latency: 40 });
    const serverSaw: unknown[] = [];
    let serverClosed: unknown = null;
    net.listen(URL_, (peer) => {
      peer.onMessage((m) => {
        serverSaw.push(m);
        peer.send(m);
      });
      peer.onClose((e) => (serverClosed = e));
    });
    const s = net.connect(`${URL_}?token=abc`);
    const got: unknown[] = [];
    let opened = false;
    s.onOpen(() => (opened = true));
    s.onMessage((m) => got.push(m));
    expect(s.send("early")).toBe(false);
    await net.advance(79);
    expect(opened).toBe(false);
    await net.advance(1);
    expect(opened).toBe(true);
    s.send("hello");
    s.send(new Uint8Array([1, 2, 255]));
    await net.advance(40);
    expect(serverSaw).toEqual(["hello", new Uint8Array([1, 2, 255])]);
    expect(got).toEqual([]);
    await net.advance(40);
    expect(got).toEqual(["hello", new Uint8Array([1, 2, 255])]);
    s.close(1000, "bye");
    expect(s.state).toBe("closed");
    await net.advance(40);
    expect(serverClosed).toEqual({ code: 1000, reason: "bye", clean: true });
  });

  test("keeps messages in order under jitter and loss, and is reproducible for a seed", async () => {
    const run = async (): Promise<number[]> => {
      const net = new LoopbackNet({ manual: true, latency: 20, jitter: 80, loss: 0.3, seed: 7 });
      const arrivals: number[] = [];
      const order: number[] = [];
      net.listen(URL_, (peer) =>
        peer.onMessage((m) => {
          order.push(Number(m));
          arrivals.push(net.timers.now());
        }),
      );
      const s = net.connect(URL_);
      await net.advance(2000);
      for (let i = 0; i < 40; i++) s.send(String(i));
      await net.advance(20000);
      expect(order).toEqual(Array.from({ length: 40 }, (_, i) => i));
      return arrivals;
    };
    const a = await run();
    expect(a).toEqual(await run());
    // Loss shows up as delay, never as a gap: some messages waited for a retransmission.
    expect(a[a.length - 1]! - a[0]!).toBeGreaterThan(200);
  });

  test("refuses unknown addresses and drops everything when the network goes down", async () => {
    const net = new LoopbackNet({ manual: true, latency: 10 });
    const closes: unknown[] = [];
    net.connect("wss://nobody.test/x").onClose((e) => closes.push(e));
    await net.advance(10);
    expect(closes).toEqual([{ code: 1006, reason: "connection refused", clean: false }]);

    let serverEnd: unknown = null;
    net.listen(URL_, (peer) => peer.onClose((e) => (serverEnd = e)));
    const s = net.connect(URL_);
    let clientEnd: unknown = null;
    s.onClose((e) => (clientEnd = e));
    await net.advance(50);
    expect(s.state).toBe("open");
    net.offline();
    expect(clientEnd).toEqual({ code: 1006, reason: "connection lost", clean: false });
    expect(serverEnd).toEqual({ code: 1006, reason: "connection lost", clean: false });
    const again = net.connect(URL_);
    let reason = "";
    again.onClose((e) => (reason = e.reason));
    await net.advance(10);
    expect(reason).toBe("offline");
    net.online();
    const back = net.connect(URL_);
    await net.advance(50);
    expect(back.state).toBe("open");
  });
});

describe("loopback HTTP", () => {
  test("round trips a JSON request with latency each way", async () => {
    const net = new LoopbackNet({ manual: true, latency: 30 });
    net.serve("https://api.test", async (req) => Response.json({ path: new URL(req.url).pathname, method: req.method, body: await req.json(), auth: req.headers.get("authorization") }, { status: 201 }));
    let res = null as Awaited<ReturnType<typeof net.request>> | null;
    void net.request({ url: "https://api.test/v1/thing?x=1", json: { a: 1 }, headers: { Authorization: "Bearer t" } }).then((r) => (res = r));
    await net.advance(59);
    expect(res).toBeNull();
    await net.advance(1);
    expect(res!.status).toBe(201);
    expect(res!.ok).toBe(true);
    expect(res!.json<unknown>()).toEqual({ path: "/v1/thing", method: "POST", body: { a: 1 }, auth: "Bearer t" });
    expect(res!.headers["content-type"]).toContain("application/json");
  });

  test("rejects with NetError when offline, refused or too slow", async () => {
    const net = new LoopbackNet({ manual: true, latency: 100 });
    const kinds: string[] = [];
    const note = (p: Promise<unknown>): void => void p.catch((e: unknown) => kinds.push(e instanceof NetError ? e.kind : "other"));
    note(net.request({ url: "https://nowhere.test/" }));
    await net.advance(100);
    net.serve("https://api.test", () => new Response("late"));
    note(net.request({ url: "https://api.test/", timeoutMs: 150 }));
    await net.advance(150);
    net.offline();
    note(net.request({ url: "https://api.test/" }));
    await net.advance(100);
    expect(kinds).toEqual(["offline", "timeout", "offline"]);
  });

  test("a handler that throws answers 500 instead of hanging", async () => {
    const net = new LoopbackNet();
    net.serve("https://api.test", () => {
      throw new Error("boom");
    });
    const res = await net.request({ url: "https://api.test/x" });
    expect(res.status).toBe(500);
    expect(res.json<unknown>()).toEqual({ error: "server_error", detail: "boom" });
  });
});

test("base64 round trips without btoa", () => {
  for (const len of [0, 1, 2, 3, 4, 31, 255]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
    const text = toBase64(bytes);
    expect(text).toBe(Buffer.from(bytes).toString("base64"));
    expect(fromBase64(text)).toEqual(bytes);
  }
});

describe("WebNet over real sockets", () => {
  test("talks to a real WebSocket and HTTP server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
        return Response.json({ got: req.headers.get("x-test") }, { status: 418 });
      },
      websocket: {
        message(ws, m) {
          ws.send(m);
        },
      },
    });
    try {
      const net = new WebNet();
      const res = await net.request({ url: `http://localhost:${server.port}/hi`, headers: { "X-Test": "yes" } });
      expect(res.status).toBe(418);
      expect(res.ok).toBe(false);
      expect(res.json<unknown>()).toEqual({ got: "yes" });

      const s = net.connect(`ws://localhost:${server.port}/ws`);
      const got: unknown[] = [];
      await new Promise<void>((resolve) => s.onOpen(resolve));
      const two = new Promise<void>((resolve) =>
        s.onMessage((m) => {
          got.push(m);
          if (got.length === 2) resolve();
        }),
      );
      s.send("ping");
      s.send(new Uint8Array([9, 8, 7]));
      await two;
      expect(got).toEqual(["ping", new Uint8Array([9, 8, 7])]);
      s.close();
      expect(s.state).toBe("closed");

      const dead = net.connect("ws://localhost:1/ws");
      const end = await new Promise<{ clean: boolean }>((resolve) => dead.onClose(resolve));
      expect(end.clean).toBe(false);
      await expect(net.request({ url: "http://localhost:1/" })).rejects.toBeInstanceOf(NetError);
    } finally {
      server.stop(true);
    }
  });
});

describe("HostNet", () => {
  test("relays sockets and requests through the native bridge", async () => {
    const calls: unknown[][] = [];
    const host = {
      netOpen: (id: number, url: string) => calls.push(["open", id, url]),
      netSend: (id: number, data: string, binary: boolean) => calls.push(["send", id, data, binary]),
      netClose: (id: number, code: number, reason: string) => calls.push(["close", id, code, reason]),
      netRequest: (id: number, json: string) => calls.push(["request", id, JSON.parse(json)]),
    } as unknown as BlackironHostApi;
    expect(HostNet.supported(host)).toBe(true);
    expect(HostNet.supported({} as BlackironHostApi)).toBe(false);
    const net = new HostNet(host);
    const s = net.connect("wss://x.test/");
    const got: unknown[] = [];
    let end: unknown = null;
    s.onMessage((m) => got.push(m));
    s.onClose((e) => (end = e));
    expect(s.send("too early")).toBe(false);
    net.deliver(1, "open", "", 0);
    s.send("hi");
    s.send(new Uint8Array([1, 2, 3]));
    net.deliver(1, "text", "yo", 0);
    net.deliver(1, "binary", "AQID", 0);
    expect(got).toEqual(["yo", new Uint8Array([1, 2, 3])]);
    net.deliver(1, "error", "reset by peer", 0);
    expect(end).toEqual({ code: 1006, reason: "reset by peer", clean: false });

    const ok = net.request({ url: "https://x.test/a", json: { n: 1 } });
    const bad = net.request({ url: "https://x.test/b", timeoutMs: 5 });
    net.deliver(2, "response", JSON.stringify({ headers: { "Content-Type": "application/json" }, body: '{"v":2}' }), 200);
    net.deliver(3, "error", "timeout", 0);
    const res = await ok;
    expect(res.json<unknown>()).toEqual({ v: 2 });
    expect(res.headers["content-type"]).toBe("application/json");
    await expect(bad).rejects.toMatchObject({ kind: "timeout" });
    expect(calls).toEqual([
      ["open", 1, "wss://x.test/"],
      ["send", 1, "hi", false],
      ["send", 1, "AQID", true],
      ["request", 2, { url: "https://x.test/a", method: "POST", headers: { "content-type": "application/json" }, body: '{"n":1}', timeoutMs: 15000 }],
      ["request", 3, { url: "https://x.test/b", method: "GET", headers: {}, body: null, timeoutMs: 5 }],
    ]);
  });
});

describe("Channel", () => {
  const setup = (opts: { latency?: number } = {}) => {
    const net = new LoopbackNet({ manual: true, latency: opts.latency ?? 10 });
    const peers: Peer[] = [];
    const inbox: unknown[] = [];
    net.listen(URL_, (socket) => {
      const peer = new Peer(socket, { timers: net.timers, time: () => net.timers.now() + 5000 });
      peer.handle<{ a: number; b: number }>("add", ({ a, b }) => a + b);
      peer.handle("fail", () => {
        throw new Error("nope");
      });
      peer.handle("slow", () => new Promise(() => {}));
      peer.on("m", (d) => inbox.push(d));
      peers.push(peer);
    });
    return { net, peers, inbox };
  };

  test("sends typed messages both ways and answers calls", async () => {
    const { net, peers } = setup();
    const ch = new Channel({ net, url: URL_, heartbeatMs: 0 });
    const statuses: string[] = [];
    ch.onStatus((s) => statuses.push(s));
    const news: unknown[] = [];
    ch.on("news", (d) => news.push(d));
    ch.open();
    await net.advance(30);
    expect(statuses).toEqual(["connecting", "open"]);
    const seen: unknown[] = [];
    peers[0]!.on("move", (d) => seen.push(d));
    ch.send("move", { x: 3 });
    peers[0]!.send("news", "hello");
    let sum = 0;
    void ch.call<number>("add", { a: 2, b: 5 }).then((v) => (sum = v));
    await net.advance(30);
    expect(seen).toEqual([{ x: 3 }]);
    expect(news).toEqual(["hello"]);
    expect(sum).toBe(7);
    // The server can call the client too.
    ch.handle("whoami", () => "client-1");
    let who = "";
    void peers[0]!.call<string>("whoami").then((v) => (who = v));
    await net.advance(30);
    expect(who).toBe("client-1");
  });

  test("a call fails with the reason: remote error, timeout or a lost connection", async () => {
    const { net } = setup();
    const ch = new Channel({ net, url: URL_, heartbeatMs: 0, reconnect: false });
    ch.open();
    await net.advance(30);
    const kinds: string[] = [];
    const note = (p: Promise<unknown>): void => void p.catch((e: ChannelError) => kinds.push(`${e.kind}:${e.message}`));
    note(ch.call("fail"));
    note(ch.call("missing"));
    note(ch.call("slow", null, 500));
    await net.advance(600);
    note(ch.call("slow", null, 5000));
    net.dropAll();
    await net.advance(1);
    note(ch.call("add", { a: 1, b: 1 }));
    await net.advance(1);
    expect(kinds).toEqual(["remote:nope", 'remote:No handler for "missing"', 'timeout:No answer to "slow" within 500 ms', "closed:Connection lost", 'closed:Not connected: "add" was not sent']);
    expect(ch.status).toBe("closed");
  });

  test("reconnects with growing waits and sends what was queued meanwhile", async () => {
    const { net, peers, inbox } = setup();
    const ch = new Channel({ net, url: URL_, heartbeatMs: 0, backoff: { min: 100, max: 1000 }, random: () => 0, queue: 2 });
    const statuses: string[] = [];
    ch.onStatus((s) => statuses.push(`${net.timers.now()}:${s}`));
    ch.open();
    await net.advance(20);
    net.offline();
    expect(ch.status).toBe("waiting");
    expect(ch.send("m", 1)).toBe(true);
    ch.send("m", 2);
    ch.send("m", 3);
    await net.advance(100 + 10 + 200 + 10 + 400 + 10);
    expect(ch.attempts).toBe(4);
    net.online();
    await net.advance(800 + 30);
    expect(ch.status).toBe("open");
    expect(ch.attempts).toBe(0);
    expect(statuses).toEqual(["0:connecting", "20:open", "20:waiting", "120:connecting", "130:waiting", "330:connecting", "340:waiting", "740:connecting", "750:waiting", "1550:connecting", "1570:open"]);
    await net.advance(20);
    // The queue held two: the oldest was dropped.
    expect(inbox).toEqual([2, 3]);
    ch.close();
    expect(ch.status).toBe("closed");
    expect(ch.send("m", 4)).toBe(false);
    await net.advance(60000);
    expect(peers.length).toBe(2);
  });

  test("asks for the URL on every attempt, so a token can be renewed", async () => {
    const { net } = setup();
    const urls: string[] = [];
    net.listen(URL_, (_s, url) => urls.push(url));
    let n = 0;
    const ch = new Channel({ net, url: async () => `${URL_}?token=${++n}`, heartbeatMs: 0, backoff: { min: 50 }, random: () => 0 });
    ch.open();
    await net.advance(30);
    net.dropAll();
    await net.advance(100);
    expect(urls).toEqual([`${URL_}?token=1`, `${URL_}?token=2`]);
  });

  test("the heartbeat measures latency, tracks the server clock and notices a dead link", async () => {
    const { net } = setup({ latency: 25 });
    const ch = new Channel({ net, url: URL_, heartbeatMs: 1000, backoff: { min: 100 }, random: () => 0 });
    ch.open();
    await net.advance(50 + 50);
    expect(ch.latency).toBe(50);
    expect(ch.clock.offset).toBe(5000);
    expect(ch.clock.remote(net.timers.now())).toBe(net.timers.now() + 5000);
    // The server stops answering without closing: only the heartbeat can tell.
    net.listen(URL_, () => {});
    net.latency = 100000;
    await net.advance(1000);
    expect(ch.status).toBe("open");
    await net.advance(2000);
    expect(ch.status === "waiting" || ch.status === "connecting").toBe(true);
  });
});

describe("realtime buffers", () => {
  test("ClockSync trusts the fastest round trip", () => {
    const c = new ClockSync(4);
    c.sample(0, 1300, 400);
    expect(c.offset).toBe(1100);
    c.sample(1000, 2020, 1040);
    expect(c.offset).toBe(1000);
    expect(c.rtt).toBe(40);
    c.sample(2000, 3500, 2600);
    expect(c.offset).toBe(1000);
  });

  test("SnapshotBuffer blends between neighbours and clamps at the ends", () => {
    const b = new SnapshotBuffer<number>(3);
    const lerp = (a: number, c: number, t: number): number => a + (c - a) * t;
    expect(b.sample(5, lerp)).toBeNull();
    b.push(100, 10);
    b.push(300, 30);
    b.push(200, 20);
    expect(b.sample(150, lerp)).toBe(15);
    expect(b.sample(250, lerp)).toBe(25);
    expect(b.sample(0, lerp)).toBe(10);
    expect(b.sample(999, lerp)).toBe(30);
    b.push(300, 33);
    b.push(400, 40);
    expect(b.length).toBe(3);
    expect(b.sample(100, lerp)).toBe(20);
    expect(b.latest()).toBe(40);
  });

  test("InputBuffer replays what the server has not confirmed", () => {
    const b = new InputBuffer<string>();
    expect([b.record("left"), b.record("jump"), b.record("right")]).toEqual([1, 2, 3]);
    b.confirm(2);
    expect(b.pending()).toEqual(["right"]);
    b.record("fire");
    // Server state x=10 as of input 2; replay the rest on top.
    const x = b.pending().reduce((p, i) => p + (i === "right" ? 1 : 0), 10);
    expect(x).toBe(11);
  });
});
