// The native audio backend: the host owns the kernel synthesiser and its audio thread; the
// engine writes commands into the host's scratch buffer and asks it to queue them.

import type { AudioBackend } from "./backend.ts";

/** What a native host exposes as `__kilnHost.audio`. */
export interface NativeAudioHost {
  unlock(): void;
  time(): number;
  readonly scratch: Float32Array;
  command(words: number): void;
  loadSample(id: number, bytes: Uint8Array): boolean;
  /** Open a streamed track; returns its sample rate, or 0 when the kernel has no codec for it. */
  loadStream?(id: number, bytes: Uint8Array): number;
  closeStream?(id: number): void;
  peak?(): number;
}

export class NativeAudioBackend implements AudioBackend {
  readonly kind = "native" as const;
  private started = false;

  constructor(private readonly host: NativeAudioHost) {}

  get unlocked(): boolean {
    return this.started;
  }

  unlock(): void {
    this.host.unlock();
    this.started = true;
  }

  time(): number {
    return this.host.time();
  }

  command(words: ArrayLike<number>): void {
    const s = this.host.scratch;
    const n = Math.min(words.length, s.length);
    for (let i = 0; i < n; i++) s[i] = words[i];
    this.host.command(n);
  }

  async loadSample(id: number, bytes: ArrayBuffer): Promise<boolean> {
    return this.host.loadSample(id, new Uint8Array(bytes));
  }

  async loadStream(id: number, bytes: ArrayBuffer): Promise<boolean> {
    if (!this.host.loadStream) return false;
    return this.host.loadStream(id, new Uint8Array(bytes)) > 0;
  }

  closeStream(id: number): void {
    this.host.closeStream?.(id);
  }

  destroy(): void {}
}
