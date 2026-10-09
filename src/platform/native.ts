// Native platform: delegates to the host object a native shell installs on the global
// before the game script runs. The host drives frames; this platform only relays them.

import type { KilnHostApi } from "../render/native.ts";
import type { StoreBackend } from "../save/store.ts";
import type { DecodedImage, HapticKind, Platform } from "./types.ts";

export function hostApi(): KilnHostApi {
  const host = (globalThis as { __kilnHost?: KilnHostApi }).__kilnHost;
  if (!host) throw new Error("No native host: globalThis.__kilnHost is missing");
  return host;
}

export class NativePlatform implements Platform {
  readonly kind = "native" as const;
  readonly host: KilnHostApi;
  readonly deterministic: boolean;
  private pending: ((t: number) => void) | null = null;
  private isVisible = true;
  private readonly visibilityListeners = new Set<(v: boolean) => void>();

  constructor(host: KilnHostApi = hostApi()) {
    this.host = host;
    this.deterministic = host.deterministic ?? false;
  }

  now(): number {
    return this.host.now();
  }

  requestFrame(cb: (time: number) => void): () => void {
    this.pending = cb;
    return () => {
      if (this.pending === cb) this.pending = null;
    };
  }

  haptic(kind: HapticKind): void {
    this.host.haptic?.(kind);
  }

  announce(text: string): void {
    this.host.announce?.(text);
  }

  /** Called by the host every display refresh. */
  fireFrame(time: number): void {
    const cb = this.pending;
    this.pending = null;
    cb?.(time);
  }

  pixelRatio(): number {
    return this.host.screen.scale || 1;
  }

  visible(): boolean {
    return this.isVisible;
  }

  onVisibility(cb: (visible: boolean) => void): () => void {
    this.visibilityListeners.add(cb);
    return () => this.visibilityListeners.delete(cb);
  }

  /** Called by the host when the app goes to the background or returns. */
  setVisible(v: boolean): void {
    if (v === this.isVisible) return;
    this.isVisible = v;
    for (const cb of this.visibilityListeners) cb(v);
  }

  async loadBytes(url: string): Promise<ArrayBuffer> {
    const bytes = this.host.loadBytes(url);
    if (!bytes) throw new Error(`Missing bundled file: ${url}`);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async loadText(url: string): Promise<string> {
    const text = this.host.loadText(url);
    if (text === null || text === undefined) throw new Error(`Missing bundled file: ${url}`);
    return text;
  }

  async loadJson<T = unknown>(url: string): Promise<T> {
    return JSON.parse(await this.loadText(url)) as T;
  }

  async loadImage(url: string): Promise<DecodedImage> {
    const img = this.host.loadImage?.(url);
    if (!img) throw new Error(`Cannot decode image on this host: ${url}`);
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
  }

  async decodeImage(bytes: Uint8Array, _mime: string): Promise<DecodedImage> {
    const image = this.host.decodeImage?.(bytes);
    if (!image) throw new Error("Native host cannot decode this embedded image");
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  }

  storage(): StoreBackend {
    const h = this.host;
    return {
      get: (k) => h.storageGet(k),
      set: (k, v) => {
        if (h.storageSet(k, v) === false) throw new Error("Native storage write failed");
      },
      remove: (k) => {
        if (h.storageRemove(k) === false) throw new Error("Native storage removal failed");
      },
    };
  }
}
