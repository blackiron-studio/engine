// Verifies the identity tokens Sign in with Apple and Google Sign-In hand a game, for a
// server that accepts those accounts. A token proves who the player is only after its
// signature, issuer, audience and expiry all check out; never trust one unverified.

import type { SignInProvider } from "./types.ts";

export interface OidcOptions {
  /** Accepted audiences: the app's bundle id for Apple, the OAuth client id(s) for Google. */
  apple?: { audience: string | string[] };
  google?: { audience: string | string[] };
  /** Fetches a provider's signing keys; the default uses `fetch`. */
  fetchKeys?: (url: string) => Promise<{ keys: JsonWebKey[] }>;
  now?: () => number;
}

const ISSUERS: Record<SignInProvider, { keys: string; issuers: string[] }> = {
  apple: { keys: "https://appleid.apple.com/auth/keys", issuers: ["https://appleid.apple.com"] },
  google: { keys: "https://www.googleapis.com/oauth2/v3/certs", issuers: ["https://accounts.google.com", "accounts.google.com"] },
};

function decodeUrl(part: string): Uint8Array<ArrayBuffer> {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Returns a `verify(provider, token)` for `createServiceHandler`: the account's stable subject, or null. */
export function oidcVerifier(opts: OidcOptions): (provider: SignInProvider, token: string) => Promise<{ subject: string; name?: string } | null> {
  const now = opts.now ?? Date.now;
  const fetchKeys = opts.fetchKeys ?? (async (url: string) => (await fetch(url)).json() as Promise<{ keys: JsonWebKey[] }>);
  const cache = new Map<string, { at: number; keys: (JsonWebKey & { kid?: string })[] }>();

  const keysFor = async (url: string, kid: string): Promise<(JsonWebKey & { kid?: string }) | undefined> => {
    let c = cache.get(url);
    // Providers rotate keys: refetch hourly, and at once for a key id not seen before.
    if (!c || now() - c.at > 3_600_000 || !c.keys.some((k) => k.kid === kid)) {
      c = { at: now(), keys: (await fetchKeys(url)).keys ?? [] };
      cache.set(url, c);
    }
    return c.keys.find((k) => k.kid === kid);
  };

  return async (provider, token) => {
    const conf = opts[provider];
    const parts = token.split(".");
    if (!conf || parts.length !== 3) return null;
    try {
      const header = JSON.parse(new TextDecoder().decode(decodeUrl(parts[0]!))) as { alg?: string; kid?: string };
      const claims = JSON.parse(new TextDecoder().decode(decodeUrl(parts[1]!))) as { iss?: string; aud?: string | string[]; exp?: number; sub?: string; name?: string };
      if (header.alg !== "RS256" || !header.kid) return null;
      const jwk = await keysFor(ISSUERS[provider].keys, header.kid);
      if (!jwk) return null;
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeUrl(parts[2]!), signed))) return null;
      const audiences = Array.isArray(conf.audience) ? conf.audience : [conf.audience];
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!ISSUERS[provider].issuers.includes(claims.iss ?? "")) return null;
      if (!aud.some((a) => typeof a === "string" && audiences.includes(a))) return null;
      if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return null;
      if (typeof claims.sub !== "string" || !claims.sub) return null;
      return { subject: claims.sub, ...(typeof claims.name === "string" ? { name: claims.name } : {}) };
    } catch {
      return null;
    }
  };
}
