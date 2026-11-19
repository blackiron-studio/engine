// An in-memory backend for tests and for developing a game's sign-in and sync screens
// without a server. Platform credentials are any non-empty string: the same string is the
// same account.

import { ServiceError, randomSecret, type Player, type ProviderSupport, type PushResult, type SaveDoc, type ServiceProvider, type Session, type SignInProvider } from "../types.ts";

interface Account {
  player: Player;
  secret: string | null;
  saves: Map<string, SaveDoc>;
}

export class MockProvider implements ServiceProvider {
  readonly name = "mock";
  readonly supports: ProviderSupport = { providers: ["apple", "google"], link: true, deleteAccount: true, maxSaveBytes: null };
  /** Set to make every call fail as it would without a connection. */
  offline = false;
  /** Tokens stop working after this many milliseconds; null never expires them. */
  tokenLifetime: number | null = null;
  readonly accounts = new Map<string, Account>();
  private readonly tokens = new Map<string, { id: string; expires: number | null }>();
  private readonly linked = new Map<string, string>();
  private nextId = 1;
  private nextToken = 1;

  constructor(private readonly now: () => number = Date.now) {}

  private up(): void {
    if (this.offline) throw new ServiceError("offline", "The mock backend is offline");
  }

  private issue(a: Account): Session {
    const token = `mock-token-${this.nextToken++}`;
    const expires = this.tokenLifetime === null ? null : this.now() + this.tokenLifetime;
    this.tokens.set(token, { id: a.player.id, expires });
    return {
      player: { ...a.player, providers: [...a.player.providers] },
      token,
      refreshToken: `refresh:${a.player.id}`,
      ...(expires === null ? {} : { expiresAt: expires }),
      ...(a.secret ? { secret: a.secret } : {}),
    };
  }

  private account(session: Session): Account {
    this.up();
    const t = this.tokens.get(session.token);
    const a = t && (t.expires === null || t.expires > this.now()) ? this.accounts.get(t.id) : undefined;
    if (!a) throw new ServiceError("unauthorized", "Unknown or expired session");
    return a;
  }

  private create(secret: string | null): Account {
    const id = `p${this.nextId++}`;
    const a: Account = { player: { id, name: `Player ${id.slice(1)}`, anonymous: true, providers: [] }, secret, saves: new Map() };
    this.accounts.set(id, a);
    return a;
  }

  async signInGuest(secret: string | null): Promise<Session> {
    this.up();
    if (secret) for (const a of this.accounts.values()) if (a.secret === secret) return this.issue(a);
    return this.issue(this.create(secret ?? randomSecret()));
  }

  async signInWith(provider: SignInProvider, credential: string): Promise<Session> {
    this.up();
    if (!credential) throw new ServiceError("rejected", "Empty credential");
    const key = `${provider}:${credential}`;
    let a = this.accounts.get(this.linked.get(key) ?? "");
    if (!a) {
      a = this.create(null);
      a.player.anonymous = false;
      a.player.providers = [provider];
      this.linked.set(key, a.player.id);
    }
    return this.issue(a);
  }

  async link(session: Session, provider: SignInProvider, credential: string): Promise<Session> {
    const a = this.account(session);
    if (!credential) throw new ServiceError("rejected", "Empty credential");
    const key = `${provider}:${credential}`;
    const owner = this.linked.get(key);
    if (owner && owner !== a.player.id) throw new ServiceError("conflict", `That ${provider} account already belongs to another player`);
    this.linked.set(key, a.player.id);
    a.player.anonymous = false;
    if (!a.player.providers.includes(provider)) a.player.providers.push(provider);
    return this.issue(a);
  }

  async refresh(session: Session): Promise<Session> {
    this.up();
    const a = this.accounts.get((session.refreshToken ?? "").replace(/^refresh:/, ""));
    if (!a) throw new ServiceError("unauthorized", "Unknown refresh token");
    return this.issue(a);
  }

  async deleteAccount(session: Session): Promise<void> {
    const a = this.account(session);
    this.accounts.delete(a.player.id);
    for (const [k, id] of [...this.linked]) if (id === a.player.id) this.linked.delete(k);
  }

  async listSaves(session: Session): Promise<SaveDoc[]> {
    return [...this.account(session).saves.values()].map((d) => ({ ...d }));
  }

  async pushSave(session: Session, key: string, data: string, baseRev: number): Promise<PushResult> {
    const a = this.account(session);
    const cur = a.saves.get(key) ?? null;
    if ((cur?.rev ?? 0) !== baseRev) return { ok: false, current: cur ? { ...cur } : null };
    const doc: SaveDoc = { key, data, rev: baseRev + 1, updatedAt: this.now() };
    a.saves.set(key, doc);
    return { ok: true, rev: doc.rev };
  }

  async deleteSave(session: Session, key: string): Promise<void> {
    this.account(session).saves.delete(key);
  }
}
