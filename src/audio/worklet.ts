import { fetchResource } from "../platform/resources.ts";
// The web audio backend: the kernel's synthesiser running inside an AudioWorklet, fed the
// same Wasm module the renderer uses. Commands travel over the worklet port.

import { KERNEL_WASM_BASE64 } from "../kernel/kernel.wasm.ts";
import { decodeBase64 } from "../kernel/wasm.ts";
import type { AudioBackend } from "./backend.ts";

type AudioCtor = typeof AudioContext;

export function audioContextCtor(): AudioCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Source of the worklet processor. It runs in the AudioWorkletGlobalScope, so no imports. */
const PROCESSOR = `
class BlackironAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.a = 0;
    this.pending = [];
    this.port.onmessage = (e) => { this.onMessage(e.data); };
  }
  async onMessage(d) {
    if (d && d.wasm) {
      const { instance } = await WebAssembly.instantiate(d.wasm, {});
      this.x = instance.exports;
      this.a = this.x.blackiron_audio_new(sampleRate, 64);
      for (const c of this.pending) this.command(c);
      this.pending = [];
      this.port.postMessage("ready");
    } else if (d && d.sample !== undefined) {
      if (!this.a) return;
      const pcm = d.pcm;
      if (!this.x.blackiron_audio_sample_begin(this.a, d.sample, pcm.length)) return;
      const cap = this.x.blackiron_audio_scratch_words(this.a);
      for (let off = 0; off < pcm.length; off += cap) {
        const n = Math.min(cap, pcm.length - off);
        this.scratch().set(pcm.subarray(off, off + n));
        this.x.blackiron_audio_sample_write(this.a, d.sample, off, n);
      }
    } else if (d && d.stream !== undefined) {
      // An encoded file for the kernel's streaming decoder; the reply carries its rate, or 0.
      let rate = 0;
      if (this.a && this.x.blackiron_audio_stream_begin) {
        const bytes = new Uint8Array(d.bytes);
        if (this.x.blackiron_audio_stream_begin(this.a, d.stream, bytes.length)) {
          const cap = this.x.blackiron_audio_scratch_words(this.a) * 4;
          for (let off = 0; off < bytes.length; off += cap) {
            const n = Math.min(cap, bytes.length - off);
            new Uint8Array(this.x.memory.buffer, this.x.blackiron_audio_scratch(this.a), cap).set(bytes.subarray(off, off + n));
            this.x.blackiron_audio_stream_write(this.a, d.stream, n);
          }
          rate = this.x.blackiron_audio_stream_open(this.a, d.stream);
        }
      }
      this.port.postMessage({ stream: d.stream, rate });
    } else if (d && d.close !== undefined) {
      if (this.a && this.x.blackiron_audio_stream_close) this.x.blackiron_audio_stream_close(this.a, d.close);
    } else if (d instanceof Float32Array) {
      if (this.a) this.command(d); else this.pending.push(d);
    }
  }
  scratch() { return new Float32Array(this.x.memory.buffer, this.x.blackiron_audio_scratch(this.a), this.x.blackiron_audio_scratch_words(this.a)); }
  command(words) { this.scratch().set(words); this.x.blackiron_audio_command(this.a, words.length); }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.a || !out || out.length === 0) return true;
    const n = out[0].length;
    this.x.blackiron_audio_render(this.a, currentFrame, n);
    const buf = new Float32Array(this.x.memory.buffer, this.x.blackiron_audio_out(this.a), n * 2);
    if (out.length >= 2) {
      const l = out[0], r = out[1];
      for (let i = 0; i < n; i++) { l[i] = buf[i * 2]; r[i] = buf[i * 2 + 1]; }
      for (let c = 2; c < out.length; c++) out[c].set(l);
    } else {
      const m = out[0];
      for (let i = 0; i < n; i++) m[i] = (buf[i * 2] + buf[i * 2 + 1]) * 0.5;
    }
    return true;
  }
}
registerProcessor("blackiron-audio", BlackironAudioProcessor);
`;

/** Where the codec build of the kernel is served; next to the game, like physics.wasm. */
export const AUDIO_WASM_URL = "audio.wasm";

export class WorkletBackend implements AudioBackend {
  readonly kind = "worklet" as const;
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready = false;
  private setup: Promise<void> | null = null;
  private readonly queue: Float32Array[] = [];
  private readonly streamWaits = new Map<number, (rate: number) => void>();
  /** Whether the processor runs the codec build, so streams can open. */
  codecs = false;

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  unlock(): void {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    if (!this.ctx) this.ctx = new Ctor();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (!this.setup) this.setup = this.install().catch((err) => console.warn("[blackiron] audio worklet failed:", (err as Error).message));
  }

