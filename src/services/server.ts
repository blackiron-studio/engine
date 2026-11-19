// The reference player service: guest and platform sign-in, account linking and deletion,
// and versioned cloud saves, as one fetch-style handler. Run it with `blackiron services`
// or mount the handler in a server of your own. It is deliberately small (one process, one
// JSON file): a backend to start with and a specification for others to match.

import { ServiceError, type SignInProvider } from "./types.ts";

interface PlayerRow {
  id: string;
  name: string;
  anonymous: boolean;
  providers: SignInProvider[];
  /** SHA-256 of the guest secret, so the data file holds no usable credential. */
  secret: string | null;
}

interface SaveRow {
  data: string;
  rev: number;
  updated_at: number;
}

export interface ServiceData {
  next: number;
  players: Record<string, PlayerRow>;
  /** "provider:subject" -> player id. */
  links: Record<string, string>;
  /** Token hash -> session. */
  sessions: Record<string, { player: string; expires: number }>;
  /** Refresh token hash -> player id. */
  refresh: Record<string, string>;
  saves: Record<string, Record<string, SaveRow>>;
}

export interface ServiceStore {
  load(): ServiceData | null;
  save(data: ServiceData): void;
}

export interface ServiceHandlerOptions {
  /** Persistence; in memory when omitted. */
  store?: ServiceStore;
  /**
   * Check a platform identity token and return the account's stable subject, or null to
   * refuse. Without it, platform sign-in answers 501. See `oidcVerifier`.
   */
  verify?: (provider: SignInProvider, credential: string) => Promise<{ subject: string; name?: string } | null>;
  now?: () => number;
  /** Access token lifetime; one hour by default. Refresh tokens last until the account is deleted. */
  tokenLifetimeMs?: number;
  /** Largest save, in characters; 1 MiB by default. */
  maxSaveBytes?: number;
  /** Saves per player; 64 by default. */
  maxSaves?: number;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
const fail = (status: number, error: string, detail?: string): Response => json(status, detail ? { error, detail } : { error });

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Build the handler. Requests outside `/v1/` get a 404, so it can share a server with other routes. */
export function createServiceHandler(opts: ServiceHandlerOptions = {}): (req: Request) => Promise<Response> {
  const now = opts.now ?? Date.now;
  const lifetime = opts.tokenLifetimeMs ?? 3_600_000;
  const maxBytes = opts.maxSaveBytes ?? 1024 * 1024;
  const maxSaves = opts.maxSaves ?? 64;
  const db: ServiceData = opts.store?.load() ?? { next: 1, players: {}, links: {}, sessions: {}, refresh: {}, saves: {} };
  const commit = (): void => opts.store?.save(db);

  const issue = async (p: PlayerRow, secret?: string) => {
    const token = randomToken();
    const refresh = randomToken();
    const expires = now() + lifetime;
    // Expired sessions are dropped as new ones are issued, so the table does not grow forever.
    for (const k of Object.keys(db.sessions)) if (db.sessions[k]!.expires <= now()) delete db.sessions[k];
    db.sessions[await sha256(token)] = { player: p.id, expires };
    db.refresh[await sha256(refresh)] = p.id;
    commit();
    return json(200, {
      session: {
        player: { id: p.id, name: p.name, anonymous: p.anonymous, providers: p.providers },
        token,
        refresh_token: refresh,
        expires_at: expires,
        ...(secret ? { secret } : {}),
      },
    });
  };

  const create = (secret: string | null): PlayerRow => {
    const id = String(db.next++);
    const p: PlayerRow = { id, name: `Player ${id}`, anonymous: true, providers: [], secret };
    db.players[id] = p;
    return p;
  };

  const authed = async (req: Request): Promise<PlayerRow | null> => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!m) return null;
    const s = db.sessions[await sha256(m[1]!)];
    return s && s.expires > now() ? (db.players[s.player] ?? null) : null;
  };

  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const v = (await req.json()) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const verified = async (b: Record<string, unknown>): Promise<{ key: string; provider: SignInProvider; name?: string } | Response> => {
    const provider = b.provider;
    if (provider !== "apple" && provider !== "google") return fail(400, "bad_provider");
    if (!opts.verify) return fail(501, "provider_sign_in_unavailable", "This server has no identity token verifier configured");
    if (typeof b.credential !== "string" || !b.credential) return fail(400, "credential_required");
    const who = await opts.verify(provider, b.credential);
    if (!who) return fail(403, "invalid_credential");
    return { key: `${provider}:${who.subject}`, provider, ...(who.name ? { name: who.name } : {}) };
  };

  return async (req) => {
    const path = new URL(req.url).pathname.replace(/^.*?(\/v1\/)/, "$1");
    const route = `${req.method} ${path}`;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (route === "POST /v1/session/guest") {
        const b = await body(req);
        if (b.secret !== undefined) {
          if (typeof b.secret !== "string" || b.secret.length < 32) return fail(400, "bad_secret", "A guest secret is at least 32 random characters");
          const hash = await sha256(b.secret);
          for (const p of Object.values(db.players)) if (p.secret === hash) return issue(p);
          // An unknown secret is a fresh installation choosing its own credential.
          return issue(create(hash));
        }
        const secret = randomToken();
        return issue(create(await sha256(secret)), secret);
      }
      if (route === "POST /v1/session/provider") {
        const v = await verified(await body(req));
        if (v instanceof Response) return v;
        let p = db.players[db.links[v.key] ?? ""];
        if (!p) {
          p = create(null);
          p.anonymous = false;
          p.providers = [v.provider];
          if (v.name) p.name = v.name;
          db.links[v.key] = p.id;
        }
        return issue(p);
      }
      if (route === "POST /v1/session/refresh") {
        const b = await body(req);
        const hash = typeof b.refresh_token === "string" ? await sha256(b.refresh_token) : "";
        const p = db.players[db.refresh[hash] ?? ""];
        if (!p) return fail(401, "invalid_refresh_token");
        // Refresh tokens are single use: a stolen one stops working once the player refreshes.
        delete db.refresh[hash];
        return issue(p);
      }
      if (!path.startsWith("/v1/")) return fail(404, "not_found");

      const player = await authed(req);
      if (!player) return fail(401, "unauthorized");

      if (route === "POST /v1/session/link") {
        const v = await verified(await body(req));
        if (v instanceof Response) return v;
        const owner = db.links[v.key];
        if (owner && owner !== player.id) return fail(409, "identity_already_linked");
        db.links[v.key] = player.id;
        player.anonymous = false;
        if (!player.providers.includes(v.provider)) player.providers.push(v.provider);
        return issue(player);
      }
      if (route === "DELETE /v1/account") {
        delete db.players[player.id];
        delete db.saves[player.id];
        for (const k of Object.keys(db.links)) if (db.links[k] === player.id) delete db.links[k];
        for (const k of Object.keys(db.sessions)) if (db.sessions[k]!.player === player.id) delete db.sessions[k];
        for (const k of Object.keys(db.refresh)) if (db.refresh[k] === player.id) delete db.refresh[k];
        commit();
        return json(200, { ok: true });
      }
      if (route === "GET /v1/saves") {
        const rows = db.saves[player.id] ?? {};
        return json(200, { saves: Object.keys(rows).map((key) => ({ key, ...rows[key]! })) });
      }
      if (path.startsWith("/v1/saves/")) {
        const key = decodeURIComponent(path.slice("/v1/saves/".length));
        if (!key || key.length > 256) return fail(400, "bad_key");
        const rows = (db.saves[player.id] ??= {});
        const cur = rows[key] ?? null;
        if (req.method === "PUT") {
          const b = await body(req);
          if (typeof b.data !== "string") return fail(400, "data_required");
          if (b.data.length > maxBytes) return fail(413, "save_too_large", `A save is at most ${maxBytes} characters`);
          const base = typeof b.base_rev === "number" ? b.base_rev : 0;
          if ((cur?.rev ?? 0) !== base) return json(409, { error: "rev_conflict", current: cur ? { key, ...cur } : null });
          if (!cur && Object.keys(rows).length >= maxSaves) return fail(507, "too_many_saves", `A player has at most ${maxSaves} saves`);
          rows[key] = { data: b.data, rev: base + 1, updated_at: now() };
          commit();
          return json(200, { rev: base + 1 });
        }
        if (req.method === "DELETE") {
          if (!cur) return fail(404, "not_found");
          delete rows[key];
          commit();
          return json(200, { ok: true });
        }
      }
      return fail(404, "not_found");
    } catch (e) {
      if (e instanceof ServiceError) return fail(400, e.kind, e.message);
      return fail(500, "server_error", e instanceof Error ? e.message : String(e));
    }
  };
}

/** Keep the service's data in one JSON file, replaced atomically on every change (Bun and Node). */
export async function fileStore(path: string): Promise<ServiceStore> {
  const fs = await import("node:fs");
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(path, "utf8")) as ServiceData;
      } catch {
        return null;
      }
    },
    save(data) {
      const tmp = `${path}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, path);
    },
  };
}
