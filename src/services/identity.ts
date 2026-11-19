// The signed-in player. A guest identity is created silently on first use and survives
// restarts through a stored secret; a platform account (Apple, Google) can be linked later
// so the same player can be reached from another device.

import type { BlackironHostApi } from "../render/native.ts";
import type { StoreBackend } from "../save/store.ts";
import { ServiceError, type PlatformSignIn, type Player, type ServiceProvider, type Session, type SignInProvider } from "./types.ts";

const KEY = "blackiron.identity";

interface Stored {
  provider: string;
  session: Session | null;
  /** Kept after sign-out of a linked account, so a guest can return. */
  secret: string | null;
}

export interface IdentityOptions {
  provider: ServiceProvider;
  /** Where the session is kept between runs. */
  storage: StoreBackend;
  /** The platform's sign-in sheet, where the build has one. */
  platform?: PlatformSignIn;
  now?: () => number;
}

export class Identity {
  readonly provider: ServiceProvider;
  private readonly storage: StoreBackend;
  private readonly platform?: PlatformSignIn;
  private readonly now: () => number;
  private session: Session | null = null;
  private secret: string | null = null;
  private signingIn: Promise<Player> | null = null;
  private readonly listeners = new Set<(player: Player | null) => void>();

  constructor(opts: IdentityOptions) {
    this.provider = opts.provider;
    this.storage = opts.storage;
    this.platform = opts.platform;
    this.now = opts.now ?? Date.now;
    try {
      const saved = JSON.parse(this.storage.get(KEY) ?? "null") as Stored | null;
      // A session from another backend means nothing to this one.
      if (saved && saved.provider === this.provider.name) {
        this.session = saved.session;
        this.secret = saved.secret ?? saved.session?.secret ?? null;
      }
    } catch {
      this.session = null;
    }
  }

  /** The current player, or null before `signIn()`. Available offline once signed in. */
  get player(): Player | null {
    return this.session?.player ?? null;
  }

  /** The bearer token for the backend and for a game's own server, or null. */
  get token(): string | null {
    return this.session?.token ?? null;
  }

  /** What this backend can do. */
  get supports(): ServiceProvider["supports"] {
    return this.provider.supports;
  }

  /** Platform accounts this build can sign in with: offered by the host and verifiable by the backend. */
  platformProviders(): SignInProvider[] {
    const host = this.platform?.providers() ?? [];
    return this.provider.supports.providers.filter((p) => host.includes(p));
  }

