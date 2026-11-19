// Apteva Games (the v2 player API): guest players and cloud saves for one game on an
// Apteva server.
//
//   base: {url}/api/apps/games/v2/games/{game}        (+ ?project_id=… on a global install)
//   POST /login/device     {} or {device_id}  -> {device_id, player, access_token, refresh_token, expires_in}
//   POST /session/refresh  {refresh_token}
//   GET  /data                                -> {data: [{key, value, version, updated_at}]}
//   PUT  /data/{key}       {value, visibility, version} -> {data} | 409 {error: "version_conflict", current}
//   DELETE /data/{key}
//
// Games does not verify Apple or Google accounts and has no player-facing account deletion
// (an operator erases a player with the `players_erase` tool), so those report "unsupported".
// Saves are capped at 256 KiB each, 128 keys and 16 MiB per player.

import type { HttpRequest, Net } from "../../net/types.ts";
import { ServiceError, type Player, type ProviderSupport, type PushResult, type SaveDoc, type ServiceProvider, type Session, type SignInProvider } from "../types.ts";
import { serviceRequest } from "./http.ts";

interface AptevaPlayer {
  id: number;
  display_name?: string;
  kind?: string;
}

interface AptevaLogin {
  device_id?: string;
  player?: AptevaPlayer;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface AptevaEntry {
  key: string;
  value: unknown;
  version: number;
  updated_at?: string;
}

/** Apteva allows `[A-Za-z0-9_.:-]{1,128}` in a key; anything else is escaped as `:xx` hex bytes. */
export function aptevaKey(key: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(key)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.-]/.test(ch) ? ch : `:${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

export function fromAptevaKey(key: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < key.length; i++) {
    if (key[i] === ":" && i + 2 < key.length + 0 && /^[0-9a-f]{2}$/.test(key.slice(i + 1, i + 3))) {
      bytes.push(parseInt(key.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(key.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export interface AptevaOptions {
  /** The Apteva server, for example `https://agents.example.com`. */
  url: string;
  /** The game's id on that server. */
  game: string;
  /** Needed when Games is installed globally rather than in one project. */
  project?: string;
}

export class AptevaProvider implements ServiceProvider {
  readonly name = "apteva";
  readonly supports: ProviderSupport = { providers: [], link: false, deleteAccount: false, maxSaveBytes: 256 * 1024 };
  private readonly base: string;
  private readonly query: string;

  constructor(
    private readonly net: Net,
    opts: AptevaOptions,
    private readonly now: () => number = Date.now,
  ) {
    if (!opts.game) throw new ServiceError("rejected", 'The "apteva" provider needs services.game: the game id on the Apteva server');
    this.base = `${opts.url.replace(/\/+$/, "")}/api/apps/games/v2/games/${encodeURIComponent(opts.game)}`;
    this.query = opts.project ? `?project_id=${encodeURIComponent(opts.project)}` : "";
  }

  private req(path: string, rest: Omit<HttpRequest, "url"> = {}, session?: Session): HttpRequest {
    return { url: `${this.base}${path}${this.query}`, ...rest, headers: { ...(session ? { authorization: `Bearer ${session.token}` } : {}), ...rest.headers } };
  }

  private session(body: AptevaLogin | null, old?: Session): Session {
    if (!body?.access_token) throw new ServiceError("rejected", "Apteva Games returned no access token");
    const p = body.player;
    const player: Player = p ? { id: String(p.id), name: p.display_name ?? "", anonymous: true, providers: [] } : (old?.player ?? { id: "", name: "", anonymous: true, providers: [] });
    if (!player.id) throw new ServiceError("rejected", "Apteva Games returned no player");
    const secret = body.device_id || old?.secret;
    return {
      player,
      token: body.access_token,
      ...(body.refresh_token || old?.refreshToken ? { refreshToken: body.refresh_token || old?.refreshToken } : {}),
      ...(typeof body.expires_in === "number" ? { expiresAt: this.now() + body.expires_in * 1000 } : {}),
      ...(secret ? { secret } : {}),
    };
  }

  async signInGuest(secret: string | null): Promise<Session> {
    const res = await serviceRequest(this.net, this.req("/login/device", { method: "POST", json: secret ? { device_id: secret } : {} }));
    return this.session(res.json<AptevaLogin>(), secret ? ({ secret } as Session) : undefined);
  }

  async signInWith(provider: SignInProvider): Promise<Session> {
    throw new ServiceError("unsupported", `Apteva Games does not verify ${provider} accounts`);
  }

  async link(_session: Session, provider: SignInProvider): Promise<Session> {
    throw new ServiceError("unsupported", `Apteva Games does not verify ${provider} accounts`);
  }

  async refresh(session: Session): Promise<Session> {
    if (!session.refreshToken) throw new ServiceError("unauthorized", "No refresh token");
    const res = await serviceRequest(this.net, this.req("/session/refresh", { method: "POST", json: { refresh_token: session.refreshToken } }), [400, 403]);
    // A refused refresh token is an expired session, not a broken request.
    if (!res.ok) throw new ServiceError("unauthorized", "Apteva Games refused the refresh token");
    return this.session(res.json<AptevaLogin>(), session);
  }

  async deleteAccount(): Promise<void> {
    throw new ServiceError("unsupported", "Apteva Games erases players from the operator side (players_erase), not from the game");
  }

  private doc(e: AptevaEntry): SaveDoc {
    const at = e.updated_at ? Date.parse(e.updated_at) : NaN;
    return { key: fromAptevaKey(e.key), data: typeof e.value === "string" ? e.value : JSON.stringify(e.value), rev: e.version, updatedAt: Number.isFinite(at) ? at : 0 };
  }

  async listSaves(session: Session): Promise<SaveDoc[]> {
    const res = await serviceRequest(this.net, this.req("/data", {}, session));
    return (res.json<{ data?: AptevaEntry[] }>()?.data ?? []).map((e) => this.doc(e));
  }

  async pushSave(session: Session, key: string, data: string, baseRev: number): Promise<PushResult> {
    const wire = aptevaKey(key);
    if (wire.length > 128) throw new ServiceError("limit", `Save key "${key}" is too long for Apteva Games (128 characters once escaped)`);
    // The save travels as a JSON string value, so any text a store writes is acceptable.
    const res = await serviceRequest(this.net, this.req(`/data/${wire}`, { method: "PUT", json: { value: data, visibility: "private", version: baseRev } }, session), [409]);
    if (res.status === 409) {
      const cur = res.json<{ current?: AptevaEntry | null }>()?.current;
      return { ok: false, current: cur ? this.doc(cur) : null };
    }
    const entry = res.json<{ data?: AptevaEntry }>()?.data;
    return { ok: true, rev: entry?.version ?? baseRev + 1 };
  }

  async deleteSave(session: Session, key: string): Promise<void> {
    await serviceRequest(this.net, this.req(`/data/${aptevaKey(key)}`, { method: "DELETE" }, session), [404]);
  }
}
