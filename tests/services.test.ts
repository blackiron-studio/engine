import { describe, expect, test } from "bun:test";
import { App } from "../src/app/app.ts";
import { LoopbackNet } from "../src/net/index.ts";
import { HeadlessPlatform } from "../src/platform/headless.ts";
import type { BlackironHostApi } from "../src/render/native.ts";
import { createStore, memoryBackend, type StoreBackend } from "../src/save/store.ts";
import {
  AptevaProvider,
  CloudSaves,
  HostSignIn,
  HttpProvider,
  Identity,
  MockProvider,
  ServiceError,
  aptevaKey,
  createProvider,
  createServices,
  fromAptevaKey,
  registerProvider,
  type PlatformSignIn,
  type ServiceProvider,
} from "../src/services/index.ts";
import { oidcVerifier } from "../src/services/oidc.ts";
import { createServiceHandler, fileStore, type ServiceData } from "../src/services/server.ts";

const kind = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof ServiceError ? e.kind : `other:${String(e)}`),
  );

/** A device: its own storage, identity and cloud saves against a shared backend. */
function device(provider: ServiceProvider, clock: { t: number }, opts: { conflict?: ConstructorParameters<typeof CloudSaves>[0]["conflict"]; platform?: PlatformSignIn; storage?: StoreBackend } = {}) {
  const storage = opts.storage ?? memoryBackend();
  const identity = new Identity({ provider, storage, platform: opts.platform, now: () => clock.t });
  const timers = { now: () => clock.t, set: () => 0, clear: () => {} };
  const saves = new CloudSaves({ identity, local: storage, timers, now: () => clock.t, conflict: opts.conflict });
  return { storage, identity, saves };
}

