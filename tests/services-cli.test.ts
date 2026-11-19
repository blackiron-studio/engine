import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGameServer } from "../cli/commands/dev.ts";
import { loadProject, validateServices } from "../cli/project.ts";

test("service config that cannot work on a device fails before any build", () => {
  const bad = (config: unknown): string => {
    try {
      validateServices(config as Parameters<typeof validateServices>[0]);
      return "ok";
    } catch (e) {
      return (e as Error).message;
    }
  };
  expect(bad({})).toBe("ok");
  expect(bad({ cloud: false })).toBe("ok");
  expect(bad({ cloud: true })).toContain('cloud: true needs a "services" block');
  expect(bad({ services: {} })).toContain("services.provider is required");
  expect(bad({ services: { provider: "mock" }, cloud: true })).toBe("ok");
  expect(bad({ services: { provider: "http" }, cloud: true })).toContain("services.url is missing");
  expect(bad({ services: { provider: "studio-backend" } })).toContain("services.url is missing");
  expect(bad({ services: { provider: "http", url: "players.example.com" } })).toContain("not a URL");
  expect(bad({ services: { provider: "http", url: "http://players.example.com" } })).toContain("must be https");
  expect(bad({ services: { provider: "http", url: "http://localhost:4250" } })).toBe("ok");
  expect(bad({ services: { provider: "http", url: "https://players.example.com" } })).toBe("ok");
  expect(bad({ services: { provider: "apteva", url: "https://agents.example.com" } })).toContain("services.game is missing");
  expect(bad({ services: { provider: "apteva", url: "https://agents.example.com", game: "g1" } })).toBe("ok");
});

test("loading a project applies the check, so every command fails early", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blackiron-services-"));
  try {
    writeFileSync(join(dir, "main.ts"), "");
    writeFileSync(join(dir, "blackiron.json"), JSON.stringify({ name: "T", entry: "main.ts", cloud: true }));
    await expect(loadProject(dir)).rejects.toThrow('cloud: true needs a "services" block');
    writeFileSync(join(dir, "blackiron.json"), JSON.stringify({ name: "T", entry: "main.ts", cloud: true, services: { provider: "http", url: "https://p.example.com" } }));
    expect((await loadProject(dir)).config.services).toEqual({ provider: "http", url: "https://p.example.com" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev --server runs the game's server script and stops it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blackiron-devserver-"));
  try {
    writeFileSync(join(dir, "server.ts"), `await Bun.write("${join(dir, "up")}", process.env.BLACKIRON_DEV ?? ""); setInterval(() => {}, 1000);`);
    expect(() => startGameServer("missing.ts", dir)).toThrow("--server script not found");
    const stop = startGameServer("server.ts", dir);
    for (let i = 0; i < 400 && !existsSync(join(dir, "up")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(join(dir, "up"), "utf8")).toBe("1");
    stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
