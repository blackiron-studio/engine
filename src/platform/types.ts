// The platform seam. Everything the engine needs from the host that is not rendering:
// time, frames, pixel ratio, asset bytes, image decoding, persistence and visibility.
// The web implementation wraps the DOM; a headless one runs tests and tools; a native
// shell would implement this once and reuse every layer above it.

import type { Net } from "../net/types.ts";
import type { StoreBackend } from "../save/store.ts";
import type { PlatformSignIn } from "../services/types.ts";

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, not premultiplied. */
  data: Uint8ClampedArray;
}

export interface Platform {
  /** True when the host runs a synthetic clock for screenshot tests: seeds must not come from the wall clock. */
  readonly deterministic?: boolean;
  readonly kind: "web" | "headless" | "native";
  /** Milliseconds, monotonic. */
  now(): number;
  /** Schedule a frame callback; returns a cancel function. */
  requestFrame(cb: (time: number) => void): () => void;
  /** Device pixels per logical CSS pixel. */
  pixelRatio(): number;
  /** Whether the app is visible; hidden apps stop their loop. */
  visible(): boolean;
  onVisibility(cb: (visible: boolean) => void): () => void;
  loadBytes(url: string): Promise<ArrayBuffer>;
  loadText(url: string): Promise<string>;
  loadJson<T = unknown>(url: string): Promise<T>;
  loadImage(url: string): Promise<DecodedImage>;
  decodeImage?(bytes: Uint8Array, mime: string): Promise<DecodedImage>;
  storage(): StoreBackend;
  /** Best-effort: open a URL, save a blob, etc. Not every platform can. */
  openUrl?(url: string): void;
  /** Haptic feedback where the device has it (phones); a no-op elsewhere. */
  haptic?(kind: HapticKind): void;
  /** Read text out through the screen reader, when the platform has one and it is on. */
  announce?(text: string): void;
  /** The app store (StoreKit, Play Billing), where the build has one. Absent on plain web and desktop. */
  readonly purchases?: Purchases;
  /** Sockets and HTTP requests. Absent on a native host built without networking. */
  readonly net?: Net;
  /** The platform's own sign-in sheet (Sign in with Apple), where the build has one. */
  readonly signIn?: PlatformSignIn;
}

/** A product as the store describes it, with the price already localised for the player. */
export interface StoreProduct {
  id: string;
  title: string;
  price: string;
}

export type PurchaseResult = "purchased" | "restored" | "cancelled" | "pending" | "failed" | "unavailable";

/**
 * In-app purchases. Product ids are the ones registered in App Store Connect and the Play
 * Console. Entitlements are the store's to keep: a game re-reads `owned()` on launch and
 * grants whatever is listed, so a reinstall or a second device restores itself.
 */
export interface Purchases {
  products(ids: string[]): Promise<StoreProduct[]>;
  buy(id: string): Promise<PurchaseResult>;
  /** Ask the store to re-sync past purchases; resolves with every owned id. */
  restore(): Promise<string[]>;
  /** Non-consumables the store last reported as owned. */
  owned(): string[];
  /** Called when entitlements change outside a `buy` (approved Ask to Buy, refunds, another device). */
  onChange(cb: (owned: string[]) => void): () => void;
}

export type HapticKind = "light" | "medium" | "heavy" | "selection" | "success" | "warning" | "error";
