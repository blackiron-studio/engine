// Player services: who the player is and where their saves live. The engine defines the
// shapes; a ServiceProvider adapts them to whatever backend a game points at (the mock, the
// reference server, Apteva Games, or one a game registers itself).

export type SignInProvider = "apple" | "google";

export interface Player {
  id: string;
  name: string;
  /** True until the player links or signs in with a platform account. */
  anonymous: boolean;
  /** Platform accounts attached to this player. */
  providers: SignInProvider[];
}

export interface Session {
  player: Player;
  /** Bearer token for the backend. Hand it to a game server so it can check who is connecting. */
  token: string;
  refreshToken?: string;
  /** Milliseconds since the epoch, when known. */
  expiresAt?: number;
  /** The guest credential: a random secret that signs this installation back in. */
  secret?: string;
}

export interface SaveDoc {
  key: string;
  data: string;
  /** Revision on the backend; increases with every accepted write. */
  rev: number;
  /** Milliseconds since the epoch. */
  updatedAt: number;
}

export type PushResult = { ok: true; rev: number } | { ok: false; current: SaveDoc | null };

/** What a backend can do, so the game can hide buttons that would only fail. */
export interface ProviderSupport {
  /** Platform accounts the backend can verify. */
  providers: SignInProvider[];
  /** Attach a platform account to the current guest, keeping their progress. */
  link: boolean;
  /** Let the player delete their account and data from inside the game. */
  deleteAccount: boolean;
  /** Largest save the backend accepts, in bytes of text, or null when unlimited. */
  maxSaveBytes: number | null;
}

/** The adapter a backend implements. Every method may reject with a ServiceError. */
export interface ServiceProvider {
  readonly name: string;
  readonly supports: ProviderSupport;
  /** Sign in as a guest. `secret` is the stored credential; null creates a new player. */
  signInGuest(secret: string | null): Promise<Session>;
  /** Sign in with a platform identity token ("credential"). */
  signInWith(provider: SignInProvider, credential: string): Promise<Session>;
  /** Attach a platform account to the session's player. */
  link(session: Session, provider: SignInProvider, credential: string): Promise<Session>;
  refresh(session: Session): Promise<Session>;
  deleteAccount(session: Session): Promise<void>;
  listSaves(session: Session): Promise<SaveDoc[]>;
  /**
   * Write a save. `baseRev` is the revision this write is based on (0: none seen). When the
   * backend holds a different one, nothing is written and `current` is returned.
   */
  pushSave(session: Session, key: string, data: string, baseRev: number): Promise<PushResult>;
  deleteSave(session: Session, key: string): Promise<void>;
}

export type ServiceErrorKind =
  /** No answer: the device is offline or the backend is down. Try again later. */
  | "offline"
  /** The session is no longer accepted. */
  | "unauthorized"
  /** This backend, or this build, cannot do that. */
  | "unsupported"
  /** The platform account already belongs to another player. */
  | "conflict"
  /** The player dismissed the platform's sign-in sheet. */
  | "cancelled"
  /** Too large or over quota. */
  | "limit"
  /** The backend refused for another reason (banned, invalid input, server error). */
  | "rejected";

export class ServiceError extends Error {
  constructor(
    readonly kind: ServiceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** The config block in `blackiron.json`. */
export interface ServicesConfig {
  /** "mock", "http" (the reference server), "apteva", or a name passed to `registerProvider`. */
  provider: string;
  /** Base URL of the backend. Required for every provider except "mock". */
  url?: string;
  /** Game identifier on a multi-game backend (Apteva Games). */
  game?: string;
  /** Project identifier, where the backend needs one (a global Apteva install). */
  project?: string;
}

/** Where a platform identity token comes from: the native host's sign-in sheet. */
export interface PlatformSignIn {
  /** Providers this build can show a sign-in sheet for. */
  providers(): SignInProvider[];
  /** Show the sheet; resolves with the identity token. Rejects with a ServiceError. */
  request(provider: SignInProvider): Promise<{ token: string; name?: string }>;
}

/** 32 random bytes as hex: a guest credential. */
export function randomSecret(random: () => number = Math.random): string {
  const bytes = new Uint8Array(32);
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
