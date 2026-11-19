# Networking and player services (0.18)

Two layers, both optional:

- **`platform.net`** opens sockets and sends HTTP requests on every host. It has no opinion
  about the server. A game's own realtime server talks through this.
- **Services** are the player's identity and their cloud saves. The engine defines the
  interfaces; a *provider* adapts them to a backend. Swap the backend by changing two lines
  of `blackiron.json`.

Rules, visibility filtering and anti-cheat stay in the game and its server. Nothing here
simulates a game.

## Transport: `platform.net`

```ts
const net = app.platform.net!;

const res = await net.request({ url: "https://example.com/v1/thing", json: { a: 1 } });
if (res.ok) console.log(res.json());

const socket = net.connect("wss://example.com/play");
socket.onOpen(() => socket.send("hello"));
socket.onMessage((data) => { /* string or Uint8Array */ });
socket.onClose(({ code, clean }) => { /* fires exactly once */ });
```

`request` resolves with any HTTP status and rejects with a `NetError` (`offline`, `timeout`
or `unsupported`) only when no response arrived. A socket is an ordered, reliable message
stream: a WebSocket everywhere.

| Host | Implementation |
|---|---|
| Web, Bun tools | `WebNet`: `WebSocket` and `fetch` |
| Windows, macOS, Linux, Android | Rust host: `tungstenite` and `ureq` on rustls with bundled roots, one thread per connection |
| iOS | `BlackironNet.swift` on URLSession |
| Tests (`HeadlessPlatform`) | `LoopbackNet`: nothing leaves the process |

A game that only uses `platform.net` (no `services` block) sets `"network": true` so the
Android export requests the INTERNET permission.

### Loopback

`LoopbackNet` joins a client and a server in one process with latency, jitter, loss and
disconnects. With `manual: true` time moves only when the test says so, so a flaky
connection plays out identically on every run.

```ts
const net = new LoopbackNet({ manual: true, latency: 80, jitter: 40, loss: 0.1, seed: 7 });
net.listen("wss://game.test/play", (socket) => { /* the server's end */ });
net.serve("https://api.test", (req) => Response.json({ ok: true })); // fetch-style handler
const socket = net.connect("wss://game.test/play");
await net.advance(500);   // deliver everything due in the next half second
net.offline();            // drop every connection, refuse new ones
net.online();
```

Sockets are reliable and ordered, as TCP is, so `loss` shows up as retransmission delay
(`retransmit`, 200 ms each), never as a missing message.

### Realtime helpers

```ts
const channel = new Channel({
  net,
  url: async () => `wss://valley.example.com/play?token=${app.services!.identity.token}`,
});
channel.onStatus((s) => { /* "connecting" | "open" | "waiting" | "closed" */ });
channel.on("snapshot", (state) => buffer.push(state.time, state));
channel.open();

channel.send("order", { unit: 4, to: [10, 3] });         // queued while reconnecting
const result = await channel.call("build", { kind: "refinery" }); // request/reply
```

- **`Channel`** (client) reconnects with exponential backoff, asks for the URL again on each
  attempt so a token can be renewed, queues sends while down (64 by default), and runs a
  heartbeat that measures `latency`, keeps `clock` (the server's clock) and notices a
  connection that died silently.
- **`Peer`** (server) wraps one accepted socket with the same `send` / `on` / `call` /
  `handle`, so either side can call the other.
- **`ClockSync`**, **`SnapshotBuffer`** (draw a moment in the past, blended between server
  states) and **`InputBuffer`** (replay unconfirmed inputs over an authoritative state) are
  plain data structures with no connection attached.

The wire format is JSON text frames: `{t, d}` for a message, `{t, d, i}` for a call and
`{r, d}` or `{r, e}` for its reply. A server in another language needs about twenty lines to
speak it.

### A game's own server

`blackiron dev --server server.ts` runs the script beside the dev server (restarting it on
change) and stops it on exit. The script is ordinary Bun; use `Peer` over Bun's WebSocket
server, or anything else that speaks WebSocket.

## Services: identity and cloud saves

```json
{
  "services": { "provider": "http", "url": "https://players.example.com" },
  "cloud": true
}
```

With that, `app.services` exists and every store the game creates is mirrored to the backend:

```ts
const { identity, saves } = app.services!;

await identity.signIn();            // a guest, created silently and remembered
identity.player;                    // { id, name, anonymous, providers }
identity.token;                     // bearer token; give it to your own game server

