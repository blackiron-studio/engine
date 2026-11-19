// Helpers for a live connection: typed JSON messages with request/reply, reconnection with
// backoff, a heartbeat that measures latency and the server's clock, a snapshot buffer for
// smooth rendering between server updates, and an input buffer for client-side prediction.
// The rules stay in the game: these only move messages and time.

import { realTimers, type Net, type Socket, type Timers } from "./types.ts";

/** A call that got no usable answer. */
export class ChannelError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "closed" | "remote",
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

interface Frame {
  /** Message type. */
  t?: string;
  /** Payload. */
  d?: unknown;
  /** Call id: the sender expects a reply. */
  i?: number;
  /** Reply to the call with this id. */
  r?: number;
  /** Error text, on a failed reply. */
  e?: string;
}

const TIME = "~time";

/**
 * One end of a message link. Both the client's `Channel` and the server's `Peer` are
 * endpoints, so either side can send, call and answer calls.
 */
export class Endpoint {
  protected socket: Socket | null = null;
  protected readonly timers: Timers;
  private nextCall = 1;
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private readonly handlers = new Map<string, (data: unknown) => unknown>();
  private readonly calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();
  private unhook: (() => void) | null = null;

  constructor(timers: Timers, time?: () => number) {
    this.timers = timers;
    this.handle(TIME, () => (time ? time() : this.timers.now()));
  }

  protected attach(socket: Socket): void {
    this.socket = socket;
    this.unhook = socket.onMessage((raw) => {
      if (typeof raw === "string") this.receive(raw);
    });
  }

  protected detach(reason: string): void {
    this.unhook?.();
    this.unhook = null;
    this.socket = null;
    for (const [id, c] of [...this.calls]) {
      this.calls.delete(id);
      this.timers.clear(c.timer);
      c.reject(new ChannelError(reason, "closed"));
    }
  }

  private write(frame: Frame): boolean {
    return this.socket?.state === "open" ? this.socket.send(JSON.stringify(frame)) : false;
  }

  private receive(raw: string): void {
    let f: Frame;
    try {
      f = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (!f || typeof f !== "object") return;
    if (typeof f.r === "number") {
      const c = this.calls.get(f.r);
      if (!c) return;
      this.calls.delete(f.r);
      this.timers.clear(c.timer);
      if (typeof f.e === "string") c.reject(new ChannelError(f.e, "remote"));
      else c.resolve(f.d);
      return;
    }
    if (typeof f.t !== "string") return;
    if (typeof f.i === "number") {
      const id = f.i;
      const handler = this.handlers.get(f.t);
      if (!handler) {
        this.write({ r: id, e: `No handler for "${f.t}"` });
        return;
      }
      Promise.resolve()
        .then(() => handler(f.d))
        .then(
          (d) => this.write({ r: id, d }),
          (e) => this.write({ r: id, e: e instanceof Error ? e.message : String(e) }),
        );
      return;
    }
    for (const cb of [...(this.listeners.get(f.t) ?? [])]) cb(f.d);
  }

  /** Listen for messages of one type. */
  on<T = unknown>(type: string, cb: (data: T) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb as (data: unknown) => void);
    return () => set.delete(cb as (data: unknown) => void);
  }

  /** Answer the other side's `call(type)`; a thrown error reaches the caller as a ChannelError. */
  handle<T = unknown>(type: string, fn: (data: T) => unknown): void {
    this.handlers.set(type, fn as (data: unknown) => unknown);
  }

  /** Send a message with no reply. False when the link is down and it was not sent. */
  send(type: string, data?: unknown): boolean {
    return this.write({ t: type, d: data });
  }