/** The same behaviour is required of every backend that claims full support. */
function contract(name: string, make: () => { provider: ServiceProvider; credential: (who: string) => string }) {
  describe(`${name}: identity`, () => {
    test("a guest is created once and comes back after a restart, even offline", async () => {
      const { provider } = make();
      const storage = memoryBackend();
      const a = new Identity({ provider, storage });
      expect(a.player).toBeNull();
      const [p1, p2] = await Promise.all([a.signIn(), a.signIn()]);
      expect(p1.id).toBe(p2.id);
      expect(p1.anonymous).toBe(true);
      expect(a.token).toBeTruthy();
      // A restart reads the stored session without asking the backend.
      const b = new Identity({ provider: { ...provider, name: provider.name, signInGuest: () => Promise.reject(new ServiceError("offline", "no network")) } as ServiceProvider, storage });
      expect(b.player?.id).toBe(p1.id);
      expect((await b.signIn()).id).toBe(p1.id);
    });

    test("a wiped session returns to the same guest through the stored secret", async () => {
      const { provider } = make();
      const storage = memoryBackend();
      const a = new Identity({ provider, storage });
      const first = await a.signIn();
      a.signOut();
      expect(a.player).toBeNull();
      expect((await a.signIn()).id).toBe(first.id);
      // A different installation is a different player.
      expect((await new Identity({ provider, storage: memoryBackend() }).signIn()).id).not.toBe(first.id);
    });

    test("linking keeps the player; signing in elsewhere with the account finds them", async () => {
      const { provider, credential } = make();
      const phone = new Identity({ provider, storage: memoryBackend() });
      const changes: (string | null)[] = [];
      phone.onChange((p) => changes.push(p ? `${p.id}:${p.anonymous}` : null));
      const guest = await phone.signIn();
      const linked = await phone.link("apple", credential("ada"));
      expect(linked.id).toBe(guest.id);
      expect(linked.anonymous).toBe(false);
      expect(linked.providers).toEqual(["apple"]);
      expect(changes).toEqual([`${guest.id}:true`, `${guest.id}:false`]);

      const tablet = new Identity({ provider, storage: memoryBackend() });
      await tablet.signIn();
      expect((await tablet.signInWith("apple", credential("ada"))).id).toBe(guest.id);
      // Someone else's guest cannot claim the same account.
      const other = new Identity({ provider, storage: memoryBackend() });
      expect(await kind(other.link("apple", credential("ada")))).toBe("conflict");
      // A second provider can be added to the same player.
      expect((await phone.link("google", credential("ada-g"))).providers).toEqual(["apple", "google"]);
    });

    test("deleting the account removes the player and their saves", async () => {
      const { provider, credential } = make();
      const clock = { t: 1000 };
      const d = device(provider, clock);
      await d.identity.signIn();
      await d.identity.link("apple", credential("bob"));
      d.saves.backend.set("slot", "progress");
      await d.saves.sync();
      const old = d.identity.token!;
      await d.identity.deleteAccount();
      expect(d.identity.player).toBeNull();
      expect(await kind(provider.listSaves({ player: { id: "x", name: "", anonymous: true, providers: [] }, token: old }))).toBe("unauthorized");
      // The account is free again and starts empty.
      const fresh = new Identity({ provider, storage: memoryBackend() });
      const p = await fresh.signInWith("apple", credential("bob"));
      expect(await fresh.authorized((s) => provider.listSaves(s))).toEqual([]);
      expect(p.anonymous).toBe(false);
    });
  });

  describe(`${name}: cloud saves`, () => {
    test("a save written on one device arrives on another signed in as the same player", async () => {
      const { provider, credential } = make();
      const clock = { t: 1000 };
      const phone = device(provider, clock);
      await phone.identity.signIn();
      await phone.identity.link("apple", credential("cy"));
      const store = createStore({ key: "game", version: 1, initial: () => ({ gold: 0 }), backend: phone.saves.backend });
      store.save({ gold: 42 });
      expect(phone.saves.pending).toBe(1);
      expect(await phone.saves.sync()).toMatchObject({ pushed: ["game"], pulled: [] });
      expect(phone.saves.pending).toBe(0);

      const tablet = device(provider, clock);
      await tablet.identity.signInWith("apple", credential("cy"));
      const pulled: string[][] = [];
      tablet.saves.onRemote((keys) => pulled.push(keys));
      expect(await tablet.saves.sync()).toMatchObject({ pushed: [], pulled: ["game"] });
      expect(pulled).toEqual([["game"]]);
      expect(createStore({ key: "game", version: 1, initial: () => ({ gold: 0 }), backend: tablet.saves.backend }).load()).toEqual({ gold: 42 });
      // Nothing changed: the next sync moves nothing.
      expect(await tablet.saves.sync()).toEqual({ pushed: [], pulled: [], conflicts: [], failed: [] });
      // Engine bookkeeping never leaves the device.
      expect((await tablet.identity.authorized((s) => provider.listSaves(s))).map((d) => d.key)).toEqual(["game"]);
    });

    test("changes on both devices settle by the conflict policy", async () => {
      for (const [policy, expected] of [
        ["newest", "tablet"],
        ["local", "phone"],
        ["remote", "tablet"],
      ] as const) {
        const { provider, credential } = make();
        const clock = { t: 1000 };
        const phone = device(provider, clock, { conflict: policy });
        const tablet = device(provider, clock);
        await phone.identity.signInWith("apple", credential("di"));
        await tablet.identity.signInWith("apple", credential("di"));
        phone.saves.backend.set("s", "base");
        await phone.saves.sync();
        await tablet.saves.sync();
        clock.t = 2000;
        phone.saves.backend.set("s", "phone");
        clock.t = 3000;
        tablet.saves.backend.set("s", "tablet");
        await tablet.saves.sync();
        clock.t = 4000;
        const report = await phone.saves.sync();
        expect(report.conflicts).toEqual([{ key: "s", kept: expected === "phone" ? "local" : "remote" }]);
        expect(phone.storage.get("s")).toBe(expected);
        await tablet.saves.sync();
        expect(tablet.storage.get("s")).toBe(expected);
      }
    });

    test("a removed save is removed everywhere", async () => {
      const { provider, credential } = make();
      const clock = { t: 1000 };
      const a = device(provider, clock);
      const b = device(provider, clock);
      await a.identity.signInWith("google", credential("ed"));
      await b.identity.signInWith("google", credential("ed"));
      a.saves.backend.set("slot1", "x");
      a.saves.backend.set("slot2", "y");
      await a.saves.sync();
      await b.saves.sync();
      a.saves.backend.remove("slot1");
      expect((await a.saves.sync()).pushed).toEqual(["slot1"]);
      expect(await b.saves.sync()).toMatchObject({ pulled: ["slot1"] });
      expect(b.storage.get("slot1")).toBeNull();
      expect(b.storage.get("slot2")).toBe("y");
    });
  });
}

