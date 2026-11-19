import { BaseSocket, NetError, makeResponse, wireRequest, type HttpRequest, type HttpResponse, type Net, type Socket } from "./types.ts";

class WebSocketSocket extends BaseSocket {
  private ws: WebSocket | null = null;

  constructor(url: string) {
    super(url);
    try {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => this.emitOpen();
      ws.onmessage = (e) => this.emitMessage(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = (e) => this.emitClose({ code: e.code || 1006, reason: e.reason || "", clean: e.wasClean });
      this.ws = ws;
    } catch (e) {
      // A bad URL throws synchronously; report it the way a refused connection would be.
      const reason = e instanceof Error ? e.message : String(e);
      queueMicrotask(() => this.emitClose({ code: 1006, reason, clean: false }));
    }
  }

  send(data: string | Uint8Array): boolean {
    if (this.state !== "open" || !this.ws) return false;
    this.ws.send(data as string | Uint8Array<ArrayBuffer>);
    return true;
  }

  close(code = 1000, reason = ""): void {
    if (this.state === "closed") return;
    try {
      this.ws?.close(code, reason);
    } catch {
      this.ws?.close();
    }
    // Do not wait for the peer's close frame: the game has let go of this socket.
    this.emitClose({ code, reason, clean: true });
  }
}

/** Sockets and requests through the browser's (or Bun's) WebSocket and fetch. */
export class WebNet implements Net {
  connect(url: string): Socket {
    return new WebSocketSocket(url);
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const w = wireRequest(req);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), w.timeoutMs);
    try {
      const res = await fetch(w.url, { method: w.method, headers: w.headers, body: w.body ?? undefined, signal: abort.signal });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return makeResponse(res.status, headers, await res.text());
    } catch (e) {
      if (abort.signal.aborted) throw new NetError(`Request timed out: ${w.method} ${w.url}`, "timeout");
      throw new NetError(`Request failed: ${w.method} ${w.url}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