  /** Send a message and wait for the other side's answer. */
  call<T = unknown>(type: string, data?: unknown, timeoutMs = 8000): Promise<T> {
    const id = this.nextCall++;
    return new Promise<T>((resolve, reject) => {
      if (!this.write({ t: type, d: data, i: id })) return reject(new ChannelError(`Not connected: "${type}" was not sent`, "closed"));
      const timer = this.timers.set(() => {
        this.calls.delete(id);
        reject(new ChannelError(`No answer to "${type}" within ${timeoutMs} ms`, "timeout"));
      }, timeoutMs);
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }
}

/** The server's end of one accepted connection. */
export class Peer extends Endpoint {
  /** `time` is the clock clients synchronise to; the timers' clock by default. */
  constructor(socket: Socket, opts: { timers?: Timers; time?: () => number } = {}) {
    super(opts.timers ?? realTimers, opts.time);
    this.attach(socket);
    socket.onClose((e) => {
      this.detach("Connection closed");
      for (const cb of [...this.closeListeners]) cb(e.clean);
    });
  }

  private readonly closeListeners = new Set<(clean: boolean) => void>();

  get open(): boolean {
    return this.socket?.state === "open";
  }

  onClose(cb: (clean: boolean) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(code = 1000, reason = ""): void {
    this.socket?.close(code, reason);
  }
}

export type ChannelStatus = "idle" | "connecting" | "open" | "waiting" | "closed";

export interface ChannelOptions {
  net: Net;
  /** Where to connect. A function is asked again on every attempt, so it can carry a fresh token. */
  url: string | (() => string | Promise<string>);
  /** Reconnect after a drop; on by default. */
  reconnect?: boolean;
  /** Wait before reconnecting: `min` doubling (`factor`) up to `max`, with up to 25% random spread. */
  backoff?: { min?: number; max?: number; factor?: number };
  /** Milliseconds between heartbeats; 0 turns them off. 5 seconds by default. */
  heartbeatMs?: number;
  /** Messages kept while disconnected and sent on reconnect, oldest dropped first. 0 keeps none. */
  queue?: number;
  timers?: Timers;
  /** Random source for backoff spread. */
  random?: () => number;
}

/**
 * The client's end: a connection that comes back. While it is down, `send` queues (up to
 * `queue` messages) and `call` rejects; `onStatus` tells the game what to show.
 */
export class Channel extends Endpoint {
  status: ChannelStatus = "idle";
  /** Round-trip time of the last heartbeat in milliseconds, or null before the first. */
  latency: number | null = null;
  /** The server's clock, as estimated from heartbeats. */
  readonly clock = new ClockSync();
  /** Failed connection attempts since the last successful one. */
  attempts = 0;
  private readonly opts: ChannelOptions;
  private readonly statusListeners = new Set<(s: ChannelStatus) => void>();
  private readonly pending: { type: string; data: unknown }[] = [];
  private retry: unknown = null;
  private beat: unknown = null;
  private generation = 0;

  constructor(opts: ChannelOptions) {
    super(opts.timers ?? opts.net.timers ?? realTimers);
    this.opts = opts;
  }

  onStatus(cb: (status: ChannelStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(s: ChannelStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const cb of [...this.statusListeners]) cb(s);
  }

  /** Start connecting. Safe to call again after `close()`. */
  open(): void {
    if (this.status === "connecting" || this.status === "open" || this.status === "waiting") return;
    this.attempts = 0;
    void this.dial();
  }

  private async dial(): Promise<void> {
    const gen = ++this.generation;
    this.setStatus("connecting");
    let url: string;
    try {
      url = typeof this.opts.url === "function" ? await this.opts.url() : this.opts.url;
    } catch {
      if (gen === this.generation) this.lost();
      return;
    }
    if (gen !== this.generation) return;
    const socket = this.opts.net.connect(url);
    socket.onOpen(() => {
      if (gen !== this.generation) return socket.close();
      this.attach(socket);
      this.attempts = 0;
      this.setStatus("open");
      for (const m of this.pending.splice(0)) super.send(m.type, m.data);
      this.heartbeat(gen);
    });
    socket.onClose(() => {
      if (gen !== this.generation) return;
      this.detach("Connection lost");
      this.lost();
    });
  }

  private lost(): void {
    this.timers.clear(this.beat);
    if (this.opts.reconnect === false) return this.setStatus("closed");
    const b = this.opts.backoff ?? {};
    const base = Math.min(b.max ?? 15000, (b.min ?? 500) * (b.factor ?? 2) ** this.attempts);
    const wait = base * (1 + 0.25 * (this.opts.random ?? Math.random)());
    this.attempts++;
    this.setStatus("waiting");
    this.retry = this.timers.set(() => void this.dial(), wait);
  }

  private heartbeat(gen: number): void {
    const every = this.opts.heartbeatMs ?? 5000;
    if (every <= 0) return;
    const ping = (): void => {
      if (gen !== this.generation || this.status !== "open") return;
      const sent = this.timers.now();
      this.call<number>(TIME, undefined, every * 2).then(
        (serverTime) => {
          if (gen !== this.generation) return;
          const now = this.timers.now();
          this.latency = now - sent;
          if (typeof serverTime === "number") this.clock.sample(sent, serverTime, now);
          this.beat = this.timers.set(ping, every);
        },
        (e: ChannelError) => {
          // No answer in two beats: the connection is dead even if nothing has said so yet.
          if (gen === this.generation && e.kind === "timeout") this.socket?.close(4000, "heartbeat timeout");
        },
      );
    };
    ping();
  }

  override send(type: string, data?: unknown): boolean {
    if (super.send(type, data)) return true;
    const max = this.opts.queue ?? 64;
    if (max <= 0 || this.status === "closed" || this.status === "idle") return false;
    this.pending.push({ type, data });
    while (this.pending.length > max) this.pending.shift();
    return true;
  }

  /** Disconnect and stay disconnected. */
  close(): void {
    this.generation++;
    this.timers.clear(this.retry);
    this.timers.clear(this.beat);
    this.pending.length = 0;
    const socket = this.socket;
    this.detach("Channel closed");
    socket?.close();
    this.setStatus("closed");
  }
}

/** Estimates the offset to a remote clock from request/response timestamps, trusting the fastest round trips. */
export class ClockSync {
  private readonly samples: { rtt: number; offset: number }[] = [];
  /** Remote time minus local time, in milliseconds; 0 until the first sample. */
  offset = 0;
  /** Round trip of the sample the offset came from, or null. */
  rtt: number | null = null;

  constructor(private readonly keep = 8) {}

  sample(sentAt: number, remoteTime: number, receivedAt: number): void {
    const rtt = Math.max(0, receivedAt - sentAt);
    this.samples.push({ rtt, offset: remoteTime - (sentAt + rtt / 2) });
    while (this.samples.length > this.keep) this.samples.shift();
    let best = this.samples[0]!;
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rtt = best.rtt;
  }

  /** The remote clock's reading at local time `localNow`. */
  remote(localNow: number): number {
    return localNow + this.offset;
  }
}

/**
 * Server states by server time, for drawing a moment slightly in the past: sample between
 * the two states either side of the render time instead of jumping when one arrives.
 */
export class SnapshotBuffer<T> {
  private readonly items: { time: number; state: T }[] = [];

  constructor(private readonly keep = 32) {}

  get length(): number {
    return this.items.length;
  }

  /** Add a state. Out-of-order arrivals are placed by time; a duplicate time replaces. */
  push(time: number, state: T): void {
    let i = this.items.length;
    while (i > 0 && this.items[i - 1]!.time > time) i--;
    if (i > 0 && this.items[i - 1]!.time === time) this.items[i - 1] = { time, state };
    else this.items.splice(i, 0, { time, state });
    while (this.items.length > this.keep) this.items.shift();
  }

  latest(): T | null {
    return this.items.length ? this.items[this.items.length - 1]!.state : null;
  }

  /**
   * The state at `time`: `blend(a, b, t)` between the neighbours, or the nearest end when
   * `time` is outside what has arrived. Null while empty.
   */
  sample(time: number, blend: (a: T, b: T, t: number) => T): T | null {
    const n = this.items.length;
    if (!n) return null;
    if (time <= this.items[0]!.time) return this.items[0]!.state;
    if (time >= this.items[n - 1]!.time) return this.items[n - 1]!.state;
    let i = 1;
    while (this.items[i]!.time < time) i++;
    const a = this.items[i - 1]!;
    const b = this.items[i]!;
    return blend(a.state, b.state, (time - a.time) / (b.time - a.time));
  }
}

/**
 * Inputs the server has not confirmed yet. Apply an input locally at once (`record`), and
 * when an authoritative state arrives naming the last input it included, drop those
 * (`confirm`) and replay the rest on top of it.
 */
export class InputBuffer<I> {
  private seq = 0;
  private items: { seq: number; input: I }[] = [];

  constructor(private readonly keep = 256) {}

  /** Remember an input; returns the sequence number to send with it. */
  record(input: I): number {
    const seq = ++this.seq;
    this.items.push({ seq, input });
    while (this.items.length > this.keep) this.items.shift();
    return seq;
  }

  /** Forget everything up to and including `seq`. */
  confirm(seq: number): void {
    this.items = this.items.filter((i) => i.seq > seq);
  }

  /** Unconfirmed inputs, oldest first. */
  pending(): I[] {
    return this.items.map((i) => i.input);
  }
}