  private async install(): Promise<void> {
    const ctx = this.ctx as AudioContext;
    if (!ctx.audioWorklet) throw new Error("AudioWorklet is not available");
    const url = URL.createObjectURL(new Blob([PROCESSOR], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, "blackiron-audio", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e) => {
      const d = e.data;
      if (d === "ready") {
        this.ready = true;
        for (const c of this.queue) node.port.postMessage(c);
        this.queue.length = 0;
      } else if (d && typeof d === "object" && d.stream !== undefined) {
        const wait = this.streamWaits.get(d.stream);
        this.streamWaits.delete(d.stream);
        wait?.(d.rate);
      }
    };
    node.connect(ctx.destination);
    // The codec build when it is served, else the plain kernel (streams then fall back to samples).
    let bytes: Uint8Array | null = null;
    try {
      const res = await fetchResource(AUDIO_WASM_URL);
      if (res.ok && (res.headers.get("Content-Type") ?? "").includes("wasm")) {
        bytes = new Uint8Array(await res.arrayBuffer());
        this.codecs = true;
      }
    } catch {
      /* not served */
    }
    if (!bytes) bytes = decodeBase64(KERNEL_WASM_BASE64);
    node.port.postMessage({ wasm: bytes.buffer }, [bytes.buffer as ArrayBuffer]);
    this.node = node;
  }

  /** Wait for the processor to report ready. */
  private async whenReady(): Promise<AudioWorkletNode | null> {
    await this.setup;
    if (this.ready) return this.node;
    const node = this.node;
    if (!node) return null;
    await new Promise<void>((resolve) => {
      const prev = node.port.onmessage;
      node.port.onmessage = (e) => {
        prev?.call(node.port, e);
        if (e.data === "ready") resolve();
      };
    });
    return node;
  }

  async loadStream(id: number, bytes: ArrayBuffer): Promise<boolean> {
    const Ctor = audioContextCtor();
    if (!Ctor) return false;
    if (!this.ctx) this.ctx = new Ctor();
    if (!this.setup) this.setup = this.install().catch((err) => console.warn("[blackiron] audio worklet failed:", (err as Error).message));
    const node = await this.whenReady();
    if (!node || !this.codecs) return false;
    const rate = await new Promise<number>((resolve) => {
      this.streamWaits.set(id, resolve);
      const copy = bytes.slice(0);
      node.port.postMessage({ stream: id, bytes: copy }, [copy]);
    });
    return rate > 0;
  }

  closeStream(id: number): void {
    this.node?.port.postMessage({ close: id });
  }

  time(): number {
    return this.ctx?.currentTime ?? 0;
  }

  command(words: ArrayLike<number>): void {
    const c = Float32Array.from(words);
    if (this.node && this.ready) this.node.port.postMessage(c);
    else this.queue.push(c);
  }

  async loadSample(id: number, bytes: ArrayBuffer): Promise<boolean> {
    const Ctor = audioContextCtor();
    if (!Ctor) return false;
    if (!this.ctx) this.ctx = new Ctor();
    if (!this.setup) this.setup = this.install().catch((err) => console.warn("[blackiron] audio worklet failed:", (err as Error).message));
    try {
      const buffer = await this.ctx.decodeAudioData(bytes.slice(0));
      const pcm = new Float32Array(buffer.length);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const d = buffer.getChannelData(ch);
        for (let i = 0; i < d.length; i++) pcm[i] += d[i] / buffer.numberOfChannels;
      }
      await this.setup;
      const post = () => this.node?.port.postMessage({ sample: id, pcm }, [pcm.buffer]);
      if (this.ready) post();
      else {
        // Deliver after the processor reports ready, keeping command order.
        const node = this.node;
        if (!node) return false;
        const prev = node.port.onmessage;
        node.port.onmessage = (e) => {
          prev?.call(node.port, e);
          if (e.data === "ready") post();
        };
      }
      return true;
    } catch (err) {
      console.warn(`[blackiron] could not decode sample ${id}:`, (err as Error).message);
      return false;
    }
  }

  destroy(): void {
    this.node?.disconnect();
    this.node = null;
    void this.ctx?.close();
    this.ctx = null;
    this.ready = false;
    this.setup = null;
  }
}
