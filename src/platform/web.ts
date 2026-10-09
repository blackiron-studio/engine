import { fetchResource } from "./resources.ts";
import { defaultBackend } from "../save/store.ts";
import type { DecodedImage, HapticKind, Platform } from "./types.ts";

/** The browser platform: DOM timers, fetch, image decoding through a canvas. */
export class WebPlatform implements Platform {
  readonly kind = "web" as const;

  now(): number {
    return performance.now();
  }

  requestFrame(cb: (time: number) => void): () => void {
    // requestAnimationFrame with a timer behind it, so embedded and background
    // contexts that throttle rAF keep ticking at a low rate instead of freezing.
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const fire = (t: number) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      cancelAnimationFrame(raf);
      cb(t);
    };
    raf = requestAnimationFrame(fire);
    timer = setTimeout(() => fire(performance.now()), 100);
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      if (timer !== null) clearTimeout(timer);
    };
  }

  pixelRatio(): number {
    return Math.min(3, window.devicePixelRatio || 1);
  }

  visible(): boolean {
    return typeof document === "undefined" || !document.hidden;
  }

  onVisibility(cb: (visible: boolean) => void): () => void {
    const fn = () => cb(!document.hidden);
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  }

  async loadBytes(url: string): Promise<ArrayBuffer> {
    const res = await fetchResource(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return res.arrayBuffer();
  }

  async loadText(url: string): Promise<string> {
    const res = await fetchResource(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return res.text();
  }

  async loadJson<T = unknown>(url: string): Promise<T> {
    return JSON.parse(await this.loadText(url)) as T;
  }

  async loadImage(url: string): Promise<DecodedImage> {
    const res = await fetchResource(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return { width: img.width, height: img.height, data: img.data };
  }

  storage() {
    return defaultBackend();
  }

  private live: HTMLElement | null = null;

  /** A visually hidden live region; assistive tech reads what lands in it. */
  announce(text: string): void {
    if (typeof document === "undefined") return;
    if (!this.live) {
      const el = document.createElement("div");
      el.setAttribute("aria-live", "polite");
      el.setAttribute("aria-atomic", "true");
      el.setAttribute("role", "status");
      el.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;";
      document.body.appendChild(el);
      this.live = el;
    }
    // Clearing first makes a repeated message read again.
    this.live.textContent = "";
    const el = this.live;
    setTimeout(() => {
      el.textContent = text;
    }, 30);
  }

  haptic(kind: HapticKind): void {
    const nav = (globalThis as { navigator?: { vibrate?: (pattern: number | number[]) => boolean } }).navigator;
    if (!nav?.vibrate) return;
    const pattern = { light: 8, medium: 16, heavy: 32, selection: 5, success: [10, 40, 10], warning: [20, 40, 20], error: [30, 40, 30, 40, 30] }[kind];
    try {
      nav.vibrate(pattern);
    } catch {
      // Ignored: some browsers throw outside a user gesture.
    }
  }

  openUrl(url: string): void {
    window.open(url, "_blank", "noopener");
  }
}