saves!.onRemote((keys) => reloadStores(keys)); // a newer save came down
saves!.onStatus((s) => { /* "idle" | "syncing" | "offline" | "error" */ });
```

### Identity

- `signIn()` returns the stored player, or creates a guest. A guest is a random secret kept
  on the device. Once signed in, the player is available offline.
- `link("apple")` attaches a platform account to the current player, keeping their progress.
- `signInWith("apple")` switches to the player who owns that account (a second device). The
  current guest is left behind, not merged.
- `signOut()` forgets the session on this device. `deleteAccount()` deletes the player and
  their data on the backend.
- `supports` and `platformProviders()` say what this backend and this build can do, so a
  settings screen shows only buttons that work.

Every failure is a `ServiceError` with a `kind`: `offline`, `unauthorized`, `unsupported`,
`conflict` (the account belongs to another player), `cancelled`, `limit` or `rejected`.

**Sign in with Apple** is native on iOS: set `"ios": { "signInWithApple": true }`, enable
the capability on the App ID, and use a backend that verifies Apple accounts. On other hosts
pass the identity token yourself: `link("google", idToken)`.

### Cloud saves

Stores keep reading and writing the device synchronously, exactly as without a backend. The
`CloudSaves` layer uploads changes after two quiet seconds, on the way to the background and
on return, and brings newer saves down. The device copy always works offline; changes wait.

- A save changed on two devices settles by `conflict`: `"newest"` (default), `"local"`,
  `"remote"` or a function.
- When a sync replaces a save on the device, `onRemote(keys)` fires. A store already loaded
  into memory still holds the old data: reload it.
- Switching to another player's account takes their saves; it never overwrites them with
  this device's.
- Engine bookkeeping (`blackiron.*` keys) never syncs. Limit what does with
  `createServices({ cloud: { keys: (k) => k.startsWith("save.") } })`.
- Saves written before cloud saves were turned on join in with `saves.track("key", …)`.

### Providers

| `provider` | Backend | Platform accounts | Delete account | Save limit |
|---|---|---|---|---|
| `mock` | In memory, for tests and UI work | any string is an account | yes | none |
| `http` | The reference server (`blackiron services`) or anything speaking its protocol | Apple, Google | yes | 1 MiB |
| `apteva` | Apteva Games v2 player API | no | no (operator-side `players_erase`) | 256 KiB, 128 keys |

Apteva needs `"game"` (the game id) and, on a global install, `"project"`:

```json
{ "services": { "provider": "apteva", "url": "https://agents.example.com", "game": "g1" } }
```

**Any other backend:** implement `ServiceProvider` (nine methods) and register it before
`App.create`:

```ts
registerProvider("studio", (config, net) => new StudioProvider(net, config.url!));
```

The test file `tests/services.test.ts` holds a `contract()` suite; run a new provider
through it.

### The reference server

```bash
blackiron services --port 4250 --data players.json --apple-audience com.example.game
```

One process and one JSON file: a backend to start with and a specification for others. It
hashes guest secrets, access tokens and refresh tokens before storing them, rotates refresh
tokens on use, and verifies Apple and Google identity tokens (signature, issuer, audience,
expiry) when given the audiences. It has no rate limiting: put it behind a proxy that does.
To mount it in a server of your own, import `createServiceHandler` from
`@blackiron-studio/engine/services/server`.

```
POST   /v1/session/guest     {secret?}                -> {session}
POST   /v1/session/provider  {provider, credential}   -> {session}
POST   /v1/session/link      {provider, credential}   -> {session}        bearer
POST   /v1/session/refresh   {refresh_token}          -> {session}
DELETE /v1/account                                                        bearer
GET    /v1/saves                                      -> {saves: [...]}   bearer
PUT    /v1/saves/{key}       {data, base_rev}         -> {rev} | 409 {current}
DELETE /v1/saves/{key}                                                    bearer
```

A game server checks a connecting player by calling `GET /v1/saves` (or any bearer route)
with the token the client sent, or by sharing the data store.

## Export checks

`blackiron` refuses to load a project, for any command, when:

- `cloud` is true without a `services` block;
- `services.url` is missing for any provider but `mock`, is not a URL, or is plain `http`
  to anything but localhost (phones refuse cleartext);
- `services.game` is missing for `apteva`.

Exporting with the `mock` provider prints a warning.

## Before shipping

- **Privacy.** A game that turns services on now collects an identifier (and, with platform
  accounts, an account link). Update the App Store privacy labels and Google Play's data
  safety form for every such game before submitting.
- **Account deletion.** Apple requires in-app deletion for apps that let people create an
  account. Guests are not accounts in that sense, but once a game offers `link`, offer
  `deleteAccount()` too, on a backend that supports it.
- **Golden screenshot runs** (`blackiron verify`) never create services, so their frames
  cannot depend on a backend.

## How it was checked

- `bun test`: loopback, channel, identity, cloud-save, provider-contract, reference-server
  and Apteva-adapter tests (the Apteva tests run against a stand-in built from the Games
  v0.8.0 player API, not a live server).
- `cargo test` in `host/`: the Rust sockets and requests against local servers;
  `cargo test -- --ignored` adds a live TLS check.
- `bun run check:native-net`: a game script on the real desktop host signs in, syncs a save
  and talks over a WebSocket.
- `bun run check:ios-net`: the same on a throwaway iOS simulator, through `App.services`.

## Not in 0.18

- Google sign-in sheets on any host, and Sign in with Apple outside iOS. Pass an identity
  token obtained another way to `link` / `signInWith`.
- Android networking is compiled from the same Rust code as desktop but was not built or
  run on a device for this release.
- UDP, WebRTC and peer-to-peer. One reliable ordered stream per connection.
- Lockstep or rollback netcode. The helpers suit server-authoritative games.