contract("mock", () => ({ provider: new MockProvider(), credential: (who) => `token-${who}` }));

contract("reference server over HTTP", () => {
  const net = new LoopbackNet();
  net.serve("https://players.test", createServiceHandler({ verify: async (provider, c) => (c.startsWith("ok:") ? { subject: `${provider}-${c.slice(3)}` } : null) }));
  return { provider: new HttpProvider(net, "https://players.test/"), credential: (who) => `ok:${who}` };
});

describe("identity edges", () => {
  test("an expired token is renewed without the game noticing", async () => {
    const clock = { t: 0 };
    const provider = new MockProvider(() => clock.t);
    provider.tokenLifetime = 60_000;
    const id = new Identity({ provider, storage: memoryBackend(), now: () => clock.t });
    await id.signIn();
    const first = id.token;
    clock.t = 45_000;
    // Within 30 seconds of expiry: renewed before the call.
    expect(await id.authorized((s) => provider.listSaves(s))).toEqual([]);
    expect(id.token).not.toBe(first);
    // Expired while the clock on the device was wrong: renewed after the backend says so.
    const second = id.token;
    clock.t = 200_000;
    const stale = new Identity({ provider, storage: memoryBackend(), now: () => 0 });
    await stale.signIn();
    clock.t = 400_000;
    expect(await stale.authorized((s) => provider.listSaves(s))).toEqual([]);
    expect(second).not.toBe(stale.token);
  });

  test("backends and builds that cannot do something say so before trying", async () => {
    const net = new LoopbackNet();
    const apteva = new Identity({ provider: new AptevaProvider(net, { url: "https://a.test", game: "g" }), storage: memoryBackend() });
    expect(apteva.supports).toMatchObject({ providers: [], link: false, deleteAccount: false });
    expect(await kind(apteva.link("apple", "t"))).toBe("unsupported");
    expect(await kind(apteva.signInWith("google", "t"))).toBe("unsupported");
    expect(await kind(apteva.deleteAccount())).toBe("unsupported");
    // The mock can verify Apple accounts, but this build has no sign-in sheet and no credential was given.
    const mock = new Identity({ provider: new MockProvider(), storage: memoryBackend() });
    expect(mock.platformProviders()).toEqual([]);
    expect(await kind(mock.signInWith("apple"))).toBe("unsupported");
    // A reference server without a verifier refuses platform accounts.
    net.serve("https://bare.test", createServiceHandler());
    const bare = new Identity({ provider: new HttpProvider(net, "https://bare.test"), storage: memoryBackend() });
    expect(await kind(bare.signInWith("apple", "anything"))).toBe("unsupported");
    net.serve("https://strict.test", createServiceHandler({ verify: async () => null }));
    expect(await kind(new Identity({ provider: new HttpProvider(net, "https://strict.test"), storage: memoryBackend() }).signInWith("apple", "forged"))).toBe("rejected");
  });

  test("the native sign-in sheet supplies the credential", async () => {
    const requests: [number, string][] = [];
    const host = { signInRequest: (id: number, p: string) => requests.push([id, p]), signInProviders: () => '["apple","steam"]' } as unknown as BlackironHostApi;
    expect(HostSignIn.supported(host)).toBe(true);
    const sheet = new HostSignIn(host);
    expect(sheet.providers()).toEqual(["apple"]);
    const id = new Identity({ provider: new MockProvider(), storage: memoryBackend(), platform: sheet });
    expect(id.platformProviders()).toEqual(["apple"]);
    await id.signIn();
    const linking = id.link("apple");
    await new Promise((r) => setTimeout(r, 0));
    expect(requests).toEqual([[1, "apple"]]);
    sheet.deliver(1, JSON.stringify({ token: "apple-token-1", name: "Ada" }));
    expect((await linking).providers).toEqual(["apple"]);
    const cancelled = id.signInWith("apple");
    await new Promise((r) => setTimeout(r, 0));
    sheet.deliver(2, '{"error":"cancelled"}');
    expect(await kind(cancelled)).toBe("cancelled");
    expect(await kind(id.signInWith("google"))).toBe("unsupported");
  });
});

