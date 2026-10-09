export type { Platform, DecodedImage } from "./types.ts";
export { WebPlatform } from "./web.ts";
export { HeadlessPlatform } from "./headless.ts";
export { NativePlatform, hostApi } from "./native.ts";

import { HeadlessPlatform } from "./headless.ts";
import { NativePlatform } from "./native.ts";
import type { Platform } from "./types.ts";
import { WebPlatform } from "./web.ts";

/** The platform for the current host: native when a host object is installed, web when a document exists, headless otherwise. */
export function detectPlatform(): Platform {
  if ((globalThis as { __blackironHost?: unknown }).__blackironHost) return new NativePlatform();
  return typeof document !== "undefined" && typeof window !== "undefined" ? new WebPlatform() : new HeadlessPlatform();
}
