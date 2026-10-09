import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const engine = resolve(import.meta.dir, ".."),
  output = resolve(engine, ".blackiron/verification/ci");
await mkdir(output, { recursive: true });
if (Bun.version !== "1.3.13")
  throw new Error(`CI requires Bun 1.3.13, got ${Bun.version}`);
const rust = await new Response(
  Bun.spawn(["rustc", "--version"], { stdout: "pipe" }).stdout,
).text();
if (!rust.startsWith("rustc 1.98.1 "))
  throw new Error(`CI requires Rust 1.98.1, got ${rust}`);
const jobs: [string, string[]][] = [
  ["install", [process.execPath, "install", "--frozen-lockfile"]],
  ["typecheck", [process.execPath, "run", "typecheck"]],
  ["tests", [process.execPath, "test"]],
  [
    "kernel",
    [
      "cargo",
      "test",
      "--locked",
      "--release",
      "--features",
      "physics,physics3d,render,codecs",
      "--manifest-path",
      "kernel/Cargo.toml",
    ],
  ],
  [
    "host",
    [
      "cargo",
      "test",
      "--locked",
      "--release",
      "--manifest-path",
      "host/Cargo.toml",
    ],
  ],
  ...(process.platform === "darwin" ? [[
    "native-gpu",
    ["cargo", "test", "--locked", "--release", "--features", "physics,physics3d,render,codecs", "--manifest-path", "kernel/Cargo.toml", "render::mesh::tests", "--", "--ignored"],
  ] as [string, string[]]] : []),
  ["gpu", [process.execPath, "run", "check:3d"]],
  ["native-content", [process.execPath, "run", "check:native-content"]],
  ["native-fps", [process.execPath, "scripts/check-native-fps.ts"]],
  ["exports", [process.execPath, "scripts/check-exports.ts"]],
  ["games", [process.execPath, "run", "check:showcases"]],
  ["fps", [process.execPath, "run", "check:fps"]],
  ["lowline", [process.execPath, "run", "check:lowline"]],
  ["reproducible", [process.execPath, "run", "check:reproducible"]],
  [
    "native",
    [
      process.execPath,
      "cli/blackiron.ts",
      "verify",
      "--host",
      "desktop",
      "--js",
      "quickjs",
    ],
  ],
];
const results = [];
for (const [name, command] of jobs) {
  console.log(`CI: ${name}`);
  const started = performance.now();
  const proc = Bun.spawn(command, {
    cwd: engine,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BLACKIRON_NO_V8: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await Bun.write(resolve(output, name + ".log"), stdout + stderr);
  results.push({
    name,
    command,
    exitCode: code,
    seconds: (performance.now() - started) / 1000,
  });
  await Bun.write(
    resolve(output, "result.json"),
    JSON.stringify(
      {
        execution: "local CI jobs on this host; hosted OS matrix is separate",
        bun: Bun.version,
        rust: rust.trim(),
        date: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
  );
  if (code !== 0)
    throw new Error(`CI ${name} failed. See ${resolve(output, name + ".log")}`);
}
console.log(`CI: ${results.length} jobs passed.`);