describe("cloud save edges", () => {
  test("offline changes wait on the device and upload when the network returns", async () => {
    const provider = new MockProvider();
    const clock = { t: 1000 };
    const d = device(provider, clock);
    await d.identity.signIn();
    const statuses: string[] = [];
    d.saves.onStatus((s) => statuses.push(s));
    provider.offline = true;
    d.saves.backend.set("s", "v1");
    expect(await d.saves.sync()).toEqual({ pushed: [], pulled: [], conflicts: [], failed: [] });
    expect(d.saves.status).toBe("offline");
    expect(d.saves.pending).toBe(1);
    expect(d.storage.get("s")).toBe("v1");
    // The bookkeeping survives a restart while offline.
    const restarted = new CloudSaves({ identity: d.identity, local: d.storage, timers: { now: () => 0, set: () => 0, clear: () => {} } });
    expect(restarted.pending).toBe(1);
    provider.offline = false;
    expect((await restarted.sync()).pushed).toEqual(["s"]);
    expect(statuses).toEqual(["syncing", "offline"]);
  });

  test("writes are uploaded after a quiet period, once", async () => {
    const net = new LoopbackNet({ manual: true });
    const provider = new MockProvider();
    const pushes: string[] = [];
    const push = provider.pushSave.bind(provider);
    provider.pushSave = (s, key, data, rev) => {
      pushes.push(data);
      return push(s, key, data, rev);
    };
    const storage = memoryBackend();
    const identity = new Identity({ provider, storage });
    const saves = new CloudSaves({ identity, local: storage, timers: net.timers, debounceMs: 2000 });
    saves.backend.set("s", "a");
    await net.advance(1500);
    saves.backend.set("s", "b");
    saves.backend.set("s", "b");
    await net.advance(1999);
    expect(pushes).toEqual([]);
    await net.advance(1);
    expect(pushes).toEqual(["b"]);
    await net.advance(10000);
    expect(pushes).toEqual(["b"]);
  });

  test("switching to another player's account takes their saves instead of overwriting them", async () => {
    const provider = new MockProvider();
    const clock = { t: 1000 };
    const owner = device(provider, clock);
    await owner.identity.signInWith("apple", "fay");
    owner.saves.backend.set("s", "fay's long campaign");
    await owner.saves.sync();

    clock.t = 9000;
    const borrowed = device(provider, clock);
    await borrowed.identity.signIn();
    borrowed.saves.backend.set("s", "guest progress, newer");
    borrowed.saves.backend.set("only-here", "kept");
    await borrowed.saves.sync();
    await borrowed.identity.signInWith("apple", "fay");
    const report = await borrowed.saves.sync();
    expect(borrowed.storage.get("s")).toBe("fay's long campaign");
    expect(report.pulled).toEqual(["s"]);
    expect(report.pushed).toEqual(["only-here"]);
  });

  test("saves that predate cloud saves are picked up with track()", async () => {
    const provider = new MockProvider();
    const clock = { t: 1000 };
    const storage = memoryBackend();
    storage.set("old-save", "from 1.0");
    storage.set("blackiron.settings", "local only");
    const d = device(provider, clock, { storage });
    d.saves.track("old-save", "blackiron.settings", "missing");
    expect((await d.saves.sync()).pushed).toEqual(["old-save"]);
  });

  test("a save the backend refuses is reported and the rest still sync", async () => {
    const net = new LoopbackNet();
    net.serve("https://small.test", createServiceHandler({ maxSaveBytes: 10, maxSaves: 2 }));
    const provider = new HttpProvider(net, "https://small.test");
    const d = device(provider, { t: 1 });
    d.saves.backend.set("big", "x".repeat(11));
    d.saves.backend.set("ok", "fine");
    const report = await d.saves.sync();
    expect(report.pushed).toEqual(["ok"]);
    expect(report.failed.map((f) => f.key)).toEqual(["big"]);
    expect(d.saves.status).toBe("error");
    expect(d.saves.lastError).toContain("save_too_large");
    expect(d.saves.pending).toBe(1);
  });
});

