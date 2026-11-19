// Networking behind the Platform seam: one ordered message socket and one HTTP request,
// with no opinion about what is on the other end. A game's own server, the reference
// player service and any hosted backend all speak through this.

export type SocketState = "connecting" | "open" | "closed";

export interface SocketClose {
  /** WebSocket close code; 1006 when the connection dropped without a close frame. */
  code: number;
  reason: string;
  /** False when the connection was lost rather than closed by either side. */
  clean: boolean;
}

/** An ordered, reliable message stream (a WebSocket on every host). */
export interface Socket {
  readonly url: string;
  readonly state: SocketState;
  /** Queue a message. Returns false, sending nothing, unless the socket is open. */
  send(data: string | Uint8Array): boolean;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): () => void;
  onMessage(cb: (data: string | Uint8Array) => void): () => void;
  /** Fires exactly once, whether the socket closed, dropped or never connected. */
  onClose(cb: (e: SocketClose) => void): () => void;
}

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Sent as-is; set `content-type` yourself, or use `json`. */
  body?: string;
  /** Serialised as the body with `content-type: application/json`. */
  json?: unknown;
  /** Milliseconds before the request fails with a NetError; 15 seconds by default. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** True for 2xx. */
  ok: boolean;
  /** Header names are lower case. */
  headers: Record<string, string>;
  text: string;
  /** The body parsed as JSON, or null when it is empty or not JSON. */
  json<T = unknown>(): T | null;
}

/** Timers a helper should use, so a loopback's simulated clock can drive retries and timeouts. */
export interface Timers {
  now(): number;
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface Net {
  connect(url: string): Socket;
  /** Resolves with any HTTP status; rejects with a NetError only when no response arrived. */
  request(req: HttpRequest): Promise<HttpResponse>;
  /** Present when time is simulated (the loopback); helpers fall back to real timers. */
  readonly timers?: Timers;
}

/** No response: offline, refused, timed out or unsupported on this host. */
export class NetError extends Error {
  constructor(
    message: string,
    readonly kind: "offline" | "timeout" | "unsupported" = "offline",
  ) {
    super(message);
    this.name = "NetError";
  }
}

export const realTimers: Timers = {
  now: () => Date.now(),
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function makeResponse(status: number, headers: Record<string, string>, text: string): HttpResponse {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]!;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: lower,
    text,
    json<T>() {
      if (!text) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
  };
}

/** The request as it goes on the wire: `json` folded into the body and headers. */
export function wireRequest(req: HttpRequest): { url: string; method: string; headers: Record<string, string>; body: string | null; timeoutMs: number } {
  const headers: Record<string, string> = {};
  for (const k of Object.keys(req.headers ?? {})) headers[k.toLowerCase()] = req.headers![k]!;
  let body = req.body ?? null;
  if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    headers["content-type"] ??= "application/json";
  }
  return { url: req.url, method: req.method ?? (body === null ? "GET" : "POST"), headers, body, timeoutMs: req.timeoutMs ?? 15000 };
}

/** The listener plumbing every Socket implementation shares. */
export abstract class BaseSocket implements Socket {
  state: SocketState = "connecting";
  private readonly opens = new Set<() => void>();
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(e: SocketClose) => void>();

  constructor(readonly url: string) {}

  abstract send(data: string | Uint8Array): boolean;
  abstract close(code?: number, reason?: string): void;

  onOpen(cb: () => void): () => void {
    this.opens.add(cb);
    return () => this.opens.delete(cb);
  }

  onMessage(cb: (data: string | Uint8Array) => void): () => void {
    this.messages.add(cb);
    return () => this.messages.delete(cb);
  }

  onClose(cb: (e: SocketClose) => void): () => void {
    this.closes.add(cb);
    return () => this.closes.delete(cb);
  }

  protected emitOpen(): void {
    if (this.state !== "connecting") return;
    this.state = "open";
    for (const cb of [...this.opens]) cb();
  }

  protected emitMessage(data: string | Uint8Array): void {
    if (this.state !== "open") return;
    for (const cb of [...this.messages]) cb(data);
  }

  protected emitClose(e: SocketClose): void {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const cb of [...this.closes]) cb(e);
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without `btoa`: the native script engines have none. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64[c & 63]! : "=";
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]!);
    const b = B64.indexOf(clean[i + 1] ?? "A");
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]!) : -1;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]!) : -1;
    out[n++] = (a << 2) | (b >> 4);
    if (c >= 0) out[n++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[n++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, n);
}
