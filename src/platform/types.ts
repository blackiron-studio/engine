// The platform seam. Everything the engine needs from the host that is not rendering:
// time, frames, pixel ratio, asset bytes, image decoding, persistence and visibility.
// The web implementation wraps the DOM; a headless one runs tests and tools; a native
// shell would implement this once and reuse every layer above it.

import type { StoreBackend } from "../save/store.ts";

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
}

export type HapticKind = "light" | "medium" | "heavy" | "selection" | "success" | "warning" | "error";
