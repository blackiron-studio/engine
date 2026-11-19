// A network in one process: a client and a server joined by simulated latency, jitter,
// retransmission delay and disconnects. Tests drive it with a manual clock so a flaky
// connection plays out the same way every run; nothing here opens a real socket.

import { BaseSocket, NetError, makeResponse, realTimers, wireRequest, type HttpRequest, type HttpResponse, type Net, type Socket, type Timers } from "./types.ts";

export interface LoopbackOptions {
  /** One-way delay in milliseconds. */
  latency?: number;
  /** Extra random delay per message, up to this many milliseconds. */
  jitter?: number;
  /**
   * Chance (0 to 1) that a message is lost in transit. The stream stays reliable and ordered,
   * as TCP is, so a loss shows up as `retransmit` milliseconds of extra delay, not a gap.
   */
  loss?: number;
  /** Delay one lost transmission costs; 200 ms by default. */
  retransmit?: number;
  /** Seed for jitter and loss. */
  seed?: number;
  /** Simulated time, moved only by `advance(ms)`. Without it, real timers deliver. */
  manual?: boolean;
}

export type HttpHandler = (req: Request) => Response | Promise<Response>;
export type ConnectionHandler = (peer: Socket, url: string) => void;

const bare = (url: string): string => url.replace(/[?#].*$/, "").replace(/\/+$/, "");
const under = (url: string, prefix: string): boolean => url === prefix || url.startsWith(`${prefix}/`);

class LoopbackSocket extends BaseSocket {
  peer: LoopbackSocket | null = null;
  /** When the last message in this direction lands, so later ones never overtake it. */
  lastDue = 0;

  constructor(
    url: string,
    private readonly net: LoopbackNet,
  ) {
    super(url);
  }

  send(data: string | Uint8Array): boolean {
    if (this.state !== "open" || !this.peer) return false;
    const peer = this.peer;
    const copy = typeof data === "string" ? data : data.slice();
    this.net.transmit(this, () => peer.emitMessage(copy));
    return true;
  }

  close(code = 1000, reason = ""): void {
    if (this.state === "closed") return;
    const peer = this.peer;
    this.net.forget(this);
    if (peer) this.net.transmit(this, () => peer.drop({ code, reason, clean: true }));
    this.emitClose({ code, reason, clean: true });
  }

  open(): void {
    this.emitOpen();
  }

  drop(e: { code: number; reason: string; clean: boolean }): void {
    this.net.forget(this);
    this.emitClose(e);
  }
}

export class LoopbackNet implements Net {
  latency: number;
  jitter: number;
  loss: number;
  retransmit: number;
  readonly timers: Timers;
  private rng: number;
  private isDown = false;
  private readonly listeners = new Map<string, ConnectionHandler>();
  private readonly routes = new Map<string, HttpHandler>();
  private readonly live = new Set<LoopbackSocket>();
  // Manual clock.
  private clock = 0;
  private seq = 0;
  private readonly queue: { due: number; seq: number; cb: () => void }[] = [];

  constructor(opts: LoopbackOptions = {}) {
    this.latency = opts.latency ?? 0;
    this.jitter = opts.jitter ?? 0;
    this.loss = opts.loss ?? 0;
    this.retransmit = opts.retransmit ?? 200;
    this.rng = (opts.seed ?? 1) | 0;
    this.timers = opts.manual
      ? {
          now: () => this.clock,
          set: (cb, ms) => {
            const entry = { due: this.clock + Math.max(0, ms), seq: this.seq++, cb };
            this.queue.push(entry);
            return entry;
          },
          clear: (h) => {
            const i = this.queue.indexOf(h as (typeof this.queue)[number]);
            if (i >= 0) this.queue.splice(i, 1);
          },
        }
      : realTimers;
  }

  private random(): number {
    this.rng = (this.rng + 0x6d2b79f5) | 0;
    let t = this.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private delay(): number {
    let d = this.latency + this.random() * this.jitter;
    for (let i = 0; i < 20 && this.random() < this.loss; i++) d += this.retransmit;
    return d;
  }

  /** Whether the network is unreachable. */
  get down(): boolean {
    return this.isDown;
  }

  /** Cut every connection and refuse new ones and requests until `online()`. */
  offline(): void {
    this.isDown = true;
    this.dropAll();
  }

  online(): void {
    this.isDown = false;
  }

  /** Lose every live connection without a close frame, as a dead radio would. */
  dropAll(reason = "connection lost"): void {
    for (const s of [...this.live]) s.drop({ code: 1006, reason, clean: false });
  }

  /** Accept socket connections to `url` (and paths under it). Returns a function that stops listening. */
  listen(url: string, onConnection: ConnectionHandler): () => void {
    const key = bare(url);
    this.listeners.set(key, onConnection);
    return () => {
      if (this.listeners.get(key) === onConnection) this.listeners.delete(key);
    };
  }

  /** Answer HTTP requests to `prefix` and paths under it with a fetch-style handler. */
  serve(prefix: string, handler: HttpHandler): () => void {
    const key = bare(prefix);
    this.routes.set(key, handler);
    return () => {
      if (this.routes.get(key) === handler) this.routes.delete(key);
    };
  }

  private match<T>(table: Map<string, T>, url: string): T | undefined {
    const target = bare(url);
    let best: string | null = null;
    for (const key of table.keys()) if (under(target, key) && (best === null || key.length > best.length)) best = key;
    return best === null ? undefined : table.get(best);
  }

  /** @internal Deliver something from `from` to its peer, after the simulated delay and in order. */
  transmit(from: LoopbackSocket, deliver: () => void): void {
    const due = Math.max(from.lastDue, this.timers.now() + this.delay());
    from.lastDue = due;
    this.timers.set(deliver, due - this.timers.now());
  }

  /** @internal */
  forget(s: LoopbackSocket): void {
    this.live.delete(s);
  }

  connect(url: string): Socket {
    const client = new LoopbackSocket(url, this);
    this.timers.set(() => {
      const handler = this.isDown ? undefined : this.match(this.listeners, url);
      if (!handler) return client.drop({ code: 1006, reason: this.isDown ? "offline" : "connection refused", clean: false });
      if (client.state !== "connecting") return;
      const server = new LoopbackSocket(url, this);
      client.peer = server;
      server.peer = client;
      this.live.add(client);
      this.live.add(server);
      server.open();
      handler(server, url);
      this.transmit(server, () => client.open());
    }, this.delay());
    return client;
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    const w = wireRequest(req);
    const label = `${w.method} ${w.url}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.timers.clear(timeout);
        fn();
      };
      const timeout = this.timers.set(() => finish(() => reject(new NetError(`Request timed out: ${label}`, "timeout"))), w.timeoutMs);
      this.timers.set(() => {
        const handler = this.isDown ? undefined : this.match(this.routes, w.url);
        if (!handler) return finish(() => reject(new NetError(`Request failed: ${label}: ${this.isDown ? "offline" : "connection refused"}`)));
        Promise.resolve()
          .then(() => handler(new Request(w.url, { method: w.method, headers: w.headers, body: w.body ?? undefined })))
          .then(async (res) => {
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => (headers[k] = v));
            const answer = makeResponse(res.status, headers, await res.text());
            this.timers.set(() => {
              if (this.isDown) finish(() => reject(new NetError(`Request failed: ${label}: offline`)));
              else finish(() => resolve(answer));
            }, this.delay());
          })
          .catch((e) => finish(() => resolve(makeResponse(500, {}, JSON.stringify({ error: "server_error", detail: e instanceof Error ? e.message : String(e) })))));
      }, this.delay());
    });
  }

  /**
   * Manual clock only: move simulated time forward, delivering everything that falls due in
   * order. Asynchronous handlers get a turn after each delivery, so the returned promise
   * resolves with the network settled at the new time.
   */
  async advance(ms: number): Promise<void> {
    const target = this.clock + Math.max(0, ms);
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    await settle();
    for (;;) {
      let next: (typeof this.queue)[number] | null = null;
      for (const e of this.queue) if (e.due <= target && (!next || e.due < next.due || (e.due === next.due && e.seq < next.seq))) next = e;
      if (!next) break;
      this.queue.splice(this.queue.indexOf(next), 1);
      this.clock = Math.max(this.clock, next.due);
      next.cb();
      await settle();
    }
    this.clock = target;
  }
}