  onChange(cb: (player: Player | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(session: Session | null): void {
    const before = JSON.stringify(this.session?.player ?? null);
    this.session = session;
    if (session?.secret) this.secret = session.secret;
    const stored: Stored = { provider: this.provider.name, session, secret: this.secret };
    try {
      this.storage.set(KEY, JSON.stringify(stored));
    } catch {
      // The session still works for this run.
    }
    const after = session?.player ?? null;
    if (JSON.stringify(after) !== before) for (const cb of [...this.listeners]) cb(after);
  }

  /**
   * Make sure there is a player: the stored one, or a new guest. Works offline when a
   * session is already stored. Concurrent calls share one request.
   */
  signIn(): Promise<Player> {
    if (this.session) return Promise.resolve(this.session.player);
    this.signingIn ??= this.provider
      .signInGuest(this.secret)
      .then((s) => {
        this.set(s);
        return s.player;
      })
      .finally(() => (this.signingIn = null));
    return this.signingIn;
  }

  private async credential(provider: SignInProvider, credential?: string): Promise<string> {
    if (!this.provider.supports.providers.includes(provider)) throw new ServiceError("unsupported", `The ${this.provider.name} backend cannot verify ${provider} accounts`);
    if (credential) return credential;
    if (!this.platform?.providers().includes(provider)) throw new ServiceError("unsupported", `This build has no ${provider} sign-in`);
    return (await this.platform.request(provider)).token;
  }

  /**
   * Attach a platform account to the current player so their progress follows them. Pass a
   * `credential` (an identity token) on hosts without a sign-in sheet, such as the web.
   */
  async link(provider: SignInProvider, credential?: string): Promise<Player> {
    if (!this.provider.supports.link) throw new ServiceError("unsupported", `The ${this.provider.name} backend cannot link accounts`);
    await this.signIn();
    const token = await this.credential(provider, credential);
    const next = await this.authorized((s) => this.provider.link(s, provider, token));
    this.set({ ...next, secret: next.secret ?? this.session?.secret });
    return next.player;
  }

  /**
   * Switch to the player who owns a platform account, as on a second device. The current
   * guest is left behind, not merged: use `link` to keep this device's progress instead.
   */
  async signInWith(provider: SignInProvider, credential?: string): Promise<Player> {
    const token = await this.credential(provider, credential);
    const next = await this.provider.signInWith(provider, token);
    this.set(next);
    return next.player;
  }

  /** Forget the session on this device. The next `signIn()` returns to this device's guest, if it had one. */
  signOut(): void {
    this.set(null);
  }

  /** Delete the player and their data on the backend, then forget them here. */
  async deleteAccount(): Promise<void> {
    if (!this.provider.supports.deleteAccount) throw new ServiceError("unsupported", `The ${this.provider.name} backend does not delete accounts from the game`);
    if (!this.session) return;
    await this.authorized((s) => this.provider.deleteAccount(s));
    this.secret = null;
    this.set(null);
  }

  /**
   * Run a backend call with the current session. A session the backend no longer accepts is
   * renewed once (refresh, then the guest secret) before giving up.
   */
  async authorized<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    if (!this.session) await this.signIn();
    let session = this.session!;
    if (session.expiresAt !== undefined && session.expiresAt - this.now() < 30_000) session = await this.renew(session);
    try {
      return await fn(session);
    } catch (e) {
      if (!(e instanceof ServiceError) || e.kind !== "unauthorized") throw e;
      return fn(await this.renew(session));
    }
  }

  private async renew(old: Session): Promise<Session> {
    let next: Session | null = null;
    try {
      next = await this.provider.refresh(old);
    } catch (e) {
      if (e instanceof ServiceError && e.kind === "offline") throw e;
    }
    // A guest can always come back with the secret; a linked player must sign in again.
    if (!next && old.player.anonymous && (old.secret ?? this.secret)) next = await this.provider.signInGuest(old.secret ?? this.secret);
    if (!next) {
      this.set(null);
      throw new ServiceError("unauthorized", "The session expired; sign in again");
    }
    const merged = { ...next, secret: next.secret ?? old.secret };
    this.set(merged);
    return merged;
  }
}

/** Platform sign-in relayed to the native host (Sign in with Apple on iOS). */
export class HostSignIn implements PlatformSignIn {
  private next = 1;
  private readonly waiting = new Map<number, (json: unknown) => void>();

  constructor(private readonly host: BlackironHostApi) {}

  static supported(host: BlackironHostApi): boolean {
    return typeof host.signInRequest === "function";
  }

  providers(): SignInProvider[] {
    try {
      const list = JSON.parse(this.host.signInProviders?.() ?? "[]") as unknown;
      return Array.isArray(list) ? list.filter((p): p is SignInProvider => p === "apple" || p === "google") : [];
    } catch {
      return [];
    }
  }

  request(provider: SignInProvider): Promise<{ token: string; name?: string }> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (json) => {
        const a = (json ?? {}) as { token?: unknown; name?: unknown; error?: unknown };
        if (typeof a.token === "string" && a.token) resolve({ token: a.token, name: typeof a.name === "string" ? a.name : undefined });
        else if (a.error === "cancelled") reject(new ServiceError("cancelled", "Sign-in was cancelled"));
        else if (a.error === "unavailable") reject(new ServiceError("unsupported", `This build has no ${provider} sign-in`));
        else reject(new ServiceError("rejected", `${provider} sign-in failed`));
      });
      try {
        this.host.signInRequest!(id, provider);
      } catch {
        this.waiting.delete(id);
        reject(new ServiceError("unsupported", `This build has no ${provider} sign-in`));
      }
    });
  }

  /** Called by the host bridge. */
  deliver(requestId: number, json: string): void {
    const done = this.waiting.get(requestId);
    this.waiting.delete(requestId);
    let data: unknown = null;
    try {
      data = JSON.parse(json);
    } catch {
      data = { error: "failed" };
    }
    done?.(data);
  }
}
