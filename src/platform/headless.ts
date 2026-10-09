import { decodePNG } from "../art/png.ts";
import { memoryBackend } from "../save/store.ts";
import type { DecodedImage, Platform } from "./types.ts";

/** No DOM: manual frames, in-memory storage, assets from a table the test fills in. */
export class HeadlessPlatform implements Platform {
  readonly kind = "headless" as const;
  private t = 0;
  private readonly store = memoryBackend();
  /** Assets a test can provide by URL. */
  readonly files = new Map<string, ArrayBuffer | string | DecodedImage>();
  /** Directory that URLs resolve against when they are not in `files`; the working directory under Bun. */
  readonly root: string | null;

  constructor(opts: { root?: string | null } = {}) {
    this.root = opts.root === undefined ? (typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : null) : opts.root;
  }

  /** Read a file under the root with Bun, or null when there is no root, no Bun, or no file. */
  private async disk(url: string): Promise<Uint8Array | null> {
    if (!this.root || typeof Bun === "undefined") return null;
    const path = url.startsWith("/") ? url : `${this.root}/${url}`;
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return new Uint8Array(await f.arrayBuffer());
  }

  now(): number {
    return this.t;
  }

  /** Advance the fake clock; frames are driven by `App.frame` in tests, not by this. */
  tick(ms: number): void {
    this.t += ms;
  }

  requestFrame(): () => void {
    return () => {};
  }

  pixelRatio(): number {
    return 1;
  }

  visible(): boolean {
    return true;
  }

  onVisibility(): () => void {
    return () => {};
  }

  async loadBytes(url: string): Promise<ArrayBuffer> {
    const f = this.files.get(url);
    if (f instanceof ArrayBuffer) return f;
    if (typeof f === "string") return new TextEncoder().encode(f).buffer as ArrayBuffer;
    const d = await this.disk(url);
    if (d) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
    throw new Error(`No headless file for ${url}`);
  }

  async loadText(url: string): Promise<string> {
    const f = this.files.get(url);
    if (typeof f === "string") return f;
    if (f instanceof ArrayBuffer) return new TextDecoder().decode(f);
    const d = await this.disk(url);
    if (d) return new TextDecoder().decode(d);
    throw new Error(`No headless file for ${url}`);
  }

  async loadJson<T = unknown>(url: string): Promise<T> {
    return JSON.parse(await this.loadText(url)) as T;
  }

  async loadImage(url: string): Promise<DecodedImage> {
    const f = this.files.get(url);
    if (f && typeof f === "object" && "data" in f) return f;
    const d = await this.disk(url);
    if (d) {
      // Bun inflates raw deflate; a PNG stream carries the two-byte zlib header first.
      const png = decodePNG(d, (b) => new Uint8Array(Bun.inflateSync(b.subarray(2) as Uint8Array<ArrayBuffer>)));
      return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.rgba.buffer, png.rgba.byteOffset, png.rgba.byteLength) };
    }
    throw new Error(`No headless image for ${url}`);
  }

  storage() {
    return this.store;
  }

  /** Text announced through `accessibility.announce`, for tests. */
  readonly announcements: string[] = [];

  announce(text: string): void {
    this.announcements.push(text);
  }
}
