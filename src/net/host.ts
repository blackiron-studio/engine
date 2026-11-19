// Networking relayed to a native host. The host owns the sockets and requests; answers
// come back on the script thread through `__blackiron.net(id, kind, data, code)`.

import type { BlackironHostApi } from "../render/native.ts";
import { BaseSocket, NetError, fromBase64, makeResponse, toBase64, wireRequest, type HttpRequest, type HttpResponse, type Net, type Socket } from "./types.ts";

class HostSocket extends BaseSocket {
  constructor(
    url: string,
    private readonly id: number,
    private readonly host: BlackironHostApi,
    private readonly forget: (id: number) => void,
  ) {
    super(url);
  }

  send(data: string | Uint8Array): boolean {
    if (this.state !== "open") return false;
    if (typeof data === "string") this.host.netSend!(this.id, data, false);
    else this.host.netSend!(this.id, toBase64(data), true);
    return true;
  }

  close(code = 1000, reason = ""): void {
    if (this.state === "closed") return;
    this.host.netClose!(this.id, code, reason);
    this.forget(this.id);
    this.emitClose({ code, reason, clean: true });
  }

  deliver(kind: string, data: string, code: number): void {
    if (kind === "open") this.emitOpen();
    else if (kind === "text") this.emitMessage(data);
    else if (kind === "binary") this.emitMessage(fromBase64(data));
    else if (kind === "close" || kind === "error") {
      this.forget(this.id);
      this.emitClose({ code: code || 1006, reason: data, clean: kind === "close" && code !== 1006 });
    }
  }
}

export class HostNet implements Net {
  private next = 1;
  private readonly sockets = new Map<number, HostSocket>();
  private readonly requests = new Map<number, { resolve: (r: HttpResponse) => void; reject: (e: Error) => void; label: string }>();

  constructor(private readonly host: BlackironHostApi) {}

  /** Whether this host build can open connections at all. */
  static supported(host: BlackironHostApi): boolean {
    return typeof host.netOpen === "function" && typeof host.netRequest === "function";
  }

  connect(url: string): Socket {
    const id = this.next++;
    const socket = new HostSocket(url, id, this.host, (i) => this.sockets.delete(i));
    this.sockets.set(id, socket);
    try {
      this.host.netOpen!(id, url);
    } catch (e) {
      queueMicrotask(() => socket.deliver("error", e instanceof Error ? e.message : String(e), 1006));
    }
    return socket;
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    const w = wireRequest(req);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject, label: `${w.method} ${w.url}` });
      try {
        this.host.netRequest!(id, JSON.stringify(w));
      } catch (e) {
        this.requests.delete(id);
        reject(new NetError(`Request failed: ${w.method} ${w.url}: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /** Called by the host bridge. */
  deliver(id: number, kind: string, data: string, code: number): void {
    const pending = this.requests.get(id);
    if (pending) {
      this.requests.delete(id);
      if (kind === "response") {
        let parsed: { headers?: Record<string, string>; body?: string } = {};
        try {
          parsed = JSON.parse(data) as typeof parsed;
        } catch {
          parsed = {};
        }
        pending.resolve(makeResponse(code, parsed.headers ?? {}, parsed.body ?? ""));
      } else pending.reject(new NetError(`Request failed: ${pending.label}: ${data}`, data === "timeout" ? "timeout" : "offline"));
      return;
    }
    this.sockets.get(id)?.deliver(kind, data, code);
  }
}
