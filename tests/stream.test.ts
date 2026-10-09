// Streaming music: the codec build of the kernel decodes OGG Vorbis and MP3 a packet at a time
// while it plays, loops without a gap, and stays within a small buffer; the engine routes
// `loadMusic` to a stream when the backend has codecs and to a whole sample otherwise.

import { describe, expect, test } from "bun:test";
import { AUDIO_CMD, type AudioBackend, AudioEngine } from "../src/audio/index.ts";

const WASM = await Bun.file(new URL("../src/kernel/audio.wasm", import.meta.url)).arrayBuffer();

interface AudioExports {
  memory: WebAssembly.Memory;
  blackiron_audio_new(rate: number, voices: number): number;
  blackiron_audio_scratch(a: number): number;
  blackiron_audio_scratch_words(a: number): number;
  blackiron_audio_command(a: number, words: number): number;
  blackiron_audio_stream_begin(a: number, id: number, len: number): number;
  blackiron_audio_stream_write(a: number, id: number, bytes: number): number;
  blackiron_audio_stream_open(a: number, id: number): number;
  blackiron_audio_stream_close(a: number, id: number): void;
  blackiron_audio_render(a: number, position: number, frames: number): void;
  blackiron_audio_out(a: number): number;
  blackiron_audio_active(a: number): number;
}

async function kernel(): Promise<{ x: AudioExports; a: number }> {
  const { instance } = await WebAssembly.instantiate(WASM, {});
  const x = instance.exports as unknown as AudioExports;
  return { x, a: x.blackiron_audio_new(48000, 8) };
}

function openStream(k: { x: AudioExports; a: number }, id: number, bytes: Uint8Array): number {
  const { x, a } = k;
  if (!x.blackiron_audio_stream_begin(a, id, bytes.length)) return 0;
  const cap = x.blackiron_audio_scratch_words(a) * 4;
  for (let off = 0; off < bytes.length; off += cap) {
    const n = Math.min(cap, bytes.length - off);
    new Uint8Array(x.memory.buffer, x.blackiron_audio_scratch(a), cap).set(bytes.subarray(off, off + n));
    x.blackiron_audio_stream_write(a, id, n);
  }
  return x.blackiron_audio_stream_open(a, id);
}

function command(k: { x: AudioExports; a: number }, words: number[]): void {
  new Float32Array(k.x.memory.buffer, k.x.blackiron_audio_scratch(k.a), words.length).set(words);
  k.x.blackiron_audio_command(k.a, words.length);
}

function peak(k: { x: AudioExports; a: number }, frames: number): number {
  const out = new Float32Array(k.x.memory.buffer, k.x.blackiron_audio_out(k.a), frames * 2);
  let m = 0;
  for (let i = 0; i < out.length; i++) m = Math.max(m, Math.abs(out[i]));
  return m;
}

describe("Streaming music", () => {
  for (const file of ["loop.ogg", "loop.mp3"]) {
    test(`${file} streams, loops without a gap, and closes`, async () => {
      const k = await kernel();
      const bytes = new Uint8Array(await Bun.file(new URL(`./fixtures/${file}`, import.meta.url)).arrayBuffer());
      const rate = openStream(k, 3, bytes);
      expect(rate).toBe(44100);
      command(k, [AUDIO_CMD.STREAM, 0, 1, 3, 1, 1, 0, 1]);
      // Four seconds of a 1.5 s file: every block sounds, so the loop has no gap.
      const block = 2400;
      let quiet = 0;
      let loud = 0;
      for (let i = 0; i < 80; i++) {
        k.x.blackiron_audio_render(k.a, i * block, block);
        const p = peak(k, block);
        if (p < 0.02) quiet++;
        loud = Math.max(loud, p);
      }
      // The fixture is a 0.75 sine; the music bus and constant-power pan bring it near 0.2.
      expect(loud).toBeGreaterThan(0.1);
      expect(quiet).toBe(0);
      expect(k.x.blackiron_audio_active(k.a)).toBe(1);
      k.x.blackiron_audio_stream_close(k.a, 3);
      k.x.blackiron_audio_render(k.a, 80 * block, block);
      expect(k.x.blackiron_audio_active(k.a)).toBe(0);
    });
  }

  test("a non-looping stream ends, and bytes no codec reads do not open", async () => {
    const k = await kernel();
    const bytes = new Uint8Array(await Bun.file(new URL("./fixtures/loop.ogg", import.meta.url)).arrayBuffer());
    expect(openStream(k, 0, bytes)).toBe(44100);
    command(k, [AUDIO_CMD.STREAM, 0, 1, 0, 1, 1, 0, 0]);
    const block = 4800;
    for (let i = 0; i < 25; i++) k.x.blackiron_audio_render(k.a, i * block, block);
    expect(k.x.blackiron_audio_active(k.a)).toBe(0);
    expect(openStream(k, 1, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(0);
  });
});

class FakeBackend implements AudioBackend {
  readonly kind = "native" as const;
  unlocked = true;
  commands: number[][] = [];
  streams = new Map<number, number>();
  samples = new Map<number, number>();
  constructor(readonly codecs: boolean) {}
  unlock() {}
  time() {
    return 0;
  }
  command(words: ArrayLike<number>) {
    this.commands.push(Array.from(words));
  }
  async loadSample(id: number, bytes: ArrayBuffer) {
    this.samples.set(id, bytes.byteLength);
    return true;
  }
  async loadStream(id: number, bytes: ArrayBuffer) {
    if (!this.codecs) return false;
    this.streams.set(id, bytes.byteLength);
    return true;
  }
  closeStream(id: number) {
    this.streams.delete(id);
  }
  destroy() {}
}

describe("AudioEngine music", () => {
  test("loadMusic streams when the backend has codecs and plays with the stream command", async () => {
    const b = new FakeBackend(true);
    const a = new AudioEngine(b);
    expect(await a.loadMusic("theme", new ArrayBuffer(1000))).toBe(true);
    expect(a.isStreamed("theme")).toBe(true);
    expect(b.streams.size).toBe(1);
    a.playMusic("theme", { volume: 0.8 });
    const cmd = b.commands.find((c) => c[0] === AUDIO_CMD.STREAM);
    // The first play lands on music bus 2; the buses alternate for crossfades.
    expect(cmd).toEqual([AUDIO_CMD.STREAM, 0, 2, 0, 0.8, 1, 0, 1]);
    a.unloadMusic("theme");
    expect(b.streams.size).toBe(0);
    expect(a.isStreamed("theme")).toBe(false);
  });

  test("without codecs the track decodes whole and plays as a sample", async () => {
    const b = new FakeBackend(false);
    const a = new AudioEngine(b);
    expect(await a.loadMusic("theme", new ArrayBuffer(1000))).toBe(true);
    expect(a.isStreamed("theme")).toBe(false);
    expect(b.samples.size).toBe(1);
    a.playMusic("theme");
    expect(b.commands.find((c) => c[0] === AUDIO_CMD.SAMPLE)).toEqual([AUDIO_CMD.SAMPLE, 0, 2, 0, 1, 1, 0, 1]);
  });
});
