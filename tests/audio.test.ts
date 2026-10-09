// The AudioEngine turns sound effects, samples and moods into kernel commands. A fake
// backend records them; the DSP itself is covered by the kernel's own tests.

import { describe, expect, test } from "bun:test";
import { AUDIO_CMD, type AudioBackend, AudioEngine, WAVE_ID } from "../src/audio/index.ts";

class FakeBackend implements AudioBackend {
  readonly kind = "native" as const;
  unlocked = false;
  t = 0;
  commands: number[][] = [];
  samples = new Map<number, number>();
  unlock() {
    this.unlocked = true;
  }
  time() {
    return this.t;
  }
  command(words: ArrayLike<number>) {
    this.commands.push(Array.from(words));
  }
  async loadSample(id: number, bytes: ArrayBuffer) {
    this.samples.set(id, bytes.byteLength);
    return bytes.byteLength > 0;
  }
  destroy() {}
}

describe("AudioEngine", () => {
  test("bus effects go to the kernel for the right buses and again after an unlock", () => {
    const b = new FakeBackend();
    const a = new AudioEngine(b);
    a.setEffects("music", { lowpass: 800, reverb: { mix: 0.4 } });
    // Not unlocked yet: nothing sent, but remembered.
    expect(b.commands).toEqual([]);
    expect(a.getEffects("music")?.lowpass).toBe(800);
    a.unlock();
    const fx = b.commands.filter((c) => c[0] === AUDIO_CMD.BUS_FX);
    expect(fx).toEqual([
      [AUDIO_CMD.BUS_FX, 1, 800, 0.4, 0.5, 0, 0.35, 0.5],
      [AUDIO_CMD.BUS_FX, 2, 800, 0.4, 0.5, 0, 0.35, 0.5],
    ]);
    b.commands.length = 0;
    a.setEffects("sfx", { echo: { time: 0.25, feedback: 0.5 } });
    expect(b.commands).toEqual([[AUDIO_CMD.BUS_FX, 0, 0, 0, 0.5, 0.25, 0.5, 0.5]]);
    a.setEffects("sfx", null);
    expect(b.commands.at(-1)).toEqual([AUDIO_CMD.BUS_FX, 0, 0, 0, 0.5, 0, 0.35, 0.5]);
  });

  test("unlocking pushes the bus levels and mute state once", () => {
    const b = new FakeBackend();
    const a = new AudioEngine(b);
    a.musicVolume = 0.25;
    a.setMuted(true);
    b.commands.length = 0;
    a.unlock();
    a.unlock();
    expect(b.commands).toEqual([
      [AUDIO_CMD.BUS, 0.8, 0.25],
      [AUDIO_CMD.MUTE, 1],
    ]);
  });

  test("sound effects become voice commands, repeats are spaced on the clock", () => {
    const b = new FakeBackend();
    const a = new AudioEngine(b);
    a.defineSfx("zap", { wave: "sawtooth", freq: 300, freqEnd: 60, duration: 0.2, release: 0.1, volume: 0.4, lowpass: 800, repeat: 2, repeatGap: 0.05 });
    a.play("zap");
    expect(b.commands).toHaveLength(0);
    a.unlock();
    b.t = 10;
    b.commands.length = 0;
    a.play("zap", { pitch: 1.5, volume: 0.5 });
    expect(b.commands).toHaveLength(2);
    const [first, second] = b.commands;
    expect(first[0]).toBe(AUDIO_CMD.VOICE);
    expect(first[1]).toBe(0);
    expect(first[3]).toBe(WAVE_ID.sawtooth);
    expect(first[4]).toBe(300);
    expect(first[5]).toBe(60);
    expect(first[9]).toBeCloseTo(0.2);
    expect(first[10]).toBe(800);
    expect(first[13]).toBe(1.5);
    expect(first[14]).toBe(0);
    expect(second[1]).toBeCloseTo(10.25);
    b.commands.length = 0;
    a.listener = { x: 0, y: 0, range: 1000 };
    a.play("zap", { x: 250, y: 0 });
    expect(b.commands[0][14]).toBeCloseTo(0.5);
    expect(b.commands[0][9]).toBeLessThan(0.4);
    a.play("zap", { x: 5000, y: 0 });
    expect(b.commands).toHaveLength(2);
  });

  test("samples get ids and play through the sample command", async () => {
    const b = new FakeBackend();
    const a = new AudioEngine(b);
    expect(await a.loadSample("thud", new ArrayBuffer(16))).toBe(true);
    expect(await a.loadSample("empty", new ArrayBuffer(0))).toBe(false);
    expect(a.hasSample("thud")).toBe(true);
    expect(a.hasSample("empty")).toBe(false);
    a.unlock();
    b.commands.length = 0;
    a.play("thud", { volume: 0.7, pitch: 0.5 });
    expect(b.commands[0]).toEqual([AUDIO_CMD.SAMPLE, 0, 0, 0, 0.7, 0.5, 0, 0]);
  });

  test("a mood schedules notes ahead of the clock on the music bus", () => {
    const b = new FakeBackend();
    const a = new AudioEngine(b);
    a.defineMood("calm", { tempo: 120, root: 220, scale: [0, 2, 3, 5, 7, 8, 10], density: 1, seed: 2 });
    a.setMood("calm");
    a.unlock();
    b.commands.length = 0;
    (a as unknown as { schedule(): void }).schedule();
    const voices = b.commands.filter((c) => c[0] === AUDIO_CMD.VOICE);
    expect(voices.length).toBeGreaterThan(0);
    for (const v of voices) {
      expect(v[2]).toBe(1);
      expect(v[1]).toBeGreaterThanOrEqual(0.05);
      expect(v[1]).toBeLessThan(0.5);
    }
    a.setMood(null);
    expect(a.currentMood).toBeNull();
    a.destroy();
    expect(b.commands.at(-1)).toEqual([AUDIO_CMD.STOP]);
  });

  test("without a backend everything is a quiet no-op", () => {
    const a = new AudioEngine(null);
    a.defineSfx("x", { freq: 100 });
    a.unlock();
    a.play("x");
    a.setMood("none");
    expect(a.available).toBe(false);
    expect(a.unlocked).toBe(false);
  });
});