describe("reference server", () => {
  test("stores no usable credentials, rotates refresh tokens and persists to a file", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/blackiron-services-${process.pid}-${Date.now()}.json`;
    const net = new LoopbackNet();
    let now = 1_000_000;
    net.serve("https://p.test", createServiceHandler({ store: await fileStore(path), now: () => now, tokenLifetimeMs: 1000 }));
    const provider = new HttpProvider(net, "https://p.test");
    const session = await provider.signInGuest(null);
    expect(session.secret).toHaveLength(64);
    await provider.pushSave(session, "slot/1 ü", "data", 0);
    const file = await Bun.file(path).text();
    expect(file).not.toContain(session.secret!);
    expect(file).not.toContain(session.token);
    expect(file).not.toContain(session.refreshToken!);

    // A restarted server reads the same file.
    net.serve("https://p.test", createServiceHandler({ store: await fileStore(path), now: () => now, tokenLifetimeMs: 1000 }));
    expect((await provider.listSaves(session)).map((d) => [d.key, d.data, d.rev])).toEqual([["slot/1 ü", "data", 1]]);
    expect(await provider.pushSave(session, "slot/1 ü", "stale", 0)).toMatchObject({ ok: false, current: { data: "data", rev: 1 } });
    now += 2000;
    expect(await kind(provider.listSaves(session))).toBe("unauthorized");
    const renewed = await provider.refresh(session);
    expect(renewed.player.id).toBe(session.player.id);
    expect(await kind(provider.refresh(session))).toBe("unauthorized");
    expect((await provider.signInGuest(session.secret!)).player.id).toBe(session.player.id);
    expect(await kind(provider.signInGuest("short"))).toBe("rejected");
    (await import("node:fs")).unlinkSync(path);
  });

  test("answers browser preflight and ignores paths outside /v1/", async () => {
    const handler = createServiceHandler();
    const pre = await handler(new Request("https://p.test/v1/saves", { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    expect((await handler(new Request("https://p.test/other"))).status).toBe(404);
    // Mounted under a prefix, the routes still resolve.
    expect((await handler(new Request("https://p.test/players/v1/session/guest", { method: "POST", body: "{}" }))).status).toBe(200);
  });

  test("verifies real RS256 identity tokens and refuses forged, expired or misaddressed ones", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
    const b64 = (b: Uint8Array | string): string => Buffer.from(b).toString("base64url");
    const sign = async (claims: object, key = pair.privateKey, kid = "k1"): Promise<string> => {
      const head = `${b64(JSON.stringify({ alg: "RS256", kid }))}.${b64(JSON.stringify(claims))}`;
      return `${head}.${b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head))))}`;
    };
    const now = 1_700_000_000_000;
    let fetched = 0;
    const verify = oidcVerifier({
      apple: { audience: "com.example.game" },
      now: () => now,
      fetchKeys: async (url) => {
        fetched++;
        expect(url).toBe("https://appleid.apple.com/auth/keys");
        return { keys: [jwk] };
      },
    });
    const good = { iss: "https://appleid.apple.com", aud: "com.example.game", exp: now / 1000 + 60, sub: "001.abc" };
    expect(await verify("apple", await sign(good))).toEqual({ subject: "001.abc" });
    expect(await verify("apple", await sign(good))).toEqual({ subject: "001.abc" });
    expect(fetched).toBe(1);
    expect(await verify("apple", await sign({ ...good, aud: "com.other.app" }))).toBeNull();
    expect(await verify("apple", await sign({ ...good, exp: now / 1000 - 1 }))).toBeNull();
    expect(await verify("apple", await sign({ ...good, iss: "https://evil.test" }))).toBeNull();
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    expect(await verify("apple", await sign(good, other.privateKey))).toBeNull();
    const [h, , sig] = (await sign(good)).split(".");
    expect(await verify("apple", `${h}.${b64(JSON.stringify({ ...good, sub: "someone-else" }))}.${sig}`)).toBeNull();
    expect(await verify("apple", `${b64('{"alg":"none","kid":"k1"}')}.${b64(JSON.stringify(good))}.`)).toBeNull();
    expect(await verify("google", await sign(good))).toBeNull();
    expect(await verify("apple", "garbage")).toBeNull();
  });
});

describe("Apteva Games adapter", () => {
  /** The v2 player API as the Games app documents it: device login, refresh and versioned data keys. */
  function fakeGames() {
    const players = new Map<string, number>();
    const tokens = new Map<string, number>();
    const data = new Map<number, Map<string, { key: string; value: unknown; visibility: string; version: number; updated_at: string }>>();
    const seen: string[] = [];
    let n = 0;
    const login = (id: number, device: string) => {
      const token = `jwt-${++n}`;
      tokens.set(token, id);
      return Response.json({ device_id: device, game_id: "g1", player: { id, display_name: `Player ${id}`, kind: "guest", status: "active" }, created: true, access_token: token, refresh_token: `r-${id}`, expires_in: 3600, token_type: "Bearer" });
    };
    const handler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      const path = url.pathname.replace("/api/apps/games/v2/games/g1", "");
      if (path === "/login/device") {
        const body = (await req.json()) as { device_id?: string };
        const device = body.device_id ?? "f".repeat(64);
        if (device.length < 32) return Response.json({ error: "device_id must be a random installation secret of at least 32 bytes" }, { status: 400 });
        if (!players.has(device)) players.set(device, players.size + 1);
        return login(players.get(device)!, device);
      }
      if (path === "/session/refresh") {
        const body = (await req.json()) as { refresh_token?: string };
        const id = Number((body.refresh_token ?? "").slice(2));
        return id ? Response.json({ access_token: (tokens.set(`jwt-${++n}`, id), `jwt-${n}`), refresh_token: `r-${id}`, expires_in: 3600 }) : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const id = tokens.get((req.headers.get("authorization") ?? "").replace("Bearer ", ""));
      if (!id) return Response.json({ error: "invalid_token" }, { status: 401 });
      const rows = data.get(id) ?? data.set(id, new Map()).get(id)!;
      if (path === "/data" && req.method === "GET") return Response.json({ data: [...rows.values()] });
      const key = decodeURIComponent(path.replace("/data/", ""));
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) return Response.json({ error: "key must match [A-Za-z0-9_.:-]{1,128}" }, { status: 400 });
      const cur = rows.get(key);
      if (req.method === "PUT") {
        const body = (await req.json()) as { value: unknown; visibility: string; version: number };
        if (JSON.stringify(body.value).length > 256 * 1024) return Response.json({ error: "value must be 256 KB or less" }, { status: 413 });
        if (body.version > 0 && body.version !== (cur?.version ?? 0)) return Response.json({ error: "version_conflict", current: cur ?? null }, { status: 409 });
        const e = { key, value: body.value, visibility: body.visibility, version: (cur?.version ?? 0) + 1, updated_at: "2026-11-19T10:00:00Z" };
        rows.set(key, e);
        return Response.json({ data: e });
      }
      if (req.method === "DELETE") return rows.delete(key) ? Response.json({ ok: true }) : Response.json({ error: "not_found", key }, { status: 404 });
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    return { handler, seen, tokens };
  }

  test("escapes save keys into the characters Games allows, reversibly", () => {
    for (const key of ["game", "frontier.slot-1", "slot/1 ü", "a:b", "::", "100%"]) {
      expect(aptevaKey(key)).toMatch(/^[A-Za-z0-9_.:-]+$/);
      expect(fromAptevaKey(aptevaKey(key))).toBe(key);
    }
    expect(aptevaKey("frontier.slot-1")).toBe("frontier.slot-1");
  });

  test("guest sign-in, refresh and save sync against the v2 player API", async () => {
    const games = fakeGames();
    const net = new LoopbackNet();
    net.serve("https://agents.test", games.handler);
    const provider = createProvider({ provider: "apteva", url: "https://agents.test/", game: "g1", project: "proj 1" }, net);
    const clock = { t: Date.parse("2026-11-19T09:00:00Z") };
    const a = device(provider, clock);
    const player = await a.identity.signIn();
    expect(player).toEqual({ id: "1", name: "Player 1", anonymous: true, providers: [] });
    expect(games.seen[0]).toBe("POST /api/apps/games/v2/games/g1/login/device?project_id=proj%201");

    a.saves.backend.set("slot/1", '{"v":1,"data":{"gold":5}}');
    expect((await a.saves.sync()).pushed).toEqual(["slot/1"]);
    expect(games.seen).toContain("PUT /api/apps/games/v2/games/g1/data/slot:2f1?project_id=proj%201");

    // The access token dies on the server: refresh, then carry on.
    games.tokens.clear();
    a.saves.backend.set("slot/1", '{"v":1,"data":{"gold":9}}');
    expect((await a.saves.sync()).pushed).toEqual(["slot/1"]);
    expect(games.seen.filter((s) => s.includes("/session/refresh")).length).toBe(1);

    // A reinstall that kept the secret is the same player and gets the save back.
    const secret = JSON.parse(a.storage.get("blackiron.identity")!).secret as string;
    const storage = memoryBackend();
    storage.set("blackiron.identity", JSON.stringify({ provider: "apteva", session: null, secret }));
    const b = device(provider, clock, { storage });
    expect((await b.identity.signIn()).id).toBe("1");
    expect((await b.saves.sync()).pulled).toEqual(["slot/1"]);
    expect(b.storage.get("slot/1")).toBe('{"v":1,"data":{"gold":9}}');

    // Both changed: the server's 409 carries the current entry and the policy settles it.
    clock.t = Date.parse("2026-11-19T11:00:00Z");
    b.saves.backend.set("slot/1", "from b");
    const racing = provider.pushSave.bind(provider);
    provider.pushSave = async (s, key, data, rev) => {
      provider.pushSave = racing;
      await racing(s, key, "from a, just now", rev);
      return racing(s, key, data, rev);
    };
    const report = await b.saves.sync();
    expect(report.conflicts).toEqual([{ key: "slot/1", kept: "local" }]);
    expect((await b.identity.authorized((s) => provider.listSaves(s)))[0]).toMatchObject({ key: "slot/1", data: "from b", rev: 4 });
    expect(await kind(provider.pushSave({ player, token: [...games.tokens.keys()][0]! }, "big", "x".repeat(300 * 1024), 0))).toBe("limit");
  });

  test("needs a game id", () => {
    expect(() => createProvider({ provider: "apteva", url: "https://agents.test" })).toThrow("services.game");
  });
});

describe("plugging in a backend", () => {
  test("config picks the provider; a game can register its own", async () => {
    expect(() => createProvider({ provider: "http" })).toThrow("services.url is required");
    expect(() => createProvider({ provider: "nope" })).toThrow('Unknown services.provider "nope"');
    const mine = new MockProvider();
    registerProvider("studio-backend", (config) => {
      expect(config.url).toBe("https://studio.test");
      return Object.assign(mine, { name: "studio-backend" });
    });
    const services = createServices({ config: { provider: "studio-backend", url: "https://studio.test" }, storage: memoryBackend(), cloud: { keys: (k) => k.startsWith("save.") } });
    expect(services.provider).toBe(mine);
    services.saves!.backend.set("save.1", "yes");
    services.saves!.backend.set("cache.1", "no");
    expect((await services.saves!.sync()).pushed).toEqual(["save.1"]);
  });

  test("a host without networking fails as unsupported, not as a crash", async () => {
    const provider = createProvider({ provider: "http", url: "https://p.test" });
    expect(await kind(provider.signInGuest(null))).toBe("unsupported");
  });

  test("an App with services and cloud saves syncs its stores through the platform's network", async () => {
    const platform = new HeadlessPlatform();
    const net = platform.net as LoopbackNet;
    net.serve("https://players.test", createServiceHandler());
    const app = await App.create({ platform, headless: true, config: { services: { provider: "http", url: "https://players.test" }, cloud: true } });
    expect(app.services?.saves).not.toBeNull();
    await app.services!.saves!.sync();
    const store = createStore({ key: "progress", version: 1, initial: () => ({ level: 1 }) });
    store.save({ level: 7 });
    expect((await app.services!.saves!.sync()).pushed).toEqual(["progress"]);
    const player = app.services!.identity.player!;
    expect(player.anonymous).toBe(true);
    // Without the config there are no services and stores stay local.
    const plain = await App.create({ platform: new HeadlessPlatform(), headless: true });
    expect(plain.services).toBeNull();
  });
});

// Keep the type import used for documentation of the data file shape.
export type { ServiceData };
