import { describe, expect, test } from "bun:test";
import { createStore, memoryBackend } from "../src/save/index.ts";

interface V1 {
  score: number;
}
interface V2 {
  best: number;
  games: number;
}

describe("Store", () => {
  test("load returns initial until saved", () => {
    const s = createStore<V1>({ key: "k", version: 1, initial: () => ({ score: 0 }), backend: memoryBackend() });
    expect(s.has()).toBe(false);
    expect(s.load()).toEqual({ score: 0 });
    expect(s.save({ score: 5 })).toBe(true);
    expect(s.has()).toBe(true);
    expect(s.load()).toEqual({ score: 5 });
    expect(s.savedAt()).toBeInstanceOf(Date);
    s.clear();
    expect(s.has()).toBe(false);
  });

  test("migrates older versions step by step", () => {
    const backend = memoryBackend();
    createStore<V1>({ key: "k", version: 1, initial: () => ({ score: 0 }), backend }).save({ score: 7 });
    const s2 = createStore<V2>({
      key: "k",
      version: 2,
      initial: () => ({ best: 0, games: 0 }),
      backend,
      migrate: (data, from) => (from === 1 ? { best: (data as V1).score, games: 1 } : null),
    });
    expect(s2.load()).toEqual({ best: 7, games: 1 });
  });

  test("newer, corrupt or invalid documents fall back to initial", () => {
    const backend = memoryBackend();
    backend.set("k", "not json");
    const s = createStore<V1>({ key: "k", version: 1, initial: () => ({ score: -1 }), backend, validate: (d) => typeof (d as V1).score === "number" });
    expect(s.load()).toEqual({ score: -1 });
    backend.set("k", JSON.stringify({ v: 9, savedAt: "", data: { score: 1 } }));
    expect(s.load()).toEqual({ score: -1 });
    backend.set("k", JSON.stringify({ v: 1, savedAt: "", data: { score: "bad" } }));
    expect(s.load()).toEqual({ score: -1 });
  });

  test("without a migrate function old saves are discarded", () => {
    const backend = memoryBackend();
    backend.set("k", JSON.stringify({ v: 1, savedAt: "", data: { score: 3 } }));
    const s = createStore<V2>({ key: "k", version: 2, initial: () => ({ best: 0, games: 0 }), backend });
    expect(s.load()).toEqual({ best: 0, games: 0 });
  });
});
