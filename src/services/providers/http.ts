// The reference protocol: plain JSON over HTTPS, small enough to implement on any stack.
// `createServiceHandler` in ../server.ts is its server; this is the client.
//
//   POST   /v1/session/guest     {secret?}                -> {session}
//   POST   /v1/session/provider  {provider, credential}   -> {session}
//   POST   /v1/session/link      {provider, credential}   -> {session}      (bearer)
//   POST   /v1/session/refresh   {refresh_token}          -> {session}
//   DELETE /v1/account                                                      (bearer)
//   GET    /v1/saves                                      -> {saves: [...]} (bearer)
//   PUT    /v1/saves/{key}       {data, base_rev}         -> {rev} | 409 {current}
//   DELETE /v1/saves/{key}                                                  (bearer)
//
// Errors are `{error: "<code>", detail?: ""}` with a matching HTTP status.

import { NetError, type HttpRequest, type HttpResponse, type Net } from "../../net/types.ts";
import { ServiceError, type Player, type ProviderSupport, type PushResult, type SaveDoc, type ServiceProvider, type Session, type SignInProvider } from "../types.ts";

/** Send a request, turning transport failures and error statuses into ServiceErrors. */
export async function serviceRequest(net: Net, req: HttpRequest, accept: number[] = []): Promise<HttpResponse> {
  let res: HttpResponse;
  try {
    res = await net.request(req);
  } catch (e) {
    if (e instanceof NetError) throw new ServiceError(e.kind === "unsupported" ? "unsupported" : "offline", e.message);
    throw e;
  }
  if (res.ok || accept.includes(res.status)) return res;
  const body = res.json<{ error?: unknown; detail?: unknown }>();
  const code = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
  const message = typeof body?.detail === "string" && body.detail ? `${code}: ${body.detail}` : code;
  if (res.status === 401) throw new ServiceError("unauthorized", message);
  if (res.status === 409) throw new ServiceError("conflict", message);
  if (res.status === 413 || res.status === 507) throw new ServiceError("limit", message);
  if (res.status === 501) throw new ServiceError("unsupported", message);
  // The backend answered but is unwell: the same as being unreachable, as far as retrying goes.
  if (res.status === 429 || res.status >= 502) throw new ServiceError("offline", message);
  throw new ServiceError("rejected", message);
}

interface WireSession {
  player: { id: string; name: string; anonymous: boolean; providers: SignInProvider[] };
  token: string;
  refresh_token?: string;
  expires_at?: number;
  secret?: string;
}

interface WireSave {
  key: string;
  data: string;
  rev: number;
  updated_at: number;
}

const toSave = (w: WireSave): SaveDoc => ({ key: w.key, data: w.data, rev: w.rev, updatedAt: w.updated_at });

export class HttpProvider implements ServiceProvider {
  readonly name = "http";
  readonly supports: ProviderSupport = { providers: ["apple", "google"], link: true, deleteAccount: true, maxSaveBytes: 1024 * 1024 };
  private readonly base: string;

  constructor(
    private readonly net: Net,
    url: string,
  ) {
    this.base = url.replace(/\/+$/, "");
  }

  private auth(session: Session): Record<string, string> {
    return { authorization: `Bearer ${session.token}` };
  }

  private session(res: HttpResponse): Session {
    const w = res.json<{ session?: WireSession }>()?.session;
    if (!w || typeof w.token !== "string" || !w.player) throw new ServiceError("rejected", "The backend returned no session");
    const player: Player = { id: String(w.player.id), name: w.player.name, anonymous: !!w.player.anonymous, providers: w.player.providers ?? [] };
    return {
      player,
      token: w.token,
      ...(w.refresh_token ? { refreshToken: w.refresh_token } : {}),
      ...(typeof w.expires_at === "number" ? { expiresAt: w.expires_at } : {}),
      ...(w.secret ? { secret: w.secret } : {}),
    };
  }

  async signInGuest(secret: string | null): Promise<Session> {
    return this.session(await serviceRequest(this.net, { url: `${this.base}/v1/session/guest`, method: "POST", json: secret ? { secret } : {} }));
  }

  async signInWith(provider: SignInProvider, credential: string): Promise<Session> {
    return this.session(await serviceRequest(this.net, { url: `${this.base}/v1/session/provider`, method: "POST", json: { provider, credential } }));
  }

  async link(session: Session, provider: SignInProvider, credential: string): Promise<Session> {
    return this.session(await serviceRequest(this.net, { url: `${this.base}/v1/session/link`, method: "POST", headers: this.auth(session), json: { provider, credential } }));
  }

  async refresh(session: Session): Promise<Session> {
    if (!session.refreshToken) throw new ServiceError("unauthorized", "No refresh token");
    return this.session(await serviceRequest(this.net, { url: `${this.base}/v1/session/refresh`, method: "POST", json: { refresh_token: session.refreshToken } }));
  }

  async deleteAccount(session: Session): Promise<void> {
    await serviceRequest(this.net, { url: `${this.base}/v1/account`, method: "DELETE", headers: this.auth(session) });
  }

  async listSaves(session: Session): Promise<SaveDoc[]> {
    const res = await serviceRequest(this.net, { url: `${this.base}/v1/saves`, headers: this.auth(session) });
    return (res.json<{ saves?: WireSave[] }>()?.saves ?? []).map(toSave);
  }

  async pushSave(session: Session, key: string, data: string, baseRev: number): Promise<PushResult> {
    const res = await serviceRequest(this.net, { url: `${this.base}/v1/saves/${encodeURIComponent(key)}`, method: "PUT", headers: this.auth(session), json: { data, base_rev: baseRev } }, [409]);
    if (res.status === 409) {
      const cur = res.json<{ current?: WireSave | null }>()?.current;
      return { ok: false, current: cur ? toSave(cur) : null };
    }
    return { ok: true, rev: res.json<{ rev: number }>()?.rev ?? baseRev + 1 };
  }

  async deleteSave(session: Session, key: string): Promise<void> {
    await serviceRequest(this.net, { url: `${this.base}/v1/saves/${encodeURIComponent(key)}`, method: "DELETE", headers: this.auth(session) }, [404]);
  }
}
